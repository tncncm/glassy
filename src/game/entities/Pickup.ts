/**
 * Pickup — a single pooled collectible/power-up. Themed spawns requested by
 * `person`/`sign` scene detections (see PickupSystem and Game.ts's
 * onSceneDetections), but the entity itself knows nothing about detection —
 * it is just a floating circle-ish shape the player can fly into for a
 * reward instead of a collision.
 *
 * Same lifecycle discipline as Obstacle: `reset()` (re)draws the Graphics
 * content and is only called when PickupSystem spawns a new one — never a
 * per-frame op. Every other per-frame touch (`setPosition`) only mutates
 * `view.x`/`view.y` on the already-built Graphics object.
 */

import { Graphics } from 'pixi.js';
import {
  PICKUP_COLLECTIBLE_COLOR,
  PICKUP_COLLECTIBLE_OUTLINE,
  PICKUP_POWERUP_BOLT_COLOR,
  PICKUP_POWERUP_COLOR,
  PICKUP_POWERUP_OUTLINE,
  PICKUP_RADIUS_COLLECTIBLE,
  PICKUP_RADIUS_POWERUP,
} from '../config.ts';

/**
 * `collectible` — from a `person` detection: a star, chased for a score
 * bonus. `powerup` — from a `sign` detection: an octagon (a deliberate nod
 * to a stop sign) that instantly recharges the dash.
 */
export type PickupKind = 'collectible' | 'powerup';

export class Pickup {
  public readonly view: Graphics = new Graphics();
  public active = false;
  /** World-space height, in px, this pickup floats above the ground line —
   * PickupSystem re-adds this to the live `groundY` every frame (plus a
   * bob offset) so it tracks a dragged platform like ground-anchored
   * obstacles do. Set once per spawn in `reset()`. */
  public heightAboveGround = 0;
  /** Bobbing phase, radians; advanced by PickupSystem each frame. Randomised
   * on spawn so multiple pickups on screen never bob in lockstep. */
  public bobPhase = 0;

  private kind: PickupKind = 'collectible';
  private radius = 0;

  get shape(): PickupKind {
    return this.kind;
  }

  get radiusPx(): number {
    return this.radius;
  }

  /** (Re)draw this pickup for a new spawn and place it at `spawnX`; y is
   * left to the caller's first `setPosition` this same frame (see
   * PickupSystem.update — spawn happens before the position/bob pass). */
  reset(kind: PickupKind, heightAboveGround: number, spawnX: number): void {
    this.kind = kind;
    this.heightAboveGround = heightAboveGround;
    this.bobPhase = Math.random() * Math.PI * 2;
    this.radius = kind === 'collectible' ? PICKUP_RADIUS_COLLECTIBLE : PICKUP_RADIUS_POWERUP;
    this.view.clear();
    if (kind === 'collectible') {
      drawStar(this.view, this.radius);
    } else {
      drawPowerupBadge(this.view, this.radius);
    }
    this.view.x = spawnX;
    this.view.visible = true;
    this.active = true;
  }

  deactivate(): void {
    this.active = false;
    this.view.visible = false;
  }

  setPosition(x: number, y: number): void {
    this.view.x = x;
    this.view.y = y;
  }

  get x(): number {
    return this.view.x;
  }

  get y(): number {
    return this.view.y;
  }

  // --- AABB, world space, for the reward-not-kill overlap test in Game.ts.

  get left(): number {
    return this.view.x - this.radius;
  }

  get right(): number {
    return this.view.x + this.radius;
  }

  get top(): number {
    return this.view.y - this.radius;
  }

  get bottom(): number {
    return this.view.y + this.radius;
  }
}

/** Five-point star centred on the local origin — visually distinct from
 * every obstacle shape (all boxy/spiky) and from the player/ground palette,
 * with a dark outline for legibility over a bright/busy camera feed. */
function drawStar(view: Graphics, radius: number): void {
  const points = 5;
  const innerRadius = radius * 0.45;
  view.moveTo(0, -radius);
  for (let i = 0; i < points; i++) {
    const outerAngle = -Math.PI / 2 + (i / points) * Math.PI * 2;
    const innerAngle = outerAngle + Math.PI / points;
    const nextOuterAngle = outerAngle + (Math.PI * 2) / points;
    view.lineTo(Math.cos(innerAngle) * innerRadius, Math.sin(innerAngle) * innerRadius);
    view.lineTo(Math.cos(nextOuterAngle) * radius, Math.sin(nextOuterAngle) * radius);
  }
  view.closePath().fill({ color: PICKUP_COLLECTIBLE_COLOR }).stroke({ width: 2, color: PICKUP_COLLECTIBLE_OUTLINE });
}

/** Regular octagon — a deliberate stop-sign silhouette for the `sign`-
 * detection power-up — with a small lightning-bolt glyph inside as visual
 * shorthand for "dash recharge". */
function drawPowerupBadge(view: Graphics, radius: number): void {
  const sides = 8;
  view.moveTo(radius, 0);
  for (let i = 1; i <= sides; i++) {
    const angle = (i / sides) * Math.PI * 2;
    view.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
  }
  view
    .closePath()
    .fill({ color: PICKUP_POWERUP_COLOR })
    .stroke({ width: 2, color: PICKUP_POWERUP_OUTLINE });

  const boltWidth = radius * 0.7;
  const boltHeight = radius * 1.1;
  view
    .moveTo(boltWidth * 0.12, -boltHeight * 0.5)
    .lineTo(-boltWidth * 0.32, boltHeight * 0.08)
    .lineTo(-boltWidth * 0.02, boltHeight * 0.08)
    .lineTo(-boltWidth * 0.12, boltHeight * 0.5)
    .lineTo(boltWidth * 0.32, -boltHeight * 0.05)
    .lineTo(boltWidth * 0.04, -boltHeight * 0.05)
    .closePath()
    .fill({ color: PICKUP_POWERUP_BOLT_COLOR });
}
