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
  SQUASH_STRETCH_RATE,
} from '../config.ts';
import { expDecay, lerp } from '../util/math.ts';

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

  private readonly body: Graphics;
  private readonly legLeft: Container;
  private readonly legRight: Container;
  private readonly arm: Container;

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

  constructor() {
    const bodyHeight = PLAYER_HEIGHT - PLAYER_LEG_LENGTH;
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

    // Draw order: legs behind the body, arm in front.
    this.view.addChild(this.legLeft, this.legRight, this.body, this.arm);
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
    this.view.scale.set(1, 1);
    this.justJumped = false;
    this.justDoubleJumped = false;
    this.justLanded = false;
  }

  update(dt: number, groundY: number, speedRatio: number): void {
    this.justJumped = false;
    this.justDoubleJumped = false;
    this.justLanded = false;

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

    this.view.y = this.footY;
    this.view.scale.set(this.squashX, this.squashY);
  }

  private launchJump(velocity: number): void {
    this.velocityY = velocity;
    this.grounded = false;
    this.coyoteTimer = 0;
    this.jumpBufferTimer = 0;
    this.squashX = JUMP_SQUASH_SCALE_X;
    this.squashY = JUMP_SQUASH_SCALE_Y;
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
