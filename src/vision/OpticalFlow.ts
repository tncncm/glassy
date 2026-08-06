/**
 * PRIVACY — read this before touching anything below.
 *
 * This is the third (and only other) place in Glassy that reads camera
 * pixels — the first two are SceneAnalyser and SurfaceProfileFinder. Exactly
 * the same discipline applies: it draws the live <video> into a tiny (see
 * SAMPLE_WIDTH below, height is derived, usually well under 100x60) offscreen
 * canvas ONCE per sample tick, reduces that single frame to a greyscale
 * buffer, does a bounded amount of integer arithmetic over it, and discards
 * every pixel before the tick ends. The canvas, its 2D context and every
 * scratch typed array are allocated once (lazily, the first time the video
 * has real dimensions) and reused forever; the `ImageData` obtained from
 * `getImageData` is read into the greyscale buffer and dropped in the same
 * call, never stored on a closure or `this`. The only things that survive
 * past a single tick are a few small typed arrays and a handful of numbers —
 * a flow field of block displacements, a focus-of-expansion point, an
 * ego-motion magnitude, and a short list of candidate boxes — all mutated in
 * place on reused objects and handed back on every read.
 *
 * No recording, no upload, no `localStorage`, no `toDataURL`/`toBlob`/
 * `captureStream`/`MediaRecorder`, no `fetch`, no `console.log` of pixel
 * data. `stop()` drops every working buffer. If you are tempted to keep a
 * frame, a crop or a thumbnail around for longer than the current tick, stop
 * — read the matching PRIVACY comment above `Detection` in src/types.ts
 * first, and change the user-facing copy before you change this.
 *
 * WHAT THIS FILE DOES AND WHY
 *
 * MediaPipe object detection costs a multi-megabyte download and real
 * battery, and only works in daylight on roads with recognisable traffic —
 * nothing in a tunnel, at night, or in rain. This is the replacement: no
 * model, no network fetch, no wasm runtime, and it works in the dark.
 *
 * The insight: the camera looks forward through a windscreen of a moving
 * car. The static world — road, barriers, signs — expands radially outward
 * from a single point (the focus of expansion, "where we are driving
 * toward") as we drive into it. A vehicle travelling at roughly our own
 * speed is nearly STATIONARY relative to that expansion pattern. So "what
 * moves differently from the road" finds the things worth reacting to
 * without ever knowing what they are:
 *
 *   1. Downscale the frame to a small greyscale buffer, sized to roughly
 *      match the video's own aspect ratio (see `setupBuffers` — using the
 *      true aspect keeps a downsampled pixel roughly the same width and
 *      height in world terms, which matters here: radial direction is a 2D
 *      geometry claim, not a per-axis one, and stretching it would bias
 *      every angle test).
 *   2. Split it into a coarse grid of blocks and, for each, brute-force
 *      search a small integer pixel radius in the previous frame for the
 *      displacement minimising SAD (sum of absolute differences). Cheap on
 *      purpose — this is why a coarse grid and a small search window are
 *      enough.
 *   3. Fit the dominant radial-expansion model to that field. NOT by least
 *      squares (one independently-moving block would drag the fit off
 *      target) but by a Hough-style vote: for pure camera translation, the
 *      focus of expansion lies exactly on the line through every static
 *      block in the direction of its own flow vector, regardless of that
 *      block's depth (only the flow's MAGNITUDE depends on depth; its
 *      DIRECTION does not). Every valid block casts a vote along that line
 *      across a coarse candidate grid; the cell with the most votes wins.
 *      A handful of outliers just cast a few wrong votes — they don't move
 *      the peak.
 *   4. Re-check every block's direction against the winning focus of
 *      expansion to get a clean inlier set, fit the scene's expansion RATE
 *      from those inliers (sigma-clipped mean, another outlier-robust step,
 *      not a plain mean), then compare every valid block's actual flow
 *      against what that rate predicts for its position. A block whose
 *      residual is too large is either moving independently or sitting at a
 *      very different depth than the road — both are "something real is
 *      there" in a driving scene. Adjacent flagged blocks are flood-filled
 *      into boxes and handed out as candidates.
 *   5. Reject the obvious junk before any of the above sees it: the bonnet
 *      at the bottom of frame (excluded by row), and — this is the
 *      important one — anything with too little texture to match reliably.
 *      A flat grey road or the sky gives a confident-LOOKING but meaningless
 *      match (every candidate shift scores about the same), so blocks are
 *      gated on match QUALITY (how much the winning shift stands out from
 *      the rest) and on raw texture variance, not on the winning shift
 *      alone. This one gate is what keeps the sky and a featureless lane out
 *      without hand-picking a fixed "sky region".
 *
 * HONESTY. This cannot say "that is a truck" — it has no concept of objects,
 * only of "this patch of pixels moved differently than the road did". It
 * hands out boxes and a confidence and stops there; `DetectionTracker`
 * (unmodified, already built for exactly this) does the temporal smoothing
 * that turns a jittery per-tick box into something stable enough to build a
 * platform on. Every `Detection` this file emits uses `kind: 'vehicle'`
 * (see the constant below) because that is the one honest label available:
 * "something solid, moving with us" — which happens to be exactly what
 * `DetectedKind`'s `'vehicle'` bucket means in this game. It is never
 * `'person'` or `'sign'`; optical flow alone cannot tell those apart from a
 * car-sized static object, and guessing would be worse than not guessing.
 */

