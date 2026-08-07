/**
 * PRIVACY — this file never touches a pixel. Every input is already a plain
 * number: the tracked objects' smoothed box coordinates (from
 * DetectionTracker) and a horizon row (from SceneAnalyser). Nothing new is
 * read from the video here, nothing is stored beyond a handful of numbers per
 * tracked id, and those are dropped on `reset()`/when a track goes stale
 * exactly like RoofFinder's own per-id state.
 *
 * WHAT THIS FILE DOES
 *
 * ObjectDetector hands out every vehicle-shaped box the model finds — the
 * one ahead of us in our own lane, the one three lanes over, the one parked
 * on the shoulder, the one on the far side of a central reservation. Every
 * one of those becomes a platform in windscreen mode. That's wrong for a
 * game about hopping across the traffic ahead of you: only vehicles actually
 * travelling our way, on our side of the road, make gameplay sense.
 *
 * Three signals, combined:
 *
 *  1. PERSPECTIVE CORRIDOR. The road our camera looks down is a trapezoid —
 *     wide at the bottom of the frame, narrowing toward the vanishing point
 *     at the horizon. A box whose base sits far outside that trapezoid for
 *     its own row isn't on a road that's ours to drive on. Derived from
 *     SceneAnalyser's horizon estimate, not a fixed rectangle, so it holds up
 *     across however the phone is being held. Widened deliberately: measured
 *     against three hours of real dashcam footage (see the constants below),
 *     a corridor tight enough to look like "one lane" throws out perfectly
 *     real traffic on any road wider than that — which is most of them. What
 *     it still catches is the geometrically-impossible case: something far
 *     from centre AND far from the camera, which cannot be sharing our road.
 *
 *  2. PERSPECTIVE SIZE CONSISTENCY. For a flat road and a box that's actually
 *     resting on it, apparent height scales linearly with how far the box's
 *     base sits below the horizon (see the comment on SIZE_RATIO_MIN/MAX for
 *     the derivation). A box wildly too small or too large for its row is a
 *     misdetection or something not standing on our ground plane — a car on
 *     a bridge overhead, a reflection, a box that's drifted onto scenery.
 *     Kept as a generous backstop, not a fine discriminator: real vehicles
 *     span a wide size range (motorcycle to bus) and the ratio itself gets
 *     noisy for anything sitting close to the horizon, which the min-denom
 *     gate below accounts for.
 *
 *  3. MOTION SIGNATURE. Traffic travelling with us is close to static in
 *     frame — that's the whole premise windscreen mode relies on. Something
 *     sweeping sideways AND growing fast at the same time is closing on us
 *     far quicker than our own traffic does: oncoming, or crossing. Requires
 *     BOTH conditions at once, sustained for two confirming ticks, precisely
 *     because either alone has an innocent explanation (a lane change, a
 *     car pulling away) but the combination — sustained — does not. This
 *     ended up being the most direct of the three signals: it needs no
 *     horizon estimate and isn't thrown off by lane count or road curvature,
 *     both of which quietly break a fixed-centre corridor (see the report
 *     for what the corridor alone got wrong before this was added).
 *
 * Every one of these can fail to fire — no horizon, a lane count wider than
 * expected, a track too young to have a velocity yet — and in every one of
 * those cases this file KEEPS the object rather than drops it. An empty
 * world is a worse failure than a cluttered one; see `filter()`.
 *
 * THE EGO-MOTION GATE. Every signal above — the corridor, the perspective
 * size check, the motion signature — is reasoning that only makes sense for
 * a camera travelling down a road. Once the allowlist widened past traffic
 * (see ObjectDetector.ts) to "anything you could land on", this filter would
 * otherwise run its "own carriageway" logic on a beach chair or a parasol,
 * which has no carriageway to be on or off. So `filter()` now takes the
 * live `EgoMotion` estimate from `OpticalFlow` — already computed for
 * exactly this purpose, and the single most direct "are we actually moving
 * through the world" signal Glassy has, since it is a property of the
 * WHOLE SCENE (the static world sweeping past) rather than any one box —
 * and uses it to decide whether the rest of this file's reasoning applies
 * at all THIS TICK:
 *
 *   - MOVING (confidently, above threshold, sustained — see MOVING_ENTER/
 *     EXIT below): the geometry and motion checks run exactly as documented
 *     above. This is a car on a road.
 *   - NOT MOVING, or not confidently: every `'vehicle'`-kind object is kept
 *     unconditionally, no geometry or motion check applied at all. This is
 *     a beach, a stopped car, a room — anywhere "our own carriageway" is
 *     meaningless, so the filter gets out of the way entirely rather than
 *     invent a road that isn't there.
 *
 * Hysteresis (two thresholds, not one) and a confidence floor exist for the
 * same reason the motion signature above requires two consecutive ticks: a
 * single noisy `EgoMotion` sample right at a threshold must not flip the
 * WHOLE FILTER on and off every tick — that would make vehicles kept one
 * frame and rejected the next as the estimate wobbles, which is worse than
 * either state held steady. Missing/low-confidence evidence holds the
 * PREVIOUS state rather than guessing, and the filter starts in the
 * "not moving" state — the same "empty world is a worse failure than a
 * cluttered one" bias this file already applies everywhere else: on cold
 * start, before OpticalFlow has accumulated enough evidence to say
 * otherwise, nothing is filtered.
 */

