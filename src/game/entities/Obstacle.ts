/**
 * Obstacle — a single pooled obstacle. `reset()` is called only when the
 * ObstacleSystem recycles an instance for a new spawn (an infrequent event,
 * not a per-frame one), and is the only place its Graphics content is
 * redrawn. Every other per-frame touch (`setPosition`) only mutates
 * `view.x`/`view.y` on the already-built Graphics object.
 */

import { Graphics } from 'pixi.js';
import {
  OBSTACLE_COLOR_BLOCK,
  OBSTACLE_COLOR_OUTLINE,
  OBSTACLE_COLOR_OVERHEAD,
  OBSTACLE_COLOR_SPIKE,
  OBSTACLE_COLOR_WIDE,
  OBSTACLE_CORNER_RADIUS,
  OVERHEAD_HAZARD_TOOTH_WIDTH,
} from '../config.ts';
import { OVERHEAD_HAZARD_CLEARANCE_PX } from '../util/solvability.ts';

/**
 * `block`/`spike` — original ground obstacles, cleared by jumping.
 * `wide` — too wide to jump-clear, cleared by dashing through during
 * invulnerability; ground-anchored like block/spike.
 * `overhead` — hangs down from off-screen-top to a fixed clearance above the
 * ground line, cleared by staying grounded; anchored to the ground line from
 * its BOTTOM edge instead of its top (see `setPosition`).
 */
export type ObstacleShape = 'block' | 'spike' | 'wide' | 'overhead';

export class Obstacle {
  public readonly view: Graphics = new Graphics();
  public active = false;
  /** Set true the first time this obstacle is dashed through during
   * invulnerability, so Game.ts awards the bonus/particle burst/shake once
   * per obstacle rather than once per overlapping frame. Cleared on every
   * new spawn via `reset()`. */
  public dashBonusAwarded = false;

  private w = 0;
  private h = 0;
  private kind: ObstacleShape = 'block';

  get width(): number {
    return this.w;
  }

  get height(): number {
    return this.h;
  }

  get shape(): ObstacleShape {
    return this.kind;
  }

  /** (Re)draw this obstacle for a new spawn and place it at `spawnX`. The
   * view's local origin is its top-left corner, so `view.x`/`view.y` double
   * directly as the AABB's left/top for collision. `topY` is only used for
   * `block`/`spike`/`wide` (ground-anchored); `overhead` recomputes its own
   * top from `groundY` on the very next `setPosition` call, same as every
   * other kind does every frame thereafter. */
  reset(width: number, height: number, shape: ObstacleShape, spawnX: number, topY: number): void {
    this.w = width;
    this.h = height;
    this.kind = shape;
    this.dashBonusAwarded = false;
    this.view.clear();
    switch (shape) {
      case 'block':
        this.view
          .roundRect(0, 0, width, height, OBSTACLE_CORNER_RADIUS)
          .fill({ color: OBSTACLE_COLOR_BLOCK })
          .stroke({ width: 2, color: OBSTACLE_COLOR_OUTLINE });
        break;
      case 'spike':
        this.view
          .moveTo(0, height)
          .lineTo(width / 2, 0)
          .lineTo(width, height)
          .lineTo(0, height)
          .fill({ color: OBSTACLE_COLOR_SPIKE })
          .stroke({ width: 2, color: OBSTACLE_COLOR_OUTLINE });
        break;
      case 'wide':
        this.view
          .roundRect(0, 0, width, height, OBSTACLE_CORNER_RADIUS)
          .fill({ color: OBSTACLE_COLOR_WIDE })
          .stroke({ width: 2, color: OBSTACLE_COLOR_OUTLINE });
        break;
      case 'overhead':
        drawOverheadHazard(this.view, width, height);
        break;
      default:
        break;
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
   * ground line — called every frame for every active obstacle. Ground-
   * anchored kinds sit on top of the ground line; `overhead` instead hangs
   * its bottom edge a fixed clearance above it, with its (fixed, generously
   * overdrawn) height reaching up off the top of the viewport. */
  setPosition(x: number, groundY: number): void {
    this.view.x = x;
    this.view.y = this.kind === 'overhead' ? groundY - OVERHEAD_HAZARD_CLEARANCE_PX - this.h : groundY - this.h;
  }

  get x(): number {
    return this.view.x;
  }

  get top(): number {
    return this.view.y;
  }
}

/** Body rect plus a row of small triangular "icicle" teeth along the bottom
 * edge, so an overhead hazard reads unmistakably as something hanging down
 * rather than a mispositioned block. Drawn once per spawn in `reset()`, same
 * as every other shape — never touched by `setPosition`. */
function drawOverheadHazard(view: Graphics, width: number, height: number): void {
  view.roundRect(0, 0, width, height, OBSTACLE_CORNER_RADIUS).fill({ color: OBSTACLE_COLOR_OVERHEAD });

  const toothCount = Math.max(1, Math.round(width / OVERHEAD_HAZARD_TOOTH_WIDTH));
  const toothWidth = width / toothCount;
  const toothDepth = toothWidth * 0.9;
  view.moveTo(0, height);
  for (let i = 0; i < toothCount; i++) {
    const left = i * toothWidth;
    const mid = left + toothWidth / 2;
    const right = left + toothWidth;
    view.lineTo(mid, height + toothDepth).lineTo(right, height);
  }
  view.lineTo(width, height).lineTo(0, height).fill({ color: OBSTACLE_COLOR_OVERHEAD });

  view.roundRect(0, 0, width, height, OBSTACLE_CORNER_RADIUS).stroke({ width: 2, color: OBSTACLE_COLOR_OUTLINE });
}
