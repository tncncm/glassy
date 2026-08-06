/**
 * PRIVACY — read this before touching anything below.
 *
 * This file never opens a camera, never draws a video frame and never
 * allocates a canvas. It is handed TWO luma buffers that SurfaceProfileFinder
 * already owns — this tick's and the previous tick's brightness numbers for
 * its small (320x180) offscreen sample — and it reduces them to a grid of
 * three-valued flags (unknown / moves-with-us / moves-with-the-world) plus a
 * handful of rectangle coordinates per tracked id. That is all that survives
 * a call: a Uint8Array of flags overwritten every tick and, per id, four
 * smoothed numbers.
 *
 * The one buffer it does own is `prevLuma`, a copy of the SAME brightness
 * numbers taken one tick ago. It is not an image, it is never rendered,
 * exported or persisted, and it is dropped by `reset()`. It exists because
 * "is this patch moving?" is a question about two moments and cannot be
 * answered from one. No recording, no upload, no `localStorage`, no
 * `toDataURL`/`toBlob`/`captureStream`/`MediaRecorder`, no `fetch`, no
 * `console.log` of pixel data. If you are tempted to keep a THIRD frame, or
 * to keep this one longer than one tick, stop — read the PRIVACY comment
 * above `TrackedObject` in src/types.ts first.
 *
 * WHAT THIS FILE DOES AND WHY
 *
 * A detection box is a neural net's "there is a vehicle roughly in here",
 * padded to be safe. On a close, well-framed vehicle that padding is a few
 * percent and SurfaceProfileFinder's edge scan traces the real roofline. On
 * a loosely-boxed one — a tall van being overtaken, a truck with open sky
 * above it — the box can hand the edge scan half a sky, and the scan
 * faithfully locks onto the first strong horizontal edge it meets on the way
 * down: a power line, a treeline, a sign gantry. The landing surface then
 * hangs in mid-air, nowhere near the vehicle. The edge scan is not wrong;
 * it was pointed at the wrong rows.
 *
 * Detection knows WHERE a vehicle roughly is. Motion knows WHAT MOVES WITH
 * US. Inside a detection box those two disagree in exactly the useful way:
 *
 *   - The sky, the power line, the treeline and the distant background
 *     inside that box belong to the STATIC WORLD. We are driving into it, so
 *     it sweeps across the image — several pixels to tens of pixels between
 *     two detector ticks.
 *   - The vehicle we are following is travelling at roughly our own speed,
 *     so it is very nearly STATIONARY IN THE IMAGE: its pixels are still in
 *     the same place one tick later.
 *
 * So the test is not "how fast did this patch move and in what direction"
 * (that is OpticalFlow's job, and it needs a focus of expansion, a fitted
 * expansion rate and a search window wide enough to actually FIND fast
 * motion). The test here is far cheaper and answers a strictly narrower
 * question: DID THIS PATCH STAY PUT?
 *
 *   1. Split the sample into a coarse grid of square cells.
 *   2. For each cell inside a detection box, measure its own texture (mean
 *      absolute deviation of its brightness) and the smallest mean absolute
 *      DIFFERENCE against the previous tick over a tiny search window — a few
 *      pixels, sized from the elapsed time so it always means the same
 *      RELATIVE SPEED (see WITH_US_MAX_SPEED). Wide enough to hold a vehicle
 *      we are slowly overtaking, nowhere near wide enough to follow the
 *      static world sweeping past. That asymmetry is the discriminator.
 *   3. Divide the two. A cell that stayed put matches itself almost exactly,
 *      so the ratio is small. A cell that swept past matches nothing inside
 *      the tiny window, so the ratio approaches the "two unrelated patches"
 *      level of ~1. A cell with no texture (open sky, a flat white panel)
 *      has no opinion either way and says so — `unknown`, never guessed.
 *   4. Rows and columns of cells that came back "moves with us" are the
 *      vehicle's actual extent. Everything above the topmost such row is
 *      sky, wire or treeline that happened to fall inside the box.
 *
 * WHY NOT THE RADIAL-EXPANSION RESIDUAL. OpticalFlow already fits a focus of
 * expansion and a static-world expansion rate, and a residual against that
 * model is the textbook way to find independently-moving objects. Measured on
 * this footage it also flags every embankment, overpass and sign gantry,
 * because the model knows exactly one depth — the road plane's — so anything
 * static but off that plane produces an honest residual too. Inside a
 * detection box none of that machinery is needed: we do not have to know how
 * fast the background is going or where it is going, only that it is going
 * and the vehicle is not. Dropping the model also drops its cost, its
 * calibration and its one measured failure mode.
 *
 * HONESTY, AND THE FAILURE CASES THIS HAS.
 *  - A textureless vehicle (a plain white van side, a dark car in shade)
 *    reads as `unknown` across its middle. Its EDGES are textured and read
 *    correctly, which is what the roofline scan needs, but a vehicle that is
 *    featureless edge to edge produces no support at all and this reports
 *    "no evidence" rather than a guess.
 *  - Anything else in the scene that is also holding station with us — a
 *    vehicle in an adjacent lane whose box overlaps, a bug on the
 *    windscreen — reads as "moves with us", because it does.
 *  - THE BIG ONE, and it is the same wall OpticalFlow's own candidate
 *    detector hit from the other side: near the vanishing point the static
 *    world barely moves either, so "slow" stops meaning "with us". Measured
 *    on real dashcam footage this shows up as a still-distant sign gantry, or
 *    the far end of a sound wall receding toward the horizon, reading as
 *    "with us" when it falls inside a box. When that happens this contributes
 *    nothing and the loose box's own failure simply stands — it does not make
 *    it worse, but it does not fix it either. Separating those two would need
 *    a focus of expansion AND a fitted expansion rate, which is exactly the
 *    single-depth model already measured to flag every embankment and
 *    overpass in the scene. This file does not attempt it and does not
 *    pretend to: it fixes the cases where the background inside the box is
 *    genuinely sweeping past, and is inert on the rest.
 *  - When WE are stopped nothing in the image moves, every cell reads
 *    "moves with us", and the reported extent is simply the whole box —
 *    which is exactly today's behaviour, so the degenerate case degrades to
 *    the status quo rather than to something wrong.
 * In every one of those the answer is "no usable evidence", and the caller
 * is expected to fall back to what it did before rather than trust a mask
 * built out of nothing.
 */

