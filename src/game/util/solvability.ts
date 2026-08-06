/**
 * Solvability is derived, not guessed.
 *
 * Crossing mode launches the player at an arbitrary angle and power the
 * player themselves choose (free 2D aim-and-release, no world scroll —
 * unlike a fixed-column runner, there is no "obstacle" to clear here). What
 * has to be DERIVED instead is:
 *
 *  - the launch-speed cap that keeps a single full-power jump from covering
 *    more than its budgeted share of a crossing (see
 *    CROSSING_MAX_JUMP_HORIZONTAL_FRACTION's doc in config.ts for the
 *    hop-count-backwards derivation that fraction itself comes from);
 *  - given that cap, the farthest horizontal distance a jump can ever cover
 *    between two points at a given height difference — exactly the number
 *    the ghost-platform fallback (CrossingSystem) needs to GUARANTEE a
 *    spawned chain is actually reachable;
 *  - a representative single-hop flight duration, used to pace the per-leg
 *    countdown timer and the trajectory-preview arc so neither is a guessed
 *    seconds value either.
 *
 * All three use the up-positive vertical convention Player.ts already uses
 * (velocityY > 0 means moving up) — GRAVITY decelerates it exactly as it
 * does there. Canvas-space px (y increases downward) map onto it as
 * `dropPx = landingCanvasY - launchCanvasY` (positive when landing is BELOW
 * the launch point), which is what `crossingMaxHorizontalReach` expects.
 */

import { CROSSING_MAX_JUMP_HORIZONTAL_FRACTION, GRAVITY } from '../config.ts';

/**
 * Launch-speed cap (px/s) for a full-power crossing jump, derived from
 * CROSSING_MAX_JUMP_HORIZONTAL_FRACTION so "a single jump only ever covers
 * its budgeted share of a crossing" holds on any canvas size. Inverts the
 * classic same-height projectile range formula `range = v^2 / g` (maximised
 * at a 45° launch angle) for the range we're willing to allow:
 * `maxRangePx = canvasWidth * CROSSING_MAX_JUMP_HORIZONTAL_FRACTION`, so
 * `v = sqrt(maxRangePx * g)`.
 */
export function crossingMaxJumpSpeed(canvasWidth: number): number {
  const maxRangePx = canvasWidth * CROSSING_MAX_JUMP_HORIZONTAL_FRACTION;
  return Math.sqrt(maxRangePx * GRAVITY);
}

/**
 * Farthest horizontal distance (px) a full-power crossing jump (speed
 * `crossingMaxJumpSpeed(canvasWidth)`) can cover, MAXIMISED OVER LAUNCH
 * ANGLE, between a launch point and a landing point `dropPx` BELOW it
 * (negative `dropPx` = landing is ABOVE launch). This is the closed-form
 * solution to "maximum projectile range to a target at a given height
 * difference": for launch speed v, gravity g and up-positive height
 * difference `h = -dropPx` (target height relative to launch),
 *
 *   R = (v / g) * sqrt(v^2 - 2*g*h) = (v / g) * sqrt(v^2 + 2*g*dropPx)
 *
 * which reduces to the plain `v^2/g` range formula when dropPx = 0 (same
 * height), and correctly GROWS for a lower landing point (more fall time =
 * more range) and SHRINKS for a higher one. Returns 0 if the landing point
 * is higher than this jump could ever reach regardless of angle (i.e. the
 * term under the root would be negative) — that target simply isn't
 * reachable by a full-power jump from this launch height, at any distance.
 */
export function crossingMaxHorizontalReach(canvasWidth: number, dropPx: number): number {
  const v = crossingMaxJumpSpeed(canvasWidth);
  const term = v * v + 2 * GRAVITY * dropPx;
  if (term <= 0) return 0;
  return (v / GRAVITY) * Math.sqrt(term);
}

/**
 * Flight time (s) of a 45°, FULL-POWER, same-height crossing jump — 45°
 * simultaneously maximises horizontal range AND (among angles that reach
 * that range) is a fair representative duration for "one hop", so this
 * doubles as: (a) the longest a full-power hop's flight ever normally takes,
 * used with a small margin to size the trajectory-preview arc
 * (CROSSING_PREVIEW_DURATION_MARGIN in config.ts) so the dots always cover
 * the whole visible arc regardless of charge power; and (b) the
 * representative "one hop" duration the per-leg countdown timer's budget is
 * built from (CROSSING_HOP_REACTION_SECONDS and friends in config.ts) — a
 * generosity margin, not a guessed number: a shorter/weaker hop (the common
 * case, since most jumps aren't full-power straight lines) always finishes
 * faster than this.
 */
export function crossingFullPowerFlightTimeSeconds(canvasWidth: number): number {
  const v = crossingMaxJumpSpeed(canvasWidth);
  const vy0 = v * Math.SQRT1_2; // sin(45deg) === cos(45deg) === 1/sqrt(2)
  return (2 * vy0) / GRAVITY;
}
