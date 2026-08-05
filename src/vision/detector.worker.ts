/**
 * PRIVACY — read this before touching anything below.
 *
 * This worker exists purely to keep MediaPipe's ~170ms-per-call inference off
 * the main thread. It changes WHERE the work happens, not WHAT happens to a
 * frame. Per detect request it receives exactly one `ImageBitmap` — already
 * downscaled to ~320px wide by the caller — runs it through the on-device
 * `detectForVideo` call, and posts back a handful of numbers (label, box,
 * score). That is the entire extent of it:
 *
 *   - inference runs locally, in this worker, on-device — there is no
 *     backend and no code path that could send a frame, a crop or a tensor
 *     anywhere
 *   - the bitmap is NEVER drawn to a canvas, never read pixel-by-pixel here,
 *     never `toDataURL`/`toBlob`'d — it is handed straight to MediaPipe and
 *     `close()`d immediately after, on both the success and the error path,
 *     so it is released the instant this tick is done with it
 *   - nothing about a bitmap, a detection or a timestamp survives past the
 *     single message that carried it in and the single message that carries
 *     the result back out — this file holds no history, no cache, no queue
 *   - the ONLY network calls this worker ever makes are the one-time,
 *     same-origin fetches of the wasm runtime (`/vision/wasm/*`) that
 *     `FilesetResolver` performs — self-hosted, never a CDN, never Google.
 *     The model itself isn't even fetched here: the main thread downloads it
 *     (with honest progress reporting) and transfers the bytes in
 *   - `dispose` calls MediaPipe's own `.close()` and drops the detector
 *     reference; the main thread then terminates this worker outright,
 *     which reclaims everything else
 *
 * This worker script — MediaPipe included — is only ever instantiated by
 * `new Worker(...)` in ObjectDetector.ts, which itself only happens once the
 * user has opted into vision and pressed start; nothing in this file runs,
 * and no byte of it is even fetched, before that. The wasm runtime fetch
 * inside `handleInit` below only fires once this worker has actually been
 * spun up for that reason. See the matching PRIVACY comment at the top of
 * ObjectDetector.ts for the main-thread half of this boundary, and the one
 * above `DetectedKind`/`Detection` in src/types.ts.
 *
 * If you are tempted to draw a bitmap into a canvas, keep a detection result
 * beyond the tick that produced it, or add any network call outside the
 * one-time wasm fetch, stop and change the user-facing privacy copy first.
 */

// A real (non-type-only) import: this worker's whole reason to exist is to
// run MediaPipe off the main thread, so — unlike ObjectDetector.ts — it is
// expected to pull MediaPipe in. It is still lazy in the sense that matters
// (see the PRIVACY comment above): this file isn't bundled by Vite at all —
// scripts/build-vision-worker.mjs pre-bundles it with esbuild into a plain
// classic script at public/vision/detector-worker.js, and THAT file is only
// ever fetched by `new Worker(...)` in ObjectDetector.ts, after a user opts
// into vision and presses start. It's a static (not dynamic) import here
// because esbuild bundles everything into one file regardless — there's no
// separate chunk to lazily split off within this file itself; the laziness
// that matters is the worker never being instantiated at all until asked for.
import * as mediapipe from '@mediapipe/tasks-vision';
import type {
  ObjectDetector as MpObjectDetector,
  ObjectDetectorResult as MpDetectionResult,
  Category as MpCategory,
} from '@mediapipe/tasks-vision';

/* ------------------------------------------------------------------ */
/* Worker <-> main-thread protocol. Type-only-imported by               */
/* ObjectDetector.ts, so this is the single source of truth for the     */
/* message shapes on both sides.                                        */
/* ------------------------------------------------------------------ */

export interface WorkerInitMessage {
  type: 'init';
  wasmBasePath: string;
  /** Transferred, not copied. */
  modelBytes: ArrayBuffer;
  scoreThreshold: number;
  maxResults: number;
  categoryAllowlist: string[];
}

export interface WorkerDetectMessage {
  type: 'detect';
  requestId: number;
  /** Transferred, not copied. Closed by this worker after use, always. */
  bitmap: ImageBitmap;
  timestamp: number;
}