/* ------------------------------------------------------------------ */
/* Tunables                                                             */
/* ------------------------------------------------------------------ */

/**
 * Cell edge in sample-canvas pixels. The sample canvas is 320x180 (see
 * SurfaceProfileFinder's ROI_CANVAS_WIDTH/HEIGHT), so this is a 40x22 grid
 * and one cell is 2.5% of frame width / 4.4% of frame height. Chosen as the
 * coarsest grid that still resolves a roofline usefully: the whole point is
 * to move the edge scan's starting row from "somewhere in the sky" to "just
 * above the vehicle", and a 4% error on that is nothing next to the 30-60%
 * error it is fixing. Smaller cells would resolve better but make each
 * cell's texture/difference statistic noisier, which is the measurement this
 * entirely rests on.
 */
const CELL = 8;
const CELL_AREA = CELL * CELL;

/**
 * How fast a patch may drift across the image and still count as "travelling
 * with us", as a fraction of frame width per second. This is THE parameter of
 * the whole idea, so it is expressed physically rather than in pixels: the
 * search window is derived from it and the elapsed time, which keeps the
 * meaning constant when the detector backs its rate off under load.
 *
 * Measured on real dashcam footage at ~6Hz, between two ticks and expressed
 * at the 320px-wide sample scale:
 *   - a vehicle we are FOLLOWING            0-2 px   (0-3.6 %/s)
 *   - a vehicle we are slowly OVERTAKING    3-6 px   (5-11 %/s)
 *   - background near the vanishing point   0-3 px
 *   - background mid-frame                  5-20 px
 *   - background near the frame edge       20-60 px
 * There is no threshold that separates traffic from ALL background, because
 * background near the vanishing point is genuinely as slow as traffic. What
 * this value buys is separation from the background that actually causes the
 * bug — the treeline, the wire, the gantry, the embankment that sit off to
 * the side of a loosely-boxed vehicle and sweep past it. Set at 10 %/s: high
 * enough to hold a vehicle being overtaken, low enough that everything from
 * mid-frame outward fails to match.
 */
const WITH_US_MAX_SPEED = 0.10;
/** Bounds on the derived radius. The floor keeps handshake and the box's own
 * sub-pixel wobble from reading as motion on a very short gap; the ceiling
 * caps both cost (the window is quadratic) and how much slow background can
 * sneak under the bar on a long one. */
const MIN_SEARCH_RADIUS = 2;
const MAX_SEARCH_RADIUS = 6;

