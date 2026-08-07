/**
 * PROTOTYPE WORKER — NOT WIRED INTO THE SHIPPED APP. See types.ts for the
 * scope of this whole directory. Exercised only by tools/video-sim.
 *
 * PRIVACY: identical discipline to detector.worker.ts. Receives exactly one
 * `ImageBitmap` per `detect` message (already downscaled by the caller),
 * closes it immediately after use on every path, and returns only numbers
 * and small typed arrays (per-instance low-res masks). Holds no frame, no
 * crop, no history. The ONLY network calls this worker makes are the
 * one-time, same-origin fetches of the self-hosted ONNX Runtime Web wasm
 * binary (see ORT_WASM_PATH in InstanceSegmenter.ts) — never a CDN. The
 * model itself is fetched by the main thread and transferred in, exactly
 * like detector.worker.ts.
 *
 * Runs ONNX Runtime Web on the WASM (CPU) backend ONLY — no WebGPU, no
 * WebGL. Glassy's one hard-won lesson from the shipped detector is that a
 * GPU delegate contended with Pixi's own WebGL renderer for the same device
 * queue and stalled frames ~150ms, and moving inference off the JS thread
 * into a worker did NOT fix that (the contention is on the GPU device, not
 * the thread). The safest prior is that the same is true of WebGPU sharing
 * a queue with Pixi's WebGL context — untested here (no browser exposes
 * both at once easily for a controlled A/B), so CPU/WASM is used
 * unconditionally rather than assumed safe. See the report for what WebGPU
 * would need to be verified before ever being considered.
 */

// eslint-disable-next-line -- this worker's whole reason to exist is to run
// onnxruntime-web off the main thread, so (like detector.worker.ts and
// MediaPipe) it is expected to import it directly, unlike InstanceSegmenter.ts
// which only imports its TYPES.
import * as ort from 'onnxruntime-web/wasm';
import type { InstanceMask } from './types.ts';

/* ------------------------------------------------------------------ */
/* Worker <-> main-thread protocol.                                     */
/* ------------------------------------------------------------------ */

export interface SegInitMessage {
  type: 'init';
  wasmBasePath: string;
  /** Transferred, not copied. */
  modelBytes: ArrayBuffer;
  inputSize: number;
  scoreThreshold: number;
  iouThreshold: number;
  maxInstances: number;
}

export interface SegDetectMessage {
  type: 'detect';
  requestId: number;
  /** Transferred, not copied. Closed by this worker after use, always. */
  bitmap: ImageBitmap;
}

export type SegMainToWorkerMessage = SegInitMessage | SegDetectMessage;

export interface SegReadyMessage {
  type: 'ready';
}
export interface SegInitErrorMessage {
  type: 'init-error';
  message: string;
}
export interface SegResultMessage {
  type: 'result';
  requestId: number;
  instances: InstanceMask[];
  inferenceMs: number;
  preprocessMs: number;
  postprocessMs: number;
  frameWidth: number;
  frameHeight: number;
}
export interface SegDetectErrorMessage {
  type: 'detect-error';
  requestId: number;
  message: string;
}
export type SegWorkerToMainMessage =
  | SegReadyMessage
  | SegInitErrorMessage
  | SegResultMessage
  | SegDetectErrorMessage;

/* ------------------------------------------------------------------ */
/* Worker-scope plumbing — see detector.worker.ts for why this cast      */
/* exists (project runs one DOM-only tsconfig, no separate webworker lib) */
/* ------------------------------------------------------------------ */
interface SegWorkerScope {
  postMessage(message: SegWorkerToMainMessage, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<SegMainToWorkerMessage>) => void) | null;
}
const workerScope = self as unknown as SegWorkerScope;

function postToMain(message: SegWorkerToMainMessage, transfer: Transferable[] = []): void {
  workerScope.postMessage(message, transfer);
}

/**
 * Standard COCO-80 class names, in the fixed order Ultralytics' own
 * data/coco.yaml (and therefore this exported model's class-score channel
 * order) uses. Just a list of category names — not the model, not model
 * output, freely reproducible.
 */
