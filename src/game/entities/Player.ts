/**
 * Player — a small hand-rolled character rig: a rounded-rect body, two
 * pivoting leg containers, one pivoting arm and a static eye, all built once
 * in the constructor. `updateCrossing()` only ever mutates transform
 * properties (position/rotation/scale) on these pre-built display objects —
 * never constructs or redraws anything — so it is safe to call every frame.
 *
 * Physics (gravity, jump impulse, coyote time, jump buffering) are
 * hand-rolled here, not delegated to any engine, per the project's "no
 * physics engine" rule. All integration is `value += rate * dt` with dt in
 * seconds. There is exactly one physics model (crossing mode's free 2D
 * aim-and-release) — see updateCrossing()'s doc for the full shape of it.
 */

import { Container, Graphics } from 'pixi.js';
import {
  AIRBORNE_LEG_ANGLE,
  CROSSING_COYOTE_TIME_SECONDS,
  CROSSING_EDGE_WARNING_TINT,
  CROSSING_JUMP_BUFFER_SECONDS,
  CROSSING_TRAIL_COLOR,
  CROSSING_TRAIL_FULL_ALPHA_SPEED_PX_S,
  CROSSING_TRAIL_MAX_ALPHA,
  CROSSING_TRAIL_SMOOTH_RATE,
  CROSSING_TRAIL_STREAK_COUNT,
  CROSSING_TRAIL_STREAK_LENGTH_PX,
  CROSSING_TRAIL_STREAK_SPACING_PX,
  CROSSING_TRAIL_STREAK_THICKNESS_PX,
  CROSSING_WALK_SPEED,
  GRAVITY,
  JUMP_SQUASH_SCALE_X,
  JUMP_SQUASH_SCALE_Y,
  LAND_SQUASH_SCALE_X,
  LAND_SQUASH_SCALE_Y,
  PLAYER_COLLISION_INSET_TOP,
  PLAYER_COLOR_BODY,
  PLAYER_COLOR_EYE,
  PLAYER_COLOR_LIMB,
  PLAYER_COLOR_OUTLINE,
  PLAYER_HEIGHT,
  PLAYER_LEG_LENGTH,
  PLAYER_LEG_WIDTH,
  PLAYER_WIDTH,
  RUN_CYCLE_BASE_SPEED,
  RUN_LEG_SWING_RADIANS,
  SQUASH_STRETCH_RATE,
} from '../config.ts';
import { clamp, expDecay, lerp, lerpColor } from '../util/math.ts';

/** Builds one leg/arm: a small pivoting container with the limb drawn
 * hanging down from its local origin, so rotating the container swings it
 * from the hip/shoulder. */
function buildLimb(color: number): Container {
  const limb = new Container();
  const graphic = new Graphics()
    .roundRect(-PLAYER_LEG_WIDTH / 2, 0, PLAYER_LEG_WIDTH, PLAYER_LEG_LENGTH, 2)
    .fill({ color })
    .stroke({ width: 1.5, color: PLAYER_COLOR_OUTLINE });
  limb.addChild(graphic);
  return limb;
}

export class Player {
  /** Root display object — Game adds this to the world container. */
  public readonly view: Container = new Container();

  /** True for exactly one `updateCrossing()` call the frame a jump launches. */
  public justJumped = false;
  /** True for exactly one `updateCrossing()` call the frame the player lands. */
  public justLanded = false;
  /** Magnitude of vertical velocity (px/s) at the instant of the most recent
   * landing — valid only the same frame `justLanded` is true. Game.ts uses
   * this to scale the landing screen-shake to how hard the player actually
   * hit the ground. */
  public landingImpactSpeed = 0;

  private readonly body: Graphics;
  private readonly legLeft: Container;
  private readonly legRight: Container;
  private readonly arm: Container;
  /** Motion-trail streaks — read airborne speed each frame (see
   * updateCrossing), not any dash mechanic (there is none in crossing mode). */
  private readonly trailStreaks: Graphics[] = [];
  private readonly trailBaseAlpha: number[] = [];
  private trailAlpha = 0;

  private originX = 0;
  /** Height above the current surface, px. 0 = grounded. */
  private airborneHeight = 0;
  /** px/s, positive = upward. */
  private velocityY = 0;
  private grounded = true;
  private coyoteTimer = 0;
  private jumpBufferTimer = 0;
  private runPhase = 0;
  private squashX = 1;
  private squashY = 1;
  /** World-space foot position, recomputed every update; exposed via the
   * `top`/`groundContactY` getters. */
  private footY = 0;

