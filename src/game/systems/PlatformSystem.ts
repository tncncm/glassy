/**
 * PlatformSystem — windscreen-mode only. Fixed-size pool of Platform
 * instances; turns `stable` TrackedObjects into landing surfaces the player
 * can stand on, positioned and sized to follow the real vehicle on screen.
 *
 * TWO independent call sites, at two different rates:
 *
 *  - `onTrackedObjects()` — fires a few times a second, straight off Game's
 *    own `onTrackedObjects` (see types.ts). Matches each STABLE track to an
 *    existing platform by id, or spawns a new one (capped at
 *    PLATFORM_POOL_SIZE — extra tracks beyond the cap are silently ignored
 *    until a slot frees up). Unstable tracks are ignored outright, even if
 *    they share an id with a platform that's already following them — the
 *    platform just stops being retargeted and starts its ordinary expiry
 *    countdown, same as any track that stopped reporting entirely.
 *
 *  - `update()` — every rendered frame. Glides each platform's CURRENT box
 *    toward its latest TARGET box (Platform.updateVisual) so motion reads as
 *    continuous even though fresh samples only arrive sparsely, advances the
 *    missed-track grace/fade timer, and returns fully-expired platforms to
 *    the pool.
 *
 * Positions are tracked and interpolated in 0..1 FRAME FRACTIONS, not px —
 * converted to canvas px fresh every frame inside Platform.updateVisual.
 * That makes a live resize/orientation-change automatically correct on the
 * very next frame with no special-case handling here: the same fraction just
 * maps to a new pixel rect.
 *
 * This system does no collision itself — it only tracks and renders boxes.
 * Game.ts reads `activePlatforms[i].left/right/top` to decide, every frame,
 * which surface (the real ground line, or a platform) the player currently
 * rests on, via the one-way ("land from above only") rule documented there.
 * That is also what keeps this feature from ever being able to trap or kill
 * the player: a platform is nothing but an extra candidate surface to land
 * on, never a hazard and never collidable from the side or below.
 */

import type { Container } from 'pixi.js';
import type { TrackedObject } from '../../types.ts';
import { PLATFORM_FADE_SECONDS, PLATFORM_FOLLOW_LERP_RATE, PLATFORM_GRACE_SECONDS, PLATFORM_POOL_SIZE } from '../config.ts';
import { Platform } from '../entities/Platform.ts';
import { clamp, expDecay } from '../util/math.ts';

export class PlatformSystem {
  private readonly pool: Platform[] = [];
  private readonly active: Platform[] = [];

  constructor(container: Container) {
    for (let i = 0; i < PLATFORM_POOL_SIZE; i++) {
      const platform = new Platform();
      platform.view.visible = false;
      container.addChild(platform.view);
      this.pool.push(platform);
    }
  }

  /** Active platforms for Game's per-frame one-way surface resolution.
   * Returned by reference (not copied) — callers must treat it as read-only. */
  get activePlatforms(): readonly Platform[] {
    return this.active;
  }

  /** Clear every active platform back to the pool — used by Game's
   * start()/reset() and on any setVisionMode() switch, so a platform from a
   * previous run/mode never leaks into the next one. */
  reset(): void {
    for (let i = 0; i < this.active.length; i++) {
      const platform = this.active[i]!;
      platform.deactivate();
      this.pool.push(platform);
    }
    this.active.length = 0;
  }

  /** See class doc — fires a few times a second, not every frame. Reads
   * `objects` synchronously only, per the TrackedObject/onTrackedObjects
   * contract in types.ts; never retains the array or its elements. */
  onTrackedObjects(objects: readonly TrackedObject[]): void {
    for (let i = 0; i < objects.length; i++) {
      const track = objects[i]!;
      if (!track.stable) continue;

      const existing = this.findByTrackId(track.id);
      if (existing) {
        existing.retarget(track.x, track.y, track.width, track.height);
        continue;
      }

      const fresh = this.pool.pop();
      if (!fresh) continue; // pool exhausted — see PLATFORM_POOL_SIZE's comment in config.ts
      fresh.activate(track.id, track.x, track.y, track.width, track.height);
      this.active.push(fresh);
    }
  }

  /** Every frame: glide current→target, age out missed tracks, return fully
   * expired platforms to the pool. `groundY` clamps every platform's top so
   * one can never render/collide below the real ground line — see
   * Platform.updateVisual. Safe (and cheap) to call with zero active
   * platforms, which is exactly what makes 'window' mode a no-op here. */
  update(dt: number, canvasWidth: number, canvasHeight: number, groundY: number): void {
    const followT = expDecay(PLATFORM_FOLLOW_LERP_RATE, dt);
    const fadeStart = PLATFORM_GRACE_SECONDS - PLATFORM_FADE_SECONDS;

    for (let i = this.active.length - 1; i >= 0; i--) {
      const platform = this.active[i]!;
      platform.missedTime += dt;

      if (platform.missedTime >= PLATFORM_GRACE_SECONDS) {
        platform.deactivate();
        this.active[i] = this.active[this.active.length - 1]!;
        this.active.pop();
        this.pool.push(platform);
        continue;
      }

      const fadeAlpha = platform.missedTime <= fadeStart ? 1 : clamp(1 - (platform.missedTime - fadeStart) / PLATFORM_FADE_SECONDS, 0, 1);
      platform.updateVisual(followT, canvasWidth, canvasHeight, groundY, fadeAlpha);
    }
  }

  private findByTrackId(id: number): Platform | undefined {
    for (let i = 0; i < this.active.length; i++) {
      const platform = this.active[i]!;
      if (platform.trackId === id) return platform;
    }
    return undefined;
  }
}
