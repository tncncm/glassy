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
 *     `onTrackedObjects` — the array and its objects are mutated in place on
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
 * As of the ego-motion gate (see CarriagewayFilter.ts), this file ALSO owns
 * one `OpticalFlow` instance — the fourth place in Glassy that reads camera
 * pixels, after SceneAnalyser, SurfaceProfileFinder and this file's own
 * bitmap capture. It is used ONLY for `egoMotion` (a magnitude and a
 * confidence number, nothing else) so CarriagewayFilter knows whether to
 * apply its road-specific reasoning at all this tick; its `candidates`/
 * `focusOfExpansion` outputs are never read here. Same discipline, same
 * discard-per-tick guarantee — see OpticalFlow.ts's own PRIVACY comment for
 * the full accounting of what it reads and drops.
 *
 * If you are tempted to draw a video frame into a canvas, keep a detection
 * result beyond the tick that produced it, or add any network call outside
 * the one-time model fetch, stop — read the matching PRIVACY comment above
 * `DetectedKind`/`Detection` in src/types.ts first, and change the
 * user-facing copy before you change this.
 */

import { createDetectionTracker, type DetectionTracker } from './DetectionTracker.ts';
import { createSurfaceProfileFinder, type SurfaceFlowDebug, type SurfaceProfileFinder } from './SurfaceProfileFinder.ts';
import { createSceneAnalyser } from './SceneAnalyser.ts';
import { createCarriagewayFilter, type CarriagewayFilter, type CarriagewayRejectReason } from './CarriagewayFilter.ts';
import { createOpticalFlow, type EgoMotion, type OpticalFlow } from './OpticalFlow.ts';
import type {
  ObjectDetector,
  ObjectDetectorOptions,
  DetectorState,
  DetectedKind,
  Detection,
  SceneAnalyser,
  TrackedObject,
} from '../types.ts';

/**
 * `ObjectDetectorOptions` (types.ts, frozen — see CLAUDE.md) has no slot for
 * a carriageway-filter debug hook; adding one there would widen a contract
 * every other layer depends on for a diagnostic only tools/video-sim needs.
 * Instead: an optional extra property, read here via a local, non-exported
 * type that widens the caller's options object structurally. A plain JS
 * caller (tools/video-sim/index.html, not type-checked) can pass it freely;
 * App.ts, built against the real `ObjectDetectorOptions`, simply never has
 * it and this is always a no-op for production. Never fires anything a real
 * caller depends on — purely additive, purely diagnostic.
 */