import type { DetectedKind, Detection } from '../types.ts';

/* ------------------------------------------------------------------ */
/* Tunables                                                             */
/* ------------------------------------------------------------------ */

/**
 * Fixed downsample width. Height is derived per-stream from the video's own
 * aspect ratio (see `setupBuffers`) and rounded to a whole number of blocks,
 * so a downsampled pixel is close to square in world terms — the radial
 * fit below is a 2D angle test and a stretched image would bias every
 * angle. Small on purpose: this runs on an iPhone CPU/GPU shared with a
 * 60fps Pixi render over the same live video, at a handful of Hz.
 */
const SAMPLE_WIDTH = 80;
/** Safety clamps on the derived height for pathological (e.g. portrait) aspect ratios. */
const MIN_SAMPLE_HEIGHT = 30;
const MAX_SAMPLE_HEIGHT = 70;
/** If the video's aspect ratio drifts more than this (e.g. an orientation
 * change), buffers are dropped and rebuilt against the new aspect. */
const ASPECT_CHANGE_REBUILD_THRESHOLD = 0.08;

/** Block size in downsampled pixels. Grid dimensions are derived from this. */
const BLOCK_SIZE = 5;

/** Integer pixel search radius for block matching, in downsampled pixels. */
const SEARCH_RADIUS = 6;

/** Ignore the bottom slice of frame — the bonnet/dashboard, always present,
 * nearly static regardless of ego-motion, and not part of the road ahead. */
const BONNET_MARGIN_FRACTION = 0.12;

/**
 * Peak-to-mean SAD contrast (0..1, see `matchBlock`) below which a block's
 * winning displacement is not trusted at all — a flat road or the sky gives
 * every candidate shift a similarly low score, which is a meaningless
 * "confident" zero as much as any other answer.
 */
const MIN_BLOCK_QUALITY = 0.14;

/** Raw luma variance (0..255 scale, squared) below which a block is judged
 * too textureless to match reliably regardless of its quality score — a
 * second, independent guard against a flat surface. */
const MIN_TEXTURE_VARIANCE = 14;

/** Flow magnitude (downsampled px) below which a block is too close to
 * "not moving" to be trusted for a direction vote or an inlier check —
 * direction is meaningless noise at that scale. */
const MIN_FLOW_FOR_DIRECTION = 0.6;

/* --- focus-of-expansion Hough voting --- */

/** FOE candidate search space, in normalized frame fractions, per axis.
 * Extends past [0,1] so a FOE just off-frame (a gentle bend in the road)
 * still gets found rather than clipped to the frame edge. */
const FOE_SEARCH_MIN = -0.3;
const FOE_SEARCH_MAX = 1.3;
const FOE_SEARCH_SPAN = FOE_SEARCH_MAX - FOE_SEARCH_MIN;
/** Square voting grid over the search space above. */
const FOE_GRID_SIZE = 24;
const FOE_CELL_SIZE = FOE_SEARCH_SPAN / FOE_GRID_SIZE;
/** Radius (in cells) of the neighbourhood averaged around the winning cell
 * for a sub-cell-precision centroid, instead of snapping to a whole cell. */
const FOE_PEAK_NEIGHBOURHOOD = 1;
/** Minimum number of distinct blocks casting a vote before a FOE guess is
 * trusted at all — a couple of blocks agreeing by chance is not evidence. */
const MIN_VOTING_BLOCKS = 6;
/** Evidence count at which FOE confidence saturates to 1 (before the
 * peak-sharpness factor is applied). */
const FOE_CONFIDENCE_FULL_EVIDENCE = 18;

/* --- inlier re-check / expansion-rate fit --- */

/** Cosine of the max angle between a block's flow direction and the
 * direction from the fitted FOE to that block for it to count as an inlier
 * (~25 degrees). */
const INLIER_MAX_ANGLE_COS = 0.9;
/** Blocks closer to the FOE than this (normalized frame fraction) are
 * excluded from direction tests — right at the FOE, direction is undefined
 * and dominated by noise. */
const MIN_DIST_FROM_FOE = 0.05;
const MIN_INLIERS_FOR_RATE_FIT = 5;
/** Sigma-clipping half-width (in standard deviations) for the expansion-rate
 * fit — a RANSAC-ish alternative to a plain mean that one outlier ruins. */
const RATE_CLIP_SIGMAS = 1.5;

/* --- ego-motion --- */

/** Evidence count at which ego-motion confidence saturates to 1. */
const EGO_CONFIDENCE_FULL_EVIDENCE = 10;

/* --- residual / candidate detection --- */

