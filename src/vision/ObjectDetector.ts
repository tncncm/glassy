/**
 * PRIVACY — read this before touching anything below.
 *
 * This file feeds the live <video> element straight into an on-device
 * MediaPipe model (`detectForVideo`) and reads back boxes + labels. That is
 * the entire extent of what happens to a frame:
 *
 *   - inference runs locally, in this tab, on-device — there is no backend
 *     and no code path that could send a frame, a crop or a tensor anywhere
 *   - MediaPipe is handed the live <video> element directly; this file never
 *     draws a frame to a canvas, never calls `toDataURL`/`toBlob`/
 *     `captureStream`/`MediaRecorder`, and never reads pixel data itself
 *   - the ONLY network calls this module ever makes are the one-time,
 *     same-origin fetches of the wasm runtime (`/vision/wasm/*`) and the
 *     detector model (`/vision/efficientdet_lite0_int8.tflite`) — both
 *     self-hosted, never a CDN, never Google, and both happen once at
 *     `start()`, never again during inference
 *   - what survives past a single inference tick is a handful of numbers
 *     (kind, box, score) written into a small object POOL that is reused
 *     forever and handed to `onDetections` — the array and its objects are
 *     mutated in place on the next tick, so nothing about a past frame is
 *     retained anywhere, and nothing is ever written to storage
 *   - `stop()` halts inference immediately; `dispose()` additionally calls
 *     MediaPipe's own `.close()` and drops every reference, including the
 *     loaded model
 *
 * MediaPipe itself is imported lazily, inside `start()`, so a user who never
 * opts into vision never downloads a byte of the wasm runtime or the model,
 * and none of it ships in the app's main bundle.
 *
 * If you are tempted to draw a video frame into a canvas, keep a detection
 * result beyond the tick that produced it, or add any network call outside
 * the one-time asset fetch, stop — read the matching PRIVACY comment above
 * `DetectedKind`/`Detection` in src/types.ts first, and change the
 * user-facing copy before you change this.
 */

import type {
  ObjectDetector,
  ObjectDetectorOptions,
  DetectorState,
  DetectedKind,
  Detection,
} from '../types.ts';

// Type-only — erased entirely at compile time. This does NOT pull MediaPipe
// into the bundle; only the dynamic `import()` inside `start()` does that.
import type {
  ObjectDetector as MpObjectDetector,
  ObjectDetectorResult as MpDetectionResult,
  Category as MpCategory,
} from '@mediapipe/tasks-vision';

/** Self-hosted only — see scripts/fetch-vision-assets.mjs. Never a CDN. */
const WASM_BASE_PATH = '/vision/wasm';
const MODEL_PATH = '/vision/efficientdet_lite0_int8.tflite';

/** Default inferences per second. Low on purpose — a neural net on a phone. */
const DEFAULT_SAMPLE_HZ = 3;
const DEFAULT_SCORE_THRESHOLD = 0.4;
const DEFAULT_MAX_RESULTS = 8;

/**
 * COCO labels Glassy reacts to, mapped to the coarse `DetectedKind` the game
 * consumes. Everything else the model reports is discarded immediately.
 * Passed as `categoryAllowlist` too, so the model itself filters early.
 */
const LABEL_TO_KIND: Readonly<Record<string, DetectedKind>> = {
  car: 'vehicle',
  truck: 'vehicle',
  bus: 'vehicle',
  motorcycle: 'vehicle',
  train: 'vehicle',
  person: 'person',
  bicycle: 'person',
  'traffic light': 'sign',
  'stop sign': 'sign',
  'parking meter': 'sign',
  bench: 'sign',
  'fire hydrant': 'sign',
};
const ALLOWED_LABELS = Object.keys(LABEL_TO_KIND);

/** Give up and fall back to `unavailable` after this many inference throws
 * in a row, rather than throwing (well, warning) on every single tick. */
const MAX_CONSECUTIVE_ERRORS = 5;

