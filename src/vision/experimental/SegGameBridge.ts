/**
 * PROTOTYPE — dev-only bridge from the YOLO instance-segmentation evaluation
 * (InstanceSegmenter.ts / segmenter.worker.ts — see that file's own header
 * for the full scope, cost numbers and AGPL licensing story) into the shape
 * the shipped game already knows how to render: `TrackedObject[]` from
 * src/types.ts (frozen — never widened, never touched, here).
 *
 * ONLY ever constructed from App.ts behind the literal
 * `if (import.meta.env.DEV)` guard at that call site. That guard — not
 * anything in this file — is what keeps this module, and everything it
 * pulls in (onnxruntime-web, the ONNX model fetch, the segmentation
 * worker), out of a production build. This file has no DEV check of its
 * own: by the time anything here runs, App.ts has already proven this is a
 * dev build and the user explicitly opted in via `?seg=yolo`. See
 * docs/dev-instance-segmentation.md for how that exclusion was verified
 * against the actual `dist/` output, not assumed.
 *
 * WHAT THIS REPLACES: in the shipped pipeline, ObjectDetector.ts's loose
 * EfficientDet box is narrowed to a landing surface by SurfaceProfileFinder,
 * a gradient-scan heuristic that approximates a vehicle's top silhouette
 * from a box plus a motion mask plus a pile of tuned thresholds. YOLO-seg
 * instead reports an actual per-pixel soft mask for each instance — its top
 * contour, per column, IS the landing surface, directly, not an
 * approximation of one. `surfaceFromMask` below does that conversion: for
 * each mask column, the first row crossing a confidence threshold becomes
 * that column's surface height; the mask's own occupied columns become
 * `surfaceLeft`/`surfaceRight` (already tight to the vehicle, unlike the
 * detector's padded box); both are resampled to the fixed
 * `SURFACE_PROFILE_SAMPLES` the game already consumes. No search band, no
 * top-skip fraction, no motion mask needed — the mask already IS the
 * vehicle, not a box that might contain one plus some sky.
 *
 * WHAT THIS DELIBERATELY DOES NOT REPLICATE from the shipped pipeline, to
 * keep this a focused measurement of "do masks make a better surface" and
 * not a second full reimplementation: CarriagewayFilter's own-side-of-the-
 * road reasoning and OpticalFlow's ego-motion gate are not run here. A real
 * merge would need them; this prototype does not need them to answer the
 * question it exists to answer, and every object it reports is still
 * `stable`-gated by the same tracker the shipped pipeline uses before
 * anything becomes a landing surface, so it never hands out gameplay-worthy
 * platforms from single-frame noise.
 *
 * IDENTITY AND BOX SMOOTHING: reuses the SHIPPED DetectionTracker as-is
 * (../DetectionTracker.ts) — the same production code, not a
 * reimplementation — for cross-frame id assignment, box smoothing and
 * `stable` gating. This file's own job is narrower: build `Detection[]`
 * from this tick's mask instances, feed the tracker, then — for whichever
 * of THIS TICK's masks best matches (by IoU) each resulting track — replace
 * that track's fallback flat surface with one built from the mask, with its
 * own light exponential smoothing (`applySurfaceSmoothing`) so a fresh mask
 * recomputed from scratch every cadence tick doesn't visibly step. There is
 * no cross-frame mask warping/caching here — every tick's mask is a fresh
 * full inference pass, unlike the amortised "compute once, translate after"
 * design InstanceSegmenter.ts's header describes as the real integration's
 * eventual shape; that is future work this prototype's cost numbers exist
 * to justify, not something this bridge implements.
 *
 * PRIVACY: identical discipline to the rest of src/vision/experimental — see
 * InstanceSegmenter.ts's own header for the full accounting. Nothing added
 * here changes it: this file reads only the numbers InstanceSegmenter/
 * DetectionTracker already produced, keeps a small bounded per-track
 * smoothing pool of plain numbers, and never touches a pixel itself.
 *
 * ALLOCATION: this runs at the seg cadence (a few Hz at most, see
 * `DEFAULT_HZ`), never inside the 60fps render loop — the "zero allocation
 * per tick" discipline that governs the shipped hot path does not apply
 * here in the same way, and this file does not fight it artificially. It
 * does reuse the shipped tracker's own pooled `TrackedObject`s and mutates
 * their `surfaceProfile` arrays in place rather than replacing them.
 */

