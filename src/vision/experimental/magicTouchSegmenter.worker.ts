/**
 * EXPERIMENTAL / RESEARCH PROTOTYPE — not part of the shipped app.
 *
 * PRIVACY — same discipline as detector.worker.ts, read that file's PRIVACY
 * comment first; this is the same shape of boundary applied to a second
 * model:
 *
 *   - inference runs locally, on-device, in this worker — no backend exists
 *   - a `segment` message carries exactly one `ImageBitmap`, transferred (not
 *     copied); it is handed straight to MediaPipe and `close()`d immediately
 *     after, success or failure, every time
 *   - the reply carries a mask (a Float32Array of per-pixel confidence) and a
 *     handful of numbers — nothing that identifies a moment in time beyond
 *     "the frame just analysed", and this worker keeps no history/queue
 *   - the ONLY network call this worker makes is the one-time, same-origin
 *     wasm fetch — the SAME already-cached runtime detector.worker.ts uses
 *     (public/vision/wasm/), never re-fetched, never a CDN. The model bytes
 *     are transferred in from the main thread exactly like the detector's.
 *
 * This worker is never instantiated by any shipped code path: only
 * tools/video-sim/experimental/*.html (a dev-only Playwright harness) ever
 * constructs it, and only after a developer has manually run
 * scripts/fetch-experimental-segmenter-assets.mjs. src/app, src/game and the
 * real ObjectDetector never import anything under src/vision/experimental/.
 *
 * WHY A SEPARATE WORKER FROM detector.worker.ts, NOT ONE WORKER RUNNING TWO
 * MODELS: the whole point of this prototype is to answer "can two models be
 * resident and running at once" — EfficientDet in its own worker (the real,
 * shipped one) plus this one. A single shared worker would beg the question
 * by construction.
 */

// eslint-disable-next-line
import * as mediapipe from '@mediapipe/tasks-vision';
import type {
  InteractiveSegmenterLegacy as MpInteractiveSegmenterLegacy,
  RegionOfInterest,
} from '@mediapipe/tasks-vision';

/* ------------------------------------------------------------------ */
/* Worker <-> main-thread protocol — mirrors detector.worker.ts's shape */
/* so the two are easy to compare side by side.                         */
/* ------------------------------------------------------------------ */

export interface SegWorkerInitMessage {
  type: 'init';
  wasmBasePath: string;
  /**
   * A same-origin URL, NOT bytes — unlike detector.worker.ts. MEASURED
   * (see probe.html/the report): `InteractiveSegmenterLegacy.
   * createFromOptions` with `baseOptions.modelAssetBuffer` throws
   * `INVALID_ARGUMENT: ExternalFile must specify at least one of
   * 'file_content', 'file_name', ...` in @mediapipe/tasks-vision@1.0.1 — the
   * graph this task builds (internally `image_segmenter_graph.cc`) never
   * wires the buffer through, even on a plain main-thread call with no
   * worker/transfer involved. `modelAssetPath` works. This worker therefore
   * lets MediaPipe do its own fetch of this same-origin, self-hosted path —
   * still never a CDN, still same privacy posture — but it means this file,
   * unlike ObjectDetector.ts, cannot offer byte-level download progress for
   * this asset; see the report for what that costs a real integration.
   */
  modelPath: string;
  /** CPU first, exactly like the shipped detector — see the delegate choice
   * comment in handleInit below. Exposed here (not hardcoded) so the harness
   * can A/B CPU vs GPU cost honestly instead of assuming. */
  delegate: 'CPU' | 'GPU';
}

export interface SegWorkerSegmentMessage {
  type: 'segment';
  requestId: number;
  /** Transferred, not copied. Closed by this worker after use, always. */
  bitmap: ImageBitmap;
  /** Normalised (0..1) point prompt — the box centre the caller wants
   * segmented. */
  x: number;
  y: number;
}

export interface SegWorkerDisposeMessage {
  type: 'dispose';
}

export type SegMainToWorkerMessage = SegWorkerInitMessage | SegWorkerSegmentMessage | SegWorkerDisposeMessage;

export interface SegWorkerReadyMessage {
  type: 'ready';
}

export interface SegWorkerInitErrorMessage {
  type: 'init-error';
  message: string;
}