/** Consecutive over-budget ticks required before we back the rate off. */
const SLOW_STREAK_TO_BACKOFF = 5;
/** A tick counts as "slow" once it eats this fraction of its own budget. */
const SLOW_BUDGET_FRACTION = 0.9;
/** Each backoff step doubles the interval (halves the effective Hz). */
const BACKOFF_FACTOR = 2;
/** Never back off past ~0.5Hz — a trickle of detections beats none. */
const MAX_INTERVAL_MS = 2000;

/** Report real fetch progress in steps no finer than this, to avoid spamming
 * `onStateChange`. */
const PROGRESS_REPORT_STEP = 0.05;

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * PRIVACY — MediaPipe's Tasks Vision runtime has its OWN built-in usage
 * telemetry compiled into the bundle: it periodically `fetch()`s aggregated,
 * non-frame usage stats (task type, delegate, init/inference timing) to
 * `https://odml.pa.googleapis.com/v1/log`, and — as of this dependency's
 * pinned version — there is no public JS option to turn it off. That is a
 * network call this file's contract explicitly forbids ("no network call in
 * the inference path; the only fetches are the wasm + model, same-origin").
 *
 * Since it can't be configured off, it is blocked at the fetch layer: any
 * request whose host is this one specific Google logging endpoint is
 * intercepted and rejected before it leaves the tab. MediaPipe's own sender
 * already wraps that fetch in try/catch and treats any failure as
 * "logging unavailable, stop trying" — so this fails silently and permanently
 * for that logger, with zero effect on model inference or on any other
 * fetch (our own same-origin `/vision/*` fetches pass straight through).
 * Installed once, lazily, right before the dynamic MediaPipe import — never
 * touches `window.fetch` for a user who never opts into vision.
 */
const BLOCKED_TELEMETRY_HOST_SUFFIX = '.pa.googleapis.com';
let telemetryBlockInstalled = false;

function installTelemetryBlock(): void {
  if (telemetryBlockInstalled) return;
  telemetryBlockInstalled = true;
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;

  const originalFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let host = '';
    try {
      const url = typeof input === 'string' || input instanceof URL ? input : input.url;
      host = new URL(url, window.location.href).host;
    } catch {
      // Unparseable input — let the real fetch deal with (and reject) it.
    }
    if (host === 'odml.pa.googleapis.com' || host.endsWith(BLOCKED_TELEMETRY_HOST_SUFFIX)) {
      throw new DOMException('blocked: MediaPipe telemetry is disabled in Glassy', 'AbortError');
    }
    return originalFetch(input, init);
  }) as typeof window.fetch;
}

