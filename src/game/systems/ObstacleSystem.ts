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
  GAP_RANDOM_EXTRA_MAX,
  GAP_RANDOM_EXTRA_MIN,
  OBSTACLE_DESPAWN_MARGIN,
  OBSTACLE_INITIAL_SPAWN_DISTANCE,
  OBSTACLE_MIN_HEIGHT,
  OBSTACLE_MIN_WIDTH,
  OBSTACLE_POOL_SIZE,
  OBSTACLE_SPAWN_MARGIN,
} from '../config.ts';
import { Obstacle, type ObstacleShape } from '../entities/Obstacle.ts';
import { randomRange } from '../util/math.ts';
import { maxClearableObstacleHeight, maxClearableObstacleWidth, minSafeGap } from '../util/solvability.ts';

export class ObstacleSystem {
  private readonly pool: Obstacle[] = [];
  private readonly active: Obstacle[] = [];
  private distanceToNextSpawn = OBSTACLE_INITIAL_SPAWN_DISTANCE;

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
  }

  update(dt: number, worldSpeed: number, canvasWidth: number, groundY: number): void {
    this.distanceToNextSpawn -= worldSpeed * dt;
    if (this.distanceToNextSpawn <= 0) {
      this.spawn(worldSpeed, canvasWidth, groundY);
    }

    for (let i = this.active.length - 1; i >= 0; i--) {
      const obstacle = this.active[i]!;
      obstacle.setPosition(obstacle.x - worldSpeed * dt, groundY);
      if (obstacle.x + obstacle.width < -OBSTACLE_DESPAWN_MARGIN) {
        obstacle.deactivate();
        this.active[i] = this.active[this.active.length - 1]!;
        this.active.pop();
        this.pool.push(obstacle);
      }
    }
  }

  private spawn(worldSpeed: number, canvasWidth: number, groundY: number): void {
    const obstacle = this.pool.pop();
    if (!obstacle) {
      // Pool exhausted (shouldn't happen at OBSTACLE_POOL_SIZE=14 with our
      // spacing, but defend rather than throw): just push the countdown out
      // a bit and try again next frame.
      this.distanceToNextSpawn = OBSTACLE_MIN_WIDTH;
      return;
    }

    const width = randomRange(OBSTACLE_MIN_WIDTH, maxClearableObstacleWidth(worldSpeed));
    const height = randomRange(OBSTACLE_MIN_HEIGHT, maxClearableObstacleHeight(width, worldSpeed));
    const shape: ObstacleShape = Math.random() < 0.5 ? 'block' : 'spike';
    const spawnX = canvasWidth + OBSTACLE_SPAWN_MARGIN;

    obstacle.reset(width, height, shape, spawnX, groundY - height);
    this.active.push(obstacle);

    const gap = minSafeGap(worldSpeed) * randomRange(GAP_RANDOM_EXTRA_MIN, GAP_RANDOM_EXTRA_MAX);
    this.distanceToNextSpawn = width + gap;
  }
}
