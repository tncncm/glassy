/**
 * PRIVACY — read this before touching anything below.
 *
 * This is the second (and only other) place in Glassy that reads camera
 * pixels — the first is SceneAnalyser. Exactly the same discipline applies:
 * it draws the live <video> into a tiny (see ROI_CANVAS_WIDTH/
 * ROI_CANVAS_HEIGHT below) offscreen canvas ONCE per detector tick, reduces
 * that single frame to a luma buffer, scans small slices of it, and discards
 * every pixel before the tick ends. The canvas, its 2D context and the scratch
 * typed arrays are allocated once and reused forever; the ImageData obtained
 * from `getImageData` is read and dropped in the same call, never stored on
 * `this`/closure state. The only things that survive past a single call are a
 * handful of numbers and small Float32Arrays per tracked object — written
 * directly onto the SAME reused `TrackedObject` the caller already owns.
 *
 * No recording, no upload, no `localStorage`, no `toDataURL`/`toBlob`/
 * `captureStream`/`MediaRecorder`, no `fetch`, no `console.log` of pixel
 * data. `stop()` drops every working buffer. If you are tempted to keep a
 * frame, a crop or a thumbnail around for longer than the current tick, stop
 * — read the matching PRIVACY comment above `TrackedObject` in src/types.ts
 * first, and change the user-facing copy before you change this.
 *
 * WHAT THIS FILE DOES
 *
 * The object detector's box is loose on purpose — it is a neural net's
 * "there is a vehicle somewhere in here", padded to be safe, and it wraps
 * mirrors, wing mirrors and a slice of sky or road along with the vehicle.
 * Landing a player character on that box's top edge means landing on empty
 * air a few pixels above the actual vehicle. Worse, even the box's true top
 * edge is a single flat line, and a real vehicle seen from behind is not
 * flat: a bonnet or boot sits low at the edges, then a windscreen or rear
 * window rises, then the roof runs flat across the top. A flat landing
 * surface reads as a rectangle floating near a car, not as the car.
 *
 * This file narrows the loose box down to the vehicle's actual TOP PROFILE
 * using the same cheap classical-CV move as SceneAnalyser: a per-row
 * luma-gradient scan, just run over small regions instead of the whole
 * frame, and just for the rows/columns a detection box says to look at.
 *
 * Per tracked object, per tick:
 *   1. Crop the box's region out of this tick's luma buffer.
 *   2. Scan downward from the box top for the row with the strongest,
 *      most row-like (as opposed to speckly) luma gradient across the WHOLE
 *      box width — the vehicle's silhouette against the sky or the road
 *      behind it. This single flat row is `surfaceY`/`Left`/`Right`, kept
 *      for callers that only want one number — same algorithm as before.
 *   3. Subdivide that same trusted width into a handful of column bins and
 *      repeat step 2 independently PER BIN — the vehicle's edge one bin over
 *      is rarely at exactly the same row as its neighbour's, and that
 *      difference is the bonnet/windscreen/roof shape. A column whose
 *      candidate disagrees sharply with both immediate neighbours (a wing
 *      mirror, an aerial, a sliver of background) is rejected and filled by
 *      interpolating across the gap, so one stray column can't put a spike
 *      in an otherwise smooth outline. The per-bin result is then resampled
 *      up to the fixed `SURFACE_PROFILE_SAMPLES` the rest of the app expects
 *      — this is `surfaceProfile`.
 *   4. Smooth both across time, per object id, and reject single-tick jumps
 *      the same way SceneAnalyser refuses to hop between crash-barrier
 *      rails. The profile rides along with the SAME accept/jump decision the
 *      flat row already makes — a real roof-line change and a real shape
 *      change are the same event, one new edge found or lost.
 *
 * When the edge is too weak to trust (dark car on a dark background, a box
 * mostly full of background, a sliver of vehicle at the frame edge), this
 * file does nothing: DetectionTracker has already written the box's own top
 * edge and sides into `surfaceY`/`surfaceLeft`/`surfaceRight`, and a flat
 * `surfaceProfile` matching it, before this runs — an honest "we don't know,
 * use the flat box" beats a confident, jagged guess.
 */

import { SURFACE_PROFILE_SAMPLES, type TrackedObject } from '../types.ts';

/**
 * Offscreen sample size. Small on purpose, same reasoning as SceneAnalyser:
 * this runs on an iPhone CPU/GPU shared with a 60fps Pixi render and a live
 * video decode. Big enough that a nearby vehicle's box is tens of pixels
 * across (enough rows/columns for the gradient scan to mean something),
 * small enough that drawing + reading it back costs nothing measurable at
 * the detector's ~6Hz tick rate. Not tied to the video's native resolution
 * or aspect ratio — box coordinates are already 0..1 fractions of frame
 * width/height, so a non-uniform stretch onto this canvas doesn't bias
 * anything; x fractions map through the width, y fractions through the
 * height, independently.
 */
const ROI_CANVAS_WIDTH = 320;
const ROI_CANVAS_HEIGHT = 180;

/**
 * Only the top slice of a box is worth searching. A loose detection box
 * extends well below the roof (down to the bumper), and the roof — by
 * definition the thing we want — is never in the bottom third of even a
 * badly-padded box. Searching the whole box risks locking onto a window
 * trim line or a door shut-line instead of the sky/roof boundary.
 */
