/**
 * Solvability is derived, not guessed.
 *
 * ObstacleSystem must never spawn a gap, width or height the player's jump
 * cannot clear at the current world speed. Rather than pick "safe-looking"
 * magic numbers, every bound here is computed from the actual jump
 * kinematics (GRAVITY, JUMP_VELOCITY) and the current world speed, so if
 * either of those tunables changes in config.ts, the safe envelope
 * recomputes automatically instead of silently going stale.
 *
 * THE PHYSICAL MODEL — this is a fixed-player runner, not a side-scroller.
 * `Player.view.x` never changes; the world (ground, obstacles) scrolls
 * (left → right, matching the passing-scenery direction — see
 * PLAYER_X_FRACTION's comment in config.ts) under it at `worldSpeed`. So
 * clearing an obstacle is *not* about covering
 * more horizontal ground than the obstacle is wide — the player doesn't
 * move horizontally at all. It's about staying airborne, with feet above
 * the obstacle's height, for the entire time the obstacle's box overlaps
 * the player's fixed horizontal column:
 *
 *   passTime(width) = (width + PLAYER_WIDTH) / worldSpeed
 *
 * (PLAYER_WIDTH is added because the player's own box has to finish
 * crossing the obstacle's box too, not just its leading edge.)
 *
 * Kinematics recap (upward launch velocity v0, downward gravity g): height
 * above ground at time t since takeoff is
 *
 *   h(t) = v0*t - 0.5*g*t^2
 *
 * a parabola that is zero at t=0 and again at the flight time t=2*v0/g, and
 * peaks at the apex time t=v0/g with height v0^2/(2g). For any target
 * height `H` at or below the apex, `h(t) >= H` holds on a symmetric
 * interval around the apex whose duration ("hang time above H") is the
 * positive root of:
 *
 *   hangTime(H) = 2 * sqrt(apexTime^2 - 2*H/g)
 *
 * A jump timed so its apex aligns with the obstacle's mid-crossing clears
 * that obstacle iff hangTime(H) >= passTime(width). We only ever *demand*
 * a fraction (JUMP_ARC_SAFETY_FACTOR) of the arc's real hang-time budget,
 * which is exactly the slack available to a jump triggered somewhat early
 * or late by input latency or an imperfect reaction.
 *
 * Two obstacle bounds fall out of inverting that inequality:
 *  - `maxClearableObstacleWidth` — the widest obstacle for which even the
 *    shortest obstacle we ever spawn (OBSTACLE_MIN_HEIGHT) is still
 *    clearable. Width and height trade off (taller needs more hang time,
 *    so less width budget), so this is the binding cap on width alone.
 *  - `maxClearableObstacleHeight(width, worldSpeed)` — once a width has
 *    been picked, the matching height cap for *that* width.
 *
 * A third, separate constraint governs SPACING between consecutive
 * obstacles: after clearing one, the player needs the jump's flight time
 * *plus* a reaction-time buffer before committing to the next jump. Because
 * world speed ramps only slowly (asymptotic, see config.ts) relative to how
 * quickly a single gap is crossed, sizing that gap in pixels from the speed
 * at spawn time — with GAP_SAFETY_FACTOR margin on top — stays valid even
 * as speed continues to creep up while the player crosses it.
 */

import {
  DASH_INVULN_SECONDS,
  GAP_REACTION_TIME_SECONDS,
  GAP_SAFETY_FACTOR,
  GRAVITY,
  JUMP_ARC_SAFETY_FACTOR,
  JUMP_VELOCITY,
  OBSTACLE_MAX_HEIGHT_CAP,
  OBSTACLE_MAX_WIDTH_CAP,
  OBSTACLE_MIN_HEIGHT,
  OBSTACLE_MIN_WIDTH,
  OVERHEAD_CLEARANCE_MARGIN_PX,
  PLAYER_COLLISION_INSET_TOP,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  WIDE_OBSTACLE_MAX_WIDTH_CAP,
  WIDE_OBSTACLE_WIDTH_MARGIN_PX,
} from '../config.ts';
import { clamp } from './math.ts';

