/**
 * Player — a small hand-rolled character rig: a rounded-rect body, two
 * pivoting leg containers, one pivoting arm and a static eye, all built once
 * in the constructor. `update()` only ever mutates transform properties
 * (position/rotation/scale) on these pre-built display objects — never
 * constructs or redraws anything — so it is safe to call every frame.
 *
 * Physics (gravity, jump impulse, coyote time, jump buffering, optional
 * double jump) are hand-rolled here, not delegated to any engine, per the
 * project's "no physics engine" rule. All integration is `value += rate *
 * dt` with dt in seconds.
 */

import { Container, Graphics } from 'pixi.js';
import {
  AIRBORNE_LEG_ANGLE,
  COYOTE_TIME_SECONDS,
  CROSSING_COYOTE_TIME_SECONDS,
  CROSSING_EDGE_WARNING_TINT,
  CROSSING_JUMP_BUFFER_SECONDS,
  CROSSING_WALK_SPEED,
  DASH_COOLDOWN_SECONDS,
  DASH_DECAY_RATE,
  DASH_INDICATOR_CHARGING_ALPHA_MIN,
  DASH_INDICATOR_CHARGING_COLOR,
  DASH_INDICATOR_OFFSET_Y,
  DASH_INDICATOR_READY_ALPHA,
  DASH_INDICATOR_READY_COLOR,
  DASH_INDICATOR_RADIUS,
  DASH_INVULN_SECONDS,
  DASH_PEAK_BOOST,
  DASH_SQUASH_SCALE_X,
  DASH_SQUASH_SCALE_Y,
  DASH_TRAIL_COLOR,
  DASH_TRAIL_MAX_ALPHA,
  DASH_TRAIL_STREAK_COUNT,
  DASH_TRAIL_STREAK_LENGTH_PX,
  DASH_TRAIL_STREAK_SPACING_PX,
  DASH_TRAIL_STREAK_THICKNESS_PX,
  DOUBLE_JUMP_ENABLED,
  DOUBLE_JUMP_VELOCITY,
  GRAVITY,
  JUMP_BUFFER_SECONDS,
  JUMP_SQUASH_SCALE_X,
  JUMP_SQUASH_SCALE_Y,
  JUMP_VELOCITY,
  LAND_SQUASH_SCALE_X,
  LAND_SQUASH_SCALE_Y,
  PLAYER_COLLISION_INSET_BOTTOM,
  PLAYER_COLLISION_INSET_TOP,
  PLAYER_COLLISION_INSET_X,
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
  SLAM_DROP_SPEED,
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

  /** True for exactly one `update()` call the frame a primary jump launches. */
  public justJumped = false;
  /** True for exactly one `update()` call the frame a double jump launches. */
  public justDoubleJumped = false;
  /** True for exactly one `update()` call the frame the player lands. */
  public justLanded = false;
  /** True for exactly one `update()` call the frame a dash actually
   * activates (cooldown allowed it) — false if requestDash() was called
   * while on cooldown. */
  public justDashed = false;
  /** True for exactly one `update()` call the frame the player lands from a
   * slam specifically (as opposed to an ordinary landing) — Game.ts uses
   * this to trigger the shockwave instead of/in addition to normal landing
   * dust. */
  public justSlamLanded = false;

  private readonly body: Graphics;
  private readonly legLeft: Container;
  private readonly legRight: Container;
  private readonly arm: Container;
  private readonly dashTrailStreaks: Graphics[] = [];
  private readonly dashTrailBaseAlpha: number[] = [];
  private readonly dashIndicator: Graphics;

  private originX = 0;
  /** Height above the ground line, px. 0 = grounded. */
  private airborneHeight = 0;
  /** px/s, positive = upward. */
  private velocityY = 0;
  private grounded = true;
  private coyoteTimer = 0;
  private jumpBufferTimer = 0;
  private hasDoubleJumped = false;
  private runPhase = 0;
  private squashX = 1;
  private squashY = 1;
  /** World-space foot position, recomputed every update; exposed via the AABB getters. */
  private footY = 0;

  /** Set by requestDash()/requestSlam(), consumed (and cleared) the next
   * update() — same "pending flag consumed inside update()" pattern as the
   * jump buffer, so an input event firing between frames never races a
   * same-tick flag reset (see class doc). */
  private dashRequested = false;
  private slamRequested = false;
  /** Extra world-speed multiplier, decaying exponentially toward 0. */
  private dashBoost = 0;
  private dashInvulnTimer = 0;
  private dashCooldownTimer = 0;
  /** True from the moment a slam triggers until the player lands. */
  private isSlamming = false;

  // --- Crossing-mode-only state (see updateCrossing/resetForCrossing and
  // the other crossing-only methods below). The runner's own update()/
  // resetToIdle()/launchJump() never read or write any of these fields, so
  // 'runner' mode is provably unaffected by their existence. ---

  /** World-space horizontal velocity, px/s, positive = rightward on screen
   * (screen space, NOT mirrored by facing — unlike the runner, crossing
   * mode's player genuinely moves left/right, so unlike `velocityY` there is
   * no runner equivalent to reuse). Driven directly while grounded (see
   * setWalkVelocity), carried ballistically (unchanged) while airborne. */
  private velocityX = 0;
  /** Which way the rig faces — true = unmirrored (the art's native
   * "runs right" orientation, see the constructor's dash-trail comment),
   * false = mirrored. The runner permanently mirrors (always false,
   * decided once in resetToIdle/update); crossing flips this live to track
   * the player's actual direction of travel. */
  private facingRight = true;
  /** Buffered directional-jump velocity, consumed by the same
   * jumpBufferTimer the runner's plain vertical jump already uses — see
   * requestDirectionalJump(). */
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

    // Motion-trail streaks. All of this rig's geometry (eye, arm, these
    // streaks) is authored assuming the player faces/runs RIGHT — offset to
    // the right of center, streaks trailing off to the left behind it. The
    // whole `view` is then mirrored horizontally (view.scale.x is negated —
    // see resetToIdle()/update() below) so the player actually reads as
    // facing LEFT, the direction of travel for a passenger looking out the
    // right-hand window (see PLAYER_X_FRACTION in config.ts): every child
    // built here flips along with it, so the streaks end up trailing off to
    // the RIGHT — behind the player, into the direction it came from — with
    // no separate per-offset mirroring needed. Built once here; only alpha
    // is touched per frame.
    for (let i = 0; i < DASH_TRAIL_STREAK_COUNT; i++) {
      const streak = new Graphics()
        .roundRect(
          -DASH_TRAIL_STREAK_LENGTH_PX / 2,
          -DASH_TRAIL_STREAK_THICKNESS_PX / 2,
          DASH_TRAIL_STREAK_LENGTH_PX,
          DASH_TRAIL_STREAK_THICKNESS_PX,
          DASH_TRAIL_STREAK_THICKNESS_PX / 2,
        )
        .fill({ color: DASH_TRAIL_COLOR });
      streak.x = -(PLAYER_WIDTH / 2 + DASH_TRAIL_STREAK_SPACING_PX * (i + 1));
      streak.y = torsoCenterY;
      streak.alpha = 0;
      this.dashTrailStreaks.push(streak);
      this.dashTrailBaseAlpha.push(DASH_TRAIL_MAX_ALPHA * (1 - i / DASH_TRAIL_STREAK_COUNT));
    }

    // Dash-ready indicator — a small dot above the head; color/alpha convey
    // ready-vs-charging (see syncDashIndicator()).
    this.dashIndicator = new Graphics().circle(0, 0, DASH_INDICATOR_RADIUS).fill({ color: 0xffffff });
    this.dashIndicator.x = 0;
    this.dashIndicator.y = -PLAYER_HEIGHT - DASH_INDICATOR_OFFSET_Y;

    // Draw order: trail behind everything, then legs behind the body, arm
    // in front, indicator on top.
    this.view.addChild(...this.dashTrailStreaks);
    this.view.addChild(this.legLeft, this.legRight, this.body, this.arm, this.dashIndicator);
    this.syncDashIndicator();
  }

  /** Fixed horizontal position — set once at start and again on resize. */
  setX(x: number): void {
    this.originX = x;
    this.view.x = x;
  }

  /** Buffers a jump request; consumed on the next update() where the player
   * is grounded, within coyote time, or (if enabled) mid-air for a double jump. */
  requestJump(): void {
    this.jumpBufferTimer = JUMP_BUFFER_SECONDS;
  }

  /** Buffers a dash request; consumed on the next update(). A no-op there if
   * still on cooldown — see justDashed for whether it actually fired. */
  requestDash(): void {
    this.dashRequested = true;
  }

  /** Instantly clears the dash cooldown — the effect of the `sign`-
   * detection power-up (see PickupSystem / Game.ts). A no-op-ish call if
   * dash is already ready (cooldown can't go negative); the indicator is
   * re-synced immediately so a "ready" cyan reads the very same frame the
   * pickup was collected, not one frame later. Deliberately does NOT touch
   * dashBoost/dashInvulnTimer — this recharges the *resource*, it doesn't
   * trigger a dash itself. */
  grantDashRecharge(): void {
    this.dashCooldownTimer = 0;
    this.syncDashIndicator();
  }

  /** Buffers a slam request; consumed on the next update(). A no-op there if
   * the player has since landed (or was never airborne) — callers should
   * still gate on `isGrounded` themselves so the gesture never even reaches
   * here while grounded (see InputSystem's arbitration rule), but this is
   * defended a second time regardless. */
  requestSlam(): void {
    this.slamRequested = true;
  }

  /** Snap back to a grounded idle pose — used by start()/reset(). */
  resetToIdle(groundY: number): void {
    this.airborneHeight = 0;
    this.velocityY = 0;
    this.grounded = true;
    this.coyoteTimer = 0;
    this.jumpBufferTimer = 0;
    this.hasDoubleJumped = false;
    this.runPhase = 0;
    this.squashX = 1;
    this.squashY = 1;
    this.footY = groundY;
    this.legLeft.rotation = 0;
    this.legRight.rotation = 0;
    this.arm.rotation = 0;
    this.view.x = this.originX;
    this.view.y = groundY;
    // Negative x scale mirrors the whole rig to face left — see the
    // dash-trail comment in the constructor for why.
    this.view.scale.set(-1, 1);
    this.justJumped = false;
    this.justDoubleJumped = false;
    this.justLanded = false;
    this.justDashed = false;
    this.justSlamLanded = false;
    this.dashRequested = false;
    this.slamRequested = false;
    this.dashBoost = 0;
    this.dashInvulnTimer = 0;
    this.dashCooldownTimer = 0;
    this.isSlamming = false;
    this.velocityX = 0;
    // Undo any crossing-mode hiding of the dash rig (see resetForCrossing) —
    // runner mode always shows it. Also clear any edge-carry warning tint
    // left over from a crossing-mode switch (see setEdgeWarningIntensity).
    this.dashIndicator.visible = true;
    this.body.tint = 0xffffff;
    for (let i = 0; i < this.dashTrailStreaks.length; i++) {
      this.dashTrailStreaks[i]!.alpha = 0;
    }
    this.syncDashIndicator();
  }

  update(dt: number, groundY: number, speedRatio: number): void {
    this.justJumped = false;
    this.justDoubleJumped = false;
    this.justLanded = false;
    this.justDashed = false;
    this.justSlamLanded = false;

    // --- Dash: timers decay regardless of grounded state, then the pending
    // request (if any) is consumed. Dash works whether airborne or grounded.
    if (this.dashCooldownTimer > 0) {
      this.dashCooldownTimer = Math.max(0, this.dashCooldownTimer - dt);
    }
    if (this.dashInvulnTimer > 0) {
      this.dashInvulnTimer = Math.max(0, this.dashInvulnTimer - dt);
    }
    this.dashBoost = lerp(this.dashBoost, 0, expDecay(DASH_DECAY_RATE, dt));
    if (this.dashRequested) {
      this.dashRequested = false;
      if (this.dashCooldownTimer <= 0) {
        this.dashBoost = DASH_PEAK_BOOST;
        this.dashInvulnTimer = DASH_INVULN_SECONDS;
        this.dashCooldownTimer = DASH_COOLDOWN_SECONDS;
        this.squashX = DASH_SQUASH_SCALE_X;
        this.squashY = DASH_SQUASH_SCALE_Y;
        this.justDashed = true;
      }
    }

    this.velocityY -= GRAVITY * dt;
    this.airborneHeight += this.velocityY * dt;

    if (this.airborneHeight <= 0) {
      const wasAirborne = !this.grounded;
      this.airborneHeight = 0;
      this.velocityY = 0;
      this.grounded = true;
      this.coyoteTimer = COYOTE_TIME_SECONDS;
      this.hasDoubleJumped = false;
      if (wasAirborne) {
        this.justLanded = true;
        if (this.isSlamming) {
          this.justSlamLanded = true;
        }
        this.squashX = LAND_SQUASH_SCALE_X;
        this.squashY = LAND_SQUASH_SCALE_Y;
      }
      this.isSlamming = false;
    } else {
      this.grounded = false;
      if (this.coyoteTimer > 0) {
        this.coyoteTimer = Math.max(0, this.coyoteTimer - dt);
      }
    }

    // --- Slam: only takes effect while genuinely airborne (checked here,
    // at consumption time, using this frame's freshly-updated grounded
    // state — not the state at the moment the gesture fired).
    if (this.slamRequested) {
      this.slamRequested = false;
      if (!this.grounded) {
        this.velocityY = -SLAM_DROP_SPEED;
        this.isSlamming = true;
      }
    }

    if (this.jumpBufferTimer > 0) {
      if (this.grounded || this.coyoteTimer > 0) {
        this.launchJump(JUMP_VELOCITY);
        this.justJumped = true;
      } else if (DOUBLE_JUMP_ENABLED && !this.hasDoubleJumped) {
        this.launchJump(DOUBLE_JUMP_VELOCITY);
        this.hasDoubleJumped = true;
        this.justDoubleJumped = true;
      } else {
        this.jumpBufferTimer = Math.max(0, this.jumpBufferTimer - dt);
      }
    }

    this.footY = groundY - this.airborneHeight;

    const relax = expDecay(SQUASH_STRETCH_RATE, dt);
    this.squashX = lerp(this.squashX, 1, relax);
    this.squashY = lerp(this.squashY, 1, relax);

    if (this.grounded) {
      this.runPhase += RUN_CYCLE_BASE_SPEED * Math.max(0.4, speedRatio) * dt;
      const swing = Math.sin(this.runPhase) * RUN_LEG_SWING_RADIANS;
      this.legLeft.rotation = swing;
      this.legRight.rotation = -swing;
      this.arm.rotation = -swing * 0.6;
    } else {
      const poseRelax = expDecay(SQUASH_STRETCH_RATE, dt);
      this.legLeft.rotation = lerp(this.legLeft.rotation, AIRBORNE_LEG_ANGLE, poseRelax);
      this.legRight.rotation = lerp(this.legRight.rotation, AIRBORNE_LEG_ANGLE, poseRelax);
      this.arm.rotation = lerp(this.arm.rotation, -AIRBORNE_LEG_ANGLE * 0.6, poseRelax);
    }

    const trailFraction = clamp(this.dashBoost / DASH_PEAK_BOOST, 0, 1);
    for (let i = 0; i < this.dashTrailStreaks.length; i++) {
      this.dashTrailStreaks[i]!.alpha = trailFraction * this.dashTrailBaseAlpha[i]!;
    }
    this.syncDashIndicator();

    this.view.y = this.footY;
    // Negative x scale mirrors the whole rig to face left — see the
    // dash-trail comment in the constructor for why. Squash/stretch still
    // works unchanged: it's a symmetric elongation about the origin, so the
    // sign of the base scale doesn't affect how it reads.
    this.view.scale.set(-this.squashX, this.squashY);
  }

  private launchJump(velocity: number): void {
    this.velocityY = velocity;
    this.grounded = false;
    this.coyoteTimer = 0;
    this.jumpBufferTimer = 0;
    this.isSlamming = false;
    this.squashX = JUMP_SQUASH_SCALE_X;
    this.squashY = JUMP_SQUASH_SCALE_Y;
  }

  /* ------------------------------------------------------------------ */
  /* Crossing mode only — see the field-group comment above for the      */
  /* isolation argument. Nothing runner-mode calls (update, resetToIdle,  */
  /* requestJump, launchJump, ...) reads any field only these methods     */
  /* write, and vice versa, so the two physics models can never interfere.*/
  /* ------------------------------------------------------------------ */

  /** Stand at a fixed world position (e.g. the start block) facing a given
   * direction — the crossing-mode equivalent of resetToIdle(). */
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
    this.hasDoubleJumped = false;
    this.runPhase = 0;
    this.squashX = 1;
    this.squashY = 1;
    this.footY = y;
    this.facingRight = facingRight;
    this.legLeft.rotation = 0;
    this.legRight.rotation = 0;
    this.arm.rotation = 0;
    this.view.x = x;
    this.view.y = y;
    this.view.scale.set(facingRight ? 1 : -1, 1);
    this.justJumped = false;
    this.justDoubleJumped = false;
    this.justLanded = false;
    this.justDashed = false;
    this.justSlamLanded = false;
    this.dashRequested = false;
    this.slamRequested = false;
    this.dashBoost = 0;
    this.dashInvulnTimer = 0;
    this.dashCooldownTimer = 0;
    this.isSlamming = false;
    // The dash mechanic doesn't exist in crossing mode — hide its rig
    // entirely rather than let a stale "ready" indicator float over the
    // player's head for a mode that never reads dashRequested. Restored by
    // resetToIdle() if the player switches back to 'runner'.
    this.dashIndicator.visible = false;
    this.body.tint = 0xffffff;
    for (let i = 0; i < this.dashTrailStreaks.length; i++) {
      this.dashTrailStreaks[i]!.alpha = 0;
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
   * requestJump. Airborne calls are silently ignored, which is what gives
   * an in-flight jump its ballistic, no-air-control feel: velocityX only
   * ever changes here or at the instant a jump launches. */
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
   * where the player is grounded or within coyote time — same
   * buffer-then-consume shape as requestJump()/the runner's jumpBufferTimer,
   * just carrying a velocity vector instead of a fixed constant. */
  requestDirectionalJump(vx: number, vy: number): void {
    this.jumpBufferTimer = CROSSING_JUMP_BUFFER_SECONDS;
    this.pendingJumpVX = vx;
    this.pendingJumpVY = vy;
  }

  /**
   * Free 2D physics step: gravity + vertical integration exactly like
   * update()'s, PLUS horizontal integration (the runner's x never moves).
   * `surfaceY` plays the same role `groundY` does in update() — the
   * currently-resolved landing surface's top, in the same relative-height
   * encoding syncGroundReference() rebases onto for a pop-free switch
   * between surfaces (a real platform's glide, a ghost's drift, or either
   * anchor block). See Game.ts's crossing surface-resolution block, which
   * mirrors the runner's one-way resolution but adds the generous landing
   * assist the brief requires.
   *
   * `surfaceAvailable` is what keeps this genuinely different from the
   * runner's update(): the runner ALWAYS has a real ground line to compare
   * `airborneHeight <= 0` against, so reaching it always means "landed".
   * Crossing mode has no such universal floor — when Game.ts's resolution
   * found no qualifying platform this frame, `surfaceY` is just whatever
   * height was last recorded (frozen, per that resolution's own doc), and
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
    // Runner-only flags (dash/slam don't exist in crossing mode) — cleared
    // every frame here too so a flag left true from a mode switch mid-gesture
    // can never read as a stale event to crossing-mode code.
    this.justDoubleJumped = false;
    this.justDashed = false;
    this.justSlamLanded = false;

    this.velocityY -= GRAVITY * dt;
    this.airborneHeight += this.velocityY * dt;
    this.originX += this.velocityX * dt;

    if (surfaceAvailable && this.airborneHeight <= 0) {
      const wasAirborne = !this.grounded;
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

    this.view.x = this.originX;
    this.view.y = this.footY;
    // Unlike the runner's permanent mirror, crossing faces the player's
    // actual direction of travel (see the `facingRight` field doc).
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

  /** Color/alpha of the dash-ready indicator dot — the only per-frame touch
   * on it, a cheap tint/alpha write, no redraw. */
  private syncDashIndicator(): void {
    if (this.dashCooldownTimer <= 0) {
      this.dashIndicator.tint = DASH_INDICATOR_READY_COLOR;
      this.dashIndicator.alpha = DASH_INDICATOR_READY_ALPHA;
    } else {
      this.dashIndicator.tint = DASH_INDICATOR_CHARGING_COLOR;
      const chargeFraction = 1 - this.dashCooldownTimer / DASH_COOLDOWN_SECONDS;
      this.dashIndicator.alpha =
        DASH_INDICATOR_CHARGING_ALPHA_MIN + (DASH_INDICATOR_READY_ALPHA - DASH_INDICATOR_CHARGING_ALPHA_MIN) * chargeFraction;
    }
  }

  /** World-space foot x, for spawning dust particles under the player. */
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

  /** Signed vertical velocity, px/s (positive = upward, i.e. same sign
   * convention as JUMP_VELOCITY). Exposed only so Game.ts's windscreen-
   * platform one-way resolution can gate candidacy on "not currently
   * rising" — a platform must never be able to catch/stop an ascending
   * jump, only be landed on while falling (or already resting). */
  get verticalVelocity(): number {
    return this.velocityY;
  }

  /**
   * Re-expresses the player's CURRENT on-screen foot position relative to a
   * NEW ground/platform reference, without changing that position or any
   * momentum — purely a continuity rebase so a later switch of WHICH
   * surface `update()`'s `groundY` argument refers to (ground ↔ a
   * windscreen platform, or platform ↔ platform — see Game.ts) can never
   * show up as a visual pop, regardless of how far apart the two surfaces
   * are. Must be called, if at all, only once per frame, strictly BEFORE
   * the `update()` call that first passes `newGroundY`. Callers must NOT
   * call this for the ordinary case of the SAME surface continuing to move
   * smoothly (e.g. the ground line's own drag/horizon-hint lerp) — doing so
   * would subtly perturb that surface's already-correct continuous
   * behaviour; it exists only for genuine surface-identity switches.
   */
  syncGroundReference(newGroundY: number): void {
    this.airborneHeight = newGroundY - this.footY;
  }

  /** Effective world-speed multiplier from the dash boost — 1 when no dash
   * is active, decaying back to 1 exponentially after one triggers. */
  get dashSpeedMultiplier(): number {
    return 1 + this.dashBoost;
  }

  /** True while the post-dash invulnerability window is open — Game.ts uses
   * this to skip collision (and award the dash-through bonus) instead. */
  get isInvulnerable(): boolean {
    return this.dashInvulnTimer > 0;
  }

  /** True when a new dash can trigger right now — drives the ready
   * indicator and is readable by callers that want to preflight the state. */
  get isDashReady(): boolean {
    return this.dashCooldownTimer <= 0;
  }

  // --- Forgiving AABB, in world space, for collision against obstacles. ---

  get left(): number {
    return this.originX - PLAYER_WIDTH / 2 + PLAYER_COLLISION_INSET_X;
  }

  get right(): number {
    return this.originX + PLAYER_WIDTH / 2 - PLAYER_COLLISION_INSET_X;
  }

  get top(): number {
    return this.footY - PLAYER_HEIGHT + PLAYER_COLLISION_INSET_TOP;
  }

  get bottom(): number {
    return this.footY - PLAYER_COLLISION_INSET_BOTTOM;
  }
}