const SEARCH_BAND_FRACTION = 0.65;

/**
 * Skip this fraction of the box's height right at the top before searching.
 * The detector's own crop edge is a soft, low-confidence boundary (partly
 * anti-aliased, partly just "where the model's padding ended"), not a real
 * scene edge — treating row 0 as a candidate would occasionally lock onto
 * the box's own edge instead of the vehicle's.
 */
const TOP_SKIP_FRACTION = 0.03;

/** Below this many canvas pixels in either dimension, a box's ROI is too
 * small to say anything meaningful — a distant car might be 8px tall in the
 * sample canvas. Skip refinement entirely rather than fit noise. */
const MIN_ROI_WIDTH_PX = 10;
const MIN_ROI_HEIGHT_PX = 6;

/**
 * Luma-gradient magnitude (0..255 scale) that counts as a "strong" edge —
 * same role and same ballpark as SceneAnalyser's STRONG_EDGE_MAGNITUDE, but
 * kept as an independent constant: this scans much smaller, more zoomed-in
 * regions, so the right absolute scale is not guaranteed to match.
 */
const STRONG_EDGE_MAGNITUDE = 20;

/**
 * The vehicle edge is the FIRST strong edge scanning down from the sky, not
 * necessarily the strongest edge anywhere in the search band. A close-up
 * vehicle routinely has a much stronger edge lower down — the dark
 * window-tint/hood boundary, a shut-line, a bumper, a beltline — than the
 * true edge/sky line above it, which can be genuinely subtle (a pale roof
 * against a bright sky). Picking the single strongest row in the band, or
 * even the first row within some fraction of the band's loudest row, both
 * end up walking straight past a real-but-quiet edge to land on that louder
 * distractor. What "first strong edge" actually means is a LOCAL maximum in
 * the gradient signal — score higher than the row immediately above and
 * immediately below it — clearing a modest absolute floor so pure sensor
 * noise near the very top can't qualify. That is the textbook definition of
 * "an edge", and unlike a global-peak comparison it is indifferent to how
 * much louder some unrelated edge further down happens to be.
 */
const ROOF_EDGE_FLOOR = STRONG_EDGE_MAGNITUDE * 0.4;

/**
 * Peak-to-mean shape ratio (0..1) below which the picked row isn't trusted
 * at all — same two-factor confidence idea as SceneAnalyser, but "mean"
 * here is the average score of the rows scanned BEFORE the picked one (the
 * sky/background this candidate edge stands out from), not the whole
 * search band's average. The band's own average is pulled up by whatever
 * busy, unrelated edges live lower in the box (windows, trim, wheels) and
 * would make a real-but-quiet edge look unremarkable by comparison even
 * though it stands out plainly from the flat region just above it.
 */
const CONFIDENCE_THRESHOLD = 0.18;
/** Minimum sample of rows above a candidate required before trusting its
 * local mean; below this, fall back to a conservative assumed background
 * level rather than a noisy near-zero-sample average. */
const MIN_LOCAL_MEAN_SAMPLES = 2;
const ASSUMED_BACKGROUND_SCORE = ROOF_EDGE_FLOOR * 0.5;
const EPSILON = 1e-3;

/**
 * At the winning row, a column counts as "part of the roof edge" once its
 * own gradient is at least this fraction of that row's peak gradient. The
 * contiguous run of such columns through the peak becomes the refined width.
 */
const WIDTH_COHERENCE_FRACTION = 0.35;

/**
 * However narrow the coherent run comes out, never report a surface
 * narrower than this fraction of the box's own width. A razor-thin bright
 * reflection can otherwise pass the coherence test on its own; a landing
 * surface a couple of pixels wide is not a useful clamp on the width, it is
 * noise wearing a confident-looking number.
 */
const MIN_SURFACE_WIDTH_FRACTION_OF_BOX = 0.3;

/**
 * Exponential-smoothing rate (1/s) for accepted in-band moves. Deliberately
 * gentler than DetectionTracker's own SMOOTHING_RATE (8): the box position
 * comes from a neural net's sub-pixel regression, already fairly clean, but
 * `surfaceY`/`Left`/`Right`/`Profile` come from a coarse per-row pixel scan —
 * a single-row difference is a real, unavoidable quantisation step — so this
 * needs to average over more ticks to keep the landing surface from
 * visibly stepping as the winning row hops by one.
 */
const SMOOTHING_RATE = 3;

/**
 * A candidate more than this fraction of the box's OWN height away from the
 * current smoothed surfaceY is a "jump", not a refinement — box height (not
 * a fixed frame fraction) because a distant car's whole box can be smaller
 * than a near car's jump threshold would allow. Y drives the jump/agreement
 * decision; left/right/profile ride along with whatever that decision was
 * (smoothed when Y is in-band, snapped once a Y jump is confirmed) since a
 * genuine roof-line change and a genuine width/shape change are almost
 * always the same event — one new edge, found or lost together. Requires two
 * consecutive agreeing Y candidates before a jump is followed, exactly
 * SceneAnalyser's "don't hop rails on one noisy sample".
 */