  /** World-space horizontal velocity, px/s, positive = rightward on screen.
   * Driven directly while grounded (see setWalkVelocity), carried
   * ballistically (unchanged) while airborne. */
  private velocityX = 0;
  /** Which way the rig faces — true = unmirrored (the art's native "runs
   * right" orientation, see the trail comment in the constructor), false =
   * mirrored. Flips live to track the player's actual direction of travel. */
  private facingRight = true;
  /** Buffered directional-jump velocity, consumed by jumpBufferTimer once
   * grounded/within coyote time — see requestDirectionalJump(). */
  private pendingJumpVX = 0;
  private pendingJumpVY = 0;

  constructor() {
    const bodyHeight = PLAYER_HEIGHT - PLAYER_LEG_LENGTH;
    const torsoCenterY = -PLAYER_HEIGHT + bodyHeight * 0.5;

    this.body = new Graphics()
      .roundRect(-PLAYER_WIDTH / 2, -PLAYER_HEIGHT, PLAYER_WIDTH, bodyHeight, 8)
      .fill({ color: PLAYER_COLOR_BODY })
      .stroke({ width: 2, color: PLAYER_COLOR_OUTLINE })
      .circle(PLAYER_WIDTH * 0.18, -PLAYER_HEIGHT + bodyHeight * 0.4, 3.2)
      .fill({ color: PLAYER_COLOR_EYE });

    this.legLeft = buildLimb(PLAYER_COLOR_LIMB);
    this.legLeft.position.set(-PLAYER_WIDTH * 0.22, -PLAYER_LEG_LENGTH);
    this.legRight = buildLimb(PLAYER_COLOR_LIMB);
    this.legRight.position.set(PLAYER_WIDTH * 0.22, -PLAYER_LEG_LENGTH);

    this.arm = buildLimb(PLAYER_COLOR_LIMB);
    this.arm.scale.set(0.75, 0.8);
    this.arm.position.set(PLAYER_WIDTH * 0.3, -PLAYER_HEIGHT + bodyHeight * 0.32);

    // Motion-trail streaks, shown while airborne with real speed (see
    // updateCrossing). All of this rig's geometry (eye, arm, these streaks)
    // is authored assuming the player faces/runs RIGHT — streaks trail off
    // to the left behind it. `view.scale.x` flips per `facingRight` below,
    // and every child flips along with it, so the streaks always end up
    // trailing correctly behind whichever way the player currently faces,
    // with no separate per-frame mirroring math needed here. Built once;
    // only alpha is touched per frame.
    for (let i = 0; i < CROSSING_TRAIL_STREAK_COUNT; i++) {
      const streak = new Graphics()
        .roundRect(
          -CROSSING_TRAIL_STREAK_LENGTH_PX / 2,
          -CROSSING_TRAIL_STREAK_THICKNESS_PX / 2,
          CROSSING_TRAIL_STREAK_LENGTH_PX,
          CROSSING_TRAIL_STREAK_THICKNESS_PX,
          CROSSING_TRAIL_STREAK_THICKNESS_PX / 2,
        )
        .fill({ color: CROSSING_TRAIL_COLOR });
      streak.x = -(PLAYER_WIDTH / 2 + CROSSING_TRAIL_STREAK_SPACING_PX * (i + 1));
      streak.y = torsoCenterY;
      streak.alpha = 0;
      this.trailStreaks.push(streak);
      this.trailBaseAlpha.push(CROSSING_TRAIL_MAX_ALPHA * (1 - i / CROSSING_TRAIL_STREAK_COUNT));
    }

    // Draw order: trail behind everything, then legs behind the body, arm
    // in front.
    this.view.addChild(...this.trailStreaks);
    this.view.addChild(this.legLeft, this.legRight, this.body, this.arm);
  }

  /** Stand at a fixed world position (e.g. the start block) facing a given
   * direction — used to (re)spawn on a fresh attempt or after completing a
   * crossing. */
  resetForCrossing(x: number, y: number, facingRight: boolean): void {
    this.originX = x;
    this.airborneHeight = 0;
    this.velocityY = 0;
    this.velocityX = 0;
    this.grounded = true;
    this.coyoteTimer = 0;
    this.jumpBufferTimer = 0;
    this.pendingJumpVX = 0;
    this.pendingJumpVY = 0;
    this.runPhase = 0;
    this.squashX = 1;
    this.squashY = 1;
    this.footY = y;
    this.facingRight = facingRight;
    this.trailAlpha = 0;
    this.legLeft.rotation = 0;
    this.legRight.rotation = 0;
    this.arm.rotation = 0;
    this.view.x = x;
    this.view.y = y;
    this.view.scale.set(facingRight ? 1 : -1, 1);
    this.justJumped = false;
    this.justLanded = false;
    this.landingImpactSpeed = 0;
    this.body.tint = 0xffffff;
    for (let i = 0; i < this.trailStreaks.length; i++) {
      this.trailStreaks[i]!.alpha = 0;
    }
  }