/**
 * Mean absolute deviation of a cell's own brightness (0..255 scale) below
 * which the cell has nothing to match on and no opinion is recorded. Open
 * sky, a blown-out highlight and a flat body panel all land here. Same guard,
 * same reasoning as OpticalFlow's MIN_TEXTURE_VARIANCE — a flat patch matches
 * everything equally well, so a confident-looking answer from one is noise.
 */
const MIN_TEXTURE_MAD = 3.5;

/**
 * The two decision thresholds on `bestMeanAbsDiff / textureMad`.
 *
 * A cell that genuinely stayed put differs from itself only by sensor noise
 * and video compression, far below its own internal contrast — measured
 * ratios cluster around 0.15-0.35 on real footage. A cell that swept past is
 * being compared against unrelated pixels; the mean absolute difference of
 * two unrelated patches of similar texture lands near 1.0, pulled down some
 * by taking the best of 25 candidate shifts. The band between the two is
 * left deliberately wide and reported as `unknown`: partial occlusion, a
 * cell straddling the vehicle's edge, and motion blur all live there, and
 * "I cannot tell" is a usable answer here whereas a coin flip is not.
 */
const STATIONARY_RATIO = 0.45;
const MOVING_RATIO = 0.62;

/** Cell flags. Public so a debug overlay can render them; the values are
 * arbitrary and no consumer should do arithmetic on them. */
export const CELL_UNEVALUATED = 0;
export const CELL_UNKNOWN = 1;
export const CELL_VEHICLE = 2;
export const CELL_BACKGROUND = 3;

/** Below this many whole cells across or down, a box is too small for the
 * grid to say anything about its shape and refinement is declined outright.
 * At CELL=8 on a 320x180 sample this is a box under ~7.5% of frame width or
 * ~13% of frame height — i.e. exactly the distant traffic whose box is a
 * dozen pixels and whose roofline was never recoverable anyway. */
const MIN_CELLS_ACROSS = 3;
const MIN_CELLS_DOWN = 3;

/** Absolute and relative floors on how much "moves with us" evidence a box
 * must produce before its extent is trusted. The relative one is against
 * DECIDED cells (vehicle + background) rather than all cells: a box that is
 * half featureless sky should not be penalised for the sky having no
 * opinion, only for the parts that did have one disagreeing. */
const MIN_VEHICLE_CELLS = 5;
const MIN_VEHICLE_FRACTION_OF_DECIDED = 0.25;

/** A row (or column) of cells counts as belonging to the vehicle when it has
 * at least this many "moves with us" cells AND at least as many of those as
 * "moves with the world" ones. One lone cell is noise; two adjacent-ish ones
 * in the same row are a shape. */
const MIN_ROW_VEHICLE_CELLS = 2;

/** How much "moves with the world" a row/column may carry, relative to its
 * "moves with us" count, and still be swept up by the loose growth pass
 * (see `growSpan`). Above 1 so a roofline row that is half sky-edge and half
 * roof still counts; low enough that a row which is mostly background does
 * not. */
const LOOSE_GROW_BACKGROUND_TOLERANCE = 2;

/** Growing the supported region outward from its strongest row/column is
 * allowed to step over this many unsupported rows/columns — a vehicle is
 * contiguous, but a single row across its glass or a single column down a
 * flat panel can legitimately come back textureless. */
const MAX_GAP_CELLS = 1;

/**
 * Hard cap on how far the top edge may be pulled down, as a fraction of the
 * box's own height. The dangerous direction of this whole idea is
 * OVER-tightening: if a vehicle were somehow read as "moving" we would crop
 * the landing surface down onto its own bumper. Nothing measured does that,
 * but the cost of being wrong here is a platform inside a car rather than on
 * it, so the cap stands as a backstop regardless of what the cells say.
 */
const MAX_TOP_TIGHTEN_FRACTION = 0.6;
/** Same idea on the sides and the base, which matter less (they only clamp
 * the landing surface's width) but can still run away on a bad tick. */
const MAX_SIDE_TIGHTEN_FRACTION = 0.4;
const MAX_BOTTOM_TIGHTEN_FRACTION = 0.5;

/** One cell of headroom is kept above the topmost supported row, so the
 * roofline EDGE ITSELF — the transition the gradient scan is looking for —
 * is inside the band handed to it rather than clipped off at its first row. */
const TOP_HEADROOM_CELLS = 1;