const JUMP_FRACTION_OF_BOX = 0.4;
/** How close two jump candidates must land (as a fraction of box size) to
 * count as "agreeing". */
const JUMP_AGREEMENT_FRACTION_OF_BOX = 0.25;

/** Consecutive low-confidence/rejected ticks after which a track's held
 * smoothed estimate is abandoned in favour of the box fallback outright,
 * rather than quietly drifting further from an object that may have
 * changed size or position while unconfirmed. ~5 ticks at 6Hz. */
const REJECT_STREAK_TO_FALLBACK = 5;

/** Fixed pool size for per-object smoothing state — comfortably above
 * DetectionTracker's own MAX_TRACKS (12), so every live track always gets a
 * slot without ever allocating one. */
const MAX_SURFACE_TRACKS = 16;

/* ------------------------------------------------------------------ */
/* Per-column profile                                                   */
/* ------------------------------------------------------------------ */

/**
 * How many independent column bins the confident run is subdivided into
 * for the per-column scan, at most. Deliberately fewer than
 * `SURFACE_PROFILE_SAMPLES` (24): a real vehicle's bonnet/windscreen/roof
 * silhouette is three or four broad steps, not 24 independent measurements,
 * and each bin's own scan costs roughly what the single flat scan already
 * costs per pixel of width — 24 full-cost column scans on top of the
 * existing flat scan would be real money on a phone CPU. This coarser count
 * is scanned cheaply, then linearly resampled up to the fixed count callers
 * need (see `buildProfileCandidate`), which reproduces the bonnet/windscreen
 * steps just as visibly since they are the low-frequency part of the shape,
 * while the resample itself costs nothing (no pixels touched).
 */
const INTERNAL_PROFILE_SAMPLES = 16;

/** A column bin narrower than this many ROI canvas pixels is too thin for
 * its own gradient average to mean anything distinct from its neighbour —
 * below this, the whole run is treated as a single flat bin instead. */
const MIN_COLUMN_WIDTH_PX = 4;

/**
 * An interior column bin whose candidate row differs from the median of
 * itself and its two immediate neighbours by more than this fraction of the
 * box's own height is treated as an outlier, not a real shape feature — a
 * wing mirror, an aerial, or a sliver of background poking into the
 * confident run. A genuine bonnet-to-windscreen or windscreen-to-roof step
 * moves several adjacent bins together, so neighbouring bins move WITH it
 * and it never trips a three-point median outlier test; only a single
 * isolated bin disagreeing with both neighbours at once does.
 */
const PROFILE_OUTLIER_REJECT_FRACTION_OF_BOX = 0.15;

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Per-object temporal smoothing state. Plain data, preallocated, recycled
 * by id exactly like DetectionTracker's own Track pool. `smoothedProfile` is
 * allocated once per pool slot at factory-creation time and mutated in
 * place forever after — never reallocated per tick or per object. */
interface SurfaceTrack {
  id: number;
  active: boolean;
  /** Set on every call that touches this slot; used to sweep stale slots
   * without allocating a Set of "seen" ids each tick. */
  touchedTick: number;
  hasEstimate: boolean;
  smoothedY: number;
  smoothedLeft: number;
  smoothedRight: number;
  smoothedProfile: Float32Array;
  rejectStreak: number;
  pendingY: number;
  pendingCount: number;
}