  /** Crossing-mode-only: tints the body toward CROSSING_EDGE_WARNING_TINT as
   * `intensity` (0..1) rises — the visible telegraph Game.ts drives before a
   * platform carrying the player horizontally off the frame ends the run.
   * `0` clears it back to neutral. A cheap tint write, never a redraw. */
  setEdgeWarningIntensity(intensity: number): void {
    this.body.tint = lerpColor(0xffffff, CROSSING_EDGE_WARNING_TINT, intensity);
  }

  /** Grounded-only lateral control: set every frame from the current input
   * state (0 when nothing is held) — NOT a one-shot request like
   * requestDirectionalJump. Airborne calls are silently ignored, which is
   * what gives an in-flight jump its ballistic, no-air-control feel:
   * velocityX only ever changes here or at the instant a jump launches. */
  setWalkVelocity(vx: number): void {
    if (!this.grounded) return;
    this.velocityX = vx;
    if (vx > 1) this.facingRight = true;
    else if (vx < -1) this.facingRight = false;
  }

  /** Passive horizontal nudge — used to carry the player along with the
   * real/ghost platform box they're currently riding, so a drifting vehicle
   * can visibly carry them toward (or off) an edge, not just support them
   * vertically. Not gated on `grounded` internally: callers (Game.ts) only
   * invoke this while a platform is actively selected as the current
   * standing surface, which already implies it. */
  driftX(dx: number): void {
    this.originX += dx;
  }

  /** Buffers an aim-and-release jump; consumed on the next updateCrossing()
   * where the player is grounded or within coyote time. */
  requestDirectionalJump(vx: number, vy: number): void {
    this.jumpBufferTimer = CROSSING_JUMP_BUFFER_SECONDS;
    this.pendingJumpVX = vx;
    this.pendingJumpVY = vy;
  }

  /**
   * Free 2D physics step: gravity + vertical integration, plus horizontal
   * integration (the player genuinely moves left/right, unlike a
   * fixed-column runner). `surfaceY` is the currently-resolved landing
   * surface's top, in the same relative-height encoding syncGroundReference()
   * rebases onto for a pop-free switch between surfaces (a real platform's
   * glide, a ghost's drift, or either anchor block) — see Game.ts's
   * surface-resolution block, which adds a generous landing-assist magnet on
   * top of a plain one-way test.
   *
   * `surfaceAvailable` is what makes this genuinely different from a
   * fixed-ground physics step: there is no universal floor in crossing mode
   * — when Game.ts's resolution found no qualifying platform this frame,
   * `surfaceY` is just whatever height was last recorded (frozen), and
   * `airborneHeight` mathematically returns to exactly 0 there the instant
   * ANY jump arcs back down through its own launch height — a phantom floor
   * with nothing under it. Landing must only ever happen when Game.ts says
   * there is actually something to land ON; otherwise this keeps `grounded`
   * false and lets `airborneHeight` run past zero into negative territory,
   * which is exactly "falling further below the frozen reference" — i.e.
   * genuinely falling, unobstructed, toward the fall-below-frame loss.
   */
  updateCrossing(dt: number, surfaceY: number, surfaceAvailable: boolean): void {
    this.justJumped = false;
    this.justLanded = false;

    this.velocityY -= GRAVITY * dt;
    this.airborneHeight += this.velocityY * dt;
    this.originX += this.velocityX * dt;

    if (surfaceAvailable && this.airborneHeight <= 0) {
      const wasAirborne = !this.grounded;
      if (wasAirborne) {
        this.landingImpactSpeed = Math.abs(this.velocityY);
      }
      this.airborneHeight = 0;
      this.velocityY = 0;
      // Land cleanly, no residual slide — keeps "which surface is the
      // player standing on" unambiguous for the frame right after landing.
      this.velocityX = 0;
      this.grounded = true;
      this.coyoteTimer = CROSSING_COYOTE_TIME_SECONDS;
      if (wasAirborne) {
        this.justLanded = true;
        this.squashX = LAND_SQUASH_SCALE_X;
        this.squashY = LAND_SQUASH_SCALE_Y;
      }
    } else {
      this.grounded = false;
      if (this.coyoteTimer > 0) {
        this.coyoteTimer = Math.max(0, this.coyoteTimer - dt);
      }
    }

    if (this.jumpBufferTimer > 0) {
      if (this.grounded || this.coyoteTimer > 0) {
        this.launchCrossingJump(this.pendingJumpVX, this.pendingJumpVY);
        this.justJumped = true;
      } else {
        this.jumpBufferTimer = Math.max(0, this.jumpBufferTimer - dt);
      }
    }

    this.footY = surfaceY - this.airborneHeight;

    const relax = expDecay(SQUASH_STRETCH_RATE, dt);
    this.squashX = lerp(this.squashX, 1, relax);
    this.squashY = lerp(this.squashY, 1, relax);

    if (this.grounded) {
      const walkRatio = clamp(Math.abs(this.velocityX) / CROSSING_WALK_SPEED, 0, 1);
      const poseRelax = expDecay(SQUASH_STRETCH_RATE, dt);
      if (walkRatio > 0.02) {
        this.runPhase += RUN_CYCLE_BASE_SPEED * Math.max(0.4, walkRatio) * dt;
        const swing = Math.sin(this.runPhase) * RUN_LEG_SWING_RADIANS;
        this.legLeft.rotation = swing;
        this.legRight.rotation = -swing;
        this.arm.rotation = -swing * 0.6;
      } else {
        this.legLeft.rotation = lerp(this.legLeft.rotation, 0, poseRelax);
        this.legRight.rotation = lerp(this.legRight.rotation, 0, poseRelax);
        this.arm.rotation = lerp(this.arm.rotation, 0, poseRelax);
      }
    } else {
      const poseRelax = expDecay(SQUASH_STRETCH_RATE, dt);
      this.legLeft.rotation = lerp(this.legLeft.rotation, AIRBORNE_LEG_ANGLE, poseRelax);
      this.legRight.rotation = lerp(this.legRight.rotation, AIRBORNE_LEG_ANGLE, poseRelax);
      this.arm.rotation = lerp(this.arm.rotation, -AIRBORNE_LEG_ANGLE * 0.6, poseRelax);
    }

    // Flight trail: reads airborne speed, not any dash mechanic (crossing
    // mode has none) — a fast hop leaves a visible streak, a gentle one
    // barely does, and it's gone the instant the player lands.
    const speed = Math.hypot(this.velocityX, this.velocityY);
    const targetTrailAlpha = this.grounded ? 0 : clamp(speed / CROSSING_TRAIL_FULL_ALPHA_SPEED_PX_S, 0, 1);
    this.trailAlpha = lerp(this.trailAlpha, targetTrailAlpha, expDecay(CROSSING_TRAIL_SMOOTH_RATE, dt));
    for (let i = 0; i < this.trailStreaks.length; i++) {
      this.trailStreaks[i]!.alpha = this.trailAlpha * this.trailBaseAlpha[i]!;
    }

    this.view.x = this.originX;
    this.view.y = this.footY;
    this.view.scale.set((this.facingRight ? 1 : -1) * this.squashX, this.squashY);
  }

