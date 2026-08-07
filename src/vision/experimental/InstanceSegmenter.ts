/**
 * PROTOTYPE — NOT WIRED INTO THE SHIPPED APP. See types.ts for the scope of
 * this whole directory. Exercised only by tools/video-sim.
 *
 * PRIVACY — same discipline as ObjectDetector.ts. This file's only contact
 * with the video is `createImageBitmap(video, …)`, a downscaled snapshot,
 * TRANSFERRED (not copied) into segmenter.worker.ts, which runs inference
 * and returns a handful of numbers plus small per-instance mask arrays. No
 * frame, crop or mask outlives the tick that produced it — the caller reads
 * the result synchronously. The ONLY network calls are the one-time,
 * self-hosted fetches of the ONNX Runtime Web wasm binary and the model
 * (both under tools/video-sim, never a CDN, never uploaded).
 *
 * WHY THIS EXISTS: evaluating whether a YOLO-family instance-segmentation
 * model, run through ONNX Runtime Web, can produce a genuine per-object
 * silhouette (not a box, not a single edge-scanned roofline) cheaply enough
 * to matter — see the report for the measured verdict. The key economic
 * idea under test (see the brief that produced this prototype): a mask does
 * NOT need to be recomputed every tick. DetectionTracker already carries a
 * stable id across frames; a real integration would compute a mask ONCE
 * when a track first stabilises, then translate/scale it with the box on
 * every subsequent tick, refreshing only occasionally. This controller does
 * NOT implement that caching itself (that is tracker-integration work, out
 * of scope for a prototype that must not rewire the shipped pipeline) — it
 * exists to produce the PER-CALL cost numbers ("first inference" vs
 * "steady state") that decide whether that amortised design is worth
 * building at all.
 */

import type { InstanceMask, InstanceSegmentResult } from './types.ts';
import type {
  SegMainToWorkerMessage,
  SegWorkerToMainMessage,
  SegResultMessage,
} from './segmenter.worker.ts';

/** A live camera `<video>` in the real (eventual) integration; the
 * evaluation harness also points this at a static `<img>` to test desk/
 * beach photos, since neither this file nor the worker cares which kind of
 * element it is — both are valid `createImageBitmap` sources and the only
 * other thing read is "is it decoded and non-empty yet". */
type CaptureSource = HTMLVideoElement | HTMLImageElement;

function isReady(source: CaptureSource): boolean {
  if (source instanceof HTMLVideoElement) {
    return source.readyState >= 2 && source.videoWidth > 0 && source.videoHeight > 0;
  }
  return source.complete && source.naturalWidth > 0 && source.naturalHeight > 0;
}

function sourceSize(source: CaptureSource): { width: number; height: number } {
  if (source instanceof HTMLVideoElement) return { width: source.videoWidth, height: source.videoHeight };
  return { width: source.naturalWidth, height: source.naturalHeight };
}

export interface InstanceSegmenterOptions {
  video: CaptureSource;
  /** Model input is square; this is both dimensions. 320 to match the
   * shipped EfficientDet budget, 640 for a quality comparison — see report. */
  inputSize: number;
  /** Self-hosted path to the .onnx file (tools/video-sim/models/…, never a
   * CDN, never committed — see scripts/fetch-seg-assets.mjs). */
  modelPath: string;
  scoreThreshold?: number;
  iouThreshold?: number;
  maxInstances?: number;
  onStateChange?: (state: 'idle' | 'loading' | 'ready' | 'error') => void;
}

export interface InstanceSegmenter {
  start(): Promise<void>;
  /**
   * Captures the current video frame and runs one detect round-trip.
   * Returns null when not ready, the video isn't playable, or the call
   * failed — never throws.
   */
  detect(): Promise<InstanceSegmentResult | null>;
  dispose(): void;
}

/** Self-hosted ONNX Runtime Web wasm directory — see
 * scripts/fetch-seg-assets.mjs. Never a CDN. */
const ORT_WASM_PATH = '/tools/video-sim/ort/';

const TARGET_BITMAP_WIDTH = 640;

function computeBitmapSize(videoWidth: number, videoHeight: number): { width: number; height: number } {
  if (videoWidth <= 0 || videoHeight <= 0) return { width: TARGET_BITMAP_WIDTH, height: TARGET_BITMAP_WIDTH };
  const width = Math.min(TARGET_BITMAP_WIDTH, videoWidth);
  const height = Math.max(1, Math.round((width * videoHeight) / videoWidth));
  return { width, height };
}