/** Exponential smoothing rate (1/s) on the reported rectangle. Matched to
 * SurfaceProfileFinder's own SMOOTHING_RATE: this feeds the same landing
 * surface and a band edge that steps by a whole cell would make the found
 * roofline hop with it. */
const SMOOTHING_RATE = 4;

/** Consecutive undecided ticks a previously-good rectangle survives before
 * it is abandoned. Short: the box underneath it is moving and a stale crop
 * is worse than the honest full box. */
const MAX_COAST_TICKS = 3;

/** A raw box that has moved or resized by more than this fraction of its own
 * size since the last tick is a different framing, not a refinement — the
 * held rectangle is dropped rather than smoothed across the discontinuity. */
const BOX_RESET_FRACTION = 0.5;

/** Pool size for per-id smoothing state. Comfortably above DetectionTracker's
 * MAX_TRACKS (12), so a slot is always available without allocating. */
const MAX_SUPPORT_TRACKS = 16;

/* ------------------------------------------------------------------ */
/* Public shape                                                         */
/* ------------------------------------------------------------------ */

/**
 * One box's motion-derived extent, in SAMPLE-CANVAS PIXELS (the same units
 * the caller passed in). A REUSED object — read it before the next call.
 */
export interface SupportRegion {
  /** False when there was not enough evidence to say anything. Every other
   * field is meaningless in that case and the caller must fall back. */
  decided: boolean;
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Cell census, for diagnostics and for the caller's own reporting. */
  vehicleCells: number;
  backgroundCells: number;
  unknownCells: number;
}

export interface FlowSupportOptions {
  /** Dimensions of the luma buffers that will be handed to `beginTick`. */
  width: number;
  height: number;
}

export interface FlowSupport {
  /**
   * Adopt this tick's luma buffer. Returns false when there is no usable
   * previous frame to compare against (first call, a gap in sampling, a
   * resolution change) — `supportFor` will report `decided: false` for
   * everything until a good pair exists. `dt` is seconds since the previous
   * accepted frame.
   */
  beginTick(luma: Float32Array, dt: number): boolean;
  /**
   * Motion-derived extent of one box. `left/top/right/bottom` are
   * sample-canvas pixel bounds, already clamped inside the buffer. `id` keys
   * the temporal smoothing; `dt` is the same value handed to `beginTick`.
   * Returns a REUSED object.
   */
  supportFor(id: number, left: number, top: number, right: number, bottom: number, dt: number): SupportRegion;
  /** Close the tick: retain this frame as the comparison frame and expire
   * smoothing state for ids not seen. */
  endTick(): void;
  /** Drop every buffer and forget all per-id state. Idempotent. */
  reset(): void;
  /** Cell flag grid for the current tick, for a debug overlay only. Cells
   * never looked at this tick read `CELL_UNEVALUATED`. Reused array. */
  readonly cells: Uint8Array;
  readonly cellCols: number;
  readonly cellRows: number;
  readonly cellSize: number;
  /** Wall-clock cost of every `supportFor` call since `beginTick`, in ms. */
  readonly lastTickCostMs: number;
}

/**
 * The widest gap between two frames (seconds) still worth comparing. Above
 * it, even a vehicle holding perfect station has drifted past the tiny search
 * radius and everything would read as "moving". Below it, the static world
 * has not moved far enough to be told apart from a vehicle. The detector runs
 * at ~6Hz (0.167s) and backs off under load, so both ends are real.
 */
const MIN_USABLE_DT = 0.05;
const MAX_USABLE_DT = 0.4;