interface ObjectDetectorDebugOptions {
  /** Motion-mask diagnostics — what FlowSupport decided per box this tick,
   * plus its cell grid, so the harness can draw the mask instead of
   * reasoning about it. Never set by App.ts. */
  onSurfaceFlowDebug?: (debug: SurfaceFlowDebug) => void;
  /** Diagnostic only: run SurfaceProfileFinder's pre-mask algorithm, so the
   * harness can A/B the same build against itself. Never set by App.ts. */
  disableFlowMask?: boolean;
  onCarriagewayDebug?: (
    kept: readonly TrackedObject[],
    rejected: readonly TrackedObject[],
    rejectedReasons: readonly CarriagewayRejectReason[],
    horizonY: number | null,
  ) => void;
  /** Diagnostic only: the ego-motion sample CarriagewayFilter's road-specific
   * reasoning is gated on this tick, whether the gate judged us to be
   * moving, and OpticalFlow's own measured per-sample cost (ms) — the main-
   * thread cost this feature actually adds. Lets the harness measure/
   * calibrate the gate against real and synthetic footage instead of
   * trusting the thresholds by eye. Never set by App.ts. */
  onEgoMotionDebug?: (ego: EgoMotion, isMoving: boolean, costMs: number) => void;
  /** Diagnostic only: every accepted-but-unfiltered `Detection` this tick
   * (post-allowlist, pre-tracking, already collapsed to `kind`), so the
   * harness can report a true detections/sec rate. Never set by App.ts —
   * the game only ever wants `onTrackedObjects`. */
  onRawDetections?: (detections: readonly Detection[]) => void;
  /** Diagnostic only: the worker's raw per-tick result BEFORE it collapses
   * to `kind` — still carries the original COCO `categoryName` (`umbrella`,
   * `chair`, …) — so the harness can confirm exactly which labels are
   * firing, not just which of the three coarse buckets they landed in.
   * Never set by App.ts. */
  onRawLabelsDebug?: (detections: readonly RawDetection[]) => void;
  /** Diagnostic only: overrides the model fetched at `start()`, so the
   * harness can A/B EfficientDet-Lite0 against a differently-sized model
   * without changing what App.ts ships. Never set by App.ts. */
  modelPath?: string;
  /** Diagnostic only: wall-clock round-trip of one detect request (capture +
   * postMessage + worker inference + postMessage back), milliseconds — the
   * number that actually matters for "does this model fit the sample
   * budget", vs trusting a vendor-published figure. Never set by App.ts. */
  onInferenceCostDebug?: (elapsedMs: number) => void;
}

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
 *
 * WIDENED FROM "TRAFFIC" TO "ANYTHING YOU COULD LAND ON". Glassy started as
 * a windscreen game and the allowlist only ever held road classes, but the
 * game is really "hop across the real objects in front of you" — a passenger
 * on a beach asking to jump between parasols is the same game as a passenger
 * in a car jumping onto the car ahead. EfficientDet-Lite0 already reports
 * `umbrella`, `chair`, `bench`, `couch`, `boat`, `surfboard`, `dining table`,
 * `potted plant`, `bed`, `suitcase` — COCO classes we were simply throwing
 * away. Nothing about the model changed; only what we keep from it did.
 *
 * `DetectedKind` (src/types.ts, frozen) still only has three buckets, and its
 * own doc comment describes them by original example ("car/truck/bus/
 * motorcycle → a hazard rolls in", etc). Nothing downstream actually
 * branches on `kind` for gameplay — grepped across src/game, src/ui and
 * src/app: the only real dependency on it is inside THIS layer
 * (SurfaceProfileFinder profiles the silhouette of `'vehicle'`-kind objects
 * only; CarriagewayFilter's road-geometry/motion reasoning applies to
 * `'vehicle'`-kind objects only, and is now gated on ego-motion — see
 * CarriagewayFilter.ts). So the mapping below is chosen for what it turns ON
 * in THIS layer, not for label accuracy:
 *
 *   - 'vehicle': anything with a top wide/flat/solid enough to plausibly
 *     land ON — existing road vehicles, plus every landable COCO class the
 *     brief called out (parasols, chairs, benches, couches, boats,
 *     surfboards, tables, planters, beds, suitcases). These get the full
 *     treatment: SurfaceProfileFinder traces their actual silhouette instead
 *     of a flat box (a parasol canopy's dome, a couch's armrests, a table's
 *     edge all benefit from the same bonnet/windscreen/roof-style scan a car
 *     gets), and CarriagewayFilter's road-specific checks apply — but ONLY
 *     while ego-motion says we're actually travelling through the world;
 *     stationary, that filter is a no-op (see CarriagewayFilter.ts) so a
 *     beach chair is never held to a "same carriageway" standard that was
 *     only ever meaningful for a car on a road.
 *   - 'person': unchanged — a person or a bicycle, a collectible, never a
 *     landing surface.
 *   - 'sign': unchanged — narrow, human-scale-or-smaller street furniture
 *     (traffic light, stop sign, parking meter, fire hydrant) nobody would
 *     try to land on; flat-profiled and never carriageway-filtered, same as
 *     before this change.
 *
 * EXCLUDED, deliberately, and why: food and place-settings (banana, pizza,
 * fork, cup, wine glass, bowl, …) — never a solid obstacle, and a fork
 * misdetected mid-frame would be a bizarre platform; small handheld/personal
 * items (cell phone, remote, backpack, handbag, tie, book, scissors, teddy
 * bear, toothbrush, hair drier, vase, clock, …) — too small to plausibly
 * land on and too easy to false-positive on skin/fabric texture; sports gear
 * (frisbee, kite, skis, snowboard, skateboard, tennis racket, baseball
 * bat/glove, sports ball) — small, fast-moving, not "solid obstacle"-shaped;
 * kitchen/bathroom appliances (toilet, microwave, oven, toaster, sink,
 * fridge, TV, laptop, mouse, keyboard) — never appear outdoors in a way that
 * would read as a real obstacle; animals (bird, cat, dog, horse, sheep, cow,
 * elephant, bear, zebra, giraffe) — not landable, not a person, and mapping
 * them to any of the three buckets would misrepresent what they are; and
 * `airplane` — technically "solid", never at ground level where a landing
 * surface would make sense.
 */
const LABEL_TO_KIND: Readonly<Record<string, DetectedKind>> = {
  // Big, solid, plausibly-landable — road vehicles and everyday furniture/
  // structure alike. See the module comment above for why these all share
  // one bucket regardless of literal "vehicle-ness".
  car: 'vehicle',
  truck: 'vehicle',
  bus: 'vehicle',
  motorcycle: 'vehicle',
  train: 'vehicle',
  boat: 'vehicle',
  bench: 'vehicle',
  chair: 'vehicle',
  couch: 'vehicle',
  bed: 'vehicle',
  'dining table': 'vehicle',
  umbrella: 'vehicle', // beach parasol — the motivating case
  surfboard: 'vehicle',
  suitcase: 'vehicle',
  'potted plant': 'vehicle', // planter

  // People — a collectible, never a landing surface.
  person: 'person',
  bicycle: 'person',

  // Narrow, human-scale-or-smaller street furniture — not landable.
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
  const debugOptions = options as ObjectDetectorOptions & ObjectDetectorDebugOptions;
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
  const surfaceFinder: SurfaceProfileFinder = createSurfaceProfileFinder({
    disableFlowMask: debugOptions.disableFlowMask === true,
  });
  /**
   * ObjectDetector owns its own SceneAnalyser instance rather than taking
   * the horizon as an option — `ObjectDetectorOptions` is frozen (see
   * CLAUDE.md) and today's only consumer of the horizon is the game, wired
   * up independently in App.ts. This pays for a second tiny (48x39, see
   * SceneAnalyser's own PRIVACY comment) canvas read at the same ~6Hz the
   * game's own analyser already runs at — negligible next to
   * SurfaceProfileFinder's 320x180 sample, and it keeps the vision layer's
   * carriageway filtering self-contained instead of threading a cross-layer
   * dependency through App.ts for one number.
   */
  const laneAnalyser: SceneAnalyser = createSceneAnalyser({ video });
  const carriagewayFilter: CarriagewayFilter = createCarriagewayFilter();
  /**
   * Ego-motion only — see the file-header PRIVACY note and CarriagewayFilter's
   * own comment for why. `candidates`/`focusOfExpansion` are never read here;
   * this exists purely so CarriagewayFilter knows whether we are actually
   * travelling through the world this tick before it applies any
   * road-specific reasoning to a `'vehicle'`-kind object. Same start/stop
   * lifecycle as `laneAnalyser` — both are cheap, both are useless (and
   * switched off) whenever the detector itself isn't running.
   *
   * `sampleHz: 2`, well under OpticalFlow's own 5Hz default: the gate only
   * needs a slowly-changing, hysteresis-smoothed "are we moving at all"
   * verdict, not a fresh number every detector tick, and each sample is a
   * synchronous main-thread block-matching pass — measured on desktop
   * Chromium at ~2ms median, ~6ms worst-case per sample (see the report;
   * unverified on-device, and iPhone JSC can run 2-4x slower on tight scalar
   * loops per this project's own performance notes). Halving the rate from
   * the module default roughly halves the time this feature spends on the
   * main thread for the same worst-case per-sample cost.
   */
  const egoFlow: OpticalFlow = createOpticalFlow({ video, sampleHz: 2 });
  let lastTrackUpdateMs = 0;

  let currentState: DetectorState = { status: 'idle' };
  function setState(next: DetectorState): void {
    currentState = next;
    options.onStateChange?.(next);
  }

  // Fixed-size pool, sized once from the constant default (never resized by
  // an untrusted option value) — this is the only allocation of Detection
  // objects for the life of the controller. `output` is the single array
  // identity ever handed to `emitTracked`/`onRawDetections`; it is cleared
  // and refilled with references into `pool`, never replaced.
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

    debugOptions.onRawDetections?.(output);
    emitTracked();
  }

  /**
   * Fold the current detections through the tracker and hand the result out.
   * Both arrays are reused; consumers read them synchronously.
   */
  function emitTracked(): void {
    if (
      !options.onTrackedObjects &&
      !debugOptions.onCarriagewayDebug &&
      !debugOptions.onSurfaceFlowDebug &&
      !debugOptions.onEgoMotionDebug
    ) {
      return;
    }
    const now = performance.now();
    const dt = lastTrackUpdateMs === 0 ? intervalMs / 1000 : (now - lastTrackUpdateMs) / 1000;
    lastTrackUpdateMs = now;
    const trackedObjects = tracker.update(output, dt);
    // Refine the loose detection box down to the actual vehicle silhouette
    // (flat row + per-column profile) in place, before handing objects out.
    // Falls back to the box's own top edge and sides (already written by
    // the tracker) on any failure.
    surfaceFinder.refine(video, trackedObjects, dt);
    debugOptions.onSurfaceFlowDebug?.(surfaceFinder.flowDebug);
    // Keep only 'vehicle'-kind objects plausibly travelling with us on our
    // own carriageway (see CarriagewayFilter.ts for the full reasoning).
    // person/sign objects pass through untouched. Falls back to the
    // unfiltered list on any internal failure — a cluttered world beats an
    // empty one. Gated on ego-motion: CarriagewayFilter's road-specific
    // reasoning is only meaningful while we're actually travelling through
    // the world (a car), and is a deliberate no-op standing still (a beach) —
    // see CarriagewayFilter.ts.
    const horizonY = laneAnalyser.horizon.y;
    const ego = egoFlow.egoMotion;
    const kept = carriagewayFilter.filter(trackedObjects, horizonY, dt, ego);

    debugOptions.onCarriagewayDebug?.(kept, carriagewayFilter.rejected, carriagewayFilter.rejectedReasons, horizonY);
    debugOptions.onEgoMotionDebug?.(ego, carriagewayFilter.isMoving, egoFlow.lastSampleCostMs);
    options.onTrackedObjects?.(kept);
  }

  function handleDetectResult(data: Extract<WorkerToMainMessage, { type: 'result' }>): void {
    if (data.requestId !== pendingRequestId) return; // stale — a later tick already moved on
    inflight = false;
    if (currentState.status !== 'ready') return; // stopped/disposed while this was in flight
    consecutiveErrors = 0;
    debugOptions.onRawLabelsDebug?.(data.detections);
    publishDetections(data.detections, data.bitmapWidth, data.bitmapHeight);
    const elapsedMs = performance.now() - pendingStartedAt;
    debugOptions.onInferenceCostDebug?.(elapsedMs);
    trackTiming(elapsedMs);
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
    // `modelPath` is diagnostic-only (see ObjectDetectorDebugOptions) — a
    // real caller (App.ts) built against the frozen ObjectDetectorOptions
    // never sets it, so this is always MODEL_PATH in production.
    const response = await fetch(debugOptions.modelPath ?? MODEL_PATH, { signal });
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
      laneAnalyser.start();
      egoFlow.start();
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
        laneAnalyser.start();
        egoFlow.start();
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
      laneAnalyser.stop();
      egoFlow.stop();
      carriagewayFilter.reset();
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
      surfaceFinder.stop();
      laneAnalyser.stop();
      egoFlow.stop();
      carriagewayFilter.reset();
      setState({ status: 'idle' });
    },
  };
}