export interface SegWorkerResultMessage {
  type: 'result';
  requestId: number;
  /** Per-pixel confidence, 0..1, row-major, `maskWidth * maskHeight` long.
   * Transferred out (its buffer), not copied. `null` when the model
   * produced no confidence mask at all (shouldn't happen with
   * outputConfidenceMasks, kept as an honest possibility). */
  mask: Float32Array | null;
  maskWidth: number;
  maskHeight: number;
  qualityScore: number;
  /** Wall-clock cost of the `segment()` call itself, measured in this
   * worker — excludes postMessage/structured-clone overhead, which the main
   * thread measures separately (round trip). */
  inferenceMs: number;
}

export interface SegWorkerSegmentErrorMessage {
  type: 'segment-error';
  requestId: number;
  message: string;
}

export interface SegWorkerDisposedMessage {
  type: 'disposed';
}

export type SegWorkerToMainMessage =
  | SegWorkerReadyMessage
  | SegWorkerInitErrorMessage
  | SegWorkerResultMessage
  | SegWorkerSegmentErrorMessage
  | SegWorkerDisposedMessage;

/* ------------------------------------------------------------------ */
/* Worker-scope plumbing — same narrowing rationale as detector.worker.ts */
/* (single DOM-only tsconfig, no separate "webworker" lib).              */
/* ------------------------------------------------------------------ */
interface SegDetectorWorkerScope {
  postMessage(message: SegWorkerToMainMessage, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<SegMainToWorkerMessage>) => void) | null;
  fetch: typeof globalThis.fetch;
  readonly location: { readonly href: string };
}
const workerScope = self as unknown as SegDetectorWorkerScope;

function postToMain(message: SegWorkerToMainMessage, transfer: Transferable[] = []): void {
  workerScope.postMessage(message, transfer);
}

/** Same MediaPipe usage-telemetry block as detector.worker.ts — a Worker has
 * its own global scope, so this has to be reinstalled here independently. */
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
/* Segmenter lifecycle.                                                 */
/* ------------------------------------------------------------------ */

let segmenter: MpInteractiveSegmenterLegacy | null = null;

async function handleInit(msg: SegWorkerInitMessage): Promise<void> {
  installTelemetryBlock();
  try {
    const fileset = await mediapipe.FilesetResolver.forVisionTasks(msg.wasmBasePath);

    segmenter = await mediapipe.InteractiveSegmenterLegacy.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: msg.modelPath, delegate: msg.delegate },
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
    postToMain({ type: 'ready' });
  } catch (err) {
    postToMain({ type: 'init-error', message: err instanceof Error ? err.message : String(err) });
  }
}

function handleSegment(msg: SegWorkerSegmentMessage): void {
  const { requestId, bitmap, x, y } = msg;

  if (!segmenter) {
    bitmap.close();
    postToMain({ type: 'segment-error', requestId, message: 'segmenter not initialised' });
    return;
  }

  try {
    const roi: RegionOfInterest = { keypoint: { x, y } };
    const startedAt = performance.now();
    const result = segmenter.segment(bitmap, roi);
    const inferenceMs = performance.now() - startedAt;

    const confMask = result.confidenceMasks?.[0];
    let mask: Float32Array | null = null;
    let maskWidth = 0;
    let maskHeight = 0;
    let qualityScore = result.qualityScores?.[0] ?? 1;
    if (confMask) {
      // Copy out of MediaPipe's own buffer before closing it — getAsFloat32Array()
      // may return a view over Wasm heap memory that becomes invalid once the
      // mask (and the result it came from) is closed.
      mask = Float32Array.from(confMask.getAsFloat32Array());
      maskWidth = confMask.width;
      maskHeight = confMask.height;
      confMask.close();
    }
    result.close();
    qualityScore = Number.isFinite(qualityScore) ? qualityScore : 1;

    if (mask) {
      postToMain(
        { type: 'result', requestId, mask, maskWidth, maskHeight, qualityScore, inferenceMs },
        [mask.buffer],
      );
    } else {
      postToMain({ type: 'result', requestId, mask: null, maskWidth, maskHeight, qualityScore, inferenceMs });
    }
  } catch (err) {
    postToMain({
      type: 'segment-error',
      requestId,
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    // Always — success or failure. Same discipline as detector.worker.ts.
    bitmap.close();
  }
}

function handleDispose(): void {
  try {
    segmenter?.close();
  } catch {
    // Already broken; the main thread terminates this worker regardless.
  }
  segmenter = null;
  postToMain({ type: 'disposed' });
}

workerScope.onmessage = (event: MessageEvent<SegMainToWorkerMessage>): void => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      void handleInit(msg);
      break;
    case 'segment':
      handleSegment(msg);
      break;
    case 'dispose':
      handleDispose();
      break;
  }
};