import type { DetectedKind, TrackedObject } from '../types.ts';
import type { EgoMotion } from './OpticalFlow.ts';

/* ------------------------------------------------------------------ */
/* Corridor                                                             */
/* ------------------------------------------------------------------ */

/**
 * Corridor half-width (fraction of frame width) right at the horizon row.
 * Not zero: the horizon estimate itself has a few percent of noise (measured
 * std dev ~0.011 on real footage, see SceneAnalyser), and a hard point would
 * make every distant, dead-centre car flicker in and out as the estimate
 * wobbles a pixel either way.
 */
const CORRIDOR_MIN_HALF_WIDTH = 0.08;

/**
 * Corridor half-width at the very bottom of the frame — deliberately almost
 * the full half-frame. Measured against three hours of real dashcam driving
 * (mostly multi-lane divided freeway): a corridor narrow enough to read as
 * "one lane" rejected genuinely-ahead traffic in the 3rd/4th lane over on
 * anything wider than a two-lane road, which is most of what's out there.
 * Close to the camera, almost anything across the frame width plausibly
 * shares our road; what stays useful even at this width is the taper toward
 * the horizon (see the module comment).
 */
const CORRIDOR_MAX_HALF_WIDTH = 0.95;

/**
 * Eases the half-width from MIN to MAX as a box's base descends from the
 * horizon to the bottom of the frame. Cube root, not linear or sqrt: reaches
 * most of its final width quickly, then flattens — matched to how fast real
 * adjacent-lane traffic reaches the frame edge as it gets close, found by
 * comparing candidate curves against real tracked boxes until false
 * rejections of visually-confirmed same-direction traffic on the multi-lane
 * segments dropped to zero (see the report).
 */
function corridorEase(t: number): number {
  return Math.cbrt(t);
}

/**
 * A box whose base sits this close to the horizon row cannot simultaneously
 * be tall — geometrically, something that size can't be exactly as far away
 * as the vanishing point. Catches boxes that have drifted onto scenery or
 * structure near the horizon regardless of how wide the corridor is there.
 */
const NEAR_HORIZON_EPSILON = 0.02;
const LARGE_HEIGHT_NEAR_HORIZON = 0.15;

/* ------------------------------------------------------------------ */
/* Perspective size consistency                                        */
/* ------------------------------------------------------------------ */

/**
 * For a box resting on a flat road, apparent height scales ~linearly with
 * (bottomY - horizonY) — the further below the horizon its base sits, the
 * closer it is, and apparent size grows the same way distance shrinks.
 * `height / (bottomY - horizonY)` should therefore cluster around a roughly
 * constant value for anything actually standing on our road.
 *
 * Measured directly from ~4700 stable-vehicle samples pooled across four
 * real dashcam segments (dense traffic, sparse traffic, a residential
 * arterial, a frontage-road-adjacent stretch — see the report for the exact
 * clips), gated to `denom >= MIN_DENOM_FOR_SIZE_CHECK` to keep the near-zero
 * denominator from amplifying horizon noise into a fake outlier:
 *
 *   p1 0.385   p10 0.563   median 1.021   p90 1.549   p99 2.782
 *
 * MIN/MAX below sit outside that with real headroom for the vehicle-size
 * range the median doesn't capture — a motorcycle and a bus at the same row
 * legitimately land far from each other and from the median car. This is a
 * coarse plausibility backstop, not a tight fit: it exists to catch
 * boxes wildly inconsistent with their row (roughly an order of magnitude
 * off), not to discriminate between a compact and a sedan.
 */
