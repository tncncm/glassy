/**
 * Tiny allocation-free numeric helpers shared across the game layer.
 * Every function here is pure and takes/returns primitives only — safe to
 * call from inside the per-frame update loop with no heap allocation.
 */

/** Clamp `value` into the inclusive [min, max] range. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Linear interpolation between `a` and `b` at `t` (not clamped). */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Frame-rate independent exponential smoothing factor. Use as
 * `value = lerp(value, target, expDecay(rate, dt))` to move `value` toward
 * `target` at a constant *rate* (1/s) regardless of the frame's dt — a
 * fixed multiply-per-frame smoothing factor is not frame-rate independent,
 * this is.
 */
export function expDecay(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

/** Uniform random float in [min, max). */
export function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** AABB overlap test on two axis-aligned boxes given as (left, top, right, bottom). */
export function aabbOverlap(
  ax0: number,
  ay0: number,
  ax1: number,
  ay1: number,
  bx0: number,
  by0: number,
  bx1: number,
  by1: number,
): boolean {
  return ax0 < bx1 && ax1 > bx0 && ay0 < by1 && ay1 > by0;
}
