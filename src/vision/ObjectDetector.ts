/**
 * PRIVACY — read this before touching anything below.
 *
 * This file feeds the live <video> element into an on-device MediaPipe
 * model. Inference itself runs in `detector.worker.ts` (a Web Worker), kept
 * off the main thread purely so a ~170ms inference call never blocks a
 * frame — the privacy boundary is unchanged by that split, just spread
 * across two files instead of one:
 *
 *   - this file's ONLY job with the video is `createImageBitmap(video, …)`,
 *     a lightweight, downscaled (~320px wide) snapshot — never a full-res
 *     copy, never drawn to a canvas, never read pixel-by-pixel here
 *   - that bitmap is TRANSFERRED (not copied — an actual ownership handoff,
 *     zero-copy) straight into the worker and this file never touches it
 *     again; the worker closes it immediately after inference, on every
 *     path, success or failure (see detector.worker.ts)
 *   - what comes back per tick is a handful of numbers (label, box score)
 *     written into a small object POOL that is reused forever and handed to
 *     `onDetections` — the array and its objects are mutated in place on
 *     the next tick, so nothing about a past frame is retained anywhere,
 *     and nothing is ever written to storage
 *   - the ONLY network calls in this file are the one-time, same-origin
 *     fetch of the detector model (`/vision/efficientdet_lite0_float16.tflite`)
 *     — self-hosted, never a CDN, never Google — which happens once at
 *     `start()`, never again during inference. The wasm runtime fetch
 *     happens inside the worker; see its own PRIVACY comment
 *   - `stop()` halts inference immediately; `dispose()` additionally tells
 *     the worker to release MediaPipe's own resources and then terminates
 *     the worker outright, dropping every reference including the model
 *
 * MediaPipe itself never runs on the main thread and is never imported
 * here — only the worker imports it, lazily, and only once this file
 * actually starts one. A user who never opts into vision never spawns the
 * worker and never downloads a byte of the wasm runtime or the model.
 *
 * If you are tempted to draw a video frame into a canvas, keep a detection
 * result beyond the tick that produced it, or add any network call outside
 * the one-time model fetch, stop — read the matching PRIVACY comment above
 * `DetectedKind`/`Detection` in src/types.ts first, and change the
 * user-facing copy before you change this.
 */

import { createDetectionTracker, type DetectionTracker } from './DetectionTracker.ts';
import type {
  ObjectDetector,
  ObjectDetectorOptions,
  DetectorState,
  DetectedKind,
  Detection,
} from '../types.ts';

// Type-only — erased entirely at compile time. Does NOT pull the worker or
// MediaPipe into this file or the main bundle.
import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  RawDetection,
} from './detector.worker.ts';

/** Self-hosted only — see scripts/fetch-vision-assets.mjs. Never a CDN. */
const WASM_BASE_PATH = '/vision/wasm';
const MODEL_PATH = '/vision/efficientdet_lite0_float16.tflite';
/**
 * Pre-bundled by scripts/build-vision-worker.mjs (run before both `npm run
 * dev` and `npm run build`) into a plain, classic (non-ESM) worker script —
 * not something Vite's own worker plugin builds. MediaPipe's wasm loader
 * only knows two ways to load its glue script: a `<script>` tag on the main
 * thread, or `importScripts()` inside a CLASSIC worker; calling
 * `importScripts` from a `type: 'module'` worker throws (module workers may
 * not use it) and sends MediaPipe down a broken fallback instead. Vite's DEV
 * SERVER always serves `new Worker(...)` scripts as ES modules — there's no
 * dev-server option for a true classic worker — so a normal Vite-bundled
 * worker would work in production but break under `npm run dev` specifically
 * (which is exactly how tools/video-sim exercises this code). Pre-bundling
 * ourselves with esbuild sidesteps that distinction entirely: the artifact
 * at this fixed path is identical, already-classic, in dev and prod alike.
 * Same directory, same gitignore, same "never precached" treatment (see
 * `globIgnores` in vite.config.ts) as the wasm runtime and the model.
 */
const WORKER_PATH = '/vision/detector-worker.js';

/**
 * Measured against real Italian motorway footage: a clearly-visible truck
 * scores 0.42-0.58, distant cars 0.25-0.33. 0.4 missed almost everything;
 * 0.3 catches the obvious stuff without letting noise through.
 */
