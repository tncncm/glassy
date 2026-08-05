/**
 * ObstacleSystem — fixed-size pool of Obstacle instances. Spawning picks a
 * width/height/gap that the solvability module (util/solvability.ts)
 * guarantees the current jump can clear at the current world speed; nothing
 * here invents its own "safe-looking" numbers.
 *
 * The pool never grows at runtime: `pool` + `active` together always sum to
 * OBSTACLE_POOL_SIZE. Recycling uses swap-and-pop on the existing `active`
 * array (no splice-shift, no new array) so steady-state play allocates
 * nothing.
 */

import type { Container } from 'pixi.js';
import {
  DETECTION_VEHICLE_QUEUE_CAP,
  GAP_RANDOM_EXTRA_MAX,
  GAP_RANDOM_EXTRA_MIN,
  OBSTACLE_DESPAWN_MARGIN,
  OBSTACLE_INITIAL_SPAWN_DISTANCE,
  OBSTACLE_MIN_HEIGHT,
  OBSTACLE_MIN_WIDTH,
  OBSTACLE_POOL_SIZE,
  OBSTACLE_SPAWN_MARGIN,
  OBSTACLE_VEHICLE_SIZE_BIAS_MIN,
  OBSTACLE_WEIGHT_BLOCK,
  OBSTACLE_WEIGHT_OVERHEAD,
  OBSTACLE_WEIGHT_SPIKE,
  OVERHEAD_HAZARD_DRAW_HEIGHT,
  OVERHEAD_HAZARD_MAX_WIDTH,
  OVERHEAD_HAZARD_MIN_WIDTH,
  WIDE_OBSTACLE_MAX_HEIGHT,
  WIDE_OBSTACLE_MIN_HEIGHT,
} from '../config.ts';
import { Obstacle, type ObstacleShape } from '../entities/Obstacle.ts';
import { randomRange } from '../util/math.ts';
import {
  maxClearableObstacleHeight,
  maxClearableObstacleWidth,
  maxDashClearableObstacleWidth,
  minSafeGap,
  minWideObstacleWidth,
  OVERHEAD_HAZARD_CLEARANCE_PX,
} from '../util/solvability.ts';

export class ObstacleSystem {
  private readonly pool: Obstacle[] = [];
  private readonly active: Obstacle[] = [];
  private distanceToNextSpawn = OBSTACLE_INITIAL_SPAWN_DISTANCE;
  /** Queued `vehicle`-scene-detection requests, capped at
   * DETECTION_VEHICLE_QUEUE_CAP — see that constant's comment in config.ts.
   * Consumed one at a time by `spawn()`, which otherwise falls back to the
   * ordinary weighted `pickShape()`; `vehicle` never appears in
   * `pickShape()`'s own weights, so with zero requests queued this system's
   * behaviour is byte-identical to before scene detection existed. */
  private pendingVehicle = 0;

  constructor(container: Container) {
    for (let i = 0; i < OBSTACLE_POOL_SIZE; i++) {
      const obstacle = new Obstacle();
      obstacle.view.visible = false;
      container.addChild(obstacle.view);
      this.pool.push(obstacle);
    }
  }

  /** Active obstacles for Game's per-frame collision scan. Returned by
   * reference (not copied) — callers must treat it as read-only. */
  get activeObstacles(): readonly Obstacle[] {
    return this.active;
  }

  /** Clear every active obstacle back to the pool and restart the spawn
   * countdown — used by Game.start()/reset(). */
  reset(): void {
    for (let i = 0; i < this.active.length; i++) {
      const obstacle = this.active[i]!;
      obstacle.deactivate();
      this.pool.push(obstacle);
    }
    this.active.length = 0;
    this.distanceToNextSpawn = OBSTACLE_INITIAL_SPAWN_DISTANCE;
    this.pendingVehicle = 0;
  }

  /** Queue a `vehicle`-scene-detection hazard request. Debounced upstream
   * in Game.ts (per-DetectedKind cooldown) — this only additionally caps
   * how many can pile up waiting for a solvability-safe spawn slot. */
  requestVehicle(): void {
    this.pendingVehicle = Math.min(DETECTION_VEHICLE_QUEUE_CAP, this.pendingVehicle + 1);
  }

  update(dt: number, worldSpeed: number, canvasWidth: number, groundY: number): void {
    this.distanceToNextSpawn -= worldSpeed * dt;
    if (this.distanceToNextSpawn <= 0) {
      this.spawn(worldSpeed, groundY);
    }

    for (let i = this.active.length - 1; i >= 0; i--) {
      const obstacle = this.active[i]!;
      // Obstacles travel left → right (see PLAYER_X_FRACTION's comment in
      // config.ts), so they advance in +x and are recycled once their
      // leading (left) edge has passed fully off the right side.
      obstacle.setPosition(obstacle.x + worldSpeed * dt, groundY);
      if (obstacle.x > canvasWidth + OBSTACLE_DESPAWN_MARGIN) {
        obstacle.deactivate();
        this.active[i] = this.active[this.active.length - 1]!;
        this.active.pop();
        this.pool.push(obstacle);
      }
    }
  }

