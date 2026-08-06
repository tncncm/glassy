/**
 * MotionCueSystem — motion-sickness comfort dots at the screen periphery,
 * the same idea as iOS 18's "Vehicle Motion Cues": small marks near the
 * edges that drift with the vehicle's own real acceleration (not the game),
 * giving the inner ear and the eyes matching information while staring at a
 * screen inside a moving vehicle — which is what actually causes the
 * sickness. Driven by `Game.setMotion(state)`/`setMotionCuesEnabled(enabled)`
 * from src/types.ts.
 *
 * Every dot is a pooled Graphics built once in the constructor at a fixed
 * "home" position (a fraction of the canvas, recomputed on `resize()`, same
 * convention Platform/CrossingSystem already use for resize-for-free).
 * `update()` only ever writes `.x`/`.y` — never redraws, never allocates —
 * so it is safe to call every frame regardless of whether cues are enabled
 * or motion is even available.
 */

import { Container, Graphics } from 'pixi.js';
import type { MotionState } from '../../types.ts';
import {
  MOTION_CUE_ACCEL_TO_PX,
  MOTION_CUE_DOT_ALPHA,
  MOTION_CUE_DOT_COLOR,
  MOTION_CUE_DOT_RADIUS,
  MOTION_CUE_DOTS_PER_HORIZONTAL_EDGE,
  MOTION_CUE_DOTS_PER_VERTICAL_EDGE,
  MOTION_CUE_EDGE_INSET_FRACTION,
  MOTION_CUE_MAX_OFFSET_PX,
  MOTION_CUE_REDUCED_MOTION_SCALE,
  MOTION_CUE_REDUCED_MOTION_SMOOTH_RATE,
  MOTION_CUE_SMOOTH_RATE,
} from '../config.ts';
import { clamp, expDecay, lerp } from '../util/math.ts';

interface CueDot {
  readonly view: Graphics;
  /** Home position, 0..1 fraction of canvas width/height — converted to px
   * fresh on every `resize()` call, exactly like Platform's own fractions. */
  homeXFraction: number;
  homeYFraction: number;
}

export class MotionCueSystem {
  private readonly dots: CueDot[] = [];
  private readonly container: Container;
  private enabled = true;
  private readonly reducedMotion: boolean;

  private canvasWidth = 1;
  private canvasHeight = 1;
  private offsetX = 0;
  private offsetY = 0;

  constructor(parent: Container) {
    this.container = new Container();
    parent.addChild(this.container);

    // Detected once at construction — a media-query flip mid-session is not
    // worth polling for in an allocation-free per-frame loop, and this
    // layer only reads it to pick which smoothing/amplitude constants to
    // use, never to decide whether to show the cues at all (see class doc:
    // reduced motion makes them CALMER, never absent).
    this.reducedMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    for (let i = 0; i < MOTION_CUE_DOTS_PER_HORIZONTAL_EDGE; i++) {
      const t = (i + 1) / (MOTION_CUE_DOTS_PER_HORIZONTAL_EDGE + 1);
      this.addDot(t, MOTION_CUE_EDGE_INSET_FRACTION);
      this.addDot(t, 1 - MOTION_CUE_EDGE_INSET_FRACTION);
    }
    for (let i = 0; i < MOTION_CUE_DOTS_PER_VERTICAL_EDGE; i++) {
      const t = (i + 1) / (MOTION_CUE_DOTS_PER_VERTICAL_EDGE + 1);
      this.addDot(MOTION_CUE_EDGE_INSET_FRACTION, t);
      this.addDot(1 - MOTION_CUE_EDGE_INSET_FRACTION, t);
    }
  }

  private addDot(xFraction: number, yFraction: number): void {
    const view = new Graphics().circle(0, 0, MOTION_CUE_DOT_RADIUS).fill({ color: MOTION_CUE_DOT_COLOR });
    view.alpha = MOTION_CUE_DOT_ALPHA;
    this.container.addChild(view);
    this.dots.push({ view, homeXFraction: xFraction, homeYFraction: yFraction });
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.container.visible = enabled;
  }

  /** Viewport changed — recompute every dot's home px position against the
   * new canvas size, same "fractions survive resize for free" convention as
   * Platform. */
  resize(width: number, height: number): void {
    this.canvasWidth = width;
    this.canvasHeight = height;
    for (let i = 0; i < this.dots.length; i++) {
      const dot = this.dots[i]!;
      dot.view.x = dot.homeXFraction * width + this.offsetX;
      dot.view.y = dot.homeYFraction * height + this.offsetY;
    }
  }

  /**
   * `motion` is `null` when no MotionState has ever arrived (sensor
   * unavailable/permission never granted) — dots simply settle back to
   * their home position and sit still, exactly as if there were no vehicle
   * motion to report. Never allocates: `motion`, when non-null, is the
   * caller's own stable, reused object (see MotionState's doc in types.ts).
   */
  update(dt: number, motion: MotionState | null): void {
    if (!this.enabled) return;

    const targetX = motion !== null && motion.available ? clamp(motion.accelerationX * MOTION_CUE_ACCEL_TO_PX, -MOTION_CUE_MAX_OFFSET_PX, MOTION_CUE_MAX_OFFSET_PX) : 0;
    const targetY = motion !== null && motion.available ? clamp(motion.accelerationY * MOTION_CUE_ACCEL_TO_PX, -MOTION_CUE_MAX_OFFSET_PX, MOTION_CUE_MAX_OFFSET_PX) : 0;
    const scale = this.reducedMotion ? MOTION_CUE_REDUCED_MOTION_SCALE : 1;
    const smoothRate = this.reducedMotion ? MOTION_CUE_REDUCED_MOTION_SMOOTH_RATE : MOTION_CUE_SMOOTH_RATE;
    const t = expDecay(smoothRate, dt);

    this.offsetX = lerp(this.offsetX, targetX * scale, t);
    this.offsetY = lerp(this.offsetY, targetY * scale, t);

    for (let i = 0; i < this.dots.length; i++) {
      const dot = this.dots[i]!;
      dot.view.x = dot.homeXFraction * this.canvasWidth + this.offsetX;
      dot.view.y = dot.homeYFraction * this.canvasHeight + this.offsetY;
    }
  }
}