import { createDetectionTracker, type DetectionTracker } from '../DetectionTracker.ts';
import { createInstanceSegmenter, type InstanceSegmenter } from './InstanceSegmenter.ts';
import type { InstanceMask } from './types.ts';
import {
  SURFACE_PROFILE_SAMPLES,
  type DetectedKind,
  type Detection,
  type TrackedObject,
} from '../../types.ts';

/**
 * Self-hosted, gitignored, NOT fetched by any script in this repo — see
 * docs/dev-instance-segmentation.md for exactly how to produce this file
 * with the Ultralytics CLI (a one-time, by-hand step outside `npm run dev`)
 * and where to place it. When it's missing, `InstanceSegmenter.start()`'s
 * `fetch()` 404s, this bridge lands in `'error'` status, logs one clear
 * console message, and the game simply never receives any tracked objects
 * from this path — never a crash, never a silent wrong answer.
 */
const DEFAULT_MODEL_PATH = '/tools/video-sim/models/yolov8n-seg-320.onnx';

/**
 * 320 matches the shipped EfficientDet budget and is the default; bump to
 * 640 by editing this constant for a quality comparison (see the report
 * referenced in InstanceSegmenter.ts's header for the cost delta measured
 * on desktop). Not exposed as a query param — unlike cadence, this isn't
 * something worth changing tick-to-tick while reading numbers off a phone.
 */
const DEFAULT_INPUT_SIZE = 320;

/**
 * How often the WHOLE pipeline runs — this is the one lever that matters,
 * per the brief: YOLO-seg reports every instance in one pass, so there is no
 * per-object caching to tune here, only how often the full pass happens.
 * Measured at 63ms steady-state single-threaded on an M4 Max desktop; an
 * iPhone's JSC can run scalar wasm 2-4x slower (this project's own
 * performance notes), so 2Hz (a fresh pass roughly every 500ms) is the
 * conservative starting default — comfortably clear of stacking two
 * inference passes back to back even at the pessimistic end of that range,
 * while still refreshing landing surfaces often enough to track a vehicle
 * ahead. Override per-run with `?segHz=<n>` (see App.ts's devSegHz()) —
 * that is the intended way to explore this on a real device, not editing
 * this file.
 */
const DEFAULT_HZ = 2;

const DEFAULT_SCORE_THRESHOLD = 0.25;
const DEFAULT_IOU_THRESHOLD = 0.45;

/**
 * Caps mask-assembly cost per pass (each kept instance costs one more mask
 * dot-product against the shared proto tensor — see segmenter.worker.ts).
 * Comfortably above what a single dashcam frame realistically holds in
 * frame at once (this project's own measurements: 19-21 detections/sec
 * across a whole scene, not per frame) and matches DetectionTracker's own
 * practical ceiling for how many objects can usefully become platforms at
 * once.
 */
const DEFAULT_MAX_INSTANCES = 12;
const MAX_RESULTS = 12;

/**
 * Duplicated, deliberately, from ObjectDetector.ts's own (module-private,
 * unexported) `LABEL_TO_KIND` — see that file's extensive comment for the
 * full reasoning behind which COCO classes count as a landing surface. This
 * is a smaller subset (the road-relevant core, not the full "anything you
 * could land on" beach/furniture allowlist) since this prototype's whole
 * purpose is measuring mask quality on REAL DASHCAM FOOTAGE (see the video-
 * sim harness), not re-litigating the allowlist. Keep the two in sync if
 * the shipped table changes in ways that matter for this comparison.
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

/** A mask candidate must overlap a track's smoothed box by at least this
 * much (IoU) before its mask is trusted as "the same object this tick" —
 * see `refineFromMasks`. Deliberately looser than DetectionTracker's own
 * MIN_IOU_TO_MATCH (0.2): the track's box may already have glided a step
 * toward a slightly different detection this tick, and a hit here only
 * unlocks a REFINEMENT (see `applySurfaceSmoothing`'s own EMA), it never
 * creates or destroys a track the way the tracker's own association would. */