export interface SurfaceProfileFinder {
  /**
   * Draws the current video frame once, then refines `surfaceY`/
   * `surfaceLeft`/`surfaceRight`/`surfaceProfile` IN PLACE on every object in
   * `objects` — the same reused `TrackedObject`s the caller already owns.
   * `dt` is seconds since the previous call, for temporal smoothing. When
   * refinement isn't possible (too small, too weak an edge, video not
   * ready), an object's fields are left exactly as the caller set them —
   * this never invents a value, only improves on one already there. Never
   * throws.
   */
  refine(video: HTMLVideoElement, objects: readonly TrackedObject[], dt: number): void;
  /** Drop working buffers and forget all per-object smoothing state.
   * Idempotent. */
  stop(): void;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

function medianOf3(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

/** `1 - e^(-rate*dt)` — the same frame-rate-independent smoothing factor
 * DetectionTracker uses. */
function smoothingFactor(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

export function createSurfaceProfileFinder(): SurfaceProfileFinder {
  let ctx: Context2D | null = null;
  let luma: Float32Array | null = null; // ROI_CANVAS_WIDTH * ROI_CANVAS_HEIGHT
  // Scratch row-score buffer, sized once to the tallest possible search band
  // (the whole canvas height) and reused for every scan — the flat full-width
  // scan AND every per-column bin scan of every object, every tick. Never
  // reallocated.
  const rowScores = new Float32Array(ROI_CANVAS_HEIGHT);
  // Scratch buffers for the per-column profile pass. Sized once to the
  // largest possible bin/sample counts and reused for every object, every
  // tick — never reallocated. `internalRowScratch` holds one candidate row
  // (or NaN) per bin; `profileCandidateScratch` holds this tick's resampled
  // 0..1 candidate before it's folded into a track's smoothed profile.
  const internalRowScratch = new Float32Array(INTERNAL_PROFILE_SAMPLES);
  const profileCandidateScratch = new Float32Array(SURFACE_PROFILE_SAMPLES);
  let disabledBySecurityError = false;
  let warnedOnce = false;
  // TEMP DEBUG — remove before shipping.
  const __dbg = { calls: 0, pass1Total: 0, pass1Nan: 0, outlierRejected: 0, bigCalls: 0, tickCostSum: 0, tickCostCount: 0, tickCostMax: 0 };

  const tracks: SurfaceTrack[] = Array.from({ length: MAX_SURFACE_TRACKS }, () => ({
    id: 0,
    active: false,
    touchedTick: -1,
    hasEstimate: false,
    smoothedY: 0,
    smoothedLeft: 0,
    smoothedRight: 0,
    smoothedProfile: new Float32Array(SURFACE_PROFILE_SAMPLES),
    rejectStreak: 0,
    pendingY: 0,
    pendingCount: 0,
  }));
  let tickCounter = 0;

  function trySetupBuffers(): boolean {
    if (ctx && luma) return true;
    try {
      let context: Context2D | null = null;
      if (typeof OffscreenCanvas !== 'undefined') {
        const oc = new OffscreenCanvas(ROI_CANVAS_WIDTH, ROI_CANVAS_HEIGHT);
        context = oc.getContext('2d', { willReadFrequently: true, alpha: false });
      } else {
        const el = document.createElement('canvas');
        el.width = ROI_CANVAS_WIDTH;
        el.height = ROI_CANVAS_HEIGHT;
        context = el.getContext('2d', { willReadFrequently: true, alpha: false });
      }
      if (!context) return false;
      ctx = context;
      luma = new Float32Array(ROI_CANVAS_WIDTH * ROI_CANVAS_HEIGHT);
      return true;
    } catch {
      ctx = null;
      luma = null;
      return false;
    }
  }

  function dropBuffers(): void {
    ctx = null;
    luma = null;
  }

  function findOrClaimTrack(id: number): SurfaceTrack | null {
    let free: SurfaceTrack | null = null;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (!t) continue;
      if (t.active && t.id === id) return t;
      if (!t.active && !free) free = t;
    }
    if (!free) return null;
    free.id = id;
    free.active = true;
    free.hasEstimate = false;
    free.rejectStreak = 0;
    free.pendingCount = 0;
    return free;
  }

  function sweepStaleTracks(): void {
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (t && t.active && t.touchedTick !== tickCounter) {
        t.active = false;
      }
    }
  }

  /**
   * Scans luma columns [xLeft, xRight) over rows [bandStart, bandEnd) for the
   * first LOCAL-MAXIMUM row-gradient that clears both the absolute floor and
   * the shape/strength confidence gate — see ROOF_EDGE_FLOOR and
   * CONFIDENCE_THRESHOLD above for why. Returns the row, or `null` when
   * nothing in the range was worth trusting. Shared by the flat full-width
   * scan and every narrow per-column bin scan; the only thing that differs
   * between those callers is how wide a slice of columns is handed in.
   */
  function findEdgeRow(
    lumaBuf: Float32Array,
    xLeft: number,
    xRight: number,
    bandStart: number,
    bandEnd: number,
  ): number | null {
    const width = xRight - xLeft;
    if (bandEnd - bandStart < 2 || width < 1) return null;

    for (let y = bandStart; y < bandEnd; y++) {
      const rowOffset = y * ROI_CANVAS_WIDTH;
      const prevOffset = (y - 1) * ROI_CANVAS_WIDTH;
      let rowSum = 0;
      for (let x = xLeft; x < xRight; x++) {
        const cur = lumaBuf[rowOffset + x] ?? 0;
        const prev = lumaBuf[prevOffset + x] ?? 0;
        rowSum += Math.abs(cur - prev);
      }
      rowScores[y] = rowSum / width;
    }

    let bestRow = -1;
    let bestScore = 0;
    let localMean = ASSUMED_BACKGROUND_SCORE;
    let runningSum = 0;
    let runningCount = 0;
    for (let y = bandStart; y < bandEnd; y++) {
      const score = rowScores[y] ?? 0;
      const prev = y > bandStart ? (rowScores[y - 1] ?? 0) : -Infinity;
      const next = y + 1 < bandEnd ? (rowScores[y + 1] ?? 0) : -Infinity;
      if (score >= ROOF_EDGE_FLOOR && score >= prev && score >= next) {
        bestRow = y;
        bestScore = score;
        localMean = runningCount >= MIN_LOCAL_MEAN_SAMPLES ? runningSum / runningCount : ASSUMED_BACKGROUND_SCORE;
        break;
      }
      runningSum += score;
      runningCount++;
    }
    if (bestRow < 0) return null;

    const shape = (bestScore - localMean) / (bestScore + localMean + EPSILON);
    const strength = Math.min(1, bestScore / STRONG_EDGE_MAGNITUDE);
    const confidence = Math.min(1, Math.max(0, shape * strength));
    if (confidence < CONFIDENCE_THRESHOLD) return null;

    return bestRow;
  }

  /**
   * Scans one object's ROI in the current luma buffer and returns a refined
   * flat candidate, or `null` when nothing in the band was worth trusting.
   * `left/top/right/bottom` are canvas-pixel bounds, already clamped inside
   * the canvas. Unchanged from the pre-profile algorithm: this is still the
   * single row/width `surfaceY`/`Left`/`Right` is built from.
   */
  function scanRoi(
    lumaBuf: Float32Array,
    left: number,
    top: number,
    right: number,
    bottom: number,
  ): { row: number; runLeft: number; runRight: number } | null {
    const bandEnd = Math.min(bottom, top + Math.round((bottom - top) * SEARCH_BAND_FRACTION));
    const bandStart = Math.max(top + 1, top + Math.round((bottom - top) * TOP_SKIP_FRACTION));
    if (right - left < 2) return null;

    const bestRow = findEdgeRow(lumaBuf, left, right, bandStart, bandEnd);
    if (bestRow === null) return null;

    // Width narrowing: recompute per-column gradient for just the winning
    // row, find its peak, then expand a contiguous run outward from the
    // peak while columns stay above a fraction of it.
    const rowOffset = bestRow * ROI_CANVAS_WIDTH;
    const prevOffset = (bestRow - 1) * ROI_CANVAS_WIDTH;
    let peakX = left;
    let peakDiff = -Infinity;
    for (let x = left; x < right; x++) {
      const cur = lumaBuf[rowOffset + x] ?? 0;
      const prev = lumaBuf[prevOffset + x] ?? 0;
      const d = Math.abs(cur - prev);
      if (d > peakDiff) {
        peakDiff = d;
        peakX = x;
      }
    }
    const threshold = peakDiff * WIDTH_COHERENCE_FRACTION;

    let runLeft = peakX;
    while (runLeft > left) {
      const cur = lumaBuf[rowOffset + runLeft - 1] ?? 0;
      const prev = lumaBuf[prevOffset + runLeft - 1] ?? 0;
      if (Math.abs(cur - prev) < threshold) break;
      runLeft--;
    }
    let runRight = peakX;
    while (runRight < right - 1) {
      const cur = lumaBuf[rowOffset + runRight + 1] ?? 0;
      const prev = lumaBuf[prevOffset + runRight + 1] ?? 0;
      if (Math.abs(cur - prev) < threshold) break;
      runRight++;
    }

    return { row: bestRow, runLeft, runRight: runRight + 1 };
  }

  /**
   * Populates `profileCandidateScratch` (module-level, `SURFACE_PROFILE_
   * SAMPLES` long, 0..1 frame-height fractions) with this tick's profile
   * candidate spanning `[finalLeftPx, finalRightPx)` — the FINAL surfaceLeft/
   * Right in ROI pixels. `[domainLeft, domainRight)` is the RAW box width to
   * scan for per-column data — deliberately wider than the narrow
   * width-coherence run `scanRoi` reports (see the call site), since that
   * run is narrowed onto a single edge on purpose and would leave nothing to
   * show shape across. `finalLeftPx/finalRightPx` normally fall inside this
   * wider scan domain; on the rare tick they don't (rounding, or a
   * MIN_SURFACE_WIDTH_FRACTION_OF_BOX pad that pushed past it) positions
   * outside clamp to the nearest edge of real data, which is an honest "we
   * don't know past here", not an invented value.
   *
   * Falls back to flat `fallbackRow` (ROI px, the same row the flat scan
   * already found) for every entry it cannot recover: too narrow a domain to
   * subdivide, a bin with no confident edge, or an isolated bin whose edge
   * disagrees with both neighbours.
   */
  function buildProfileCandidate(
    lumaBuf: Float32Array,
    domainLeft: number,
    domainRight: number,
    bandStart: number,
    bandEnd: number,
    fallbackRow: number,
    boxHeightPx: number,
    finalLeftPx: number,
    finalRightPx: number,
  ): void {
    const domainWidthPx = domainRight - domainLeft;
    const nInternal =
      domainWidthPx >= MIN_COLUMN_WIDTH_PX
        ? clamp(Math.floor(domainWidthPx / MIN_COLUMN_WIDTH_PX), 1, INTERNAL_PROFILE_SAMPLES)
        : 1;

    if (nInternal < 2) {
      profileCandidateScratch.fill(fallbackRow / ROI_CANVAS_HEIGHT);
      return;
    }

    // Pass 1: one edge-row candidate per column bin, NaN where none was
    // trusted.
    for (let i = 0; i < nInternal; i++) {
      const xLeft = domainLeft + Math.floor((i * domainWidthPx) / nInternal);
      let xRight = domainLeft + Math.floor(((i + 1) * domainWidthPx) / nInternal);
      if (xRight <= xLeft) xRight = xLeft + 1;
      if (xRight > domainRight) xRight = domainRight;
      const row = findEdgeRow(lumaBuf, xLeft, xRight, bandStart, bandEnd);
      internalRowScratch[i] = row === null ? Number.NaN : row;
    }
    // TEMP DEBUG pass1
    __dbg.calls++;
    for (let i = 0; i < nInternal; i++) {
      __dbg.pass1Total++;
      const v = internalRowScratch[i];
      if (v === undefined || Number.isNaN(v)) __dbg.pass1Nan++;
    }
    if (nInternal >= 12 && __dbg.bigCalls < 25) {
      __dbg.bigCalls++;
      console.log('[PROFDBG-BIG] call', __dbg.calls, 'nInternal', nInternal, 'domainW', domainWidthPx, 'boxH', boxHeightPx,
        'raw', Array.from(internalRowScratch.slice(0, nInternal)).map((v) => Number.isNaN(v) ? 'NaN' : v.toFixed(1)).join(','));
    }

    // Pass 2: reject interior bins whose candidate disagrees sharply with
    // BOTH immediate neighbours — see PROFILE_OUTLIER_REJECT_FRACTION_OF_BOX.
    const outlierThresholdPx = PROFILE_OUTLIER_REJECT_FRACTION_OF_BOX * boxHeightPx;
    for (let i = 1; i < nInternal - 1; i++) {
      const v = internalRowScratch[i];
      const a = internalRowScratch[i - 1];
      const b = internalRowScratch[i + 1];
      if (v === undefined || Number.isNaN(v)) continue;
      if (a === undefined || b === undefined || Number.isNaN(a) || Number.isNaN(b)) continue;
      const med = medianOf3(a, v, b);
      if (Math.abs(v - med) > outlierThresholdPx) {
        internalRowScratch[i] = Number.NaN;
        __dbg.outlierRejected++;
      }
    }
    if (__dbg.calls % 200 === 0) {
      console.log('[PROFDBG] SUMMARY calls', __dbg.calls, 'pass1NanRate', (__dbg.pass1Nan / __dbg.pass1Total).toFixed(3), 'outlierRejected', __dbg.outlierRejected);
    }

    // Pass 3: fill every gap by interpolating between the nearest surviving
    // bins either side; extend flat past the outermost survivor. Zero
    // survivors means the whole run is untrustworthy this tick — the
    // caller's flat fallback beats an invented shape.
    let firstValid = -1;
    let lastValid = -1;
    for (let i = 0; i < nInternal; i++) {
      const v = internalRowScratch[i];
      if (v !== undefined && !Number.isNaN(v)) {
        if (firstValid < 0) firstValid = i;
        lastValid = i;
      }
    }
    if (firstValid < 0) {
      profileCandidateScratch.fill(fallbackRow / ROI_CANVAS_HEIGHT);
      return;
    }

    const firstValue = internalRowScratch[firstValid] ?? fallbackRow;
    const lastValue = internalRowScratch[lastValid] ?? fallbackRow;
    for (let i = 0; i < nInternal; i++) {
      const v = internalRowScratch[i];
      if (v !== undefined && !Number.isNaN(v)) continue;
      if (i < firstValid) {
        internalRowScratch[i] = firstValue;
        continue;
      }
      if (i > lastValid) {
        internalRowScratch[i] = lastValue;
        continue;
      }
      let prevIdx = i - 1;
      while (prevIdx >= 0) {
        const pv = internalRowScratch[prevIdx];
        if (pv !== undefined && !Number.isNaN(pv)) break;
        prevIdx--;
      }
      let nextIdx = i + 1;
      while (nextIdx < nInternal) {
        const nv = internalRowScratch[nextIdx];
        if (nv !== undefined && !Number.isNaN(nv)) break;
        nextIdx++;
      }
      const prevVal = internalRowScratch[prevIdx] ?? fallbackRow;
      const nextVal = internalRowScratch[nextIdx] ?? fallbackRow;
      const span = nextIdx - prevIdx;
      const t = span > 0 ? (i - prevIdx) / span : 0;
      internalRowScratch[i] = prevVal + (nextVal - prevVal) * t;
    }

    // Pass 4: resample the now-fully-populated bins up to the fixed
    // SURFACE_PROFILE_SAMPLES the caller needs, mapping each output sample's
    // position across the FINAL [finalLeftPx, finalRightPx) domain back into
    // bin space and clamping — positions inside the confident domain
    // interpolate between real bin data, positions in the padding outside it
    // clamp to the nearest edge bin (flat extension, not invention).
    const outputSpan = SURFACE_PROFILE_SAMPLES > 1 ? SURFACE_PROFILE_SAMPLES - 1 : 1;
    const finalSpanPx = Math.max(1, finalRightPx - finalLeftPx);
    for (let k = 0; k < SURFACE_PROFILE_SAMPLES; k++) {
      const t = SURFACE_PROFILE_SAMPLES > 1 ? k / outputSpan : 0;
      const xPx = finalLeftPx + t * finalSpanPx;
      const posInDomain = clamp((xPx - domainLeft) / domainWidthPx, 0, 1);
      const cIdx = posInDomain * (nInternal - 1);
      const lo = Math.floor(cIdx);
      const hi = Math.min(nInternal - 1, lo + 1);
      const frac = cIdx - lo;
      const loVal = internalRowScratch[lo] ?? fallbackRow;
      const hiVal = internalRowScratch[hi] ?? fallbackRow;
      const rowPx = loVal + (hiVal - loVal) * frac;
      profileCandidateScratch[k] = rowPx / ROI_CANVAS_HEIGHT;
    }
  }

  function applyCandidate(
    track: SurfaceTrack,
    dt: number,
    candY: number,
    candLeft: number,
    candRight: number,
    candProfile: Float32Array,
    boxHeight: number,
  ): void {
    track.rejectStreak = 0;

    if (!track.hasEstimate) {
      track.smoothedY = candY;
      track.smoothedLeft = candLeft;
      track.smoothedRight = candRight;
      track.smoothedProfile.set(candProfile);
      track.hasEstimate = true;
      track.pendingCount = 0;
      return;
    }

    const jumpThresholdY = JUMP_FRACTION_OF_BOX * boxHeight;
    const withinBand = Math.abs(candY - track.smoothedY) <= jumpThresholdY;

    if (withinBand) {
      const k = smoothingFactor(SMOOTHING_RATE, dt);
      track.smoothedY += (candY - track.smoothedY) * k;
      track.smoothedLeft += (candLeft - track.smoothedLeft) * k;
      track.smoothedRight += (candRight - track.smoothedRight) * k;
      for (let i = 0; i < SURFACE_PROFILE_SAMPLES; i++) {
        const cv = candProfile[i] ?? candY;
        const sp = track.smoothedProfile[i] ?? cv;
        track.smoothedProfile[i] = sp + (cv - sp) * k;
      }
      track.pendingCount = 0;
      return;
    }

    // A jump: require a second, agreeing candidate before following it —
    // one noisy tick can't relocate the surface across the box.
    const agreementThreshold = JUMP_AGREEMENT_FRACTION_OF_BOX * boxHeight;
    if (track.pendingCount > 0 && Math.abs(candY - track.pendingY) <= agreementThreshold) {
      track.pendingCount++;
    } else {
      track.pendingY = candY;
      track.pendingCount = 1;
    }

    if (track.pendingCount >= 2) {
      track.smoothedY = candY;
      track.smoothedLeft = candLeft;
      track.smoothedRight = candRight;
      track.smoothedProfile.set(candProfile);
      track.pendingCount = 0;
    }
  }

  function refine(video: HTMLVideoElement, objects: readonly TrackedObject[], dt: number): void {
    if (disabledBySecurityError) return;
    if (objects.length === 0) return;
    if (document.hidden) return;
    if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return;
    if (!trySetupBuffers() || !ctx || !luma) return;

    tickCounter++;
    const step = Math.max(0, Math.min(dt, 1));
    const __t0 = performance.now();

    try {
      ctx.drawImage(video, 0, 0, ROI_CANVAS_WIDTH, ROI_CANVAS_HEIGHT);
      const imageData = ctx.getImageData(0, 0, ROI_CANVAS_WIDTH, ROI_CANVAS_HEIGHT);
      const data = imageData.data;
      for (let i = 0; i < luma.length; i++) {
        const o = i * 4;
        const r = data[o] ?? 0;
        const g = data[o + 1] ?? 0;
        const b = data[o + 2] ?? 0;
        luma[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      }
      // `imageData`/`data` are never referenced again — everything past
      // this point reads only the reused `luma` scratch buffer.

      for (let i = 0; i < objects.length; i++) {
        const obj = objects[i];
        if (!obj) continue;

        const boxLeftFrac = obj.x - obj.width / 2;
        const boxRightFrac = obj.x + obj.width / 2;
        const boxTopFrac = obj.y - obj.height / 2;
        const boxBottomFrac = obj.y + obj.height / 2;

        const left = Math.max(0, Math.round(boxLeftFrac * ROI_CANVAS_WIDTH));
        const right = Math.min(ROI_CANVAS_WIDTH, Math.round(boxRightFrac * ROI_CANVAS_WIDTH));
        const top = Math.max(1, Math.round(boxTopFrac * ROI_CANVAS_HEIGHT));
        const bottom = Math.min(ROI_CANVAS_HEIGHT, Math.round(boxBottomFrac * ROI_CANVAS_HEIGHT));

        const track = findOrClaimTrack(obj.id);
        if (track) track.touchedTick = tickCounter;

        if (right - left < MIN_ROI_WIDTH_PX || bottom - top < MIN_ROI_HEIGHT_PX) {
          // Too small to say anything — leave the caller's box-top/flat
          // fallback alone, but still let a held smoothed estimate lapse
          // over time so it doesn't linger for an object that's shrunk into
          // the distance.
          if (track) track.rejectStreak++;
          continue;
        }

        const hit = scanRoi(luma, left, top, right, bottom);

        if (!hit) {
          if (track) {
            track.rejectStreak++;
            if (track.hasEstimate && track.rejectStreak < REJECT_STREAK_TO_FALLBACK) {
              // Hold the last good estimate rather than flicker back to the
              // box on a single weak tick — but clamp it into the CURRENT
              // box bounds first, since the box may have moved or resized
              // underneath the held value.
              const holdLo = boxTopFrac;
              const holdHi = boxTopFrac + SEARCH_BAND_FRACTION * obj.height;
              const clampedY = clamp(track.smoothedY, holdLo, holdHi);
              const clampedLeft = clamp(track.smoothedLeft, boxLeftFrac, boxRightFrac);
              const clampedRight = clamp(track.smoothedRight, boxLeftFrac, boxRightFrac);
              if (clampedRight - clampedLeft >= MIN_SURFACE_WIDTH_FRACTION_OF_BOX * obj.width * 0.5) {
                obj.surfaceY = clamp01(clampedY);
                obj.surfaceLeft = clamp01(clampedLeft);
                obj.surfaceRight = clamp01(clampedRight);
                for (let p = 0; p < SURFACE_PROFILE_SAMPLES; p++) {
                  const held = track.smoothedProfile[p] ?? clampedY;
                  obj.surfaceProfile[p] = clamp01(clamp(held, holdLo, holdHi));
                }
              }
            } else {
              track.hasEstimate = false;
            }
          }
          continue;
        }

        const candY = hit.row / ROI_CANVAS_HEIGHT;
        let candLeft = hit.runLeft / ROI_CANVAS_WIDTH;
        let candRight = hit.runRight / ROI_CANVAS_WIDTH;

        // Never report a surface narrower than a fraction of the box's own
        // width — expand symmetrically around the found run's centre.
        const minWidth = MIN_SURFACE_WIDTH_FRACTION_OF_BOX * obj.width;
        if (candRight - candLeft < minWidth) {
          const centre = (candLeft + candRight) / 2;
          candLeft = centre - minWidth / 2;
          candRight = centre + minWidth / 2;
        }
        candLeft = clamp(candLeft, boxLeftFrac, boxRightFrac);
        candRight = clamp(candRight, boxLeftFrac, boxRightFrac);

        // Per-column profile: only worth the extra scan for vehicles — a
        // person/sign box has no bonnet/windscreen/roof shape to find, so a
        // flat candidate at the same row is both cheaper and honest.
        const bandEnd = Math.min(bottom, top + Math.round((bottom - top) * SEARCH_BAND_FRACTION));
        const bandStart = Math.max(top + 1, top + Math.round((bottom - top) * TOP_SKIP_FRACTION));
        if (obj.kind === 'vehicle') {
          // Scan across the RAW box width (left/right), not the narrow
          // width-coherence run `hit` found — that run is deliberately
          // narrowed onto the single strongest edge (see scanRoi's width
          // narrowing) precisely to exclude mirrors and background, which
          // leaves it far too narrow to show bonnet/windscreen/roof
          // variation across. The whole point of the profile is to use the
          // width scanRoi throws away; per-bin confidence, outlier
          // rejection and gap interpolation below are what keep a noisy
          // edge or a real mirror from corrupting the result instead.
          buildProfileCandidate(
            luma,
            left,
            right,
            bandStart,
            bandEnd,
            hit.row,
            bottom - top,
            candLeft * ROI_CANVAS_WIDTH,
            candRight * ROI_CANVAS_WIDTH,
          );
        } else {
          profileCandidateScratch.fill(candY);
        }

        if (!track) {
          // Pool exhausted (shouldn't happen — MAX_SURFACE_TRACKS
          // comfortably exceeds the tracker's own cap) — use this tick's
          // candidate unsmoothed rather than dropping it.
          obj.surfaceY = clamp01(candY);
          obj.surfaceLeft = clamp01(candLeft);
          obj.surfaceRight = clamp01(candRight);
          for (let p = 0; p < SURFACE_PROFILE_SAMPLES; p++) {
            obj.surfaceProfile[p] = clamp01(profileCandidateScratch[p] ?? candY);
          }
          continue;
        }

        applyCandidate(track, step, candY, candLeft, candRight, profileCandidateScratch, obj.height);
        obj.surfaceY = clamp01(track.smoothedY);
        obj.surfaceLeft = clamp01(track.smoothedLeft);
        obj.surfaceRight = clamp01(track.smoothedRight);
        for (let p = 0; p < SURFACE_PROFILE_SAMPLES; p++) {
          obj.surfaceProfile[p] = clamp01(track.smoothedProfile[p] ?? obj.surfaceY);
        }
      }

      sweepStaleTracks();
      // TEMP DEBUG timing
      const __elapsed = performance.now() - __t0;
      __dbg.tickCostSum += __elapsed;
      __dbg.tickCostCount++;
      __dbg.tickCostMax = Math.max(__dbg.tickCostMax, __elapsed);
      if (__dbg.tickCostCount % 100 === 0) {
        console.log('[PROFDBG-COST] n', __dbg.tickCostCount, 'avgMs', (__dbg.tickCostSum / __dbg.tickCostCount).toFixed(4), 'maxMs', __dbg.tickCostMax.toFixed(4), 'objectsThisTick', objects.length);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'SecurityError') {
        disabledBySecurityError = true;
        dropBuffers();
        if (!warnedOnce) {
          warnedOnce = true;
          console.warn(
            '[SurfaceProfileFinder] canvas read blocked by a SecurityError; surface refinement disabled for this session.',
          );
        }
      }
      // Any other unexpected failure: the caller's box-top fallback, already
      // written before this ran, stands. Never throw across the module
      // boundary for something as recoverable as "this tick's scan failed".
    }
  }

  return {
    refine,
    stop(): void {
      dropBuffers();
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        if (t) {
          t.active = false;
          t.hasEstimate = false;
        }
      }
    },
  };
}