const SIZE_RATIO_MIN = 0.22;
const SIZE_RATIO_MAX = 4.5;

/**
 * Below this (bottomY - horizonY), the size ratio is noise, not evidence —
 * the horizon estimate's own jitter (std dev ~0.01-0.06 depending on scene,
 * see SceneAnalyser) is no longer small next to the denominator, so small
 * horizon wobbles turn into huge, meaningless ratio swings. Skip the size
 * check entirely below this rather than reject on amplified noise.
 */
const MIN_DENOM_FOR_SIZE_CHECK = 0.05;

/* ------------------------------------------------------------------ */
/* Motion signature                                                     */
/* ------------------------------------------------------------------ */

/** Exponential-smoothing rate (1/s) for the two motion signals. Gentle for
 * the same reason RoofFinder smooths gentler than DetectionTracker: these
 * are derivatives of an already-smoothed box, so raw frame-to-frame noise is
 * proportionally louder and needs more averaging to mean anything. */
const MOTION_SMOOTH_RATE = 6;

/**
 * Reject thresholds for smoothed |lateral velocity| (frame-widths/s) and
 * growth rate (relative height change/s), both measured against the same
 * pooled real-footage sample used for the size ratio above (same-direction
 * traffic only — this footage never contained genuine oncoming or crossing
 * traffic despite a deliberate search across the full 3-hour recording, see
 * the report):
 *
 *   lateral |dx/dt|:  p50 0.012  p90 0.088  p95 0.129  p99 0.229  p100 0.418
 *   growth  dh/h/dt:  p50 0.000  p90 ~0.4   p95 0.524  p99 1.068  p100 2.941
 *
 * Both thresholds sit above the p99 of normal same-direction traffic, and —
 * critically — BOTH must be exceeded AT ONCE, sustained for two consecutive
 * confirming ticks (see CONFIRM_TICKS). A single one alone has an innocent
 * explanation (a lane change is lateral without fast growth; a car ahead
 * braking is growth without lateral sweep); the combination, sustained, is
 * what a real closing-speed encounter — oncoming or crossing — looks like
 * and normal traffic essentially never produces both at once by chance:
 * under independence that's roughly a 1-in-10000 co-occurrence at the p99
 * marks alone, before the sustained-for-two-ticks requirement on top.
 */
const LATERAL_REJECT_THRESHOLD = 0.28;
const GROWTH_REJECT_THRESHOLD = 1.1;

/** Consecutive ticks the combined motion condition must hold before it's
 * trusted — the same "don't act on one noisy sample" rule RoofFinder and
 * SceneAnalyser both use for their own jump detection. */
const CONFIRM_TICKS = 2;

/** A dt this large means the track coasted through a gap (occlusion, a
 * missed frame) rather than being seen every tick — the resulting velocity
 * estimate spans too much dead time to trust, so motion state resets rather
 * than folding a stale jump into the smoothed signal. */
const MAX_TRUSTED_DT = 1;
const MIN_TRUSTED_DT = 0.01;
const MIN_HEIGHT_FOR_GROWTH = 0.01;

/** Fixed pool size for per-object motion state — comfortably above
 * DetectionTracker's own MAX_TRACKS (12), matching RoofFinder's headroom, so
 * every live vehicle track always gets a slot without ever allocating one. */
const MAX_CARRIAGEWAY_TRACKS = 16;

/* ------------------------------------------------------------------ */
/* Ego-motion gate                                                      */
/* ------------------------------------------------------------------ */

