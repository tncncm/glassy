/**
 * EXPERIMENTAL / RESEARCH PROTOTYPE — not part of the shipped app.
 *
 * PRIVACY — read this before touching anything below. Same discipline as
 * ObjectDetector.ts (this file's real-pipeline counterpart), applied to a
 * second, class-agnostic model:
 *
 *   - this file's only job with a frame is `createImageBitmap(...)`, a
 *     lightweight snapshot, never drawn to a canvas, never read pixel-by-
 *     pixel here
 *   - that bitmap is TRANSFERRED (zero-copy) into `magicTouchSegmenter.
 *     worker.ts`, which closes it immediately after inference, every path
 *   - what comes back is a per-pixel confidence mask (numbers, not an
 *     image — never `toDataURL`/`toBlob`) plus a few scalars, and this file
 *     hands that straight to the caller; nothing is cached beyond the
 *     lifetime of the Promise that returned it
 *   - the only network calls are the one-time same-origin model fetch (once
 *     `start()` is called) and the wasm runtime the worker fetches — same
 *     self-hosted files the shipped detector already uses, never a CDN
 *
 * NEVER IMPORTED BY SHIPPED CODE. src/app, src/game and the real
 * ObjectDetector.ts do not and must not import anything under
 * src/vision/experimental/ — this exists purely so
 * tools/video-sim/experimental/*.html can measure whether MediaPipe's
 * Interactive Segmenter is worth building for real. See the report handed
 * back with this prototype for the recommendation.
 *
 * WHAT THIS IS: a point-prompt -> object-silhouette probe. Give it a frame
 * and a normalised (x, y) point (the centre of a detection box, in this
 * project's case), it returns a per-pixel confidence mask for "the object at
 * that point" — class-agnostic, so a person, a chair, a laptop and a beach
 * parasol are all just "the thing under the point" to this model. Unlike
 * ObjectDetector, there is no polling loop here: a caller decides when a
 * point is worth the ~100ms it costs (see the report) — the design brief's
 * "segment once when an object first stabilises, then carry the mask with
 * its box" — so this module is a thin request/response wrapper around the
 * worker, not a ticking pipeline stage.
 */

import type {
  SegMainToWorkerMessage,
  SegWorkerToMainMessage,
  SegWorkerResultMessage,
} from './magicTouchSegmenter.worker.ts';

/** Self-hosted only — never a CDN. Shared with the real detector; see
 * scripts/fetch-vision-assets.mjs. Must already exist (`npm run
 * vision-assets`, or any prior `npm run dev`/`build`, materialises it). */
const WASM_BASE_PATH = '/vision/wasm';
/** Fetched by hand — see scripts/fetch-experimental-segmenter-assets.mjs.
 * Never fetched by the shipped app's own asset pipeline. */
const DEFAULT_MODEL_PATH = '/vision/experimental/magic_touch_float32.tflite';
/** Pre-bundled by hand — see scripts/build-experimental-segmenter-worker.mjs. */
const WORKER_PATH = '/vision/experimental/magic-touch-worker.js';

export type MagicTouchStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

export interface MagicTouchSegmentResult {
  /** Per-pixel confidence, 0..1, row-major, `width * height` long. Owned by
   * the caller once returned — copy it if you need it past this tick. */
  mask: Float32Array;
  width: number;
  height: number;
  qualityScore: number;
  /** Wall-clock cost of the `segment()` call inside the worker — excludes
   * postMessage/structured-clone/bitmap-capture overhead. */
  inferenceMs: number;
  /** Wall-clock cost of the WHOLE round trip as observed by this file:
   * capture + postMessage + worker inference + postMessage back. The number
   * that actually matters for "does this fit a frame budget". */
  roundTripMs: number;
}

export interface MagicTouchSegmenterOptions {
  /** 'CPU' by default — this project measured the GPU delegate contending
   * with Pixi's own WebGL renderer for the real detector (see
   * detector.worker.ts) and treats that as the default-suspect explanation
   * here too. Exposed so the harness can A/B honestly rather than assume the
   * same conclusion transfers unmeasured. */
  delegate?: 'CPU' | 'GPU';
  /** Diagnostic-only override, for A/B against a different model file
   * without touching the fetch script. */
  modelPath?: string;
}

export interface MagicTouchSegmenter {
  readonly status: MagicTouchStatus;
  /** Downloads the model (if not already resident) and starts the worker.
   * Never rejects: failure lands in `unavailable`. */
  start(): Promise<MagicTouchStatus>;
  /**
   * Segment the object at normalised point (x, y) in `bitmap`. `bitmap` is
   * TRANSFERRED to the worker — the caller must not touch it again after
   * calling this. Returns `null` on any failure (never throws) — including
   * "not ready" and "the model produced no mask".
   *
   * Multiple calls may be in flight at once; the single worker thread
   * services them in the order they were sent (MediaPipe's `segment()` is
   * itself synchronous per call, so this is genuinely serial underneath,
   * not parallel) — which is exactly the "several new objects appear at
   * once" worst case this prototype exists to measure.
   */
  segmentAt(bitmap: ImageBitmap, x: number, y: number): Promise<MagicTouchSegmentResult | null>;
  /** Stop and release the worker + model entirely. */
  dispose(): void;
}