export interface WorkerDisposeMessage {
  type: 'dispose';
}

export type MainToWorkerMessage = WorkerInitMessage | WorkerDetectMessage | WorkerDisposeMessage;

/** A single detection, flattened out of MediaPipe's own result shape so the
 * main thread never needs MediaPipe's types (which don't structured-clone
 * anyway — plain data only crosses this boundary). */
export interface RawDetection {
  categoryName: string;
  score: number;
  originX: number;
  originY: number;
  width: number;
  height: number;
}

export interface WorkerReadyMessage {
  type: 'ready';
}

export interface WorkerInitErrorMessage {
  type: 'init-error';
  message: string;
}

export interface WorkerResultMessage {
  type: 'result';
  requestId: number;
  detections: RawDetection[];
  /** The bitmap's own dimensions — detections are normalised against these,
   * not the original video frame, since MediaPipe's box coordinates are in
   * the space of whatever image it was actually handed. */
  bitmapWidth: number;
  bitmapHeight: number;
}

export interface WorkerDetectErrorMessage {
  type: 'detect-error';
  requestId: number;
  message: string;
}

export interface WorkerDisposedMessage {
  type: 'disposed';
}

export type WorkerToMainMessage =
  | WorkerReadyMessage
  | WorkerInitErrorMessage
  | WorkerResultMessage
  | WorkerDetectErrorMessage
  | WorkerDisposedMessage;

/* ------------------------------------------------------------------ */
/* Worker-scope plumbing.                                               */
/*                                                                       */
/* This file is compiled under the project's single tsconfig, whose lib */
/* array is DOM-only (no "webworker" — TS doesn't allow both DOM and     */
/* WebWorker libs in one program, and this project deliberately runs     */
/* one tsconfig for everything). `self`'s ambient DOM type is `Window &  */
/* typeof globalThis`, whose `postMessage`/`onmessage` overloads don't    */
/* match a dedicated worker's simpler 2-arg shape. Rather than touch the  */
/* shared tsconfig, this narrow cast gives just this file the few         */
/* members it actually needs, correctly typed for how they're really     */
/* used here.                                                             */
/* ------------------------------------------------------------------ */
interface DetectorWorkerScope {
  postMessage(message: WorkerToMainMessage, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<MainToWorkerMessage>) => void) | null;
  fetch: typeof globalThis.fetch;
  readonly location: { readonly href: string };
}
const workerScope = self as unknown as DetectorWorkerScope;

function postToMain(message: WorkerToMainMessage, transfer: Transferable[] = []): void {
  workerScope.postMessage(message, transfer);
}

/**
 * PRIVACY — MediaPipe's Tasks Vision runtime has its OWN built-in usage
 * telemetry compiled into the bundle: it periodically `fetch()`s aggregated,
 * non-frame usage stats to `https://odml.pa.googleapis.com/v1/log`, with no
 * public JS option to turn it off. A Worker has its own global scope, so the
 * equivalent block installed on `window.fetch` in ObjectDetector.ts does NOT
 * carry over here — it has to be reinstalled against THIS scope's `fetch`,
 * or the telemetry call would slip out through the worker instead. (The
 * production CSP's `connect-src 'self'` would also block it, but this is
 * belt-and-braces, not reliance on that alone.) Installed once, lazily,
 * right before this worker ever calls into MediaPipe.
 */
const BLOCKED_TELEMETRY_HOST_SUFFIX = '.pa.googleapis.com';
let telemetryBlockInstalled = false;

function installTelemetryBlock(): void {
  if (telemetryBlockInstalled) return;
  telemetryBlockInstalled = true;

  const originalFetch = workerScope.fetch.bind(workerScope);
  workerScope.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let host = '';
    try {
      const url = typeof input === 'string' || input instanceof URL ? input : input.url;
      host = new URL(url, workerScope.location.href).host;
    } catch {
      // Unparseable input — let the real fetch deal with (and reject) it.
    }
    if (host === 'odml.pa.googleapis.com' || host.endsWith(BLOCKED_TELEMETRY_HOST_SUFFIX)) {
      throw new DOMException('blocked: MediaPipe telemetry is disabled in Glassy', 'AbortError');
    }
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;
}