const MASK_MATCH_MIN_IOU = 0.15;

/** Soft-mask confidence (post-sigmoid, 0..1) a pixel must clear to count as
 * "part of the vehicle" when walking down a mask column for its top edge.
 * 0.5 is the standard decision boundary for a sigmoid mask head. */
const MASK_THRESHOLD = 0.5;

/** Exponential-smoothing rate (1/s) for the mask-derived surface fields.
 * Deliberately gentle, same role as SurfaceProfileFinder's own SMOOTHING_RATE
 * (3): a mask is much more reliable per-tick than a gradient scan, so this
 * exists only to keep a fresh-every-tick recomputation from visibly
 * stepping at this cadence, not to reject noise the way a jump-detector
 * would. */
const SURFACE_SMOOTHING_RATE = 4;

/** Fixed pool size for per-object surface-smoothing state, comfortably above
 * any plausible number of simultaneously-tracked vehicles — same margin
 * SurfaceProfileFinder's own MAX_SURFACE_TRACKS keeps over DetectionTracker's
 * MAX_TRACKS. */
const MAX_SMOOTH_TRACKS = 16;

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** `1 - e^(-rate*dt)` — the same frame-rate-independent smoothing factor
 * used throughout src/vision. */
function smoothingFactor(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

/** Same shape as DetectionTracker's own (module-private) `iou` — duplicated
 * here rather than exported from that file, since this is the only other
 * caller and the function is a five-line pure calculation. */
function iouXYWH(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): number {
  const aLeft = ax - aw / 2, aRight = ax + aw / 2;
  const aTop = ay - ah / 2, aBottom = ay + ah / 2;
  const bLeft = bx - bw / 2, bRight = bx + bw / 2;
  const bTop = by - bh / 2, bBottom = by + bh / 2;
  const overlapW = Math.min(aRight, bRight) - Math.max(aLeft, bLeft);
  const overlapH = Math.min(aBottom, bBottom) - Math.max(aTop, bTop);
  if (overlapW <= 0 || overlapH <= 0) return 0;
  const overlap = overlapW * overlapH;
  const union = aw * ah + bw * bh - overlap;
  return union > 0 ? overlap / union : 0;
}

/**
 * Derives a landing surface directly from one instance's soft mask: for
 * each mask column, the first row (top to bottom) crossing `MASK_THRESHOLD`
 * is that column's surface height; columns that never cross it are filled
 * by interpolating between their nearest occupied neighbours (a hole, a
 * reflection), never invented past the mask's own occupied span. Writes the
 * resampled `SURFACE_PROFILE_SAMPLES`-long profile into `outProfile` (frame-
 * height fractions) and returns the flat `surfaceY`/`Left`/`Right` triple,
 * or `null` when NO column of this mask crossed the threshold at all — an
 * honest "no data", same as SurfaceProfileFinder's own null-return path.
 *
 * `surfaceY` is the MEDIAN of the resampled profile, not the minimum: a
 * single stray pixel (an aerial, a mirror sliver) surviving the threshold
 * would otherwise pull a single-row summary up to a spike, where the median
 * tracks the dominant, usually-flattest, largest-area part of the
 * silhouette — the same role SurfaceProfileFinder's single full-width scan
 * played for the shipped pipeline.
 */
function surfaceFromMask(
  mask: InstanceMask,
  outProfile: Float32Array,
): { surfaceY: number; surfaceLeft: number; surfaceRight: number } | null {
  const { maskWidth, maskHeight, mask: data } = mask;
  if (maskWidth < 2 || maskHeight < 2) return null;

  // Pass 1: topmost row per column crossing the threshold; NaN where a
  // column has no crossing at all.
  const topRow = new Float32Array(maskWidth);
  let firstOccupied = -1;
  let lastOccupied = -1;
  for (let x = 0; x < maskWidth; x++) {
    let row = -1;
    for (let y = 0; y < maskHeight; y++) {
      const v = data[y * maskWidth + x] ?? 0;
      if (v >= MASK_THRESHOLD) {
        row = y;
        break;
      }
    }
    if (row < 0) {
      topRow[x] = Number.NaN;
      continue;
    }
    topRow[x] = row;
    if (firstOccupied < 0) firstOccupied = x;
    lastOccupied = x;
  }
  if (firstOccupied < 0) return null; // nothing in this mask crossed the threshold

  // Pass 2: fill interior gaps between the outermost occupied columns by
  // linear interpolation between the nearest surviving neighbours either
  // side. firstOccupied/lastOccupied are themselves occupied by
  // construction, so every gap here is strictly interior.
  let prevVal = topRow[firstOccupied] ?? 0;
  let prevIdx = firstOccupied;
  for (let x = firstOccupied + 1; x <= lastOccupied; x++) {
    const v = topRow[x];
    if (v !== undefined && !Number.isNaN(v)) {
      prevVal = v;
      prevIdx = x;
      continue;
    }
    let nextIdx = x + 1;
    while (nextIdx <= lastOccupied) {
      const nv = topRow[nextIdx];
      if (nv !== undefined && !Number.isNaN(nv)) break;
      nextIdx++;
    }
    const nextVal = topRow[nextIdx] ?? prevVal;
    const span = nextIdx - prevIdx;
    const t = span > 0 ? (x - prevIdx) / span : 0;
    topRow[x] = prevVal + (nextVal - prevVal) * t;
  }

  // Pass 3: resample the occupied span up to SURFACE_PROFILE_SAMPLES in the
  // mask's own pixel space, then convert to frame fractions via the box this
  // mask covers (mask.x/y/width/height — box-relative 0..1, per types.ts).
  const boxLeft = mask.x - mask.width / 2;
  const boxTop = mask.y - mask.height / 2;
  const spanCols = lastOccupied - firstOccupied;
  const outputSpan = SURFACE_PROFILE_SAMPLES > 1 ? SURFACE_PROFILE_SAMPLES - 1 : 1;
  for (let k = 0; k < SURFACE_PROFILE_SAMPLES; k++) {
    const t = SURFACE_PROFILE_SAMPLES > 1 ? k / outputSpan : 0;
    const colF = firstOccupied + t * spanCols;
    const lo = Math.floor(colF);
    const hi = Math.min(lastOccupied, lo + 1);
    const frac = colF - lo;
    const loRow = topRow[lo] ?? 0;
    const hiRow = topRow[hi] ?? loRow;
    const rowPx = loRow + (hiRow - loRow) * frac;
    outProfile[k] = clamp01(boxTop + (rowPx / maskHeight) * mask.height);
  }

  const surfaceLeft = clamp01(boxLeft + (firstOccupied / maskWidth) * mask.width);
  const surfaceRight = clamp01(boxLeft + ((lastOccupied + 1) / maskWidth) * mask.width);

  const sorted = Array.from(outProfile).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const surfaceY =
    sorted.length % 2 === 0
      ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
      : (sorted[mid] ?? 0);

  return { surfaceY, surfaceLeft, surfaceRight };
}

interface SmoothTrack {
  id: number;
  active: boolean;
  touchedTick: number;
  hasEstimate: boolean;
  y: number;
  left: number;
  right: number;
  profile: Float32Array;
}

/** Cost/status readout for the debug overlay — see App.ts's formatSegDebugText.
 * A fresh small object per tick (this fires at most a few times a second,
 * not in the render loop — see this file's own ALLOCATION note above). */
export interface SegDebugInfo {
  status: 'idle' | 'loading' | 'ready' | 'error';
  cadenceHz: number;
  instanceCount: number;
  lastPreprocessMs: number;
  lastInferenceMs: number;
  lastPostprocessMs: number;
  lastTotalMs: number;
  ticks: number;
  errors: number;
}

export interface SegGameBridgeOptions {
  video: HTMLVideoElement;
  modelPath?: string;
  inputSize?: number;
  /** Passes per second — see DEFAULT_HZ's doc. */
  hz?: number;
  scoreThreshold?: number;
  iouThreshold?: number;
  maxInstances?: number;
  /** Reused array, read synchronously — same contract as
   * `ObjectDetectorOptions.onTrackedObjects` in types.ts. */
  onTrackedObjects?: (objects: readonly TrackedObject[]) => void;
  /** Fires after every completed pass (success or failure) — see
   * `SegDebugInfo`. */
  onDebugInfo?: (info: SegDebugInfo) => void;
}

export interface SegGameBridge {
  /** Load the model (first call only) and begin ticking at the configured
   * cadence. Never rejects/throws — a load failure lands in `'error'`
   * status and the bridge simply reports nothing thereafter. Safe to call
   * again after `stop()` — resumes instantly without re-fetching the model. */
  start(): Promise<void>;
  /** Halt the ticking loop. Keeps the loaded model/worker alive so a
   * restart is instant, matching ObjectDetector's own start/stop contract. */
  stop(): void;
  /** Stop and release the worker/model entirely. */
  dispose(): void;
}

export function createSegGameBridge(options: SegGameBridgeOptions): SegGameBridge {
  const hz = options.hz ?? DEFAULT_HZ;
  const intervalMs = 1000 / hz;

  const segmenter: InstanceSegmenter = createInstanceSegmenter({
    video: options.video,
    inputSize: options.inputSize ?? DEFAULT_INPUT_SIZE,
    modelPath: options.modelPath ?? DEFAULT_MODEL_PATH,
    scoreThreshold: options.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD,
    iouThreshold: options.iouThreshold ?? DEFAULT_IOU_THRESHOLD,
    maxInstances: options.maxInstances ?? DEFAULT_MAX_INSTANCES,
    onStateChange(next) {
      if (next === 'ready') status = 'ready';
      else if (next === 'error') status = 'error';
      else if (next === 'loading') status = 'loading';
    },
  });

  const tracker: DetectionTracker = createDetectionTracker();

  // Fixed-size pools — the only allocation of Detection objects for the life
  // of the bridge, matching ObjectDetector.ts's own pattern.
  const pool: Detection[] = Array.from({ length: MAX_RESULTS }, () => ({
    kind: 'vehicle' as DetectedKind,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    score: 0,
  }));
  const output: Detection[] = [];
  const sourceMasks: (InstanceMask | null)[] = new Array(MAX_RESULTS).fill(null);
  const profileScratch = new Float32Array(SURFACE_PROFILE_SAMPLES);

  const smoothTracks: SmoothTrack[] = Array.from({ length: MAX_SMOOTH_TRACKS }, () => ({
    id: 0,
    active: false,
    touchedTick: -1,
    hasEstimate: false,
    y: 0,
    left: 0,
    right: 0,
    profile: new Float32Array(SURFACE_PROFILE_SAMPLES),
  }));
  let smoothTickCounter = 0;

  let status: SegDebugInfo['status'] = 'idle';
  let loaded = false;
  let loadingPromise: Promise<void> | null = null;
  let ticking = false;
  let disposed = false;
  let inflight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastTickAtMs = 0;

  let ticks = 0;
  let errors = 0;
  let lastPreprocessMs = 0;
  let lastInferenceMs = 0;
  let lastPostprocessMs = 0;
  let lastInstanceCount = 0;

  function findOrClaimSmoothTrack(id: number): SmoothTrack | null {
    let free: SmoothTrack | null = null;
    for (let i = 0; i < smoothTracks.length; i++) {
      const t = smoothTracks[i];
      if (!t) continue;
      if (t.active && t.id === id) return t;
      if (!t.active && !free) free = t;
    }
    if (!free) return null;
    free.id = id;
    free.active = true;
    free.hasEstimate = false;
    return free;
  }

  function sweepStaleSmoothTracks(): void {
    for (let i = 0; i < smoothTracks.length; i++) {
      const t = smoothTracks[i];
      if (t && t.active && t.touchedTick !== smoothTickCounter) t.active = false;
    }
  }

  function buildDetections(instances: readonly InstanceMask[]): void {
    output.length = 0;
    for (const inst of instances) {
      if (output.length >= pool.length) break;
      const kind = LABEL_TO_KIND[inst.label];
      if (!kind) continue;
      const slot = pool[output.length];
      if (!slot) break;
      slot.kind = kind;
      slot.x = clamp01(inst.x);
      slot.y = clamp01(inst.y);
      slot.width = clamp01(inst.width);
      slot.height = clamp01(inst.height);
      slot.score = inst.score;
      sourceMasks[output.length] = inst;
      output.push(slot);
    }
  }

  /**
   * For every live, vehicle-kind track, find this tick's best-IoU-matching
   * source mask (if any) and replace the tracker's flat box-top fallback
   * with the mask-derived surface, smoothed per-track. person/sign objects
   * are left exactly as the tracker wrote them — same "no shape to find"
   * convention SurfaceProfileFinder uses for non-vehicle kinds.
   */
  function refineFromMasks(tracked: readonly TrackedObject[], dt: number): void {
    smoothTickCounter++;
    for (let i = 0; i < tracked.length; i++) {
      const obj = tracked[i];
      if (!obj || obj.kind !== 'vehicle') continue;

      let bestIdx = -1;
      let bestIou = MASK_MATCH_MIN_IOU;
      for (let j = 0; j < output.length; j++) {
        const det = output[j];
        if (!det || det.kind !== obj.kind) continue;
        const overlap = iouXYWH(obj.x, obj.y, obj.width, obj.height, det.x, det.y, det.width, det.height);
        if (overlap > bestIou) {
          bestIou = overlap;
          bestIdx = j;
        }
      }
      if (bestIdx < 0) continue; // no confident mask this tick — leave the tracker's fallback

      const mask = sourceMasks[bestIdx];
      if (!mask) continue;
      const candidate = surfaceFromMask(mask, profileScratch);
      if (!candidate) continue;

      const track = findOrClaimSmoothTrack(obj.id);
      if (!track) {
        // Pool exhausted (shouldn't happen — comfortably sized) — use the
        // candidate unsmoothed rather than dropping it.
        obj.surfaceY = candidate.surfaceY;
        obj.surfaceLeft = candidate.surfaceLeft;
        obj.surfaceRight = candidate.surfaceRight;
        obj.surfaceProfile.set(profileScratch);
        continue;
      }
      track.touchedTick = smoothTickCounter;

      if (!track.hasEstimate) {
        track.hasEstimate = true;
        track.y = candidate.surfaceY;
        track.left = candidate.surfaceLeft;
        track.right = candidate.surfaceRight;
        track.profile.set(profileScratch);
      } else {
        const k = smoothingFactor(SURFACE_SMOOTHING_RATE, dt);
        track.y += (candidate.surfaceY - track.y) * k;
        track.left += (candidate.surfaceLeft - track.left) * k;
        track.right += (candidate.surfaceRight - track.right) * k;
        for (let p = 0; p < SURFACE_PROFILE_SAMPLES; p++) {
          const cv = profileScratch[p] ?? candidate.surfaceY;
          const pv = track.profile[p] ?? cv;
          track.profile[p] = pv + (cv - pv) * k;
        }
      }

      obj.surfaceY = clamp01(track.y);
      obj.surfaceLeft = clamp01(track.left);
      obj.surfaceRight = clamp01(track.right);
      for (let p = 0; p < SURFACE_PROFILE_SAMPLES; p++) {
        obj.surfaceProfile[p] = clamp01(track.profile[p] ?? obj.surfaceY);
      }
    }
    sweepStaleSmoothTracks();
  }

  function debugInfoSnapshot(): SegDebugInfo {
    return {
      status,
      cadenceHz: hz,
      instanceCount: lastInstanceCount,
      lastPreprocessMs,
      lastInferenceMs,
      lastPostprocessMs,
      lastTotalMs: lastPreprocessMs + lastInferenceMs + lastPostprocessMs,
      ticks,
      errors,
    };
  }

  function scheduleNext(): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(tick, intervalMs);
  }

  function tick(): void {
    timer = null;
    if (!ticking) return;
    void runOnce();
  }

  async function runOnce(): Promise<void> {
    if (inflight) {
      scheduleNext();
      return;
    }
    inflight = true;
    const result = await segmenter.detect().catch(() => null);
    inflight = false;
    if (!ticking || disposed) return; // stopped/disposed while this was in flight

    ticks++;
    if (!result) {
      errors++;
    } else {
      lastPreprocessMs = result.preprocessMs;
      lastInferenceMs = result.inferenceMs;
      lastPostprocessMs = result.postprocessMs;
      lastInstanceCount = result.instances.length;

      const now = performance.now();
      const dt = lastTickAtMs === 0 ? intervalMs / 1000 : (now - lastTickAtMs) / 1000;
      lastTickAtMs = now;

      buildDetections(result.instances);
      const tracked = tracker.update(output, dt);
      refineFromMasks(tracked, dt);
      options.onTrackedObjects?.(tracked);
    }
    options.onDebugInfo?.(debugInfoSnapshot());
    if (ticking) scheduleNext();
  }

  return {
    async start(): Promise<void> {
      if (disposed) return;
      if (!loaded) {
        if (!loadingPromise) {
          status = 'loading';
          loadingPromise = segmenter
            .start()
            .then(() => {
              // InstanceSegmenter.start() NEVER REJECTS — like the rest of
              // this codebase's vision layer, it catches its own failures
              // (missing model file, worker crash, no wasm backend) and
              // reports them through `onStateChange('error')` instead, which
              // the `onStateChange` handler passed to createInstanceSegmenter
              // above has already applied to `status` by the time this
              // `.then()` runs (the callback fires synchronously inside
              // `start()`, before its returned promise settles). So success
              // is "the promise resolved AND status is still what loading
              // left it as" — never assume resolution alone means it worked.
              if (status === 'error') {
                loaded = false;
                return;
              }
              loaded = true;
              status = 'ready';
            })
            .catch((err: unknown) => {
              // Defensive only — see above, this path is not expected to be
              // reachable given InstanceSegmenter.start()'s own contract, but
              // never trust a dependency's "never throws" doc comment alone.
              status = 'error';
              console.warn('[SegGameBridge] failed to start the segmentation worker; the model file may be missing — see docs/dev-instance-segmentation.md.', err);
            })
            .finally(() => {
              loadingPromise = null;
            });
        }
        await loadingPromise;
        // Fire one snapshot right away regardless of outcome — a phone
        // tester reading the on-screen `?debug` overlay (the whole point of
        // this being visible without a cable) needs to see `status=error`
        // even when load failed before a single tick ever ran; ticks only
        // report their own snapshot from inside runOnce() below.
        options.onDebugInfo?.(debugInfoSnapshot());
        if (!loaded) return; // load failed — degrade to reporting nothing further, never throw
      }
      if (ticking) return;
      ticking = true;
      lastTickAtMs = 0;
      scheduleNext();
    },

    stop(): void {
      ticking = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },

    dispose(): void {
      disposed = true;
      ticking = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      segmenter.dispose();
      tracker.reset();
      loaded = false;
      status = 'idle';
    },
  };
}
