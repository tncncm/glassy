/**
 * PRIVACY — read this before touching anything below.
 *
 * This is the second (and only other) place in Glassy that reads camera
 * pixels — the first is SceneAnalyser. Exactly the same discipline applies:
 * it draws the live <video> into a tiny (see ROI_CANVAS_WIDTH/
 * ROI_CANVAS_HEIGHT below) offscreen canvas ONCE per detector tick, reduces
 * that single frame to a luma buffer, scans small slices of it, and discards
 * every pixel before the tick ends. The canvas, its 2D context and the scratch
 * typed array are allocated once and reused forever; the ImageData obtained
 * from `getImageData` is read and dropped in the same call, never stored on
 * `this`/closure state. The only things that survive past a single call are a
 * handful of numbers per tracked object — three floats written directly onto
 * the SAME reused `TrackedObject` the caller already owns.
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
 * air a few pixels above the actual roof. This file narrows that box down to
 * the real roof line using the same cheap classical-CV move as SceneAnalyser:
 * a per-row luma-gradient scan, just run over a small region instead of the
 * whole frame, and just for the rows/columns a detection box says to look at.
 *
 * Per tracked object, per tick:
 *   1. Crop the box's region out of this tick's luma buffer.
 *   2. Scan downward from the box top for the row with the strongest,
 *      most row-like (as opposed to speckly) luma gradient — the vehicle's
 *      silhouette against the sky or the road behind it.
 *   3. At that row, find how far the same edge extends left/right before it
 *      weakens — that is the roof's actual width, narrower than the box
 *      (which also counts mirrors and flared wheel arches).
 *   4. Smooth both across time, per object id, and reject single-tick jumps
 *      the same way SceneAnalyser refuses to hop between crash-barrier rails.
 *
 * When the edge is too weak to trust (dark car on a dark background, a box
 * mostly full of background, a sliver of vehicle at the frame edge), this
 * file does nothing: DetectionTracker has already written the box's own top
 * edge and sides into `surfaceY`/`surfaceLeft`/`surfaceRight` before this
 * runs, and an honest "we don't know, use the box" beats a confident guess.
 */

import type { TrackedObject } from '../types.ts';

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
 * The roof is the FIRST strong edge scanning down from the sky, not
 * necessarily the strongest edge anywhere in the search band. A close-up
 * vehicle routinely has a much stronger edge lower down — the dark
 * window-tint/hood boundary, a shut-line, a bumper, a beltline — than the
 * true roof/sky line above it, which can be genuinely subtle (a pale roof
 * against a bright sky). Picking the single strongest row in the band, or
 * even the first row within some fraction of the band's loudest row, both
 * end up walking straight past a real-but-quiet roof edge to land on that
 * louder distractor. What "first strong edge" actually means is a LOCAL
 * maximum in the gradient signal — score higher than the row immediately
 * above and immediately below it — clearing a modest absolute floor so
 * pure sensor noise near the very top can't qualify. That is the textbook
 * definition of "an edge", and unlike a global-peak comparison it is
 * indifferent to how much louder some unrelated edge further down happens
 * to be.
 */
const ROOF_EDGE_FLOOR = STRONG_EDGE_MAGNITUDE * 0.4;

/**
 * Peak-to-mean shape ratio (0..1) below which the picked row isn't trusted
 * at all — same two-factor confidence idea as SceneAnalyser, but "mean"
 * here is the average score of the rows scanned BEFORE the picked one (the
 * sky/background this candidate edge stands out from), not the whole
 * search band's average. The band's own average is pulled up by whatever
 * busy, unrelated edges live lower in the box (windows, trim, wheels) and
 * would make a real-but-quiet roof edge look unremarkable by comparison
 * even though it stands out plainly from the flat region just above it.
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
 * `surfaceY`/`Left`/`Right` come from a coarse per-row pixel scan — a
 * single-row difference is a real, unavoidable quantisation step — so this
 * needs to average over more ticks to keep the landing surface from
 * visibly stepping as the winning row hops by one.
 */
const SMOOTHING_RATE = 3;

/**
 * A candidate more than this fraction of the box's OWN height away from the
 * current smoothed surfaceY is a "jump", not a refinement — box height (not
 * a fixed frame fraction) because a distant car's whole box can be smaller
 * than a near car's jump threshold would allow. Y drives the jump/agreement
 * decision; left/right ride along with whatever that decision was (smoothed
 * when Y is in-band, snapped once a Y jump is confirmed) since a genuine
 * roof-line change and a genuine width change are almost always the same
 * event — one new edge, found or lost together. Requires two consecutive
 * agreeing Y candidates before a jump is followed, exactly SceneAnalyser's
 * "don't hop rails on one noisy sample".
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
const MAX_ROOF_TRACKS = 16;

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Per-object temporal smoothing state. Plain data, preallocated, recycled
 * by id exactly like DetectionTracker's own Track pool. */
interface RoofTrack {
  id: number;
  active: boolean;
  /** Set on every call that touches this slot; used to sweep stale slots
   * without allocating a Set of "seen" ids each tick. */
  touchedTick: number;
  hasEstimate: boolean;
  smoothedY: number;
  smoothedLeft: number;
  smoothedRight: number;
  rejectStreak: number;
  pendingY: number;
  pendingCount: number;
}