interface SupportTrack {
  id: number;
  active: boolean;
  touchedTick: number;
  has: boolean;
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Raw box last seen, to detect a discontinuity worth resetting on. */
  boxLeft: number;
  boxTop: number;
  boxRight: number;
  boxBottom: number;
  missStreak: number;
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

/** `1 - e^(-rate*dt)` — the same frame-rate-independent factor used by
 * DetectionTracker and SurfaceProfileFinder. */
function smoothingFactor(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

export function createFlowSupport(options: FlowSupportOptions): FlowSupport {
  const width = Math.max(1, Math.floor(options.width));
  const height = Math.max(1, Math.floor(options.height));
  const cellCols = Math.max(1, Math.floor(width / CELL));
  const cellRows = Math.max(1, Math.floor(height / CELL));
  const cellCount = cellCols * cellRows;

  /**
   * Candidate shifts, ordered by distance from zero so the most likely
   * winner for a vehicle cell is tried first and the running-minimum early
   * exit inside `classifyCell` has something to beat immediately. Built once,
   * interleaved x,y in a single flat array — a per-tick array of pairs is
   * exactly the allocation this whole layer avoids.
   */
  const maxShiftCount = (2 * MAX_SEARCH_RADIUS + 1) * (2 * MAX_SEARCH_RADIUS + 1);
  const shifts = new Int8Array(maxShiftCount * 2);
  /** `ringEnd[r]` = number of entries in `shifts` covering radius <= r, so a
   * tick's derived radius is applied by simply stopping early. */
  const ringEnd = new Int32Array(MAX_SEARCH_RADIUS + 1);
  {
    let n = 0;
    for (let ring = 0; ring <= MAX_SEARCH_RADIUS; ring++) {
      for (let sy = -ring; sy <= ring; sy++) {
        for (let sx = -ring; sx <= ring; sx++) {
          if (Math.max(Math.abs(sx), Math.abs(sy)) !== ring) continue;
          shifts[n * 2] = sx;
          shifts[n * 2 + 1] = sy;
          n++;
        }
      }
      ringEnd[ring] = n;
    }
  }
  /** Derived from `dt` at the top of every tick — see WITH_US_MAX_SPEED. */
  let searchRadius = MIN_SEARCH_RADIUS;
  let shiftCount = ringEnd[MIN_SEARCH_RADIUS] ?? 1;

  /**
   * One flag per cell, cleared at the top of every tick. `CELL_UNEVALUATED`
   * doubles as "not computed yet this tick", so two overlapping boxes never
   * pay for the same cell twice and a stale flag can never be read as a
   * fresh one — no separate stamp array needed.
   */
  const cells = new Uint8Array(cellCount);
  let tickCounter = 0;

  /** Per-cell-row/column tallies for the box currently being analysed.
   * Sized to the grid once; only the box's own span is ever touched. */
  const rowVehicle = new Int16Array(cellRows);
  const rowBackground = new Int16Array(cellRows);
  const colVehicle = new Int16Array(cellCols);
  const colBackground = new Int16Array(cellCols);

  let prevLuma: Float32Array | null = null;
  let currLuma: Float32Array | null = null;
  let havePrev = false;
  let pairUsable = false;
  let lastTickCostMs = 0;
  let tickCostAccumulator = 0;

  const tracks: SupportTrack[] = Array.from({ length: MAX_SUPPORT_TRACKS }, () => ({
    id: 0,
    active: false,
    touchedTick: -1,
    has: false,
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    boxLeft: 0,
    boxTop: 0,
    boxRight: 0,
    boxBottom: 0,
    missStreak: 0,
  }));

  const result: SupportRegion = {
    decided: false,
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    vehicleCells: 0,
    backgroundCells: 0,
    unknownCells: 0,
  };

  function findOrClaimTrack(id: number): SupportTrack | null {
    let free: SupportTrack | null = null;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (!t) continue;
      if (t.active && t.id === id) return t;
      if (!t.active && !free) free = t;
    }
    if (!free) return null;
    free.id = id;
    free.active = true;
    free.has = false;
    free.missStreak = 0;
    return free;
  }

  /**
   * Classifies one cell, memoised for the current tick. Returns one of the
   * CELL_* flags. Cells within `SEARCH_RADIUS` of the buffer edge are not
   * classified — the shifted read would fall outside the buffer, and a
   * clamped/replicated read there would fabricate a suspiciously good match
   * exactly where the fastest-moving pixels in the frame live.
   */
  function classifyCell(col: number, row: number): number {
    const idx = row * cellCols + col;
    const memo = cells[idx] ?? CELL_UNEVALUATED;
    if (memo !== CELL_UNEVALUATED) return memo;

    const curr = currLuma;
    const prev = prevLuma;
    if (!curr || !prev || !pairUsable) {
      cells[idx] = CELL_UNKNOWN;
      return CELL_UNKNOWN;
    }

    const x0 = col * CELL;
    const y0 = row * CELL;
    if (
      x0 - searchRadius < 0 ||
      y0 - searchRadius < 0 ||
      x0 + CELL + searchRadius > width ||
      y0 + CELL + searchRadius > height
    ) {
      cells[idx] = CELL_UNKNOWN;
      return CELL_UNKNOWN;
    }

    let sum = 0;
    for (let v = 0; v < CELL; v++) {
      const o = (y0 + v) * width + x0;
      for (let u = 0; u < CELL; u++) sum += curr[o + u] ?? 0;
    }
    const mean = sum / CELL_AREA;

    let mad = 0;
    for (let v = 0; v < CELL; v++) {
      const o = (y0 + v) * width + x0;
      for (let u = 0; u < CELL; u++) mad += Math.abs((curr[o + u] ?? 0) - mean);
    }
    mad /= CELL_AREA;

    if (mad < MIN_TEXTURE_MAD) {
      cells[idx] = CELL_UNKNOWN;
      return CELL_UNKNOWN;
    }

    // Smallest sum-of-absolute-differences against the previous frame over
    // the tiny shift window. `best` is a running minimum used to abandon a
    // candidate shift the moment it can no longer win — most cells settle on
    // the first (zero) shift or are hopeless everywhere, so this is where
    // nearly all of the nominal cost disappears.
    let best = Infinity;
    for (let s = 0; s < shiftCount; s++) {
      const sx = shifts[s * 2] ?? 0;
      const sy = shifts[s * 2 + 1] ?? 0;
      let acc = 0;
      for (let v = 0; v < CELL; v++) {
        const co = (y0 + v) * width + x0;
        const po = (y0 + v + sy) * width + x0 + sx;
        for (let u = 0; u < CELL; u++) acc += Math.abs((curr[co + u] ?? 0) - (prev[po + u] ?? 0));
        if (acc >= best) break;
      }
      if (acc < best) best = acc;
    }

    const ratio = best / CELL_AREA / mad;
    const flag = ratio <= STATIONARY_RATIO ? CELL_VEHICLE : ratio >= MOVING_RATIO ? CELL_BACKGROUND : CELL_UNKNOWN;
    cells[idx] = flag;
    return flag;
  }

  /**
   * Grows a supported span outward from its strongest entry. `vehicle` and
   * `background` are the per-row (or per-column) tallies over [lo, hi]; the
   * returned pair is the contiguous supported run containing the seed, with
   * up to MAX_GAP_CELLS skipped over. Returns null when no entry qualifies.
   * Written against flat typed arrays and index bounds rather than slices —
   * one function serving both axes, no allocation either way.
   */
  function growSpan(
    vehicle: Int16Array,
    background: Int16Array,
    lo: number,
    hi: number,
    outSpan: Int16Array,
  ): boolean {
    let seed = -1;
    let seedCount = 0;
    for (let i = lo; i <= hi; i++) {
      const v = vehicle[i] ?? 0;
      if (v > seedCount) {
        seedCount = v;
        seed = i;
      }
    }
    if (seed < 0 || seedCount < MIN_ROW_VEHICLE_CELLS) return false;

    /**
     * Two tests, deliberately. The STRICT one establishes the core of the
     * vehicle — enough "with us" cells to outvote the "with the world" ones —
     * and is what stops the span running off into the treeline. The LOOSE one
     * then extends that core outward on weaker evidence, and exists because
     * of an asymmetry that matters: the rows this is ultimately protecting are
     * the vehicle's TOP ones, and they are its worst-evidenced. A roofline is
     * one cell of textured edge with sky above it and glass below; it will
     * routinely muster a single "with us" cell in a row where the strict test
     * wants two. Stopping short there would crop the landing surface down onto
     * the vehicle's own windows — the one failure mode worse than the loose
     * box this whole file exists to fix. So the core is found strictly, then
     * grown as far as any positive evidence reaches, and never further.
     */
    const strict = (i: number): boolean => {
      const v = vehicle[i] ?? 0;
      const b = background[i] ?? 0;
      return v >= MIN_ROW_VEHICLE_CELLS && v >= b;
    };
    const loose = (i: number): boolean => {
      const v = vehicle[i] ?? 0;
      const b = background[i] ?? 0;
      return v >= 1 && v * LOOSE_GROW_BACKGROUND_TOLERANCE >= b;
    };

    let start = seed;
    let end = seed;
    for (let pass = 0; pass < 2; pass++) {
      const test = pass === 0 ? strict : loose;
      let gap = 0;
      for (let i = start - 1; i >= lo; i--) {
        if (test(i)) {
          start = i;
          gap = 0;
          continue;
        }
        gap++;
        if (gap > MAX_GAP_CELLS) break;
      }
      gap = 0;
      for (let i = end + 1; i <= hi; i++) {
        if (test(i)) {
          end = i;
          gap = 0;
          continue;
        }
        gap++;
        if (gap > MAX_GAP_CELLS) break;
      }
    }

    outSpan[0] = start;
    outSpan[1] = end;
    return true;
  }

  const spanScratch = new Int16Array(2);

  function beginTick(luma: Float32Array, dt: number): boolean {
    tickCounter++;
    tickCostAccumulator = 0;
    cells.fill(CELL_UNEVALUATED);
    currLuma = luma;
    if (prevLuma === null || prevLuma.length !== luma.length) {
      // Allocated once per resolution, not per tick — `endTick` fills it and
      // every later tick reuses it.
      prevLuma = new Float32Array(luma.length);
      havePrev = false;
      pairUsable = false;
      return false;
    }
    pairUsable = havePrev && dt >= MIN_USABLE_DT && dt <= MAX_USABLE_DT;
    // The window is "how far something travelling with us could have drifted
    // in this gap" — a threshold on relative speed, expressed in pixels only
    // because that is what the search loop counts in.
    searchRadius = Math.round(
      clamp(WITH_US_MAX_SPEED * width * (pairUsable ? dt : 0), MIN_SEARCH_RADIUS, MAX_SEARCH_RADIUS),
    );
    shiftCount = ringEnd[searchRadius] ?? 1;
    return pairUsable;
  }

  function endTick(): void {
    const curr = currLuma;
    if (curr && prevLuma && prevLuma.length === curr.length) {
      prevLuma.set(curr);
      havePrev = true;
    }
    currLuma = null;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (t && t.active && t.touchedTick !== tickCounter) t.active = false;
    }
    lastTickCostMs = tickCostAccumulator;
  }