export interface JumpArc {
  /** Time from takeoff to apex, seconds. */
  apexTimeSeconds: number;
  /** Time from takeoff back to ground level, seconds. */
  flightTimeSeconds: number;
  /** Peak height above ground, px. */
  apexHeightPx: number;
}

/** Pure kinematics of one jump. Independent of horizontal speed — this is
 * the shape of the arc, not where anything lands relative to it. */
export function computeJumpArc(jumpVelocity: number, gravity: number): JumpArc {
  const apexTimeSeconds = jumpVelocity / gravity;
  return {
    apexTimeSeconds,
    flightTimeSeconds: apexTimeSeconds * 2,
    apexHeightPx: (jumpVelocity * jumpVelocity) / (2 * gravity),
  };
}

/** The primary jump's arc, computed once from the configured constants. */
export const PRIMARY_JUMP_ARC: JumpArc = computeJumpArc(JUMP_VELOCITY, GRAVITY);

/** Duration the arc spends at or above `height` (0 if `height` exceeds the
 * apex, i.e. the jump never reaches it at all). */
function hangTimeAboveHeight(height: number): number {
  const discriminant = PRIMARY_JUMP_ARC.apexTimeSeconds ** 2 - (2 * height) / GRAVITY;
  if (discriminant <= 0) return 0;
  return 2 * Math.sqrt(discriminant);
}

/** Widest obstacle for which even a minimum-height (OBSTACLE_MIN_HEIGHT)
 * spawn is still clearable at `worldSpeed`, with the configured margin. */
export function maxClearableObstacleWidth(worldSpeed: number): number {
  const budgetedHangTime = hangTimeAboveHeight(OBSTACLE_MIN_HEIGHT) * JUMP_ARC_SAFETY_FACTOR;
  const width = budgetedHangTime * worldSpeed - PLAYER_WIDTH;
  return clamp(width, OBSTACLE_MIN_WIDTH, OBSTACLE_MAX_WIDTH_CAP);
}

/** Tallest obstacle of the given `width` still clearable at `worldSpeed`,
 * with the configured margin. Always >= OBSTACLE_MIN_HEIGHT for any width
 * produced by `maxClearableObstacleWidth` (see module doc for the proof:
 * both bounds invert the same inequality, so a width sampled within the
 * width cap can never make the height cap fall below the minimum). */
export function maxClearableObstacleHeight(width: number, worldSpeed: number): number {
  const passTime = (width + PLAYER_WIDTH) / worldSpeed;
  const requiredHangTime = passTime / JUMP_ARC_SAFETY_FACTOR;
  const halfRequired = requiredHangTime / 2;
  const discriminant = PRIMARY_JUMP_ARC.apexTimeSeconds ** 2 - halfRequired ** 2;
  if (discriminant <= 0) return OBSTACLE_MIN_HEIGHT;
  const height = (GRAVITY / 2) * discriminant;
  return clamp(height, OBSTACLE_MIN_HEIGHT, OBSTACLE_MAX_HEIGHT_CAP);
}

/** Minimum empty gap (trailing edge of one obstacle to the leading edge of
 * the next), in px, that guarantees time to land, spot and clear the next
 * obstacle at `worldSpeed`. */
export function minSafeGap(worldSpeed: number): number {
  const requiredSeconds = PRIMARY_JUMP_ARC.flightTimeSeconds + GAP_REACTION_TIME_SECONDS;
  return worldSpeed * requiredSeconds * GAP_SAFETY_FACTOR;
}

/* ------------------------------------------------------------------ */
/* Wide obstacle — cleared by dash, not by jump                        */
/* ------------------------------------------------------------------ */

/**
 * Narrowest a `wide` obstacle is ever allowed to be: strictly wider than any
 * jump can clear. `maxClearableObstacleWidth()` above always clamps to
 * OBSTACLE_MAX_WIDTH_CAP as its own ceiling, so "OBSTACLE_MAX_WIDTH_CAP plus
 * a margin" is a width no jump can ever clear *by construction* — this
 * doesn't even need to know the current `worldSpeed`. We still take it and
 * compare against the live jump-clearable width defensively (belt and
 * suspenders: if a future change ever let `maxClearableObstacleWidth`
 * exceed the cap, this stays correct instead of silently going stale).
 */
