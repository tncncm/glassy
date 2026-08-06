/**
 * Platform — a single pooled landing surface: either a real tracked vehicle,
 * a synthetic "ghost" fallback, or one of the two fixed start/goal anchor
 * blocks (see CrossingSystem, the only owner of this entity). The Graphics
 * content is only ever mutated via `.clear()` + redraw on the SAME
 * pre-built instance, never `new Graphics()`; unlike a fixed-size sprite, a
 * platform's SHAPE genuinely changes every frame as it glides toward its
 * latest target box AND toward its latest target surface profile, so
 * `redraw()` runs whenever the box or the profile has moved enough to
 * matter — still just mutating the existing Graphics, never constructing a
 * new one, so this stays allocation-free per frame.
 *
 * Positions/sizes are tracked as 0..1 FRAME FRACTIONS (matching
 * TrackedObject's own units) and converted to canvas px fresh every call to
 * `updateVisual` — that's what makes a live resize "just work" with no
 * special-case handling.
 *
 * SURFACE PROFILE — a real vehicle isn't a slab: it has a bonnet, a
 * windscreen, a roof. `TrackedObject.surfaceProfile` (see types.ts) samples
 * the vehicle's actual top silhouette at SURFACE_PROFILE_SAMPLES evenly
 * spaced columns across [surfaceLeft, surfaceRight]. This class stores TWO
 * such profiles — `currentProfile`/`targetProfile`, in the SAME 0..1
 * frame-Y-fraction units as `centerYFraction` — and glides between them
 * elementwise at the same `followT` rate as every other field, so a profile
 * that changes shape between tracker samples (a better roof read landing, a
 * track losing confidence and falling back to flat) animates smoothly
 * instead of snapping — the same reasoning that already applied to a flat
 * platform's `top` changing, generalised per-column. This is also what keeps
 * a shape change safe for a STANDING player: Game.ts re-samples the surface
 * at the player's own x every single frame it stays grounded on this
 * platform, and that sample can only ever move by a `followT`-sized step per
 * frame, so it can never read as a shove or a sudden drop — only ever a
 * continuation of the same glide already trusted for a flat platform's
 * motion. Ghost platforms and the two anchor blocks never pass a profile
 * (see `activate`/`retarget`) and get a flat one filled from their own box
 * top, so they render and collide exactly as before this existed.
 *
 * `surfaceYAt(xPx)` is the single per-x collision query every consumer
 * (Game.ts's landing resolution, CrossingSystem's trajectory preview) uses
 * instead of a flat `.top` — a lerp between the two nearest of the CURRENT
 * (post-glide) profile's samples, no searching, since the samples are known
 * to be evenly spaced.
 */

import { Graphics } from 'pixi.js';
import { SURFACE_PROFILE_SAMPLES } from '../../types.ts';
import {
  PLATFORM_BRACKET_ALPHA,
  PLATFORM_BRACKET_INSET_PX,
  PLATFORM_BRACKET_LENGTH_PX,
  PLATFORM_BRACKET_THICKNESS,
  PLATFORM_FILL_ALPHA,
  PLATFORM_FILL_COLOR,
  PLATFORM_OUTLINE_ALPHA,
  PLATFORM_OUTLINE_COLOR,
  PLATFORM_OUTLINE_WIDTH,
  PLATFORM_SHADOW_ALPHA,
  PLATFORM_SHADOW_COLOR,
  PLATFORM_SHADOW_HEIGHT_PX,
  PLATFORM_SHADOW_OFFSET_Y_PX,
  PLATFORM_TOP_BAR_ALPHA,
  PLATFORM_TOP_BAR_COLOR,
  PLATFORM_TOP_BAR_GLOW_ALPHA,
  PLATFORM_TOP_BAR_GLOW_THICKNESS,
  PLATFORM_TOP_BAR_OVERHANG_PX,
  PLATFORM_TOP_BAR_THICKNESS,
} from '../config.ts';
import { clamp, lerp } from '../util/math.ts';