/**
 * `EgoMotion.magnitude` (see OpticalFlow.ts) is normalised to "frame
 * diagonals per second" — resolution/aspect independent, which is what
 * makes a single constant here meaningful across devices. Measured with
 * `tools/video-sim` at the sample rate this actually ships at (see
 * ObjectDetector.ts's `egoFlow`, 2Hz — see the report for full numbers):
 *
 *   - genuinely stationary — a frozen real dashcam frame (a car stopped at
 *     a light) AND a synthetic near-static handheld sway over a still photo
 *     of a beach — read 0.0000 at every percentile, max 0.0007-0.0013.
 *     Sensor/compression noise never got close to real scene motion.
 *   - real driving, including dense stop-and-go traffic, sits at p10
 *     0.040-0.046 within a couple of seconds of moving and climbs to
 *     0.08-0.10 at p90. Nowhere near the stationary numbers above.
 *
 * The two thresholds below sit in the wide gap between those, with real
 * headroom on the stationary side. ENTER is set high enough that engine
 * idle vibration or a hand adjusting grip cannot alone cross it. EXIT sits
 * below ENTER on purpose — see the hysteresis note in the module header —
 * so the gate doesn't chatter right at "just started rolling" or "just
 * stopped at a light".
 *
 * KNOWN LIMITATION, measured not guessed: a FAST deliberate pan across a
 * still scene (not driving — someone quickly scanning their view) also
 * produces real per-block flow and can cross ENTER (measured max 0.044 on
 * a ~6-second corner-to-corner pan across a photo, versus real driving's
 * 0.040-0.046 p10 — the two ranges border each other). Magnitude alone
 * cannot fully tell a fast pan from a slow drive-off; nothing here claims
 * it can. What was verified is that this stays a SOFT, SELF-CORRECTING
 * failure: the gate only engages for the seconds the pan is actually in
 * motion, drops back to OFF within one hysteresis step once it settles
 * (confirmed on the test clip: 2 gate transitions, not sustained
 * chatter), and even while engaged the geometry checks it turns on kept
 * the large majority of objects (91.5% on that clip) — a slow/gentle pan,
 * which is what aiming a phone at a specific parasol actually looks like,
 * never approached ENTER at all.
 */
const MOVING_ENTER_MAGNITUDE = 0.018;
const MOVING_EXIT_MAGNITUDE = 0.01;

/**
 * Below this confidence (see `EgoMotion.confidence` — driven by how many
 * blocks the estimate is based on), a sample is too thin to move the gate
 * either way: too little texture this tick, a resolution/aspect change that
 * just rebuilt OpticalFlow's buffers, or the first tick or two after
 * `start()`. The gate holds whatever state it was already in rather than
 * react to a handful of blocks.
 */
const MIN_EGO_CONFIDENCE_FOR_GATE = 0.3;

/** Why an object was dropped, for diagnostics only (see `rejectedReasons`).
 * Never consumed by production code — App/Game only ever see the kept list. */
export type CarriagewayRejectReason = 'corridor' | 'size' | 'near-horizon' | 'motion';

interface MotionTrack {
  id: number;
  active: boolean;
  touchedTick: number;
  hasPrev: boolean;
  prevX: number;
  prevHeight: number;
  smoothedLateral: number;
  smoothedGrowth: number;
  suspiciousStreak: number;
}