const DEFAULT_SCORE_THRESHOLD = 0.3;
const DEFAULT_MAX_RESULTS = 8;

/**
 * The model's own input is 320x320 regardless of what we hand it, so
 * feeding it anything bigger is pure waste — every extra pixel is CPU/GPU
 * spent downscaling on top of what `createImageBitmap` already did for us.
 * Kept well under 4K/1080p/720p; this is the whole frame, downscaled,
 * before it ever reaches the worker.
 */
const TARGET_BITMAP_WIDTH = 320;

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

/**
 * COCO labels Glassy reacts to, mapped to the coarse `DetectedKind` the game
 * consumes. Everything else the model reports is discarded immediately.
 * Passed to the worker as `categoryAllowlist` too, so the model itself
 * filters early, before a single extra byte crosses back to this thread.
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
  'fire hydrant': 'sign',
};
const ALLOWED_LABELS = Object.keys(LABEL_TO_KIND);

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Picks the downscaled bitmap size handed to the worker: capped at
 * `TARGET_BITMAP_WIDTH` wide, aspect ratio preserved, never upscaled.
 */
function computeBitmapSize(videoWidth: number, videoHeight: number): { width: number; height: number } {
  if (videoWidth <= 0 || videoHeight <= 0) {
    return { width: TARGET_BITMAP_WIDTH, height: TARGET_BITMAP_WIDTH };
  }
  const width = Math.min(TARGET_BITMAP_WIDTH, videoWidth);
  const height = Math.max(1, Math.round((width * videoHeight) / videoWidth));
  return { width, height };
}

/** True only when this browser can actually run the worker pipeline at all.
 * If any of these are missing, detection degrades to `unavailable` rather
 * than falling back to blocking the main thread. */
function environmentSupportsWorkerPipeline(): boolean {
  return (
    typeof Worker !== 'undefined' &&
    typeof createImageBitmap === 'function' &&
    typeof WebAssembly !== 'undefined'
  );
}