const COCO_CLASSES = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
  'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog',
  'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella',
  'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball', 'kite',
  'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket', 'bottle',
  'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange',
  'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch', 'potted plant',
  'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone',
  'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase', 'scissors',
  'teddy bear', 'hair drier', 'toothbrush',
] as const;
const NUM_CLASSES = COCO_CLASSES.length; // 80
const NUM_MASK_COEFFS = 32;

let session: ort.InferenceSession | null = null;
let inputSize = 320;
let scoreThreshold = 0.25;
let iouThreshold = 0.45;
let maxInstances = 20;

/* ------------------------------------------------------------------ */
/* Init                                                                  */
/* ------------------------------------------------------------------ */

async function handleInit(msg: SegInitMessage): Promise<void> {
  try {
    inputSize = msg.inputSize;
    scoreThreshold = msg.scoreThreshold;
    iouThreshold = msg.iouThreshold;
    maxInstances = msg.maxInstances;

    // Self-hosted only — see InstanceSegmenter.ts's ORT_WASM_PATH. Never a
    // CDN, matching the rest of Glassy's vision stack.
    ort.env.wasm.wasmPaths = msg.wasmBasePath;
    // Single-threaded: the multi-threaded wasm build needs
    // crossOriginIsolated (COOP/COEP headers) to use SharedArrayBuffer, which
    // this prototype's plain `vite` dev server does not set. Forcing 1
    // thread makes the measured cost the REALISTIC same-origin, no-extra-
    // headers number — see the report for what multi-threading could buy on
    // top of this if the project ever added those headers.
    ort.env.wasm.numThreads = 1;
    // Already inside a worker; ORT's own "proxy" mode (spawn ANOTHER worker
    // to run the wasm) would be pure overhead here.
    ort.env.wasm.proxy = false;

    session = await ort.InferenceSession.create(msg.modelBytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    postToMain({ type: 'ready' });
  } catch (err) {
    postToMain({ type: 'init-error', message: err instanceof Error ? err.message : String(err) });
  }
}

/* ------------------------------------------------------------------ */
/* Preprocessing — letterbox resize into a square input tensor.         */
/* ------------------------------------------------------------------ */

interface Letterbox {
  data: Float32Array; // NCHW, 1x3xinputSizeXinputSize, 0..1
  scale: number;
  padX: number;
  padY: number;
}

let canvas: OffscreenCanvas | null = null;
let canvasCtx: OffscreenCanvasRenderingContext2D | null = null;
let tensorScratch: Float32Array | null = null;

function letterbox(bitmap: ImageBitmap): Letterbox {
  if (!canvas || canvas.width !== inputSize || canvas.height !== inputSize) {
    canvas = new OffscreenCanvas(inputSize, inputSize);
    canvasCtx = canvas.getContext('2d', { willReadFrequently: true });
  }
  const ctx = canvasCtx;
  if (!ctx) throw new Error('2d context unavailable');

  const scale = Math.min(inputSize / bitmap.width, inputSize / bitmap.height);
  const drawW = Math.round(bitmap.width * scale);
  const drawH = Math.round(bitmap.height * scale);
  const padX = Math.floor((inputSize - drawW) / 2);
  const padY = Math.floor((inputSize - drawH) / 2);

  // Standard YOLO letterbox padding colour (114,114,114).
  ctx.fillStyle = 'rgb(114,114,114)';
  ctx.fillRect(0, 0, inputSize, inputSize);
  ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, padX, padY, drawW, drawH);

  const imageData = ctx.getImageData(0, 0, inputSize, inputSize);
  const rgba = imageData.data;

  const pixelCount = inputSize * inputSize;
  if (!tensorScratch || tensorScratch.length !== pixelCount * 3) {
    tensorScratch = new Float32Array(pixelCount * 3);
  }
  const data = tensorScratch;
  // NCHW: plane 0 = R, plane 1 = G, plane 2 = B.
  for (let i = 0; i < pixelCount; i++) {
    const o = i * 4;
    data[i] = (rgba[o] ?? 0) / 255;
    data[pixelCount + i] = (rgba[o + 1] ?? 0) / 255;
    data[2 * pixelCount + i] = (rgba[o + 2] ?? 0) / 255;
  }
  return { data, scale, padX, padY };
}