/** Minimum change (px) in drawn width/height/profile-sample before the
 * Graphics content is rebuilt — avoids redundant redraws for sub-pixel
 * interpolation jitter. */
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

  // --- Surface profile, in the SAME 0..1 frame-Y-fraction units as
  // centerYFraction — see the file doc. Fixed-size, allocated once here,
  // never reallocated; activate()/retarget() copy INTO these element-by-
  // element (`.set()`), never retain the caller's array (which TrackedObject
  // documents as reused/mutated between ticks). ---
  private readonly currentProfile: Float32Array = new Float32Array(SURFACE_PROFILE_SAMPLES);
  private readonly targetProfile: Float32Array = new Float32Array(SURFACE_PROFILE_SAMPLES);
  /** Cached CANVAS-PX profile, recomputed every `updateVisual` call from
   * `currentProfile` — what `surfaceYAt()` interpolates and what `redraw()`
   * traces. */
  private readonly profilePx: Float32Array = new Float32Array(SURFACE_PROFILE_SAMPLES);
  /** `profilePx` as of the last redraw — compared against the live
   * `profilePx` every frame (profileChangedSinceLastDraw) to decide whether
   * a profile SHAPE change (as opposed to a uniform box resize, already
   * covered by the width/height epsilon checks below) warrants a redraw. */
  private readonly lastDrawnProfilePx: Float32Array = new Float32Array(SURFACE_PROFILE_SAMPLES);

  // --- Palette override — see setPalette(). Defaults to the module
  // constants below, which is what makes every PlatformSystem-owned
  // instance (the ONLY caller in 'runner' mode) render byte-identically to
  // before this existed: nothing in that call path ever calls setPalette. ---
  private fillColor: number = PLATFORM_FILL_COLOR;
  private topBarColor: number = PLATFORM_TOP_BAR_COLOR;
  private paletteDirty = false;

  // --- Current px extents, recomputed every `updateVisual` call against the
  // live canvas size. `left`/`right`/`top` are read by Game.ts/CrossingSystem
  // for coarse (non-per-x) checks; `surfaceYAt()` is what per-x landing/
  // standing/walking collision actually uses. ---
  private leftPx = 0;
  private rightPx = 0;
  /** The HIGHEST point of the current profile (smallest px Y) — a
   * conservative scalar stand-in for callers that only need "is there
   * anything landable here at all" (Game.ts's isProgressReachable) or a
   * fixed anchor point (the flag glyphs, both of which sit on flat anchor
   * blocks where this is exact, not an approximation). */
  private topPx = 0;
  /** The box's flat bottom edge, px — also the local Graphics origin
   * (`view.y`), see redraw()'s doc. */
  private bottomPx = 0;
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

  /**
   * Interpolated surface height (canvas px) at a given canvas-px x — the
   * per-x collision query every consumer keys landing/standing/walking off
   * (see the file doc). A cheap lerp between the two nearest of the 24
   * CURRENT (post-glide) samples; `xPx` outside [left, right] clamps to the
   * nearest edge column. No search: the samples are evenly spaced, so the
   * index is a direct division.
   */
  surfaceYAt(xPx: number): number {
    const span = this.rightPx - this.leftPx;
    if (span <= 0) return this.profilePx[0]!;
    const t = clamp((xPx - this.leftPx) / span, 0, 1) * (SURFACE_PROFILE_SAMPLES - 1);
    const i0 = Math.floor(t);
    const i1 = Math.min(SURFACE_PROFILE_SAMPLES - 1, i0 + 1);
    return lerp(this.profilePx[i0]!, this.profilePx[i1]!, t - i0);
  }

  /** New track acquired a platform (pool → active). Snaps current==target so
   * a freshly-spawned platform appears immediately at the right spot instead
   * of gliding in from the pool's stale last position. `profile`, if given,
   * is COPIED (never retained) into both current and target — see the file
   * doc; omitted (ghosts, anchor blocks) fills a flat profile from the box's
   * own top edge, matching this class's pre-profile behaviour exactly. */
  activate(
    trackId: number,
    centerXFraction: number,
    centerYFraction: number,
    widthFraction: number,
    heightFraction: number,
    profile: Float32Array | null = null,
  ): void {
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
    this.setProfile(this.currentProfile, centerYFraction, heightFraction, profile);
    this.setProfile(this.targetProfile, centerYFraction, heightFraction, profile);
    this.currentAlpha = 1;
    this.view.visible = true;
    this.view.alpha = 1;
    this.lastDrawnWidthPx = -1;
    this.lastDrawnHeightPx = -1;
  }

  /** A fresh sample arrived for the track this platform is already
   * following — update the glide TARGET only; `updateVisual` does the actual
   * gliding, once per frame, regardless of how sparsely this fires. `profile`
   * follows the same copy-not-retain / flat-fallback rule as `activate()`. */
  retarget(
    centerXFraction: number,
    centerYFraction: number,
    widthFraction: number,
    heightFraction: number,
    profile: Float32Array | null = null,
  ): void {
    this.targetCenterXFraction = centerXFraction;
    this.targetCenterYFraction = centerYFraction;
    this.targetWidthFraction = widthFraction;
    this.targetHeightFraction = heightFraction;
    this.setProfile(this.targetProfile, centerYFraction, heightFraction, profile);
    this.missedTime = 0;
  }

  deactivate(): void {
    this.active = false;
    this.trackId = -1;
    this.view.visible = false;
  }

  /**
   * Overrides the fill/top-bar hue for THIS instance only — used by
   * CrossingSystem to tell real / ghost / start / goal apart at a glance
   * (a plain `Container.tint` multiply can't do this well: it can only ever
   * DARKEN a channel, never raise one, so multiplying this class's cyan base
   * toward "gold" just produces a muddy yellow-green — a distinct override
   * color gets an actually legible, intentional hue instead). Forces the
   * next `updateVisual` to redraw even if the box's size hasn't changed.
   * Alpha/outline/thickness stay shared (PLATFORM_*_ALPHA etc.) — only the
   * two hues vary, so every platform still reads as "the same KIND of
   * thing", just color-coded. Never called anywhere in 'runner' mode (only
   * PlatformSystem owns platforms there), so its instances keep the default
   * palette forever — byte-identical to before this method existed.
   */
  setPalette(fillColor: number, topBarColor: number): void {
    this.fillColor = fillColor;
    this.topBarColor = topBarColor;
    this.paletteDirty = true;
  }

  /**
   * Per-frame update: glide current→target (box AND profile, elementwise)
   * and current alpha→fadeAlpha at `followT` (a single expDecay(dt) factor
   * shared across every platform, computed once by the owning system),
   * recompute px extents/profile against the live canvas size, and redraw
   * only if the box or the profile SHAPE changed enough to matter.
   *
   * The profile glide is what makes a shape change under a standing player
   * safe — see the file doc and Game.ts's surface-resolution block: a new
   * tracker sample can only ever nudge `currentProfile` a `followT`-sized
   * step per frame toward its target, at the SAME rate box position/size
   * already glide at, so it can never read as a snap or a shove.
   *
   * `offsetXPx`/`offsetYPx` (default 0) is an EXTRA px nudge folded straight
   * into the same px extents the collision queries read (`left`/`right`/
   * `top`/`surfaceYAt`) — never just a rendering-only transform — so the
   * visible shape and the collidable one can never disagree. CrossingSystem
   * uses this to apply gyro-stabilisation's hand-shake correction to REAL
   * tracked platforms only (see GYRO_STABILIZATION_* in config.ts); every
   * other caller passes 0,0.
   */
  updateVisual(followT: number, canvasWidth: number, canvasHeight: number, fadeAlpha: number, offsetXPx = 0, offsetYPx = 0): void {
    this.currentCenterXFraction = lerp(this.currentCenterXFraction, this.targetCenterXFraction, followT);
    this.currentCenterYFraction = lerp(this.currentCenterYFraction, this.targetCenterYFraction, followT);
    this.currentWidthFraction = lerp(this.currentWidthFraction, this.targetWidthFraction, followT);
    this.currentHeightFraction = lerp(this.currentHeightFraction, this.targetHeightFraction, followT);
    this.currentAlpha = lerp(this.currentAlpha, fadeAlpha, followT);
    for (let i = 0; i < SURFACE_PROFILE_SAMPLES; i++) {
      this.currentProfile[i] = lerp(this.currentProfile[i]!, this.targetProfile[i]!, followT);
    }

    const widthPx = this.currentWidthFraction * canvasWidth;
    const centerXPx = this.currentCenterXFraction * canvasWidth + offsetXPx;
    const bottomPx = this.currentCenterYFraction * canvasHeight + (this.currentHeightFraction * canvasHeight) / 2 + offsetYPx;

    let minProfilePx = Infinity;
    for (let i = 0; i < SURFACE_PROFILE_SAMPLES; i++) {
      const px = this.currentProfile[i]! * canvasHeight + offsetYPx;
      this.profilePx[i] = px;
      if (px < minProfilePx) minProfilePx = px;
    }

    this.leftPx = centerXPx - widthPx / 2;
    this.rightPx = centerXPx + widthPx / 2;
    this.topPx = minProfilePx;
    this.bottomPx = bottomPx;

    this.view.x = this.leftPx;
    this.view.y = this.bottomPx;
    this.view.alpha = this.currentAlpha;

    const heightPx = bottomPx - minProfilePx;
    if (
      this.paletteDirty ||
      Math.abs(widthPx - this.lastDrawnWidthPx) > REDRAW_EPSILON_PX ||
      Math.abs(heightPx - this.lastDrawnHeightPx) > REDRAW_EPSILON_PX ||
      this.profileChangedSinceLastDraw()
    ) {
      this.paletteDirty = false;
      this.redraw(widthPx, heightPx);
    }
  }

  private profileChangedSinceLastDraw(): boolean {
    for (let i = 0; i < SURFACE_PROFILE_SAMPLES; i++) {
      if (Math.abs(this.profilePx[i]! - this.lastDrawnProfilePx[i]!) > REDRAW_EPSILON_PX) return true;
    }
    return false;
  }

  /** Copies `profile` (SURFACE_PROFILE_SAMPLES elements, per the
   * TrackedObject contract) into `dst`, or — when `profile` is null (every
   * ghost and both anchor blocks) — fills `dst` with the flat top edge a
   * plain box would have had, so this class's pre-profile rendering/
   * collision behaviour is reproduced exactly when no real shape exists. */
  private setProfile(dst: Float32Array, centerYFraction: number, heightFraction: number, profile: Float32Array | null): void {
    if (profile !== null) {
      dst.set(profile);
    } else {
      dst.fill(centerYFraction - heightFraction / 2);
    }
  }

  /**
   * Outline-over-reality body (low-alpha fill so the real vehicle stays
   * visible) plus a bright top-edge line tracing the ACTUAL silhouette — the
   * landing-surface indicator, replacing the old flat rect now that there's
   * a real shape to trace — echoing the ground line's own core+glow styling
   * so a platform still reads as "the same kind of thing as the ground" at a
   * glance. A soft drop shadow beneath the flat bottom edge and four corner
   * brackets (anchored to the profile's own left/right edge heights, not a
   * flat top) round out the same AR/target-lock visual language as before.
   *
   * Local coordinate system: origin (0,0) is the box's BOTTOM-LEFT corner
   * (`view.y === this.bottomPx` in screen space) — the flat bottom edge sits
   * at local y=0, and every profile column sits at a NEGATIVE local y
   * (`profilePx[i] - bottomPx`, above the bottom edge). Unlike the old flat
   * rectangle (whose origin was the box's TOP-left, since every point on the
   * top edge shared one Y), the bottom edge is now the one fixed reference
   * every column's height varies relative to.
   */
  private redraw(widthPx: number, heightPx: number): void {
    this.lastDrawnWidthPx = widthPx;
    this.lastDrawnHeightPx = heightPx;
    this.lastDrawnProfilePx.set(this.profilePx);

    const w = Math.max(1, widthPx);
    const h = Math.max(1, heightPx);
    const colStep = w / (SURFACE_PROFILE_SAMPLES - 1);
    const bracket = Math.min(PLATFORM_BRACKET_LENGTH_PX, w / 2, h / 2);
    const topLeftY = this.profilePx[0]! - this.bottomPx;
    const topRightY = this.profilePx[SURFACE_PROFILE_SAMPLES - 1]! - this.bottomPx;
    const left = PLATFORM_BRACKET_INSET_PX;
    const right = w - PLATFORM_BRACKET_INSET_PX;
    const bracketTopLeftY = topLeftY + PLATFORM_BRACKET_INSET_PX;
    const bracketTopRightY = topRightY + PLATFORM_BRACKET_INSET_PX;
    const bracketBottomY = -PLATFORM_BRACKET_INSET_PX;

    this.view.clear();

    // Shadow, below the flat bottom edge (unchanged offset/height from the
    // flat-rectangle version).
    this.view
      .rect(0, PLATFORM_SHADOW_OFFSET_Y_PX, w, PLATFORM_SHADOW_HEIGHT_PX)
      .fill({ color: PLATFORM_SHADOW_COLOR, alpha: PLATFORM_SHADOW_ALPHA });

    // Body: follows the profile along the top, flat along the bottom — this
    // is what makes the platform read as the vehicle's actual silhouette
    // instead of a slab floating near it.
    this.tracePathAtColumns(colStep);
    this.view.lineTo(w, 0).lineTo(0, 0).closePath();
    this.view.fill({ color: this.fillColor, alpha: PLATFORM_FILL_ALPHA });

    this.tracePathAtColumns(colStep);
    this.view.lineTo(w, 0).lineTo(0, 0).closePath();
    this.view.stroke({ width: PLATFORM_OUTLINE_WIDTH, color: PLATFORM_OUTLINE_COLOR, alpha: PLATFORM_OUTLINE_ALPHA });

    // Top line: bright indicator tracing the profile itself (plus a small
    // horizontal overhang past the first/last column), drawn twice — glow,
    // then crisp — exactly like the old flat rect was, just as a stroked
    // polyline instead of a filled rect now that the line isn't flat.
    this.tracePathWithOverhang(colStep, w, topLeftY, topRightY);
    this.view.stroke({ width: PLATFORM_TOP_BAR_GLOW_THICKNESS, color: this.topBarColor, alpha: PLATFORM_TOP_BAR_GLOW_ALPHA });
    this.tracePathWithOverhang(colStep, w, topLeftY, topRightY);
    this.view.stroke({ width: PLATFORM_TOP_BAR_THICKNESS, color: this.topBarColor, alpha: PLATFORM_TOP_BAR_ALPHA });

    // Corner brackets — top-left/top-right anchored to the profile's actual
    // edge heights, bottom-left/bottom-right to the flat bottom edge.
    this.view
      .moveTo(left, bracketTopLeftY + bracket)
      .lineTo(left, bracketTopLeftY)
      .lineTo(left + bracket, bracketTopLeftY)
      .moveTo(right - bracket, bracketTopRightY)
      .lineTo(right, bracketTopRightY)
      .lineTo(right, bracketTopRightY + bracket)
      .moveTo(left, bracketBottomY - bracket)
      .lineTo(left, bracketBottomY)
      .lineTo(left + bracket, bracketBottomY)
      .moveTo(right - bracket, bracketBottomY)
      .lineTo(right, bracketBottomY)
      .lineTo(right, bracketBottomY - bracket)
      .stroke({ width: PLATFORM_BRACKET_THICKNESS, color: this.topBarColor, alpha: PLATFORM_BRACKET_ALPHA });
  }

  /** Traces `moveTo` at the first column, `lineTo` through every subsequent
   * column, in local coordinates — shared by the body fill/outline paths
   * (which then close off with the two bottom corners). */
  private tracePathAtColumns(colStep: number): void {
    this.view.moveTo(0, this.profilePx[0]! - this.bottomPx);
    for (let i = 1; i < SURFACE_PROFILE_SAMPLES; i++) {
      this.view.lineTo(colStep * i, this.profilePx[i]! - this.bottomPx);
    }
  }

  /** Same trace as `tracePathAtColumns`, extended by PLATFORM_TOP_BAR_
   * OVERHANG_PX on both ends (flat extensions at the edge columns' own
   * height) — used for the top line/glow strokes only. */
  private tracePathWithOverhang(colStep: number, w: number, topLeftY: number, topRightY: number): void {
    this.view.moveTo(-PLATFORM_TOP_BAR_OVERHANG_PX, topLeftY);
    for (let i = 0; i < SURFACE_PROFILE_SAMPLES; i++) {
      this.view.lineTo(colStep * i, this.profilePx[i]! - this.bottomPx);
    }
    this.view.lineTo(w + PLATFORM_TOP_BAR_OVERHANG_PX, topRightY);
  }
}
