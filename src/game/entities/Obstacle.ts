/**
 * Obstacle — a single pooled obstacle. `reset()` is called only when the
 * ObstacleSystem recycles an instance for a new spawn (an infrequent event,
 * not a per-frame one), and is the only place its Graphics content is
 * redrawn. Every other per-frame touch (`setPosition`) only mutates
 * `view.x`/`view.y` on the already-built Graphics object.
 */

import { Graphics } from 'pixi.js';
import { OBSTACLE_COLOR_BLOCK, OBSTACLE_COLOR_OUTLINE, OBSTACLE_COLOR_SPIKE, OBSTACLE_CORNER_RADIUS } from '../config.ts';

export type ObstacleShape = 'block' | 'spike';

export class Obstacle {
  public readonly view: Graphics = new Graphics();
  public active = false;

  private w = 0;
  private h = 0;

  get width(): number {
    return this.w;
  }

  get height(): number {
    return this.h;
  }

  /** (Re)draw this obstacle for a new spawn and place it at `spawnX`. The
   * view's local origin is its top-left corner, so `view.x`/`view.y` double
   * directly as the AABB's left/top for collision. */
  reset(width: number, height: number, shape: ObstacleShape, spawnX: number, topY: number): void {
    this.w = width;
    this.h = height;
    this.view.clear();
    if (shape === 'block') {
      this.view
        .roundRect(0, 0, width, height, OBSTACLE_CORNER_RADIUS)
        .fill({ color: OBSTACLE_COLOR_BLOCK })
        .stroke({ width: 2, color: OBSTACLE_COLOR_OUTLINE });
    } else {
      this.view
        .moveTo(0, height)
        .lineTo(width / 2, 0)
        .lineTo(width, height)
        .lineTo(0, height)
        .fill({ color: OBSTACLE_COLOR_SPIKE })
        .stroke({ width: 2, color: OBSTACLE_COLOR_OUTLINE });
    }
    this.view.x = spawnX;
    this.view.y = topY;
    this.view.visible = true;
    this.active = true;
  }

  deactivate(): void {
    this.active = false;
    this.view.visible = false;
  }

  /** Move by the world scroll and re-anchor to the (possibly just-dragged)
   * ground line — called every frame for every active obstacle. */
  setPosition(x: number, groundY: number): void {
    this.view.x = x;
    this.view.y = groundY - this.h;
  }

  get x(): number {
    return this.view.x;
  }

  get top(): number {
    return this.view.y;
  }
}