  function undecided(): SupportRegion {
    result.decided = false;
    return result;
  }

  function supportFor(
    id: number,
    left: number,
    top: number,
    right: number,
    bottom: number,
    dt: number,
  ): SupportRegion {
    const startedAt = performance.now();
    try {
      const track = findOrClaimTrack(id);
      if (track) track.touchedTick = tickCounter;

      const boxWidth = right - left;
      const boxHeight = bottom - top;

      // A box that jumped is a different framing; a held crop from the old
      // one would be pointing at the wrong pixels.
      if (track && track.has) {
        const moved =
          Math.abs(left - track.boxLeft) + Math.abs(right - track.boxRight) > BOX_RESET_FRACTION * boxWidth ||
          Math.abs(top - track.boxTop) + Math.abs(bottom - track.boxBottom) > BOX_RESET_FRACTION * boxHeight;
        if (moved) track.has = false;
      }
      if (track) {
        track.boxLeft = left;
        track.boxTop = top;
        track.boxRight = right;
        track.boxBottom = bottom;
      }

      result.vehicleCells = 0;
      result.backgroundCells = 0;
      result.unknownCells = 0;

      const c0 = Math.max(0, Math.ceil(left / CELL));
      const c1 = Math.min(cellCols - 1, Math.floor(right / CELL) - 1);
      const r0 = Math.max(0, Math.ceil(top / CELL));
      const r1 = Math.min(cellRows - 1, Math.floor(bottom / CELL) - 1);

      const tooSmall = c1 - c0 + 1 < MIN_CELLS_ACROSS || r1 - r0 + 1 < MIN_CELLS_DOWN;
      if (!pairUsable || tooSmall) {
        return coastOrGiveUp(track, left, top, right, bottom);
      }

      for (let r = r0; r <= r1; r++) {
        rowVehicle[r] = 0;
        rowBackground[r] = 0;
      }
      for (let c = c0; c <= c1; c++) {
        colVehicle[c] = 0;
        colBackground[c] = 0;
      }

      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const flag = classifyCell(c, r);
          if (flag === CELL_VEHICLE) {
            rowVehicle[r] = (rowVehicle[r] ?? 0) + 1;
            colVehicle[c] = (colVehicle[c] ?? 0) + 1;
            result.vehicleCells++;
          } else if (flag === CELL_BACKGROUND) {
            rowBackground[r] = (rowBackground[r] ?? 0) + 1;
            colBackground[c] = (colBackground[c] ?? 0) + 1;
            result.backgroundCells++;
          } else {
            result.unknownCells++;
          }
        }
      }