/* ------------------------------------------------------------------ */
/* Detector lifecycle.                                                  */
/* ------------------------------------------------------------------ */

let mpDetector: MpObjectDetector | null = null;

async function handleInit(msg: WorkerInitMessage): Promise<void> {
  installTelemetryBlock();
  try {
    const fileset = await mediapipe.FilesetResolver.forVisionTasks(msg.wasmBasePath);
    const modelAssetBuffer = new Uint8Array(msg.modelBytes);

    const shared = {
      runningMode: 'VIDEO' as const,
      scoreThreshold: msg.scoreThreshold,
      maxResults: msg.maxResults,
      categoryAllowlist: msg.categoryAllowlist,
    };

    /**
     * CPU first, deliberately — this is the opposite of the usual advice and
     * it is measured, not assumed.
     *
     * With the GPU delegate the driver logs "GPU stall due to ReadPixels" and
     * frame times spike to ~150ms roughly three times a second: MediaPipe's
     * readback contends with Pixi's own WebGL renderer for the same GPU
     * queue, and moving inference to a worker does not help because the
     * contention is on the device, not the JS thread. Same worker code with
     * the CPU delegate: zero frames over 33ms, median unchanged at 8.3ms.
     *
     * Glassy is a game rendering over live video — a smooth 60fps matters far
     * more than detector throughput at 3Hz. GPU is kept only as a fallback in
     * case a platform has no usable CPU path.
     */
    let detector: MpObjectDetector;
    try {
      detector = await mediapipe.ObjectDetector.createFromOptions(fileset, {
        ...shared,
        baseOptions: { modelAssetBuffer, delegate: 'CPU' },
      });
    } catch (cpuErr) {
      console.warn('[detector.worker] CPU delegate unavailable, falling back to GPU.', cpuErr);
      detector = await mediapipe.ObjectDetector.createFromOptions(fileset, {
        ...shared,
        baseOptions: { modelAssetBuffer, delegate: 'GPU' },
      });
    }

    mpDetector = detector;
    postToMain({ type: 'ready' });
  } catch (err) {
    postToMain({ type: 'init-error', message: err instanceof Error ? err.message : String(err) });
  }
}

function handleDetect(msg: WorkerDetectMessage): void {
  const { requestId, bitmap, timestamp } = msg;

  if (!mpDetector) {
    bitmap.close();
    postToMain({ type: 'detect-error', requestId, message: 'detector not initialised' });
    return;
  }

  try {
    const result: MpDetectionResult = mpDetector.detectForVideo(bitmap, timestamp);
    const detections: RawDetection[] = [];
    for (const detection of result.detections) {
      const box = detection.boundingBox;
      const top: MpCategory | undefined = detection.categories[0];
      if (!box || !top) continue;
      detections.push({
        categoryName: top.categoryName,
        score: top.score,
        originX: box.originX,
        originY: box.originY,
        width: box.width,
        height: box.height,
      });
    }
    postToMain({
      type: 'result',
      requestId,
      detections,
      bitmapWidth: bitmap.width,
      bitmapHeight: bitmap.height,
    });
  } catch (err) {
    postToMain({
      type: 'detect-error',
      requestId,
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    // Always — success or failure. A leaked ImageBitmap is a real memory
    // leak, and this is the only place in the worker that ever sees one.
    bitmap.close();
  }
}

function handleDispose(): void {
  try {
    mpDetector?.close();
  } catch {
    // Already broken; nothing more we can do about it. The main thread
    // terminates this worker outright regardless, which reclaims the rest.
  }
  mpDetector = null;
  postToMain({ type: 'disposed' });
}

workerScope.onmessage = (event: MessageEvent<MainToWorkerMessage>): void => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      void handleInit(msg);
      break;
    case 'detect':
      handleDetect(msg);
      break;
    case 'dispose':
      handleDispose();
      break;
  }
};
