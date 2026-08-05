/**
 * PickupSystem — fixed-size pool of Pickup instances (collectibles from
 * `person` detections, power-ups from `sign` detections). Mirrors
 * ObstacleSystem's pooling discipline (swap-and-pop recycle, no per-frame
 * allocation) but is deliberately simpler: pickups are never a solvability
 * concern, because missing one has no failure consequence — see
 * PICKUP_MIN_SPACING_PX's comment in config.ts.
 *
 * Unlike ObstacleSystem, nothing here spawns ambiently. A pickup only ever
 * appears in response to a queued `requestCollectible()`/`requestPowerup()`
 * call from Game.ts's onSceneDetections — so with detection off (or never
 * delivering anything), this system produces zero spawns for the entire
 * run, which is exactly what keeps "detection off" gameplay byte-identical
 * to before this feature existed.
 */

import type { Container } from 'pixi.js';
import {
  DETECTION_PICKUP_QUEUE_CAP,
  PICKUP_BOB_AMPLITUDE_PX,
  PICKUP_BOB_SPEED,
  PICKUP_DESPAWN_MARGIN,
  PICKUP_HEIGHT_APEX_FRACTION_MAX,
  PICKUP_HEIGHT_APEX_FRACTION_MIN,
  PICKUP_MIN_SPACING_PX,
  PICKUP_POOL_SIZE,
  PICKUP_RADIUS_COLLECTIBLE,
  PICKUP_RADIUS_POWERUP,
  PICKUP_SPAWN_MARGIN,
} from '../config.ts';
import { Pickup, type PickupKind } from '../entities/Pickup.ts';
import { randomRange } from '../util/math.ts';
import { PRIMARY_JUMP_ARC } from '../util/solvability.ts';

export class PickupSystem {
  private readonly pool: Pickup[] = [];
  private readonly active: Pickup[] = [];
  /** Queued requests, capped at DETECTION_PICKUP_QUEUE_CAP each — see that
   * constant's comment. A `sign` power-up is favoured over a queued
   * `person` collectible when both are waiting, purely so the more
   * time-sensitive utility (dash recharge) doesn't sit behind a score
   * pickup; in practice both drain within a spacing cycle or two anyway. */
  private pendingCollectible = 0;
  private pendingPowerup = 0;
  private distanceSinceLastSpawn = PICKUP_MIN_SPACING_PX;

  constructor(container: Container) {
    for (let i = 0; i < PICKUP_POOL_SIZE; i++) {
      const pickup = new Pickup();
      pickup.view.visible = false;
      container.addChild(pickup.view);
      this.pool.push(pickup);
    }
  }

  /** Active pickups for Game's per-frame overlap scan. Returned by
   * reference (not copied) — callers must treat it as read-only. */
  get activePickups(): readonly Pickup[] {
    return this.active;
  }

  /** Clear every active pickup back to the pool, drop any queued requests
   * and restart the spacing countdown — used by Game's start()/reset(), so
   * a request queued in a previous run never leaks into the next one. */
  reset(): void {
    for (let i = 0; i < this.active.length; i++) {
      const pickup = this.active[i]!;
      pickup.deactivate();
      this.pool.push(pickup);
    }
    this.active.length = 0;
    this.pendingCollectible = 0;
    this.pendingPowerup = 0;
    this.distanceSinceLastSpawn = PICKUP_MIN_SPACING_PX;
  }

  /** Queue a `person`-detection collectible request. Debounced upstream in
   * Game.ts (per-DetectedKind cooldown) — this only additionally caps how
   * many can pile up waiting for a spacing slot. */
  requestCollectible(): void {
    this.pendingCollectible = Math.min(DETECTION_PICKUP_QUEUE_CAP, this.pendingCollectible + 1);
  }

  /** Queue a `sign`-detection power-up request. Same debounce/cap contract
   * as requestCollectible(). */
  requestPowerup(): void {
    this.pendingPowerup = Math.min(DETECTION_PICKUP_QUEUE_CAP, this.pendingPowerup + 1);
  }

  update(dt: number, worldSpeed: number, canvasWidth: number, groundY: number): void {
    this.distanceSinceLastSpawn += worldSpeed * dt;
    if (this.distanceSinceLastSpawn >= PICKUP_MIN_SPACING_PX) {
      if (this.pendingPowerup > 0) {
        this.pendingPowerup--;
        this.spawn('powerup');
        this.distanceSinceLastSpawn = 0;
      } else if (this.pendingCollectible > 0) {
        this.pendingCollectible--;
        this.spawn('collectible');
        this.distanceSinceLastSpawn = 0;
      }
    }

    for (let i = this.active.length - 1; i >= 0; i--) {
      const pickup = this.active[i]!;
      pickup.bobPhase += PICKUP_BOB_SPEED * dt;
      // Ground-anchored like Obstacle's block/spike/wide (see
      // Obstacle.setPosition) so a mid-run platform drag moves pickups
      // along with everything else instead of leaving them floating at a
      // stale height; the sine term layers a purely cosmetic bob on top.
      const x = pickup.x + worldSpeed * dt;
      const y = groundY - pickup.heightAboveGround + Math.sin(pickup.bobPhase) * PICKUP_BOB_AMPLITUDE_PX;
      pickup.setPosition(x, y);
      if (x > canvasWidth + PICKUP_DESPAWN_MARGIN) {
        this.recycleAt(i);
      }
    }
  }

  /** Called by Game.ts once it has read `pickup.shape`/position off
   * `activePickups[index]` for scoring/effects — removes it from play
   * (swap-and-pop, same pattern as the despawn path above) and returns it
   * to the pool. */
  remove(index: number): void {
    this.recycleAt(index);
  }

  private recycleAt(index: number): void {
    const pickup = this.active[index]!;
    pickup.deactivate();
    this.active[index] = this.active[this.active.length - 1]!;
    this.active.pop();
    this.pool.push(pickup);
  }

  private spawn(kind: PickupKind): void {
    const pickup = this.pool.pop();
    if (!pickup) {
      // Pool exhausted (shouldn't happen at PICKUP_POOL_SIZE=8 given the
      // spacing/queue caps, but defend rather than throw): drop this spawn,
      // the request has already been dequeued above.
      return;
    }
    const heightAboveGround = randomRange(
      PRIMARY_JUMP_ARC.apexHeightPx * PICKUP_HEIGHT_APEX_FRACTION_MIN,
      PRIMARY_JUMP_ARC.apexHeightPx * PICKUP_HEIGHT_APEX_FRACTION_MAX,
    );
    const radius = kind === 'collectible' ? PICKUP_RADIUS_COLLECTIBLE : PICKUP_RADIUS_POWERUP;
    // Spawn fully off the LEFT edge, same convention as ObstacleSystem (see
    // OBSTACLE_SPAWN_MARGIN's comment in config.ts).
    const spawnX = -PICKUP_SPAWN_MARGIN - radius;
    pickup.reset(kind, heightAboveGround, spawnX);
    this.active.push(pickup);
  }
}
