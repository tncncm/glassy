/**
 * Platform — a single pooled "windscreen" platform: a real tracked vehicle
 * turned into solid ground the player can land on. Mirrors Obstacle's
 * lifecycle discipline (the Graphics content is only ever mutated via
 * `.clear()` + redraw on the SAME pre-built instance, never `new Graphics()`)
 * with one difference: unlike an Obstacle's fixed size, a platform's box
 * genuinely changes shape every frame as it glides toward the latest tracked
 * box (see PlatformSystem), so `redraw()` runs whenever the box has moved
 * enough to matter — still just mutating the existing Graphics, never
 * constructing a new one, so this stays allocation-free per frame.
 *
 * Positions/sizes are tracked as 0..1 FRAME FRACTIONS (matching
 * TrackedObject's own units) and converted to canvas px fresh every call to
 * `updateVisual` — see PlatformSystem's doc for why that's what makes a live
 * resize "just work" with no special-case handling.
 */

import { Graphics } from 'pixi.js';
import {
  PLATFORM_FILL_ALPHA,
  PLATFORM_FILL_COLOR,
  PLATFORM_OUTLINE_ALPHA,
  PLATFORM_OUTLINE_COLOR,
  PLATFORM_OUTLINE_WIDTH,
  PLATFORM_TOP_BAR_ALPHA,
  PLATFORM_TOP_BAR_COLOR,
  PLATFORM_TOP_BAR_GLOW_ALPHA,
  PLATFORM_TOP_BAR_GLOW_THICKNESS,
  PLATFORM_TOP_BAR_OVERHANG_PX,
  PLATFORM_TOP_BAR_THICKNESS,
} from '../config.ts';
import { lerp } from '../util/math.ts';

/** Minimum change (px) in drawn width/height before the Graphics content is
 * rebuilt — avoids redundant redraws for sub-pixel interpolation jitter. */
const REDRAW_EPSILON_PX = 0.5;

export class Platform {
  public readonly view: Graphics = new Graphics();
  /** True from `activate()` until `deactivate()` — covers both "actively
   * tracking" and "expiring" states; PlatformSystem is the only writer. */
  public active = false;
  /** Stable id of the TrackedObject this platform is following. -1 when
   * pooled/inactive. */
  public trackId = -1;
  /** Seconds since the last matching TrackedObject update. Reset to 0 by
   * `activate()`/`retarget()`; advanced by PlatformSystem.update(), which
   * uses it to drive the grace-period fade and eventual pooling. */
  public missedTime = 0;

  // --- Follow state, in 0..1 frame fractions. ---
  private currentCenterXFraction = 0;
  private currentCenterYFraction = 0;
  private currentWidthFraction = 0;
  private currentHeightFraction = 0;
  private targetCenterXFraction = 0;
  private targetCenterYFraction = 0;
  private targetWidthFraction = 0;
  private targetHeightFraction = 0;
  private currentAlpha = 1;

  // --- Current px extents, recomputed every `updateVisual` call against the
  // live canvas size. Read by Game.ts for the one-way collision test. ---
  private leftPx = 0;
  private rightPx = 0;
  private topPx = 0;
  private lastDrawnWidthPx = -1;
  private lastDrawnHeightPx = -1;

  get left(): number {
    return this.leftPx;
  }

  get right(): number {
    return this.rightPx;
  }

  get top(): number {
    return this.topPx;
  }

  /** New track acquired a platform (pool → active). Snaps current==target so
   * a freshly-spawned platform appears immediately at the right spot instead
   * of gliding in from the pool's stale last position. */
  activate(trackId: number, centerXFraction: number, centerYFraction: number, widthFraction: number, heightFraction: number): void {
    this.active = true;
    this.trackId = trackId;
    this.missedTime = 0;
    this.currentCenterXFraction = centerXFraction;
    this.currentCenterYFraction = centerYFraction;
    this.currentWidthFraction = widthFraction;
    this.currentHeightFraction = heightFraction;
    this.targetCenterXFraction = centerXFraction;
    this.targetCenterYFraction = centerYFraction;
    this.targetWidthFraction = widthFraction;
    this.targetHeightFraction = heightFraction;
    this.currentAlpha = 1;
    this.view.visible = true;
    this.view.alpha = 1;
    this.lastDrawnWidthPx = -1;
    this.lastDrawnHeightPx = -1;
  }