export function createObjectDetector(options: ObjectDetectorOptions): ObjectDetector {
  const { video } = options;
  /**
   * There is one framing now — through the windscreen — where objects hold
   * still in frame. That both benefits from and can afford a faster rate:
   * inference runs on the CPU delegate in a worker and costs the main thread
   * nothing measurable.
   */
  const WINDSCREEN_SAMPLE_HZ = 6;
  function intervalForMode(): number {
    return 1000 / WINDSCREEN_SAMPLE_HZ;
  }
  let intervalMs = intervalForMode();

  const tracker: DetectionTracker = createDetectionTracker();
  let lastTrackUpdateMs = 0;

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

  let worker: Worker | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight = false;
  let lastTimestamp = -1;
  let requestCounter = 0;
  let pendingRequestId = -1;
  let pendingStartedAt = 0;
  let consecutiveErrors = 0;
  let slowStreak = 0;
  let warnedSlow = false;
  let warnedUnavailable = false;
  let warnedInferenceError = false;

  // Resolvers for the in-flight `init` round-trip, so `loadAndStart()` can
  // simply `await` the worker's `ready`/`init-error` response.
  let pendingInit: { resolve: () => void; reject: (err: Error) => void } | null = null;

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

  function postToWorker(w: Worker, message: MainToWorkerMessage, transfer: Transferable[] = []): void {
    w.postMessage(message, transfer);
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

  function terminateWorker(): void {
    worker?.terminate();
    worker = null;
  }

  function failPermanently(): void {
    clearTimer();
    inflight = false;
    terminateWorker();
    setState({ status: 'unavailable' });
  }

  function publishDetections(detections: readonly RawDetection[], bitmapWidth: number, bitmapHeight: number): void {
    output.length = 0;
    if (bitmapWidth === 0 || bitmapHeight === 0) {
      return;
    }

    for (const detection of detections) {
      if (output.length >= pool.length) break;
      const kind = LABEL_TO_KIND[detection.categoryName];
      if (!kind) continue;

      const slot = pool[output.length];
      if (!slot) break;
      slot.kind = kind;
      slot.x = clamp01((detection.originX + detection.width / 2) / bitmapWidth);
      slot.y = clamp01((detection.originY + detection.height / 2) / bitmapHeight);
      slot.width = clamp01(detection.width / bitmapWidth);
      slot.height = clamp01(detection.height / bitmapHeight);
      slot.score = detection.score;
      output.push(slot);
    }

    emitTracked();
  }

  /**
   * Fold the current detections through the tracker and hand the result out.
   * Both arrays are reused; consumers read them synchronously.
   */
  function emitTracked(): void {
    if (!options.onTrackedObjects) return;
    const now = performance.now();
    const dt = lastTrackUpdateMs === 0 ? intervalMs / 1000 : (now - lastTrackUpdateMs) / 1000;
    lastTrackUpdateMs = now;
    options.onTrackedObjects(tracker.update(output, dt));
  }

  function handleDetectResult(data: Extract<WorkerToMainMessage, { type: 'result' }>): void {
    if (data.requestId !== pendingRequestId) return; // stale — a later tick already moved on
    inflight = false;
    if (currentState.status !== 'ready') return; // stopped/disposed while this was in flight
    consecutiveErrors = 0;
    publishDetections(data.detections, data.bitmapWidth, data.bitmapHeight);
    trackTiming(performance.now() - pendingStartedAt);
  }

  function handleDetectError(data: Extract<WorkerToMainMessage, { type: 'detect-error' }>): void {
    if (data.requestId !== pendingRequestId) return; // stale
    inflight = false;
    consecutiveErrors++;
    warnOnce(
      () => (warnedInferenceError = true),
      warnedInferenceError,
      'inference threw inside the worker; will retry a few times before disabling detection for this session.',
      data.message,
    );
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      failPermanently();
    }
  }

  function handleWorkerMessage(data: WorkerToMainMessage): void {
    switch (data.type) {
      case 'ready':
        pendingInit?.resolve();
        pendingInit = null;
        break;
      case 'init-error':
        pendingInit?.reject(new Error(data.message));
        pendingInit = null;
        break;
      case 'result':
        handleDetectResult(data);
        break;
      case 'detect-error':
        handleDetectError(data);
        break;
      case 'disposed':
        // Handled by disposeWorker()'s own one-shot listener below; nothing
        // to do on the shared handler.
        break;
    }
  }

  function handleWorkerFatalError(message: string): void {
    warnOnce(() => (warnedUnavailable = true), warnedUnavailable, `vision worker failed: ${message}`);
    if (pendingInit) {
      pendingInit.reject(new Error(message));
      pendingInit = null;
      return;
    }
    failPermanently();
  }

  function createWorker(): Worker | null {
    try {
      // Deliberately a plain classic worker (no `{ type: 'module' }`) from a
      // fixed, pre-bundled static path — see the WORKER_PATH comment above.
      const w = new Worker(WORKER_PATH);
      w.onmessage = (event: MessageEvent): void => {
        handleWorkerMessage(event.data as WorkerToMainMessage);
      };
      w.onerror = (event: ErrorEvent): void => {
        handleWorkerFatalError(event.message || 'unknown worker error');
      };
      w.onmessageerror = (): void => {
        handleWorkerFatalError('a worker message could not be deserialised');
      };
      return w;
    } catch {
      return null;
    }
  }

  function initWorker(w: Worker, modelBytes: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      pendingInit = { resolve, reject };
      // `fetchModelWithProgress` always builds `modelBytes` via
      // `new Uint8Array(received)`, so `.buffer` is always a fresh, plain
      // ArrayBuffer (never a SharedArrayBuffer) — safe to assert and hand
      // over as a transferable.
      const buffer = modelBytes.buffer as ArrayBuffer;
      postToWorker(
        w,
        {
          type: 'init',
          wasmBasePath: WASM_BASE_PATH,
          modelBytes: buffer,
          scoreThreshold: DEFAULT_SCORE_THRESHOLD,
          maxResults,
          categoryAllowlist: ALLOWED_LABELS,
        },
        [buffer],
      );
    });
  }

  /** Fire-and-forget best-effort teardown: tells the worker to release
   * MediaPipe's own resources (a synchronous `.close()` call the worker can
   * make instantly), then terminates the worker unconditionally shortly
   * after regardless of whether it acknowledged — a worker that never
   * responds (crashed, wedged) must not leak forever. `dispose()` itself
   * stays synchronous per the frozen contract in types.ts; this runs after
   * it returns. */
  function disposeWorker(w: Worker): void {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      w.terminate();
    };
    w.addEventListener(
      'message',
      (event: MessageEvent) => {
        if ((event.data as WorkerToMainMessage).type === 'disposed') finish();
      },
      { once: true },
    );
    try {
      postToWorker(w, { type: 'dispose' });
    } catch {
      finish();
      return;
    }
    setTimeout(finish, 250);
  }

  function runInference(): void {
    if (inflight) return; // previous tick hasn't finished — never queue up
    if (document.hidden) return;
    if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return;
    if (!worker) return;

    const now = Math.round(performance.now());
    if (now <= lastTimestamp) return; // MediaPipe requires strictly increasing timestamps
    lastTimestamp = now;

    const { width, height } = computeBitmapSize(video.videoWidth, video.videoHeight);
    const requestId = ++requestCounter;
    inflight = true;
    pendingRequestId = requestId;
    pendingStartedAt = performance.now();

    // 'medium', not 'low': MediaPipe resizes again internally to its own
    // fixed input size regardless of what we hand it, so THIS resize is the
    // only chance to preserve detail before that — a cheap-and-blurry first
    // pass here measurably cost small/distant detections (person, bicycle)
    // in testing, for no measurable main-thread time saved at this target
    // size (~320px wide).
    createImageBitmap(video, { resizeWidth: width, resizeHeight: height, resizeQuality: 'medium' })
      .then((bitmap) => {
        // Stale by the time the (async) capture finished — a stop()/resume()
        // raced ahead of us, or the worker was torn down. Drop it, never
        // queue it up behind whatever's current now.
        if (!worker || requestId !== pendingRequestId) {
          bitmap.close();
          if (requestId === pendingRequestId) inflight = false;
          return;
        }
        postToWorker(worker, { type: 'detect', requestId, bitmap, timestamp: now }, [bitmap]);
      })
      .catch((err: unknown) => {
        if (requestId !== pendingRequestId) return;
        inflight = false;
        consecutiveErrors++;
        warnOnce(
          () => (warnedInferenceError = true),
          warnedInferenceError,
          'failed to capture a frame for detection; will retry a few times before disabling detection for this session.',
          err,
        );
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          failPermanently();
        }
      });
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
    if (!environmentSupportsWorkerPipeline()) {
      warnOnce(
        () => (warnedUnavailable = true),
        warnedUnavailable,
        'this browser lacks Worker/createImageBitmap/WebAssembly support needed for on-device detection.',
      );
      setState({ status: 'unavailable' });
      return currentState;
    }

    stopRequested = false;
    loadAbort = new AbortController();
    setState({ status: 'loading' });

    try {
      const modelBytes = await fetchModelWithProgress(loadAbort.signal);

      if (stopRequested) {
        setState({ status: 'disabled' });
        return currentState;
      }

      if (!worker) {
        worker = createWorker();
        if (!worker) {
          warnOnce(() => (warnedUnavailable = true), warnedUnavailable, 'failed to start the detection worker.');
          setState({ status: 'unavailable' });
          return currentState;
        }
      }

      await initWorker(worker, modelBytes);

      if (stopRequested) {
        setState({ status: 'disabled' });
        return currentState;
      }

      consecutiveErrors = 0;
      slowStreak = 0;
      intervalMs = intervalForMode();
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
      terminateWorker();
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
      if (currentState.status === 'disabled' && worker) {
        // Model already loaded in the worker — instant resume, no re-fetch.
        stopRequested = false;
        consecutiveErrors = 0;
        slowStreak = 0;
        intervalMs = intervalForMode();
        lastTimestamp = -1;
        setState({ status: 'ready' });
        scheduleNext();
        return Promise.resolve(currentState);
      }
      // idle, unavailable (deliberate retry — e.g. the network came back;
      // warnedUnavailable already guards against repeat warnings), or
      // disabled-without-a-loaded-worker: all fall through to a full load.
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
      pendingInit?.reject(new Error('disposed'));
      pendingInit = null;
      if (worker) {
        disposeWorker(worker);
        worker = null;
      }
      output.length = 0;
      setState({ status: 'idle' });
    },
  };
}