export interface CarriagewayFilter {
  /**
   * Filters `objects` down to the ones plausibly on our own carriageway.
   * Only `kind === 'vehicle'` objects are ever dropped — a person or a sign
   * isn't constrained by lane geometry the same way, so both pass through
   * untouched. `horizonY` is SceneAnalyser's horizon estimate (0..1, or
   * `null` when there isn't a trustworthy one this tick); `dt` is seconds
   * since the previous call, for the motion signal. `ego` is OpticalFlow's
   * live ego-motion estimate, or `null` when it isn't running — see the
   * "EGO-MOTION GATE" section of the module comment: while not confidently
   * moving, every `'vehicle'`-kind object is kept unconditionally and none
   * of the geometry/motion reasoning below runs at all.
   *
   * Returns a REUSED array — read synchronously, never retain, exactly like
   * DetectionTracker's own `update()`. Never throws: any internal
   * inconsistency degrades to returning `objects` unfiltered rather than an
   * empty list — a cluttered world beats an empty one.
   */
  filter(
    objects: readonly TrackedObject[],
    horizonY: number | null,
    dt: number,
    ego: EgoMotion | null,
  ): readonly TrackedObject[];
  /**
   * Diagnostics only, valid until the next `filter()` call — the vehicle
   * objects `filter()` just dropped, paired with why in the same-indexed
   * `rejectedReasons`. Not read by production code; exists so
   * tools/video-sim can show what got rejected and why.
   */
  readonly rejected: readonly TrackedObject[];
  readonly rejectedReasons: readonly CarriagewayRejectReason[];
  /** Diagnostics only: whether the ego-motion gate currently judges us to be
   * moving — i.e. whether the last `filter()` call actually applied its
   * road-specific reasoning. Not read by production code. */
  readonly isMoving: boolean;
  /** Forget all per-object motion history AND the ego-motion gate's held
   * state (back to "not moving" — see the module comment). Used when the
   * scene changes. */
  reset(): void;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

/** `1 - e^(-rate*dt)`, the same frame-rate-independent smoothing used
 * throughout the vision layer (DetectionTracker, RoofFinder, SceneAnalyser). */
function smoothingFactor(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

/**
 * Corridor half-width (fraction of frame width) at a given box-base row.
 * Exported as a pure function — no hidden state — so tools/video-sim can
 * draw the exact same corridor it's filtering against, rather than
 * re-deriving the constants by hand.
 */
export function corridorHalfWidthAt(bottomY: number, horizonY: number): number {
  const span = 1 - horizonY;
  if (span <= 1e-3) return CORRIDOR_MAX_HALF_WIDTH;
  const t = clamp01((bottomY - horizonY) / span);
  return CORRIDOR_MIN_HALF_WIDTH + corridorEase(t) * (CORRIDOR_MAX_HALF_WIDTH - CORRIDOR_MIN_HALF_WIDTH);
}

export function createCarriagewayFilter(): CarriagewayFilter {
  const tracks: MotionTrack[] = Array.from({ length: MAX_CARRIAGEWAY_TRACKS }, () => ({
    id: 0,
    active: false,
    touchedTick: -1,
    hasPrev: false,
    prevX: 0,
    prevHeight: 0,
    smoothedLateral: 0,
    smoothedGrowth: 0,
    suspiciousStreak: 0,
  }));
  let tickCounter = 0;
  // Starts "not moving" — see the module comment's ego-motion-gate section:
  // on cold start, before OpticalFlow has accumulated enough evidence to say
  // otherwise, nothing is filtered.
  let movingState = false;

  /** Hysteresis update for the ego-motion gate. Missing or low-confidence
   * evidence holds the PREVIOUS state rather than guessing either way. */
  function updateMovingState(ego: EgoMotion | null): boolean {
    if (!ego || !Number.isFinite(ego.magnitude) || ego.confidence < MIN_EGO_CONFIDENCE_FOR_GATE) {
      return movingState;
    }
    if (movingState) {
      if (ego.magnitude < MOVING_EXIT_MAGNITUDE) movingState = false;
    } else {
      if (ego.magnitude > MOVING_ENTER_MAGNITUDE) movingState = true;
    }
    return movingState;
  }

  // Reused output buffers — arrays of REFERENCES into the caller's own
  // TrackedObject pool (DetectionTracker's), never copies, never new
  // TrackedObject allocation. Cleared and refilled every call, exactly like
  // DetectionTracker's own `live` array.
  const kept: TrackedObject[] = [];
  const rejectedList: TrackedObject[] = [];
  const rejectedReasonsList: CarriagewayRejectReason[] = [];

  function findOrClaimTrack(id: number): MotionTrack | null {
    let free: MotionTrack | null = null;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (!t) continue;
      if (t.active && t.id === id) return t;
      if (!t.active && !free) free = t;
    }
    if (!free) return null;
    free.id = id;
    free.active = true;
    free.hasPrev = false;
    free.smoothedLateral = 0;
    free.smoothedGrowth = 0;
    free.suspiciousStreak = 0;
    return free;
  }

  function sweepStaleTracks(): void {
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (t && t.active && t.touchedTick !== tickCounter) {
        t.active = false;
        t.hasPrev = false;
      }
    }
  }

  /** Updates (or initialises) a track's smoothed motion signals and reports
   * whether the combined "closing fast" condition has been confirmed for
   * `CONFIRM_TICKS` in a row. Never the sole reason an object is kept — only
   * ever a reason to reject. */
  function updateMotion(track: MotionTrack, x: number, height: number, dt: number): boolean {
    if (!track.hasPrev || dt < MIN_TRUSTED_DT || dt > MAX_TRUSTED_DT) {
      track.hasPrev = true;
      track.prevX = x;
      track.prevHeight = height;
      track.suspiciousStreak = 0;
      return false;
    }

    const rawLateral = (x - track.prevX) / dt;
    const rawGrowth = (height - track.prevHeight) / Math.max(track.prevHeight, MIN_HEIGHT_FOR_GROWTH) / dt;
    const k = smoothingFactor(MOTION_SMOOTH_RATE, dt);
    track.smoothedLateral += (rawLateral - track.smoothedLateral) * k;
    track.smoothedGrowth += (rawGrowth - track.smoothedGrowth) * k;
    track.prevX = x;
    track.prevHeight = height;

    const suspiciousThisTick =
      Math.abs(track.smoothedLateral) > LATERAL_REJECT_THRESHOLD && track.smoothedGrowth > GROWTH_REJECT_THRESHOLD;
    track.suspiciousStreak = suspiciousThisTick ? track.suspiciousStreak + 1 : 0;
    return track.suspiciousStreak >= CONFIRM_TICKS;
  }