/* ------------------------------------------------------------------ */
/* Postprocessing — decode boxes, class scores and mask coefficients,   */
/* class-agnostic NMS, then assemble each surviving instance's mask     */
/* from the shared proto tensor.                                        */
/* ------------------------------------------------------------------ */

interface Candidate {
  cx: number;
  cy: number;
  w: number;
  h: number;
  score: number;
  classIdx: number;
  coeffs: Float32Array; // length NUM_MASK_COEFFS, a VIEW into a per-call scratch buffer
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function iouXYWH(a: Candidate, b: Candidate): number {
  const ax1 = a.cx - a.w / 2, ay1 = a.cy - a.h / 2, ax2 = a.cx + a.w / 2, ay2 = a.cy + a.h / 2;
  const bx1 = b.cx - b.w / 2, by1 = b.cy - b.h / 2, bx2 = b.cx + b.w / 2, by2 = b.cy + b.h / 2;
  const ix1 = Math.max(ax1, bx1), iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1), ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Decodes `output0` [1, 4+80+32, N] into candidates above `scoreThreshold`,
 * then greedy class-agnostic NMS. Returns at most `maxInstances`, highest
 * score first — bounding both NMS cost and mask-assembly cost, which is the
 * point of the cap (a scene can report dozens of low-confidence boxes; only
 * the confident ones are worth a mask).
 */
function decodeAndNms(output0: Float32Array, numAnchors: number): Candidate[] {
  const stride = numAnchors;
  const candidates: Candidate[] = [];

  for (let n = 0; n < numAnchors; n++) {
    let bestScore = scoreThreshold;
    let bestClass = -1;
    for (let c = 0; c < NUM_CLASSES; c++) {
      const s = output0[(4 + c) * stride + n] ?? 0;
      if (s > bestScore) {
        bestScore = s;
        bestClass = c;
      }
    }
    if (bestClass < 0) continue;

    const coeffs = new Float32Array(NUM_MASK_COEFFS);
    for (let k = 0; k < NUM_MASK_COEFFS; k++) {
      coeffs[k] = output0[(4 + NUM_CLASSES + k) * stride + n] ?? 0;
    }

    candidates.push({
      cx: output0[0 * stride + n] ?? 0,
      cy: output0[1 * stride + n] ?? 0,
      w: output0[2 * stride + n] ?? 0,
      h: output0[3 * stride + n] ?? 0,
      score: bestScore,
      classIdx: bestClass,
      coeffs,
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  const kept: Candidate[] = [];
  for (const cand of candidates) {
    if (kept.length >= maxInstances) break;
    let suppressed = false;
    for (const k of kept) {
      if (k.classIdx === cand.classIdx && iouXYWH(k, cand) > iouThreshold) {
        suppressed = true;
        break;
      }
    }
    if (!suppressed) kept.push(cand);
  }
  return kept;
}

/**
 * Builds one instance's low-resolution mask by dot-producting its 32 mask
 * coefficients against the shared proto tensor [32, protoH, protoW], sigmoid
 * applied, cropped to the box's own region in proto-pixel space (the proto
 * grid is the letterboxed input downsampled by a fixed factor, so a box in
 * letterbox-pixel space maps down by simple division — no extra warp).
 * Returns null when the box maps to an empty region (degenerate box).
 */
function buildInstanceMask(
  coeffs: Float32Array,
  proto: Float32Array,
  protoH: number,
  protoW: number,
  boxLeftPx: number,
  boxTopPx: number,
  boxRightPx: number,
  boxBottomPx: number,
  inputSizePx: number,
): { width: number; height: number; data: Float32Array } | null {
  const protoScale = protoW / inputSizePx; // proto grid is a uniform downsample of the square input
  const left = Math.max(0, Math.floor(boxLeftPx * protoScale));
  const top = Math.max(0, Math.floor(boxTopPx * protoScale));
  const right = Math.min(protoW, Math.ceil(boxRightPx * protoScale));
  const bottom = Math.min(protoH, Math.ceil(boxBottomPx * protoScale));
  const w = right - left;
  const h = bottom - top;
  if (w < 1 || h < 1) return null;

  const planeSize = protoH * protoW;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const py = top + y;
    for (let x = 0; x < w; x++) {
      const px = left + x;
      let sum = 0;
      for (let k = 0; k < NUM_MASK_COEFFS; k++) {
        const c = coeffs[k] ?? 0;
        sum += c * (proto[k * planeSize + py * protoW + px] ?? 0);
      }
      out[y * w + x] = sigmoid(sum);
    }
  }
  return { width: w, height: h, data: out };
}

/* ------------------------------------------------------------------ */
/* Detect                                                                */
/* ------------------------------------------------------------------ */

async function handleDetect(msg: SegDetectMessage): Promise<void> {
  const { requestId, bitmap } = msg;
  if (!session) {
    bitmap.close();
    postToMain({ type: 'detect-error', requestId, message: 'session not initialised' });
    return;
  }

  const frameWidth = bitmap.width;
  const frameHeight = bitmap.height;

  try {
    const preStart = performance.now();
    const { data, scale, padX, padY } = letterbox(bitmap);
    const inputTensor = new ort.Tensor('float32', data, [1, 3, inputSize, inputSize]);
    const preprocessMs = performance.now() - preStart;

    const infStart = performance.now();
    const feeds: Record<string, ort.Tensor> = {};
    const inputName = session.inputNames[0];
    if (!inputName) throw new Error('model has no input');
    feeds[inputName] = inputTensor;
    const results = await session.run(feeds);
    const inferenceMs = performance.now() - infStart;

    const postStart = performance.now();
    const out0Name = session.outputNames[0];
    const out1Name = session.outputNames[1];
    if (!out0Name || !out1Name) throw new Error('model has fewer than 2 outputs');
    const output0 = results[out0Name];
    const output1 = results[out1Name];
    if (!output0 || !output1) throw new Error('missing model output tensor');

    const numAnchors = output0.dims[2] ?? 0;
    const protoH = output1.dims[2] ?? 0;
    const protoW = output1.dims[3] ?? 0;
    const out0Data = output0.data as Float32Array;
    const protoData = output1.data as Float32Array;

    const kept = decodeAndNms(out0Data, numAnchors);

    const instances: InstanceMask[] = [];
    for (const cand of kept) {
      const boxLeftPx = cand.cx - cand.w / 2;
      const boxTopPx = cand.cy - cand.h / 2;
      const boxRightPx = cand.cx + cand.w / 2;
      const boxBottomPx = cand.cy + cand.h / 2;

      const built = buildInstanceMask(
        cand.coeffs, protoData, protoH, protoW,
        boxLeftPx, boxTopPx, boxRightPx, boxBottomPx, inputSize,
      );
      if (!built) continue;

      // Unletterbox: subtract padding, undo scale, normalise to 0..1 of the
      // ORIGINAL bitmap (not the square input).
      const origLeft = (boxLeftPx - padX) / scale;
      const origTop = (boxTopPx - padY) / scale;
      const origRight = (boxRightPx - padX) / scale;
      const origBottom = (boxBottomPx - padY) / scale;
      const cxFrac = ((origLeft + origRight) / 2) / frameWidth;
      const cyFrac = ((origTop + origBottom) / 2) / frameHeight;
      const wFrac = (origRight - origLeft) / frameWidth;
      const hFrac = (origBottom - origTop) / frameHeight;

      instances.push({
        label: COCO_CLASSES[cand.classIdx] ?? `class_${cand.classIdx}`,
        score: cand.score,
        x: cxFrac,
        y: cyFrac,
        width: wFrac,
        height: hFrac,
        maskWidth: built.width,
        maskHeight: built.height,
        mask: built.data,
      });
    }
    const postprocessMs = performance.now() - postStart;

    const transfer: Transferable[] = instances.map((i) => i.mask.buffer);
    postToMain(
      { type: 'result', requestId, instances, inferenceMs, preprocessMs, postprocessMs, frameWidth, frameHeight },
      transfer,
    );
  } catch (err) {
    postToMain({ type: 'detect-error', requestId, message: err instanceof Error ? err.message : String(err) });
  } finally {
    bitmap.close();
  }
}

workerScope.onmessage = (event: MessageEvent<SegMainToWorkerMessage>): void => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      void handleInit(msg);
      break;
    case 'detect':
      void handleDetect(msg);
      break;
  }
};