/** A block's residual against the fitted radial model must exceed BOTH an
 * absolute floor (downsampled px — catches slow-growing, distant deviations
 * near the FOE where predicted magnitude is tiny) and a fraction of its own
 * predicted magnitude (catches large, obviously-wrong deviations far from
 * the FOE) to be flagged. */
const RESIDUAL_ABS_FLOOR = 1.1;
const RESIDUAL_REL_FACTOR = 0.6;
/** Minimum flood-filled cluster size, in blocks, to be worth reporting —
 * a single stray block is exactly the kind of one-off noise this whole
 * design tries to avoid trusting. */
const MIN_CLUSTER_BLOCKS = 2;
/** Hard cap on candidates handed out per tick. */
const MAX_CANDIDATES = 8;

const EPSILON = 1e-3;

/** The only label optical flow can honestly give — see the file header. */
const CANDIDATE_KIND: DetectedKind = 'vehicle';

/** Default sample rate. Deliberately low, like SceneAnalyser's default. */
const DEFAULT_SAMPLE_HZ = 5;

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/* ------------------------------------------------------------------ */
/* Public types                                                         */
/* ------------------------------------------------------------------ */

/**
 * The coarse block-grid flow field, reduced to typed arrays. All four arrays
 * are the SAME LENGTH (`cols * rows`) and REUSED across ticks — read them
 * synchronously, never retain a reference across a tick boundary.
 */
export interface FlowField {
  cols: number;
  rows: number;
  /** Per-block displacement found by block matching, in DOWNSAMPLED PIXELS
   * (not normalized — see the file header on why direction needs an
   * isotropic unit). Zero for a block that had no usable match. */
  dx: Float32Array;
  dy: Float32Array;
  /** Per-block match quality, 0..1. 0 means "no usable match" — textureless,
   * out of the search window, or in the excluded bonnet band; consumers
   * should treat `dx`/`dy` at that index as meaningless. */
  quality: Float32Array;
  /** Per-block centre, normalized 0..1 fractions of frame width/height.
   * Static for the lifetime of the buffers (recomputed only if the video's
   * aspect ratio changes), safe to cache by index. */
  cx: Float32Array;
  cy: Float32Array;
}

/** Where the road is going. Independently useful beyond feeding the
 * candidate-detection model — it is a more direct "where does the road go"
 * signal than a horizon row. */
export interface FocusOfExpansion {
  /** Normalized 0..1 frame fractions (may fall slightly outside 0..1 — see
   * `FOE_SEARCH_MIN`/`MAX` — on a bend). `null` when no reliable radial
   * pattern could be voted on this tick (too little texture, or the scene
   * isn't expanding at all, e.g. stopped). */
  x: number | null;
  y: number | null;
  /** 0..1. Consumers should ignore estimates below their own threshold,
   * same convention as `HorizonEstimate.confidence`. */
  confidence: number;
}

/** Roughly how fast we are moving, in image terms — zero when stopped. */
export interface EgoMotion {
  /** Normalized to "frame diagonals per second" so it is resolution/aspect
   * independent: the median-ish flow speed of the static world, divided by
   * elapsed time and by the sample buffer's diagonal. Not clamped to 0..1 —
   * fast motion can exceed 1. Exactly 0 when nothing in the static world is
   * moving (stopped, or no usable texture this tick). */
  magnitude: number;
  /** 0..1, driven by how many blocks the estimate is actually based on. */
  confidence: number;
}

export interface OpticalFlowOptions {
  /** The live camera element. Never mutated, only sampled. */
  video: HTMLVideoElement;
  /** Analyses per second. Keep low — this competes with the 60fps render loop. */
  sampleHz?: number;
}

export interface OpticalFlow {
  /** Begin sampling. Safe to call twice; a no-op without a live video. */
  start(): void;
  /** Stop sampling and drop every working buffer. Idempotent. */
  stop(): void;
  /** Latest flow field. Cheap field read, safe every frame; the arrays
   * inside are reused and mutated in place, never reallocated. */
  readonly flowField: FlowField;
  /** Latest focus-of-expansion estimate. Stable object, never allocates. */
  readonly focusOfExpansion: FocusOfExpansion;
  /** Latest ego-motion estimate. Stable object, never allocates. */
  readonly egoMotion: EgoMotion;
  /**
   * Candidate regions that deviate from the static-world radial-expansion
   * model, shaped like `Detection` so they can be fed straight into
   * `DetectionTracker.update()`. REUSED array of REUSED objects, valid only
   * until the next sample — read synchronously, never retain it.
   */
  readonly candidates: readonly Detection[];
  /** Wall-clock cost of the most recent sample tick, in milliseconds. For
   * on-device budget verification, not gameplay — 0 before the first tick. */
  readonly lastSampleCostMs: number;
}

/* ------------------------------------------------------------------ */
/* Implementation                                                       */
/* ------------------------------------------------------------------ */