  /** Geometry-only check (corridor + size + the near-horizon impossibility
   * case). Returns `null` when the object looks plausible, or the reason it
   * doesn't. Skipped entirely when there's no usable horizon this tick. */
  function geometryReject(obj: TrackedObject, horizonY: number): CarriagewayRejectReason | null {
    const bottomY = obj.y + obj.height / 2;
    const denom = bottomY - horizonY;

    if (denom < NEAR_HORIZON_EPSILON && obj.height > LARGE_HEIGHT_NEAR_HORIZON) {
      return 'near-horizon';
    }

    const halfWidth = corridorHalfWidthAt(bottomY, horizonY);
    if (Math.abs(obj.x - 0.5) > halfWidth) {
      return 'corridor';
    }

    if (denom >= MIN_DENOM_FOR_SIZE_CHECK) {
      const ratio = obj.height / denom;
      if (ratio < SIZE_RATIO_MIN || ratio > SIZE_RATIO_MAX) {
        return 'size';
      }
    }

    return null;
  }

  function filter(
    objects: readonly TrackedObject[],
    horizonY: number | null,
    dt: number,
    ego: EgoMotion | null,
  ): readonly TrackedObject[] {
    kept.length = 0;
    rejectedList.length = 0;
    rejectedReasonsList.length = 0;

    try {
      tickCounter++;
      const step = clamp(dt, 0, 1);
      const moving = updateMovingState(ego);
      const hasHorizon = moving && horizonY !== null && Number.isFinite(horizonY) && horizonY < 1;

      for (let i = 0; i < objects.length; i++) {
        const obj = objects[i];
        if (!obj) continue;

        if ((obj.kind as DetectedKind) !== 'vehicle') {
          kept.push(obj);
          continue;
        }

        // The ego-motion gate: not confidently moving through the world (a
        // beach, a stopped car, indoors) means "our own carriageway" is
        // meaningless, so every vehicle-kind object is kept unconditionally
        // and no per-object geometry/motion track work happens at all — see
        // the module comment's "EGO-MOTION GATE" section. Tracks are simply
        // left untouched; `sweepStaleTracks` retires them below exactly as
        // it would for any object that stopped appearing, and a fresh claim
        // once moving resumes starts clean (no stale, possibly-stale-by-
        // minutes velocity history feeding a false motion rejection).
        if (!moving) {
          kept.push(obj);
          continue;
        }

        const track = findOrClaimTrack(obj.id);
        if (track) track.touchedTick = tickCounter;

        const motionSuspicious = track ? updateMotion(track, obj.x, obj.height, step) : false;
        const geometryReason = hasHorizon ? geometryReject(obj, horizonY) : null;

        if (motionSuspicious || geometryReason) {
          rejectedList.push(obj);
          rejectedReasonsList.push(motionSuspicious ? 'motion' : (geometryReason as CarriagewayRejectReason));
          continue;
        }

        kept.push(obj);
      }

      sweepStaleTracks();
      return kept;
    } catch {
      // Never throw across the module boundary; an unfiltered world beats an
      // empty one. Diagnostics buffers may be partially filled from this
      // attempt — irrelevant, they're debug-only and overwritten next call.
      kept.length = objects.length;
      for (let i = 0; i < objects.length; i++) kept[i] = objects[i] as TrackedObject;
      rejectedList.length = 0;
      rejectedReasonsList.length = 0;
      return objects;
    }
  }

  return {
    filter,
    rejected: rejectedList,
    rejectedReasons: rejectedReasonsList,
    get isMoving(): boolean {
      return movingState;
    },
    reset(): void {
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        if (t) {
          t.active = false;
          t.hasPrev = false;
        }
      }
      movingState = false;
      kept.length = 0;
      rejectedList.length = 0;
      rejectedReasonsList.length = 0;
    },
  };
}