  /** A fresh sample arrived for the track this platform is already
   * following — update the glide TARGET only; `updateVisual` does the actual
   * gliding, once per frame, regardless of how sparsely this fires. */
  retarget(centerXFraction: number, centerYFraction: number, widthFraction: number, heightFraction: number): void {
    this.targetCenterXFraction = centerXFraction;
    this.targetCenterYFraction = centerYFraction;
    this.targetWidthFraction = widthFraction;
    this.targetHeightFraction = heightFraction;
    this.missedTime = 0;
  }

  deactivate(): void {
    this.active = false;
    this.trackId = -1;
    this.view.visible = false;
  }

  /**
   * Per-frame update: glide current→target and current alpha→fadeAlpha at
   * `followT` (a single expDecay(dt) factor shared across every platform,
   * computed once by PlatformSystem.update), recompute px extents against
   * the live canvas size, clamp the top so it can never sink below the real
   * ground line (`maxTopY`), and redraw only if the box changed enough to
   * matter.
   */
  updateVisual(followT: number, canvasWidth: number, canvasHeight: number, maxTopY: number, fadeAlpha: number): void {
    this.currentCenterXFraction = lerp(this.currentCenterXFraction, this.targetCenterXFraction, followT);
    this.currentCenterYFraction = lerp(this.currentCenterYFraction, this.targetCenterYFraction, followT);
    this.currentWidthFraction = lerp(this.currentWidthFraction, this.targetWidthFraction, followT);
    this.currentHeightFraction = lerp(this.currentHeightFraction, this.targetHeightFraction, followT);
    this.currentAlpha = lerp(this.currentAlpha, fadeAlpha, followT);

    const widthPx = this.currentWidthFraction * canvasWidth;
    const heightPx = this.currentHeightFraction * canvasHeight;
    const centerXPx = this.currentCenterXFraction * canvasWidth;
    const rawTopPx = this.currentCenterYFraction * canvasHeight - heightPx / 2;
    const topPx = Math.min(rawTopPx, maxTopY);

    this.leftPx = centerXPx - widthPx / 2;
    this.rightPx = centerXPx + widthPx / 2;
    this.topPx = topPx;

    this.view.x = this.leftPx;
    this.view.y = topPx;
    this.view.alpha = this.currentAlpha;

    if (Math.abs(widthPx - this.lastDrawnWidthPx) > REDRAW_EPSILON_PX || Math.abs(heightPx - this.lastDrawnHeightPx) > REDRAW_EPSILON_PX) {
      this.redraw(widthPx, heightPx);
    }
  }

  /** Outline-over-reality body (low-alpha fill so the real vehicle stays
   * visible) plus a bright top-edge bar — the actual landing-surface
   * indicator — echoing the ground line's own core+glow styling so a
   * platform reads as "the same kind of thing as the ground" at a glance. */
  private redraw(widthPx: number, heightPx: number): void {
    this.lastDrawnWidthPx = widthPx;
    this.lastDrawnHeightPx = heightPx;
    const w = Math.max(1, widthPx);
    const h = Math.max(1, heightPx);
    const barSpanLeft = -PLATFORM_TOP_BAR_OVERHANG_PX;
    const barSpanWidth = w + PLATFORM_TOP_BAR_OVERHANG_PX * 2;

    this.view.clear();
    this.view
      .rect(0, 0, w, h)
      .fill({ color: PLATFORM_FILL_COLOR, alpha: PLATFORM_FILL_ALPHA })
      .rect(0, 0, w, h)
      .stroke({ width: PLATFORM_OUTLINE_WIDTH, color: PLATFORM_OUTLINE_COLOR, alpha: PLATFORM_OUTLINE_ALPHA })
      .rect(barSpanLeft, -PLATFORM_TOP_BAR_GLOW_THICKNESS / 2, barSpanWidth, PLATFORM_TOP_BAR_GLOW_THICKNESS)
      .fill({ color: PLATFORM_TOP_BAR_COLOR, alpha: PLATFORM_TOP_BAR_GLOW_ALPHA })
      .rect(barSpanLeft, -PLATFORM_TOP_BAR_THICKNESS / 2, barSpanWidth, PLATFORM_TOP_BAR_THICKNESS)
      .fill({ color: PLATFORM_TOP_BAR_COLOR, alpha: PLATFORM_TOP_BAR_ALPHA });
  }
}