export function createObjectDetector(options: ObjectDetectorOptions): ObjectDetector {
  const { video } = options;
  const sampleHz = options.sampleHz ?? DEFAULT_SAMPLE_HZ;
  const baseIntervalMs = 1000 / Math.max(1, sampleHz);
  let intervalMs = baseIntervalMs;

  let currentState: DetectorState = { status: 'idle' };
  function setState(next: DetectorState): void {
    currentState = next;
    options.onStateChange?.(next);
  }

  // Fixed-size pool, sized once from the constant default (never resized by
  // an untrusted option value) — this is the only allocation of Detection
  // objects for the life of the controller. `output` is the single array
  // identity ever handed to `onDetections`; it is cleared and refilled with
  // references into `pool`, never replaced.
  const maxResults = DEFAULT_MAX_RESULTS;
  const pool: Detection[] = Array.from({ length: maxResults }, () => ({
    kind: 'vehicle' as DetectedKind,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    score: 0,
  }));
  const output: Detection[] = [];

  let mpDetector: MpObjectDetector | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight = false;
  let lastTimestamp = -1;
  let consecutiveErrors = 0;
  let slowStreak = 0;
  let warnedSlow = false;
  let warnedUnavailable = false;
  let warnedInferenceError = false;

  // Set while an in-flight start() should unwind into 'disabled' rather than
  // 'ready'/'unavailable' — stop()/dispose() called mid-load.
  let stopRequested = false;
  let loadAbort: AbortController | null = null;
  // Coalesces concurrent start() calls into one load.
  let startPromise: Promise<DetectorState> | null = null;

  function warnOnce(flagSet: () => void, already: boolean, message: string, err?: unknown): void {
    if (already) return;
    flagSet();
    if (err !== undefined) {
      console.warn(`[ObjectDetector] ${message}`, err);
    } else {
      console.warn(`[ObjectDetector] ${message}`);
    }
  }

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleNext(): void {
    clearTimer();
    timer = setTimeout(tick, intervalMs);
  }

  function tick(): void {
    timer = null;
    if (currentState.status !== 'ready') return;
    runInference();
    scheduleNext();
  }

  function trackTiming(elapsedMs: number): void {
    if (elapsedMs > intervalMs * SLOW_BUDGET_FRACTION) {
      slowStreak++;
      if (slowStreak >= SLOW_STREAK_TO_BACKOFF && intervalMs < MAX_INTERVAL_MS) {
        intervalMs = Math.min(MAX_INTERVAL_MS, intervalMs * BACKOFF_FACTOR);
        slowStreak = 0;
        warnOnce(
          () => (warnedSlow = true),
          warnedSlow,
          `inference is slower than the sample budget; backing off to ~${(1000 / intervalMs).toFixed(1)}Hz.`,
        );
      }
    } else {
      slowStreak = 0;
    }
  }

  function failPermanently(): void {
    clearTimer();
    try {
      mpDetector?.close();
    } catch {
      // Already broken; nothing more we can do about it.
    }
    mpDetector = null;
    setState({ status: 'unavailable' });
  }

  function publishDetections(result: MpDetectionResult): void {
    output.length = 0;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw === 0 || vh === 0) {
      options.onDetections?.(output);
      return;
    }

    for (const detection of result.detections) {
      if (output.length >= pool.length) break;
      const box = detection.boundingBox;
      if (!box) continue;
      const top: MpCategory | undefined = detection.categories[0];
      if (!top) continue;
      const kind = LABEL_TO_KIND[top.categoryName];
      if (!kind) continue;

      const slot = pool[output.length];
      if (!slot) break;
      slot.kind = kind;
      slot.x = clamp01((box.originX + box.width / 2) / vw);
      slot.y = clamp01((box.originY + box.height / 2) / vh);
      slot.width = clamp01(box.width / vw);
      slot.height = clamp01(box.height / vh);
      slot.score = top.score;
      output.push(slot);
    }

    options.onDetections?.(output);
  }

  function runInference(): void {
    if (inflight) return; // previous tick hasn't finished — never queue up
    if (document.hidden) return;
    if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return;
    if (!mpDetector) return;

    const now = Math.round(performance.now());
    if (now <= lastTimestamp) return; // MediaPipe requires strictly increasing timestamps
    lastTimestamp = now;

    inflight = true;
    const startedAt = performance.now();
    try {
      const result = mpDetector.detectForVideo(video, now);
      consecutiveErrors = 0;
      publishDetections(result);
    } catch (err) {
      consecutiveErrors++;
      warnOnce(
        () => (warnedInferenceError = true),
        warnedInferenceError,
        'inference threw; will retry a few times before disabling detection for this session.',
        err,
      );
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        failPermanently();
      }
    } finally {
      inflight = false;
    }
    trackTiming(performance.now() - startedAt);
  }

  async function fetchModelWithProgress(signal: AbortSignal): Promise<Uint8Array> {
    const response = await fetch(MODEL_PATH, { signal });
    if (!response.ok || !response.body) {
      throw new Error(`model fetch failed: HTTP ${response.status}`);
    }
    const totalHeader = response.headers.get('content-length');
    const total = totalHeader ? Number.parseInt(totalHeader, 10) : 0;

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    let lastReported = -1;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      received += value.byteLength;
      // Real byte progress only — no fabricated percentage. If the server
      // doesn't send Content-Length (`total === 0`), we simply never call
      // this and the UI stays indeterminate, which is the honest option.
      if (total > 0 && !stopRequested) {
        const progress = Math.min(0.99, received / total);
        if (progress - lastReported >= PROGRESS_REPORT_STEP) {
          lastReported = progress;
          setState({ status: 'loading', progress });
        }
      }
    }

    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  async function loadAndStart(): Promise<DetectorState> {
    if (typeof WebAssembly === 'undefined') {
      warnOnce(() => (warnedUnavailable = true), warnedUnavailable, 'WebAssembly is not supported here.');
      setState({ status: 'unavailable' });
      return currentState;
    }

    stopRequested = false;
    loadAbort = new AbortController();
    installTelemetryBlock();
    setState({ status: 'loading' });

    try {
      const [mediapipe, modelBytes] = await Promise.all([
        import('@mediapipe/tasks-vision'),
        fetchModelWithProgress(loadAbort.signal),
      ]);

      if (stopRequested) {
        setState({ status: 'disabled' });
        return currentState;
      }

      const fileset = await mediapipe.FilesetResolver.forVisionTasks(WASM_BASE_PATH);

      if (stopRequested) {
        setState({ status: 'disabled' });
        return currentState;
      }

      const shared = {
        runningMode: 'VIDEO' as const,
        scoreThreshold: DEFAULT_SCORE_THRESHOLD,
        maxResults,
        categoryAllowlist: ALLOWED_LABELS,
      };

      let detector: MpObjectDetector;
      try {
        detector = await mediapipe.ObjectDetector.createFromOptions(fileset, {
          ...shared,
          baseOptions: { modelAssetBuffer: modelBytes, delegate: 'GPU' },
        });
      } catch (gpuErr) {
        // GPU delegate support varies a lot across real phones; a hard
        // failure here must not kill the feature.
        console.warn('[ObjectDetector] GPU delegate unavailable, falling back to CPU.', gpuErr);
        detector = await mediapipe.ObjectDetector.createFromOptions(fileset, {
          ...shared,
          baseOptions: { modelAssetBuffer: modelBytes, delegate: 'CPU' },
        });
      }

      if (stopRequested) {
        detector.close();
        setState({ status: 'disabled' });
        return currentState;
      }

      mpDetector = detector;
      consecutiveErrors = 0;
      slowStreak = 0;
      intervalMs = baseIntervalMs;
      lastTimestamp = -1;
      setState({ status: 'ready' });
      scheduleNext();
      return currentState;
    } catch (err) {
      if (stopRequested) {
        setState({ status: 'disabled' });
        return currentState;
      }
      warnOnce(
        () => (warnedUnavailable = true),
        warnedUnavailable,
        'failed to initialise the on-device object detector; continuing without it.',
        err,
      );
      setState({ status: 'unavailable' });
      return currentState;
    } finally {
      loadAbort = null;
    }
  }

  function stopInference(): void {
    clearTimer();
    inflight = false;
  }

  return {
    get state(): DetectorState {
      return currentState;
    },

    start(): Promise<DetectorState> {
      if (currentState.status === 'ready') {
        return Promise.resolve(currentState);
      }
      if (startPromise) {
        return startPromise;
      }
      if (currentState.status === 'disabled' && mpDetector) {
        // Model already loaded — instant resume, no re-fetch.
        stopRequested = false;
        consecutiveErrors = 0;
        slowStreak = 0;
        intervalMs = baseIntervalMs;
        lastTimestamp = -1;
        setState({ status: 'ready' });
        scheduleNext();
        return Promise.resolve(currentState);
      }
      // idle, unavailable (deliberate retry — e.g. the network came back;
      // warnedUnavailable already guards against repeat warnings), or
      // disabled-without-a-loaded-model: all fall through to a full load.
      const promise = loadAndStart().finally(() => {
        startPromise = null;
      });
      startPromise = promise;
      return promise;
    },

    stop(): void {
      if (currentState.status === 'idle' || currentState.status === 'unavailable') {
        return;
      }
      stopRequested = true;
      loadAbort?.abort();
      stopInference();
      if (currentState.status === 'loading') {
        // loadAndStart()'s in-flight promise will observe stopRequested and
        // land on 'disabled' itself once it unwinds.
        return;
      }
      if (currentState.status === 'ready') {
        setState({ status: 'disabled' });
      }
    },

    dispose(): void {
      stopRequested = true;
      loadAbort?.abort();
      stopInference();
      try {
        mpDetector?.close();
      } catch {
        // Best-effort; we're dropping the reference regardless.
      }
      mpDetector = null;
      output.length = 0;
      setState({ status: 'idle' });
    },
  };
}