  private spawn(worldSpeed: number, groundY: number): void {
    const obstacle = this.pool.pop();
    if (!obstacle) {
      // Pool exhausted (shouldn't happen at OBSTACLE_POOL_SIZE=14 with our
      // spacing, but defend rather than throw): just push the countdown out
      // a bit and try again next frame.
      this.distanceToNextSpawn = OBSTACLE_MIN_WIDTH;
      return;
    }

    // A queued detection request always wins over the random weighted pick
    // — it is still gated by the very same solvability envelope as
    // block/spike below (case 'vehicle'), it just skips the dice roll for
    // *which* shape spawns this cycle. `pickShape()` never produces
    // 'vehicle' on its own, so with nothing queued this is exactly the
    // pre-existing random pick.
    let shape: ObstacleShape;
    if (this.pendingVehicle > 0) {
      this.pendingVehicle--;
      shape = 'vehicle';
    } else {
      shape = pickShape();
    }
    let width: number;
    let height: number;
    let topY: number;

    switch (shape) {
      case 'vehicle': {
        // Same envelope as block/spike (jump-clearable), biased toward the
        // upper portion of it so it reads as bulkier — see
        // OBSTACLE_VEHICLE_SIZE_BIAS_MIN's comment in config.ts.
        const maxWidth = maxClearableObstacleWidth(worldSpeed);
        const minWidth = OBSTACLE_MIN_WIDTH + (maxWidth - OBSTACLE_MIN_WIDTH) * OBSTACLE_VEHICLE_SIZE_BIAS_MIN;
        width = randomRange(Math.min(minWidth, maxWidth), maxWidth);
        const maxHeight = maxClearableObstacleHeight(width, worldSpeed);
        const minHeight = OBSTACLE_MIN_HEIGHT + (maxHeight - OBSTACLE_MIN_HEIGHT) * OBSTACLE_VEHICLE_SIZE_BIAS_MIN;
        height = randomRange(Math.min(minHeight, maxHeight), maxHeight);
        topY = groundY - height;
        break;
      }
      case 'wide': {
        const minWidth = minWideObstacleWidth(worldSpeed);
        const maxWidth = Math.max(minWidth, maxDashClearableObstacleWidth(worldSpeed));
        width = randomRange(minWidth, maxWidth);
        height = randomRange(WIDE_OBSTACLE_MIN_HEIGHT, WIDE_OBSTACLE_MAX_HEIGHT);
        topY = groundY - height;
        break;
      }
      case 'overhead': {
        width = randomRange(OVERHEAD_HAZARD_MIN_WIDTH, OVERHEAD_HAZARD_MAX_WIDTH);
        height = OVERHEAD_HAZARD_DRAW_HEIGHT;
        topY = groundY - OVERHEAD_HAZARD_CLEARANCE_PX - height;
        break;
      }
      case 'block':
      case 'spike':
      default: {
        width = randomRange(OBSTACLE_MIN_WIDTH, maxClearableObstacleWidth(worldSpeed));
        height = randomRange(OBSTACLE_MIN_HEIGHT, maxClearableObstacleHeight(width, worldSpeed));
        topY = groundY - height;
        break;
      }
    }

    // Spawn fully off the LEFT edge — obstacles travel left → right (see
    // PLAYER_X_FRACTION's comment in config.ts) — so the obstacle's trailing
    // (right) edge sits OBSTACLE_SPAWN_MARGIN px short of x=0, i.e. its
    // whole body is comfortably off-screen.
    const spawnX = -OBSTACLE_SPAWN_MARGIN - width;
    obstacle.reset(width, height, shape, spawnX, topY);
    this.active.push(obstacle);

    // Spacing uses the same jump-flight-time-derived minimum for every kind:
    // it's generous enough to also cover the (much shorter) reaction a
    // wide/overhead obstacle actually demands, so reusing it here keeps the
    // spacing derivation in one place rather than forking it per kind.
    const gap = minSafeGap(worldSpeed) * randomRange(GAP_RANDOM_EXTRA_MIN, GAP_RANDOM_EXTRA_MAX);
    this.distanceToNextSpawn = width + gap;
  }
}

/** Cumulative-weight pick across the four obstacle kinds — see the
 * OBSTACLE_WEIGHT_* comment in config.ts for why these particular weights. */
function pickShape(): ObstacleShape {
  const roll = Math.random();
  if (roll < OBSTACLE_WEIGHT_BLOCK) return 'block';
  if (roll < OBSTACLE_WEIGHT_BLOCK + OBSTACLE_WEIGHT_SPIKE) return 'spike';
  if (roll < OBSTACLE_WEIGHT_BLOCK + OBSTACLE_WEIGHT_SPIKE + OBSTACLE_WEIGHT_OVERHEAD) return 'overhead';
  return 'wide';
}