export function createMagicTouchSegmenter(options: MagicTouchSegmenterOptions = {}): MagicTouchSegmenter {
  const delegate = options.delegate ?? 'CPU';
  const modelPath = options.modelPath ?? DEFAULT_MODEL_PATH;

  let status: MagicTouchStatus = 'idle';
  let worker: Worker | null = null;
  let startPromise: Promise<MagicTouchStatus> | null = null;
  let requestCounter = 0;

  interface Pending {
    resolve: (r: MagicTouchSegmentResult | null) => void;
    startedAt: number;
  }
  const pending = new Map<number, Pending>();
  let pendingInit: { resolve: () => void; reject: (err: Error) => void } | null = null;

  function postToWorker(message: SegMainToWorkerMessage, transfer: Transferable[] = []): void {
    worker?.postMessage(message, transfer);
  }

  function handleWorkerMessage(data: SegWorkerToMainMessage): void {
    switch (data.type) {
      case 'ready':
        pendingInit?.resolve();
        pendingInit = null;
        return;
      case 'init-error':
        pendingInit?.reject(new Error(data.message));
        pendingInit = null;
        return;
      case 'disposed':
        return;
      case 'result':
        handleResult(data);
        return;
      case 'segment-error':
        handleSegmentError(data.requestId, data.message);
        return;
    }
  }

  function handleResult(data: SegWorkerResultMessage): void {
    const entry = pending.get(data.requestId);
    if (!entry) return; // stale or already resolved
    pending.delete(data.requestId);
    if (!data.mask) {
      entry.resolve(null);
      return;
    }
    entry.resolve({
      mask: data.mask,
      width: data.maskWidth,
      height: data.maskHeight,
      qualityScore: data.qualityScore,
      inferenceMs: data.inferenceMs,
      roundTripMs: performance.now() - entry.startedAt,
    });
  }

  function handleSegmentError(requestId: number, message: string): void {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    console.warn('[MagicTouchSegmenter] segment failed:', message);
    entry.resolve(null);
  }

  function createWorker(): Worker | null {
    try {
      const w = new Worker(WORKER_PATH);
      w.onmessage = (event: MessageEvent): void => handleWorkerMessage(event.data as SegWorkerToMainMessage);
      w.onerror = (event: ErrorEvent): void => {
        const message = event.message || 'unknown worker error';
        if (pendingInit) {
          pendingInit.reject(new Error(message));
          pendingInit = null;
        }
        for (const [, entry] of pending) entry.resolve(null);
        pending.clear();
      };
      return w;
    } catch {
      return null;
    }
  }

  async function loadAndStart(): Promise<MagicTouchStatus> {
    status = 'loading';
    try {
      // No pre-fetch here, unlike ObjectDetector.ts: `modelAssetBuffer` is
      // broken for this task in the pinned library version (see
      // magicTouchSegmenter.worker.ts's SegWorkerInitMessage doc) — the
      // worker hands `modelPath` straight to MediaPipe and lets IT fetch,
      // same-origin, self-hosted. That means no byte-level progress
      // reporting for this asset; a real integration would need to fake one
      // (e.g. warm the HTTP/SW cache with our own fetch first, purely for a
      // progress bar, then let MediaPipe's fetch hit that cache) — out of
      // scope for this prototype.
      worker = createWorker();
      if (!worker) {
        status = 'unavailable';
        return status;
      }
      await new Promise<void>((resolve, reject) => {
        pendingInit = { resolve, reject };
        postToWorker({ type: 'init', wasmBasePath: WASM_BASE_PATH, modelPath, delegate });
      });
      status = 'ready';
      return status;
    } catch (err) {
      console.warn('[MagicTouchSegmenter] failed to initialise:', err);
      worker?.terminate();
      worker = null;
      status = 'unavailable';
      return status;
    }
  }

  return {
    get status(): MagicTouchStatus {
      return status;
    },

    start(): Promise<MagicTouchStatus> {
      if (status === 'ready') return Promise.resolve(status);
      if (startPromise) return startPromise;
      const p = loadAndStart().finally(() => {
        startPromise = null;
      });
      startPromise = p;
      return p;
    },

    segmentAt(bitmap: ImageBitmap, x: number, y: number): Promise<MagicTouchSegmentResult | null> {
      if (status !== 'ready' || !worker) {
        bitmap.close();
        return Promise.resolve(null);
      }
      const requestId = ++requestCounter;
      const startedAt = performance.now();
      return new Promise((resolve) => {
        pending.set(requestId, { resolve, startedAt });
        postToWorker({ type: 'segment', requestId, bitmap, x, y }, [bitmap]);
      });
    },

    dispose(): void {
      for (const [, entry] of pending) entry.resolve(null);
      pending.clear();
      if (worker) {
        try {
          postToWorker({ type: 'dispose' });
        } catch {
          // ignore
        }
        worker.terminate();
        worker = null;
      }
      status = 'idle';
    },
  };
}