      const decidedCells = result.vehicleCells + result.backgroundCells;
      if (
        result.vehicleCells < MIN_VEHICLE_CELLS ||
        decidedCells === 0 ||
        result.vehicleCells < MIN_VEHICLE_FRACTION_OF_DECIDED * decidedCells
      ) {
        return coastOrGiveUp(track, left, top, right, bottom);
      }

      if (!growSpan(rowVehicle, rowBackground, r0, r1, spanScratch)) {
        return coastOrGiveUp(track, left, top, right, bottom);
      }
      const rowStart = spanScratch[0] ?? r0;
      const rowEnd = spanScratch[1] ?? r1;
      if (!growSpan(colVehicle, colBackground, c0, c1, spanScratch)) {
        return coastOrGiveUp(track, left, top, right, bottom);
      }
      const colStart = spanScratch[0] ?? c0;
      const colEnd = spanScratch[1] ?? c1;

      // Cell indices back to sample-canvas pixels, then clamped so the result
      // can only ever be a SUBSET of the box it came from, and only by a
      // bounded amount (see the MAX_*_TIGHTEN_FRACTION comments).
      let rawTop = Math.max(top, (rowStart - TOP_HEADROOM_CELLS) * CELL);
      let rawBottom = Math.min(bottom, (rowEnd + 1) * CELL);
      let rawLeft = Math.max(left, colStart * CELL);
      let rawRight = Math.min(right, (colEnd + 1) * CELL);