export function createInstanceSegmenter(options: InstanceSegmenterOptions): InstanceSegmenter {
  const { video } = options;
  const inputSize = options.inputSize;
  const scoreThreshold = options.scoreThreshold ?? 0.25;
  const iouThreshold = options.iouThreshold ?? 0.45;
  const maxInstances = options.maxInstances ?? 20;

  let worker: Worker | null = null;
  let requestCounter = 0;
  let pendingInit: { resolve: () => void; reject: (err: Error) => void } | null = null;
  const pendingDetects = new Map<number, { resolve: (r: InstanceSegmentResult | null) => void }>();

  function post(msg: SegMainToWorkerMessage, transfer: Transferable[] = []): void {
    worker?.postMessage(msg, transfer);
  }

  function handleMessage(data: SegWorkerToMainMessage): void {
    switch (data.type) {
      case 'ready':
        pendingInit?.resolve();
        pendingInit = null;
        break;
      case 'init-error':
        pendingInit?.reject(new Error(data.message));
        pendingInit = null;
        break;
      case 'result': {
        const pending = pendingDetects.get(data.requestId);
        if (!pending) return; // stale
        pendingDetects.delete(data.requestId);
        pending.resolve(toResult(data));
        break;
      }
      case 'detect-error': {
        const pending = pendingDetects.get(data.requestId);
        if (!pending) return;
        pendingDetects.delete(data.requestId);
        console.warn('[InstanceSegmenter] detect failed:', data.message);
        pending.resolve(null);
        break;
      }
    }
  }

  function toResult(data: SegResultMessage): InstanceSegmentResult {
    const instances: InstanceMask[] = data.instances;
    return {
      instances,
      inferenceMs: data.inferenceMs,
      preprocessMs: data.preprocessMs,
      postprocessMs: data.postprocessMs,
      frameWidth: data.frameWidth,
      frameHeight: data.frameHeight,
    };
  }

  async function fetchModel(path: string): Promise<ArrayBuffer> {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`model fetch failed: HTTP ${response.status}`);
    // Vite's dev server SPA-falls-back an unmatched path to index.html with
    // a 200 OK rather than a 404 — a genuinely missing model file at `path`
    // (the expected case for anyone who hasn't placed one yet, see
    // docs/dev-instance-segmentation.md) looks like a SUCCESSFUL fetch of
    // the wrong content instead of a clear "not found". Left uncaught, those
    // HTML bytes reach ONNX Runtime as garbage and fail deep inside session
    // creation with an opaque "protobuf parsing failed" error that gives no
    // hint the actual problem is a missing file at a documented path — this
    // check turns that into the specific, actionable message it should be.
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/html')) {
      throw new Error(
        `model not found at ${path} (the dev server returned its HTML shell instead — see docs/dev-instance-segmentation.md for where to place the .onnx file)`,
      );
    }
    return await response.arrayBuffer();
  }

  return {
    async start(): Promise<void> {
      options.onStateChange?.('loading');
      try {
        const modelBytes = await fetchModel(options.modelPath);

        // Plain ES-module worker — unlike detector.worker.ts (MediaPipe),
        // onnxruntime-web does not need `importScripts`, so Vite's normal
        // worker handling (dev AND build) is sufficient; no esbuild
        // pre-bundle step needed for this prototype.
        worker = new Worker(new URL('./segmenter.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<SegWorkerToMainMessage>) => handleMessage(event.data);
        worker.onerror = (event: ErrorEvent) => {
          console.warn('[InstanceSegmenter] worker error:', event.message);
          pendingInit?.reject(new Error(event.message));
          pendingInit = null;
        };

        await new Promise<void>((resolve, reject) => {
          pendingInit = { resolve, reject };
          post(
            {
              type: 'init',
              wasmBasePath: ORT_WASM_PATH,
              modelBytes,
              inputSize,
              scoreThreshold,
              iouThreshold,
              maxInstances,
            },
            [modelBytes],
          );
        });
        options.onStateChange?.('ready');
      } catch (err) {
        console.warn('[InstanceSegmenter] failed to start:', err);
        options.onStateChange?.('error');
      }
    },

    async detect(): Promise<InstanceSegmentResult | null> {
      if (!worker) return null;
      if (!isReady(video)) return null;

      const { width: srcWidth, height: srcHeight } = sourceSize(video);
      const { width, height } = computeBitmapSize(srcWidth, srcHeight);
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(video, { resizeWidth: width, resizeHeight: height, resizeQuality: 'medium' });
      } catch (err) {
        console.warn('[InstanceSegmenter] bitmap capture failed:', err);
        return null;
      }

      const requestId = ++requestCounter;
      return new Promise<InstanceSegmentResult | null>((resolve) => {
        pendingDetects.set(requestId, { resolve });
        post({ type: 'detect', requestId, bitmap }, [bitmap]);
      });
    },

    dispose(): void {
      worker?.terminate();
      worker = null;
      pendingDetects.clear();
      pendingInit = null;
    },
  };
}