export function createOpticalFlow(options: OpticalFlowOptions): OpticalFlow {
  const { video } = options;
  const sampleHz = options.sampleHz ?? DEFAULT_SAMPLE_HZ;
  const sampleIntervalMs = 1000 / Math.max(1, sampleHz);

  // The stable objects ever handed back from the getters below. Mutated in
  // place, never replaced.
  const flowField: FlowField = {
    cols: 0,
    rows: 0,
    dx: new Float32Array(0),
    dy: new Float32Array(0),
    quality: new Float32Array(0),
    cx: new Float32Array(0),
    cy: new Float32Array(0),
  };
  const foe: FocusOfExpansion = { x: null, y: null, confidence: 0 };
  const ego: EgoMotion = { magnitude: 0, confidence: 0 };
  const candidatesLive: Detection[] = [];

  // Fixed-size pools, independent of video dimensions — allocated once,
  // eagerly, here.
  const candidatesPool: Detection[] = Array.from({ length: MAX_CANDIDATES }, () => ({
    kind: CANDIDATE_KIND,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    score: 0,
  }));
  const foeVotes = new Float32Array(FOE_GRID_SIZE * FOE_GRID_SIZE);

  // Video-dimension-dependent state. Allocated lazily by `setupBuffers`,
  // dropped on `stop()` and rebuilt if the video's aspect ratio changes.
  let ctx: Context2D | null = null;
  let sampleHeight = 0;
  let gridCols = 0;
  let gridRows = 0;
  let blockCount = 0;
  let knownAspect = 0;

  let lumaCurrent: Float32Array | null = null;
  let lumaPrevious: Float32Array | null = null;
  let havePrevious = false;

  // Per-block scratch, sized to `blockCount`.
  let blockValid: Uint8Array | null = null; // quality+texture+bonnet gate
  let inlierMask: Uint8Array | null = null;
  let inlierRatio: Float32Array | null = null; // mag / dist, valid where inlierMask=1
  let deviant: Uint8Array | null = null;
  let visited: Uint8Array | null = null;
  let floodStack: Int32Array | null = null;

  let timer: ReturnType<typeof setInterval> | null = null;
  let disabledBySecurityError = false;
  let warnedOnce = false;
  let lastSampleAtMs: number | null = null;

  /** Measured cost of the last `sample()` call, milliseconds. A plain
   * number, updated in place — useful for a caller (or a dev harness) that
   * wants to confirm this stays inside its per-tick budget on device. */
  let lastSampleCostMs = 0;

  // Scratch for the block-matching pass — written directly by
  // `matchBlockInto` instead of returning a fresh object per block per
  // tick (this runs once per block, up to ~200 times a tick).
  let matchDx = 0;
  let matchDy = 0;
  let matchQuality = 0;
  let matchVariance = 0;

  function dropBuffers(): void {
    ctx = null;
    lumaCurrent = null;
    lumaPrevious = null;
    havePrevious = false;
    blockValid = null;
    inlierMask = null;
    inlierRatio = null;
    deviant = null;
    visited = null;
    floodStack = null;
    gridCols = 0;
    gridRows = 0;
    blockCount = 0;
    sampleHeight = 0;
    knownAspect = 0;
    flowField.cols = 0;
    flowField.rows = 0;
    flowField.dx = new Float32Array(0);
    flowField.dy = new Float32Array(0);
    flowField.quality = new Float32Array(0);
    flowField.cx = new Float32Array(0);
    flowField.cy = new Float32Array(0);
  }

  function resetOutputs(): void {
    foe.x = null;
    foe.y = null;
    foe.confidence = 0;
    ego.magnitude = 0;
    ego.confidence = 0;
    candidatesLive.length = 0;
  }

  /** Lazily (re)builds every video-dimension-dependent buffer. Returns false
   * (and leaves prior state untouched) if it can't — never throws. */
  function setupBuffers(): boolean {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw <= 0 || vh <= 0) return false;

    const aspect = vw / vh;
    if (ctx && blockCount > 0 && knownAspect > 0) {
      if (Math.abs(aspect - knownAspect) / knownAspect < ASPECT_CHANGE_REBUILD_THRESHOLD) {
        return true; // buffers already match this aspect closely enough
      }
      dropBuffers(); // aspect drifted (e.g. orientation change) — rebuild below
    }

    try {
      let context: Context2D | null = null;
      const rawHeight = SAMPLE_WIDTH / aspect;
      const clampedHeight = Math.min(MAX_SAMPLE_HEIGHT, Math.max(MIN_SAMPLE_HEIGHT, rawHeight));
      const rows = Math.max(1, Math.round(clampedHeight / BLOCK_SIZE));
      sampleHeight = rows * BLOCK_SIZE;

      if (typeof OffscreenCanvas !== 'undefined') {
        const oc = new OffscreenCanvas(SAMPLE_WIDTH, sampleHeight);
        context = oc.getContext('2d', { willReadFrequently: true, alpha: false });
      } else {
        const el = document.createElement('canvas');
        el.width = SAMPLE_WIDTH;
        el.height = sampleHeight;
        context = el.getContext('2d', { willReadFrequently: true, alpha: false });
      }
      if (!context) return false;

      gridCols = SAMPLE_WIDTH / BLOCK_SIZE;
      gridRows = rows;
      blockCount = gridCols * gridRows;
      knownAspect = aspect;
      ctx = context;

      lumaCurrent = new Float32Array(SAMPLE_WIDTH * sampleHeight);
      lumaPrevious = new Float32Array(SAMPLE_WIDTH * sampleHeight);
      havePrevious = false;

      blockValid = new Uint8Array(blockCount);
      inlierMask = new Uint8Array(blockCount);
      inlierRatio = new Float32Array(blockCount);
      deviant = new Uint8Array(blockCount);
      visited = new Uint8Array(blockCount);
      floodStack = new Int32Array(blockCount);

      flowField.cols = gridCols;
      flowField.rows = gridRows;
      flowField.dx = new Float32Array(blockCount);
      flowField.dy = new Float32Array(blockCount);
      flowField.quality = new Float32Array(blockCount);
      flowField.cx = new Float32Array(blockCount);
      flowField.cy = new Float32Array(blockCount);
      for (let r = 0; r < gridRows; r++) {
        for (let c = 0; c < gridCols; c++) {
          const i = r * gridCols + c;
          flowField.cx[i] = (c + 0.5) / gridCols;
          flowField.cy[i] = (r + 0.5) / gridRows;
        }
      }

      resetOutputs();
      return true;
    } catch {
      dropBuffers();
      return false;
    }
  }

  /** Clamped array read — border-replicate so the search window never reads
   * out of bounds without a branch-heavy per-pixel guard. */
  function lumaAt(buf: Float32Array, x: number, y: number, w: number, h: number): number {
    const cx = x < 0 ? 0 : x >= w ? w - 1 : x;
    const cy = y < 0 ? 0 : y >= h ? h - 1 : y;
    return buf[cy * w + cx] ?? 0;
  }

  /**
   * Block matching for a single block. Finds the integer displacement
   * (in downsampled px) minimising SAD between the current block and the
   * previous frame, plus a 0..1 quality score (peak-to-mean SAD contrast —
   * same "shape" idea SceneAnalyser uses for its confidence) and the
   * block's own raw luma variance (texture check).
   *
   * Writes its results into `matchDx`/`matchDy`/`matchQuality`/
   * `matchVariance` rather than returning an object — this runs up to ~200
   * times a tick and a fresh return object each call is exactly the kind of
   * per-tick allocation this module exists to avoid.
   */
  function matchBlockInto(
    curr: Float32Array,
    prev: Float32Array,
    w: number,
    h: number,
    blockX: number,
    blockY: number,
  ): void {
    let mean = 0;
    for (let v = 0; v < BLOCK_SIZE; v++) {
      for (let u = 0; u < BLOCK_SIZE; u++) {
        mean += lumaAt(curr, blockX + u, blockY + v, w, h);
      }
    }
    mean /= BLOCK_SIZE * BLOCK_SIZE;
    let variance = 0;
    for (let v = 0; v < BLOCK_SIZE; v++) {
      for (let u = 0; u < BLOCK_SIZE; u++) {
        const d = lumaAt(curr, blockX + u, blockY + v, w, h) - mean;
        variance += d * d;
      }
    }
    variance /= BLOCK_SIZE * BLOCK_SIZE;

    let bestSad = Infinity;
    let bestDx = 0;
    let bestDy = 0;
    let sadSum = 0;
    let sadCount = 0;

    for (let sy = -SEARCH_RADIUS; sy <= SEARCH_RADIUS; sy++) {
      for (let sx = -SEARCH_RADIUS; sx <= SEARCH_RADIUS; sx++) {
        let sad = 0;
        for (let v = 0; v < BLOCK_SIZE; v++) {
          for (let u = 0; u < BLOCK_SIZE; u++) {
            const c = lumaAt(curr, blockX + u, blockY + v, w, h);
            const p = lumaAt(prev, blockX + u - sx, blockY + v - sy, w, h);
            sad += Math.abs(c - p);
          }
        }
        sadSum += sad;
        sadCount++;
        if (sad < bestSad) {
          bestSad = sad;
          bestDx = sx;
          bestDy = sy;
        }
      }
    }

    const sadMean = sadCount > 0 ? sadSum / sadCount : 0;
    // Same "peak stands out from the mean" shape used by SceneAnalyser's
    // confidence: a flat/textureless block scores similarly at every shift
    // (sadMean ≈ bestSad), which naturally collapses this toward 0 without
    // needing a separate hand-picked "sky region".
    matchDx = bestDx;
    matchDy = bestDy;
    matchQuality = Math.max(0, Math.min(1, (sadMean - bestSad) / (sadMean + bestSad + EPSILON)));
    matchVariance = variance;
  }

  /** Casts one block's vote: the FOE lies on the line through the block's
   * centre in the direction of its flow vector (see file header). Steps
   * along that line across the voting grid, accumulating `weight` into
   * every cell it passes through. */
  function castFoeVote(px: number, py: number, dirX: number, dirY: number, weight: number): void {
    const len = Math.hypot(dirX, dirY);
    if (len < EPSILON) return;
    const ux = dirX / len;
    const uy = dirY / len;

    // Bound how far we need to step in either direction to cover the whole
    // search span from this starting point.
    const maxT = FOE_SEARCH_SPAN * 1.5;
    const step = FOE_CELL_SIZE * 0.5;
    const steps = Math.ceil(maxT / step);

    for (let sign = -1; sign <= 1; sign += 2) {
      for (let s = 0; s <= steps; s++) {
        const t = sign * s * step;
        const x = px + ux * t;
        const y = py + uy * t;
        if (x < FOE_SEARCH_MIN || x >= FOE_SEARCH_MAX || y < FOE_SEARCH_MIN || y >= FOE_SEARCH_MAX) {
          if (s === 0) continue;
          break; // left the search space in this direction; no point continuing further out
        }
        const col = Math.floor((x - FOE_SEARCH_MIN) / FOE_CELL_SIZE);
        const row = Math.floor((y - FOE_SEARCH_MIN) / FOE_CELL_SIZE);
        if (col < 0 || col >= FOE_GRID_SIZE || row < 0 || row >= FOE_GRID_SIZE) continue;
        const idx = row * FOE_GRID_SIZE + col;
        const current = foeVotes[idx] ?? 0;
        foeVotes[idx] = current + weight;
      }
    }
  }

  function sample(): void {
    if (disabledBySecurityError) return;
    if (document.hidden) return;
    if (video.readyState < 2) return;
    if (!setupBuffers()) return;
    if (!ctx || !lumaCurrent || !lumaPrevious || !blockValid ||
        !inlierMask || !inlierRatio || !deviant || !visited || !floodStack) return;

    const now = performance.now();
    const dt = lastSampleAtMs === null ? 1 / sampleHz : Math.max(1 / 60, (now - lastSampleAtMs) / 1000);
    lastSampleAtMs = now;

    const perfStart = now;
    const w = SAMPLE_WIDTH;
    const h = sampleHeight;

    try {
      ctx.drawImage(video, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);
      const data = imageData.data;
      const luma = lumaCurrent;
      for (let i = 0; i < luma.length; i++) {
        const o = i * 4;
        const r = data[o] ?? 0;
        const g = data[o + 1] ?? 0;
        const b = data[o + 2] ?? 0;
        luma[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      }
      // `imageData`/`data` are never referenced again — everything past
      // this point works only from `luma`, a reused scratch buffer of
      // brightness numbers, and `lumaPrevious`, last tick's copy of same.

      if (!havePrevious) {
        lumaPrevious.set(luma);
        havePrevious = true;
        resetOutputs();
        flowField.dx.fill(0);
        flowField.dy.fill(0);
        flowField.quality.fill(0);
        return;
      }

      const bonnetRowStart = Math.floor(gridRows * (1 - BONNET_MARGIN_FRACTION));

      // Pass 1: block matching.
      for (let r = 0; r < gridRows; r++) {
        for (let c = 0; c < gridCols; c++) {
          const i = r * gridCols + c;
          matchBlockInto(luma, lumaPrevious, w, h, c * BLOCK_SIZE, r * BLOCK_SIZE);
          flowField.dx[i] = matchDx;
          flowField.dy[i] = matchDy;
          flowField.quality[i] = matchQuality;
          const inBonnet = r >= bonnetRowStart;
          blockValid[i] =
            !inBonnet && matchQuality >= MIN_BLOCK_QUALITY && matchVariance >= MIN_TEXTURE_VARIANCE ? 1 : 0;
        }
      }

      // Pass 2: FOE Hough voting.
      foeVotes.fill(0);
      let votingBlocks = 0;
      for (let i = 0; i < blockCount; i++) {
        if (!blockValid[i]) continue;
        const dx = flowField.dx[i] ?? 0;
        const dy = flowField.dy[i] ?? 0;
        if (Math.hypot(dx, dy) < MIN_FLOW_FOR_DIRECTION) continue;
        castFoeVote(flowField.cx[i] ?? 0, flowField.cy[i] ?? 0, dx, dy, flowField.quality[i] ?? 0);
        votingBlocks++;
      }

      let foeConfident = false;
      let foeX = 0;
      let foeY = 0;
      if (votingBlocks >= MIN_VOTING_BLOCKS) {
        let peakIdx = -1;
        let peak = 0;
        let voteSum = 0;
        for (let i = 0; i < foeVotes.length; i++) {
          const v = foeVotes[i] ?? 0;
          voteSum += v;
          if (v > peak) {
            peak = v;
            peakIdx = i;
          }
        }
        if (peakIdx >= 0 && peak > 0) {
          const peakRow = Math.floor(peakIdx / FOE_GRID_SIZE);
          const peakCol = peakIdx % FOE_GRID_SIZE;
          let sumW = 0;
          let sumX = 0;
          let sumY = 0;
          for (let dr = -FOE_PEAK_NEIGHBOURHOOD; dr <= FOE_PEAK_NEIGHBOURHOOD; dr++) {
            for (let dc = -FOE_PEAK_NEIGHBOURHOOD; dc <= FOE_PEAK_NEIGHBOURHOOD; dc++) {
              const rr = peakRow + dr;
              const cc = peakCol + dc;
              if (rr < 0 || rr >= FOE_GRID_SIZE || cc < 0 || cc >= FOE_GRID_SIZE) continue;
              const wgt = foeVotes[rr * FOE_GRID_SIZE + cc] ?? 0;
              if (wgt <= 0) continue;
              const cellX = FOE_SEARCH_MIN + (cc + 0.5) * FOE_CELL_SIZE;
              const cellY = FOE_SEARCH_MIN + (rr + 0.5) * FOE_CELL_SIZE;
              sumW += wgt;
              sumX += cellX * wgt;
              sumY += cellY * wgt;
            }
          }
          if (sumW > EPSILON) {
            foeX = sumX / sumW;
            foeY = sumY / sumW;
            foeConfident = true;

            const meanVote = voteSum / foeVotes.length;
            const shape = (peak - meanVote) / (peak + meanVote + EPSILON);
            const evidence = Math.min(1, votingBlocks / FOE_CONFIDENCE_FULL_EVIDENCE);
            foe.confidence = Math.max(0, Math.min(1, shape * evidence));
            foe.x = foeX;
            foe.y = foeY;
          }
        }
      }
      if (!foeConfident) {
        foe.x = null;
        foe.y = null;
        foe.confidence = 0;
      }

      // Pass 3: inlier re-check + expansion-rate fit (only if FOE found).
      let rateAvailable = false;
      let expansionRate = 0;
      inlierMask.fill(0);
      let inlierCount = 0;
      if (foeConfident) {
        for (let i = 0; i < blockCount; i++) {
          if (!blockValid[i]) continue;
          const bx = flowField.cx[i] ?? 0;
          const by = flowField.cy[i] ?? 0;
          const fx = bx - foeX;
          const fy = by - foeY;
          const dist = Math.hypot(fx, fy);
          if (dist < MIN_DIST_FROM_FOE) continue;
          const dx = flowField.dx[i] ?? 0;
          const dy = flowField.dy[i] ?? 0;
          const mag = Math.hypot(dx, dy);
          if (mag < MIN_FLOW_FOR_DIRECTION) continue;
          const dot = (dx * fx + dy * fy) / (mag * dist);
          if (dot >= INLIER_MAX_ANGLE_COS) {
            inlierMask[i] = 1;
            // dist is in normalized frame fractions but dx/dy are in
            // downsampled px — convert dist to the same px unit via the
            // sample width so the ratio is dimensionally consistent.
            inlierRatio[i] = mag / (dist * SAMPLE_WIDTH);
            inlierCount++;
          }
        }

        if (inlierCount >= MIN_INLIERS_FOR_RATE_FIT) {
          let sum = 0;
          let count = 0;
          for (let i = 0; i < blockCount; i++) {
            if (!inlierMask[i]) continue;
            sum += inlierRatio[i] ?? 0;
            count++;
          }
          let mean = count > 0 ? sum / count : 0;
          let sqSum = 0;
          for (let i = 0; i < blockCount; i++) {
            if (!inlierMask[i]) continue;
            const d = (inlierRatio[i] ?? 0) - mean;
            sqSum += d * d;
          }
          const std = count > 0 ? Math.sqrt(sqSum / count) : 0;

          // One round of sigma-clipping: a RANSAC-ish alternative to a
          // plain mean that a single outlier ruins.
          let clippedSum = 0;
          let clippedCount = 0;
          const lo = mean - RATE_CLIP_SIGMAS * std;
          const hi = mean + RATE_CLIP_SIGMAS * std;
          for (let i = 0; i < blockCount; i++) {
            if (!inlierMask[i]) continue;
            const v = inlierRatio[i] ?? 0;
            if (v < lo || v > hi) continue;
            clippedSum += v;
            clippedCount++;
          }
          if (clippedCount > 0) {
            mean = clippedSum / clippedCount;
          }
          expansionRate = mean;
          rateAvailable = true;
        }
      }

      // Ego-motion: quality-weighted mean flow magnitude over the inlier
      // set when available (robust — excludes anything independently
      // moving), else over every valid block (still meaningful, just less
      // robust; used mainly for the "confidently near zero" stopped case,
      // where there IS no independent motion to be robust against).
      {
        let sumW = 0;
        let sumMagW = 0;
        let evidenceCount = 0;
        const useInliers = inlierCount >= MIN_INLIERS_FOR_RATE_FIT;
        for (let i = 0; i < blockCount; i++) {
          if (useInliers ? !inlierMask[i] : !blockValid[i]) continue;
          const dx = flowField.dx[i] ?? 0;
          const dy = flowField.dy[i] ?? 0;
          const wgt = flowField.quality[i] ?? 0;
          sumMagW += Math.hypot(dx, dy) * wgt;
          sumW += wgt;
          evidenceCount++;
        }
        const diag = Math.hypot(SAMPLE_WIDTH, sampleHeight);
        const meanMagPx = sumW > EPSILON ? sumMagW / sumW : 0;
        ego.magnitude = (meanMagPx / diag) / dt;
        ego.confidence = Math.max(0, Math.min(1, evidenceCount / EGO_CONFIDENCE_FULL_EVIDENCE));
      }

      // Pass 4: residual against the fitted model → deviant blocks.
      deviant.fill(0);
      if (rateAvailable) {
        for (let i = 0; i < blockCount; i++) {
          if (!blockValid[i]) continue;
          const bx = flowField.cx[i] ?? 0;
          const by = flowField.cy[i] ?? 0;
          const fx = bx - foeX;
          const fy = by - foeY;
          const dist = Math.hypot(fx, fy);
          if (dist < MIN_DIST_FROM_FOE) continue;
          const ux = fx / dist;
          const uy = fy / dist;
          const predictedMag = expansionRate * dist * SAMPLE_WIDTH;
          const predDx = ux * predictedMag;
          const predDy = uy * predictedMag;
          const dx = flowField.dx[i] ?? 0;
          const dy = flowField.dy[i] ?? 0;
          const residual = Math.hypot(dx - predDx, dy - predDy);
          const threshold = Math.max(RESIDUAL_ABS_FLOOR, RESIDUAL_REL_FACTOR * predictedMag);
          if (residual > threshold) deviant[i] = 1;
        }
      }

      // Pass 5: flood-fill adjacent deviant blocks into boxes.
      candidatesLive.length = 0;
      visited.fill(0);
      if (rateAvailable) {
        let stackTop = 0;
        for (let start = 0; start < blockCount; start++) {
          if (!deviant[start] || visited[start]) continue;
          stackTop = 0;
          floodStack[stackTop++] = start;
          visited[start] = 1;

          let minCol = Infinity, maxCol = -Infinity, minRow = Infinity, maxRow = -Infinity;
          let scoreSum = 0;
          let blockN = 0;

          while (stackTop > 0) {
            const idx = floodStack[--stackTop] ?? 0;
            const row = Math.floor(idx / gridCols);
            const col = idx % gridCols;
            minCol = Math.min(minCol, col);
            maxCol = Math.max(maxCol, col);
            minRow = Math.min(minRow, row);
            maxRow = Math.max(maxRow, row);
            scoreSum += flowField.quality[idx] ?? 0;
            blockN++;

            // Four neighbours, unrolled rather than built as an array
            // literal — this runs once per visited block, and a fresh
            // array per node is exactly the per-tick allocation this
            // module is built to avoid.
            if (row > 0) {
              const n = idx - gridCols;
              if (deviant[n] && !visited[n]) { visited[n] = 1; floodStack[stackTop++] = n; }
            }
            if (row < gridRows - 1) {
              const n = idx + gridCols;
              if (deviant[n] && !visited[n]) { visited[n] = 1; floodStack[stackTop++] = n; }
            }
            if (col > 0) {
              const n = idx - 1;
              if (deviant[n] && !visited[n]) { visited[n] = 1; floodStack[stackTop++] = n; }
            }
            if (col < gridCols - 1) {
              const n = idx + 1;
              if (deviant[n] && !visited[n]) { visited[n] = 1; floodStack[stackTop++] = n; }
            }
          }

          if (blockN < MIN_CLUSTER_BLOCKS) continue;
          if (candidatesLive.length >= MAX_CANDIDATES) continue;

          const left = minCol / gridCols;
          const right = (maxCol + 1) / gridCols;
          const top = minRow / gridRows;
          const bottom = (maxRow + 1) / gridRows;
          const slot = candidatesPool[candidatesLive.length];
          if (!slot) continue;
          slot.kind = CANDIDATE_KIND;
          slot.x = (left + right) / 2;
          slot.y = (top + bottom) / 2;
          slot.width = right - left;
          slot.height = bottom - top;
          const avgQuality = blockN > 0 ? scoreSum / blockN : 0;
          slot.score = Math.max(0, Math.min(1, avgQuality * Math.min(1, blockN / 4)));
          candidatesLive.push(slot);
        }
      }

      lumaPrevious.set(luma);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'SecurityError') {
        disabledBySecurityError = true;
        dropBuffers();
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
        if (!warnedOnce) {
          warnedOnce = true;
          console.warn(
            '[OpticalFlow] canvas read blocked by a SecurityError; optical flow disabled for this session.',
          );
        }
      }
      resetOutputs();
    } finally {
      lastSampleCostMs = performance.now() - perfStart;
    }
  }

  return {
    start(): void {
      if (timer !== null) return;
      if (disabledBySecurityError) return;
      timer = setInterval(sample, sampleIntervalMs);
    },
    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      dropBuffers();
      resetOutputs();
      lastSampleAtMs = null;
    },
    get flowField(): FlowField {
      return flowField;
    },
    get focusOfExpansion(): FocusOfExpansion {
      return foe;
    },
    get egoMotion(): EgoMotion {
      return ego;
    },
    get candidates(): readonly Detection[] {
      return candidatesLive;
    },
    get lastSampleCostMs(): number {
      return lastSampleCostMs;
    },
  };
}
