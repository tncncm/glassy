/**
 * ParticleSystem — a fixed-size pool of plain white circles reused for jump
 * dust, landing dust and the collision burst. Every Graphics object is built
 * once in the constructor and drawn white; per-spawn "color" is applied via
 * `.tint` (a cheap property write, not a redraw) so `update()` never touches
 * geometry, only position/velocity/alpha — all primitive field writes.
 */

import { Container, Graphics } from 'pixi.js';
import {
  COLLISION_COLOR_A,
  COLLISION_COLOR_B,
  COLLISION_LIFETIME_SECONDS,
  COLLISION_PARTICLE_COUNT,
  COLLISION_SPEED_MAX,
  COLLISION_SPEED_MIN,
  DUST_COLOR,
  DUST_LIFETIME_SECONDS,
  DUST_PARTICLE_COUNT,
  DUST_SPEED_MAX,
  DUST_SPEED_MIN,
  PARTICLE_DRAG_PER_SECOND,
  PARTICLE_GRAVITY,
  PARTICLE_POOL_SIZE,
  PARTICLE_RADIUS,
  SLAM_PARTICLE_COLOR,
  SLAM_PARTICLE_COUNT,
  SLAM_PARTICLE_LIFETIME_SECONDS,
  SLAM_PARTICLE_SPEED_MAX,
  SLAM_PARTICLE_SPEED_MIN,
  SLAM_PARTICLE_VERTICAL_SQUASH,
} from '../config.ts';
import { randomRange } from '../util/math.ts';

class ParticleSlot {
  public readonly view: Graphics;
  public active = false;
  public vx = 0;
  public vy = 0;
  public life = 0;
  public maxLife = 1;

  constructor() {
    this.view = new Graphics().circle(0, 0, PARTICLE_RADIUS).fill({ color: 0xffffff });
    this.view.visible = false;
  }
}

export class ParticleSystem {
  private readonly pool: ParticleSlot[] = [];

  constructor(container: Container) {
    for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
      const slot = new ParticleSlot();
      container.addChild(slot.view);
      this.pool.push(slot);
    }
  }

  reset(): void {
    for (let i = 0; i < this.pool.length; i++) {
      const slot = this.pool[i]!;
      slot.active = false;
      slot.view.visible = false;
    }
  }

  update(dt: number): void {
    for (let i = 0; i < this.pool.length; i++) {
      const slot = this.pool[i]!;
      if (!slot.active) continue;

      slot.vy += PARTICLE_GRAVITY * dt;
      const drag = Math.max(0, 1 - PARTICLE_DRAG_PER_SECOND * dt);
      slot.vx *= drag;
      slot.vy *= drag;

      slot.view.x += slot.vx * dt;
      slot.view.y += slot.vy * dt;

      slot.life -= dt;
      if (slot.life <= 0) {
        slot.active = false;
        slot.view.visible = false;
        continue;
      }
      slot.view.alpha = slot.life / slot.maxLife;
    }
  }

  /** Small upward-biased puff at (x, y) — jump takeoff and landing. */
  spawnDust(x: number, y: number): void {
    for (let i = 0; i < DUST_PARTICLE_COUNT; i++) {
      const slot = this.acquire();
      if (!slot) return;
      const vx = randomRange(-DUST_SPEED_MAX, DUST_SPEED_MAX) * 0.5;
      const vy = -randomRange(DUST_SPEED_MIN, DUST_SPEED_MAX);
      this.activate(slot, x, y, vx, vy, DUST_LIFETIME_SECONDS, DUST_COLOR);
    }
  }

  /** Full-circle burst at (x, y) — collision. */
  spawnBurst(x: number, y: number): void {
    for (let i = 0; i < COLLISION_PARTICLE_COUNT; i++) {
      const slot = this.acquire();
      if (!slot) return;
      const angle = randomRange(0, Math.PI * 2);
      const speed = randomRange(COLLISION_SPEED_MIN, COLLISION_SPEED_MAX);
      const vx = Math.cos(angle) * speed;
      const vy = Math.sin(angle) * speed;
      const color = i % 2 === 0 ? COLLISION_COLOR_A : COLLISION_COLOR_B;
      this.activate(slot, x, y, vx, vy, COLLISION_LIFETIME_SECONDS, color);
    }
  }

  /** Flattened, evenly-spaced ring at (x, y) — the slam landing shockwave.
   * Unlike `spawnBurst`'s random full-circle scatter, an even angular spread
   * reads as a coherent shockwave rather than debris, and the vertical
   * component is squashed so it hugs the ground line instead of ballooning
   * upward. */
  spawnRing(x: number, y: number): void {
    for (let i = 0; i < SLAM_PARTICLE_COUNT; i++) {
      const slot = this.acquire();
      if (!slot) return;
      const angle = (i / SLAM_PARTICLE_COUNT) * Math.PI * 2;
      const speed = randomRange(SLAM_PARTICLE_SPEED_MIN, SLAM_PARTICLE_SPEED_MAX);
      const vx = Math.cos(angle) * speed;
      const vy = Math.sin(angle) * speed * SLAM_PARTICLE_VERTICAL_SQUASH;
      this.activate(slot, x, y, vx, vy, SLAM_PARTICLE_LIFETIME_SECONDS, SLAM_PARTICLE_COLOR);
    }
  }

  private activate(
    slot: ParticleSlot,
    x: number,
    y: number,
    vx: number,
    vy: number,
    lifetime: number,
    color: number,
  ): void {
    slot.active = true;
    slot.view.visible = true;
    slot.view.x = x;
    slot.view.y = y;
    slot.view.alpha = 1;
    slot.view.tint = color;
    slot.vx = vx;
    slot.vy = vy;
    slot.life = lifetime;
    slot.maxLife = lifetime;
  }

  private acquire(): ParticleSlot | undefined {
    for (let i = 0; i < this.pool.length; i++) {
      const slot = this.pool[i]!;
      if (!slot.active) return slot;
    }
    return undefined;
  }
}