export function minWideObstacleWidth(worldSpeed: number): number {
  const marginOverCap = OBSTACLE_MAX_WIDTH_CAP + WIDE_OBSTACLE_WIDTH_MARGIN_PX;
  const marginOverLiveJumpMax = maxClearableObstacleWidth(worldSpeed) + WIDE_OBSTACLE_WIDTH_MARGIN_PX;
  return Math.max(marginOverCap, marginOverLiveJumpMax);
}

/**
 * Widest a `wide` obstacle is allowed to be at `worldSpeed` such that
 * DASH_INVULN_SECONDS of invulnerability is still guaranteed to cover its
 * full pass time — see DASH_INVULN_SECONDS' doc comment in config.ts for why
 * *unboosted* `worldSpeed` is the right (conservative) input here rather
 * than the live dash-boosted speed.
 *
 * Inverting `passTime(width) = (width + PLAYER_WIDTH) / worldSpeed <=
 * DASH_INVULN_SECONDS` gives `width <= DASH_INVULN_SECONDS * worldSpeed -
 * PLAYER_WIDTH`. Clamped below by `minWideObstacleWidth` (so the range is
 * never inverted/empty even if a future tuning change made the two bounds
 * cross) and above by WIDE_OBSTACLE_MAX_WIDTH_CAP (visual sanity ceiling).
 */
export function maxDashClearableObstacleWidth(worldSpeed: number): number {
  const width = DASH_INVULN_SECONDS * worldSpeed - PLAYER_WIDTH;
  const floor = minWideObstacleWidth(worldSpeed);
  return clamp(width, floor, Math.max(floor, WIDE_OBSTACLE_MAX_WIDTH_CAP));
}

/* ------------------------------------------------------------------ */
/* Overhead hazard — cleared by staying grounded                       */
/* ------------------------------------------------------------------ */

/**
 * Fixed px clearance an `overhead` hazard's lower edge keeps above the
 * ground line. Independent of `worldSpeed` — this is a geometric fit, not a
 * timed arc, so unlike the jump/dash bounds above it's a module-level
 * constant rather than a function.
 *
 * A grounded player's own AABB top sits at `groundY - PLAYER_HEIGHT +
 * PLAYER_COLLISION_INSET_TOP` (see Player.top). For the hazard to never
 * overlap a grounded player, its bottom edge (`groundY -
 * OVERHEAD_HAZARD_CLEARANCE_PX`) must sit at or above that, i.e. clearance
 * >= `PLAYER_HEIGHT - PLAYER_COLLISION_INSET_TOP`, plus
 * OVERHEAD_CLEARANCE_MARGIN_PX of slack so it isn't a pixel-perfect squeeze.
 *
 * This also has to be well below PRIMARY_JUMP_ARC.apexHeightPx so that
 * jumping into the hazard is a real, legible risk (the "reward" for staying
 * grounded is only meaningful if the alternative — jumping — actually
 * fails), which holds by a wide margin for every PLAYER_HEIGHT/JUMP_VELOCITY
 * pairing this game has shipped with.
 *
 * Solvability guarantee: the player is never *forced* to be airborne when an
 * overhead hazard's leading edge arrives, because obstacle spacing
 * (`minSafeGap`) already reserves the jump's full flight time plus a
 * reaction buffer after any preceding obstacle — so a player who jumped to
 * clear a block/spike, or dashed through a wide wall, has always landed
 * again before the next obstacle (of any kind) reaches them. Staying
 * grounded is therefore always an available, deterministic way to clear
 * every overhead hazard — no timing luck required.
 */
export const OVERHEAD_HAZARD_CLEARANCE_PX =
  PLAYER_HEIGHT - PLAYER_COLLISION_INSET_TOP + OVERHEAD_CLEARANCE_MARGIN_PX;