  private launchCrossingJump(vx: number, vy: number): void {
    this.velocityX = vx;
    this.velocityY = vy;
    this.grounded = false;
    this.coyoteTimer = 0;
    this.jumpBufferTimer = 0;
    this.squashX = JUMP_SQUASH_SCALE_X;
    this.squashY = JUMP_SQUASH_SCALE_Y;
    if (vx > 0.01) this.facingRight = true;
    else if (vx < -0.01) this.facingRight = false;
  }

  /** World-space foot x, for spawning particles under the player and for
   * horizontal landing-precision checks. */
  get x(): number {
    return this.originX;
  }

  /** World-space foot y (ground contact point while grounded). */
  get groundContactY(): number {
    return this.footY;
  }

  get isGrounded(): boolean {
    return this.grounded;
  }

  /** Signed vertical velocity, px/s (positive = upward). Exposed so
   * Game.ts's landing surface-resolution can gate candidacy on "not
   * currently rising" — a platform must never be able to catch/stop an
   * ascending jump, only be landed on while falling (or already resting). */
  get verticalVelocity(): number {
    return this.velocityY;
  }

  /**
   * Re-expresses the player's CURRENT on-screen foot position relative to a
   * NEW surface reference, without changing that position or any momentum —
   * purely a continuity rebase so a later switch of WHICH surface
   * `updateCrossing()`'s `surfaceY` argument refers to (platform ↔ platform,
   * or platform ↔ either anchor block) can never show up as a visual pop,
   * regardless of how far apart the two surfaces are. Must be called, if at
   * all, only once per frame, strictly BEFORE the `updateCrossing()` call
   * that first passes the new surface's Y. Callers must NOT call this for
   * the ordinary case of the SAME surface continuing to move smoothly (a
   * platform's own follow-glide or drift) — doing so would subtly perturb
   * that surface's already-correct continuous behaviour; it exists only for
   * genuine surface-identity switches.
   */
  syncGroundReference(newGroundY: number): void {
    this.airborneHeight = newGroundY - this.footY;
  }

  /** Fall-below-frame loss check, in world space (see
   * CROSSING_FALL_MARGIN_PX in config.ts). Forgiving inset — same "players
   * hate pixel-perfect geometry" reasoning as everywhere else. */
  get top(): number {
    return this.footY - PLAYER_HEIGHT + PLAYER_COLLISION_INSET_TOP;
  }
}