export interface RoofFinder {
  /**
   * Draws the current video frame once, then refines `surfaceY`/
   * `surfaceLeft`/`surfaceRight` IN PLACE on every object in `objects` —
   * the same reused `TrackedObject`s the caller already owns. `dt` is
   * seconds since the previous call, for temporal smoothing. When
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

/** `1 - e^(-rate*dt)` — the same frame-rate-independent smoothing factor
 * DetectionTracker uses. */
function smoothingFactor(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

export function createRoofFinder(): RoofFinder {
  let ctx: Context2D | null = null;
  let luma: Float32Array | null = null; // ROI_CANVAS_WIDTH * ROI_CANVAS_HEIGHT
  // Scratch row-score buffer, sized once to the tallest possible search band
  // (the whole canvas height) and reused for every object's scan — never
  // reallocated per box, per tick.
  const rowScores = new Float32Array(ROI_CANVAS_HEIGHT);
  let disabledBySecurityError = false;
  let warnedOnce = false;

  const tracks: RoofTrack[] = Array.from({ length: MAX_ROOF_TRACKS }, () => ({
    id: 0,
    active: false,
    touchedTick: -1,
    hasEstimate: false,
    smoothedY: 0,
    smoothedLeft: 0,
    smoothedRight: 0,
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

  function findOrClaimTrack(id: number): RoofTrack | null {
    let free: RoofTrack | null = null;
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
   * Scans one object's ROI in the current luma buffer and returns a refined
   * candidate, or `null` when nothing in the band was worth trusting.
   * `left/top/right/bottom` are canvas-pixel bounds, already clamped inside
   * the canvas.
   */
  function scanRoi(
    lumaBuf: Float32Array,
    left: number,
    top: number,
    right: number,
    bottom: number,
  ): { row: number; runLeft: number; runRight: number } | null {
    const width = right - left;
    const bandEnd = Math.min(bottom, top + Math.round((bottom - top) * SEARCH_BAND_FRACTION));
    const bandStart = Math.max(top + 1, top + Math.round((bottom - top) * TOP_SKIP_FRACTION));
    if (bandEnd - bandStart < 2 || width < 2) return null;

    // Pass 1: per-row gradient score across the band — same "mean absolute
    // luma difference against the row above" definition SceneAnalyser uses,
    // just over a box-sized slice instead of the whole frame.
    for (let y = bandStart; y < bandEnd; y++) {
      const rowOffset = y * ROI_CANVAS_WIDTH;
      const prevOffset = (y - 1) * ROI_CANVAS_WIDTH;
      let rowSum = 0;
      for (let x = left; x < right; x++) {
        const cur = lumaBuf[rowOffset + x] ?? 0;
        const prev = lumaBuf[prevOffset + x] ?? 0;
        rowSum += Math.abs(cur - prev);
      }
      rowScores[y] = rowSum / width;
    }

    // Pass 2: walk top-down and take the first LOCAL maximum — a row whose
    // score is at least as high as its immediate neighbours above and
    // below — that also clears an absolute floor. See ROOF_EDGE_FLOOR for
    // why this beats both "global max" and "fraction of the band's max".
    // `runningSum`/`runningCount` track the mean of everything scanned
    // before the candidate, i.e. the background this edge stands out from.
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

  function applyCandidate(track: RoofTrack, dt: number, candY: number, candLeft: number, candRight: number, boxHeight: number): void {
    track.rejectStreak = 0;

    if (!track.hasEstimate) {
      track.smoothedY = candY;
      track.smoothedLeft = candLeft;
      track.smoothedRight = candRight;
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
      track.pendingCount = 0;
      return;
    }

    // A jump: require a second, agreeing candidate before following it —
    // one noisy tick can't relocate the roof line across the box.
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
          // Too small to say anything — leave the caller's box-top fallback
          // alone, but still let a held smoothed estimate lapse over time
          // so it doesn't linger for an object that's shrunk into the
          // distance.
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
              const clampedY = clamp(track.smoothedY, boxTopFrac, boxTopFrac + SEARCH_BAND_FRACTION * obj.height);
              const clampedLeft = clamp(track.smoothedLeft, boxLeftFrac, boxRightFrac);
              const clampedRight = clamp(track.smoothedRight, boxLeftFrac, boxRightFrac);
              if (clampedRight - clampedLeft >= MIN_SURFACE_WIDTH_FRACTION_OF_BOX * obj.width * 0.5) {
                obj.surfaceY = clamp01(clampedY);
                obj.surfaceLeft = clamp01(clampedLeft);
                obj.surfaceRight = clamp01(clampedRight);
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

        if (!track) {
          // Pool exhausted (shouldn't happen — MAX_ROOF_TRACKS comfortably
          // exceeds the tracker's own cap) — use this tick's candidate
          // unsmoothed rather than dropping it.
          obj.surfaceY = clamp01(candY);
          obj.surfaceLeft = clamp01(candLeft);
          obj.surfaceRight = clamp01(candRight);
          continue;
        }

        applyCandidate(track, step, candY, candLeft, candRight, obj.height);
        obj.surfaceY = clamp01(track.smoothedY);
        obj.surfaceLeft = clamp01(track.smoothedLeft);
        obj.surfaceRight = clamp01(track.smoothedRight);
      }

      sweepStaleTracks();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'SecurityError') {
        disabledBySecurityError = true;
        dropBuffers();
        if (!warnedOnce) {
          warnedOnce = true;
          console.warn(
            '[RoofFinder] canvas read blocked by a SecurityError; roof refinement disabled for this session.',
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