      rawTop = clamp(rawTop, top, top + MAX_TOP_TIGHTEN_FRACTION * boxHeight);
      rawBottom = clamp(rawBottom, bottom - MAX_BOTTOM_TIGHTEN_FRACTION * boxHeight, bottom);
      rawLeft = clamp(rawLeft, left, left + MAX_SIDE_TIGHTEN_FRACTION * boxWidth);
      rawRight = clamp(rawRight, right - MAX_SIDE_TIGHTEN_FRACTION * boxWidth, right);

      if (rawBottom - rawTop < CELL || rawRight - rawLeft < CELL) {
        return coastOrGiveUp(track, left, top, right, bottom);
      }

      if (!track) {
        result.decided = true;
        result.left = rawLeft;
        result.top = rawTop;
        result.right = rawRight;
        result.bottom = rawBottom;
        return result;
      }

      track.missStreak = 0;
      if (!track.has) {
        track.left = rawLeft;
        track.top = rawTop;
        track.right = rawRight;
        track.bottom = rawBottom;
        track.has = true;
      } else {
        const k = smoothingFactor(SMOOTHING_RATE, clamp(dt, 0, 1));
        track.left += (rawLeft - track.left) * k;
        track.top += (rawTop - track.top) * k;
        track.right += (rawRight - track.right) * k;
        track.bottom += (rawBottom - track.bottom) * k;
      }

      result.decided = true;
      result.left = clamp(track.left, left, right);
      result.top = clamp(track.top, top, bottom);
      result.right = clamp(track.right, left, right);
      result.bottom = clamp(track.bottom, top, bottom);
      return result;
    } finally {
      tickCostAccumulator += performance.now() - startedAt;
    }
  }

  /**
   * No usable evidence this tick. A rectangle found on a recent tick is worth
   * a few ticks of coasting — the detector's own box coasts the same way —
   * but it is re-clamped into the CURRENT box first, because the box has
   * almost certainly moved underneath it.
   */
  function coastOrGiveUp(
    track: SupportTrack | null,
    left: number,
    top: number,
    right: number,
    bottom: number,
  ): SupportRegion {
    if (!track || !track.has) return undecided();
    track.missStreak++;
    if (track.missStreak > MAX_COAST_TICKS) {
      track.has = false;
      return undecided();
    }
    const l = clamp(track.left, left, right);
    const r = clamp(track.right, left, right);
    const t = clamp(track.top, top, bottom);
    const b = clamp(track.bottom, top, bottom);
    if (r - l < CELL || b - t < CELL) return undecided();
    result.decided = true;
    result.left = l;
    result.top = t;
    result.right = r;
    result.bottom = b;
    return result;
  }

  return {
    beginTick,
    supportFor,
    endTick,
    reset(): void {
      prevLuma = null;
      currLuma = null;
      havePrev = false;
      pairUsable = false;
      cells.fill(CELL_UNEVALUATED);
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        if (t) {
          t.active = false;
          t.has = false;
        }
      }
    },
    get cells(): Uint8Array {
      return cells;
    },
    get cellCols(): number {
      return cellCols;
    },
    get cellRows(): number {
      return cellRows;
    },
    get cellSize(): number {
      return CELL;
    },
    get lastTickCostMs(): number {
      return lastTickCostMs;
    },
  };
}
