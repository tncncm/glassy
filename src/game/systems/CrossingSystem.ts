/**
 * CrossingSystem — everything specific to 'crossing' mode's world: the fixed
 * start/goal anchor blocks, real tracked-vehicle platforms, the ghost-
 * platform solvability fallback, and the dotted trajectory preview.
 *
 * DELIBERATELY DOES NOT SHARE PlatformSystem. That class's whole contract
 * (ground-line clamping via `maxTopY`, a single pool, no concept of
 * "permanent"/"synthetic") is shaped around the runner's world, and the
 * brief requires 'runner' to stay byte-for-byte unchanged. Reusing (and
 * therefore having to extend) PlatformSystem for this would mean touching a
 * class runner mode depends on every frame; a second, self-contained
 * system with its own pool touches zero runner code and makes the
 * isolation the brief asks for trivially provable by inspection instead of
 * by careful reasoning about every new branch. It reuses the `Platform`
 * ENTITY (box + glide + top-bar rendering) as-is, recoloring instances via
 * the small additive `Platform.setPalette` override (see that method's doc
 * for why a plain `Container.tint` multiply can't produce a legible gold
 * from the entity's cyan base) to tell real / ghost / start / goal apart.
 *
 * THREE kinds of `Platform` this owns:
 *  - Two ANCHOR blocks (`leftBlock`/`rightBlock`) — fixed fraction position,
 *    always active, never expire. Which one currently counts as the
 *    player's start vs. goal flips on every completed crossing (see
 *    `direction`/`completeCrossing`) rather than moving the blocks
 *    themselves — "swap the blocks" reads as swapping their ROLE.
 *  - REAL platforms — one per stable TrackedObject, same activate/retarget/
 *    expire idea as PlatformSystem, but with a HARD never-vanish-underfoot
 *    guarantee: `update()`'s `occupiedPlatform` parameter's missed-track
 *    timer is forced to 0 every single frame it's occupied, not just
 *    "extended" — so it can never even begin approaching its grace/fade
 *    window while the player is standing on it.
 *  - GHOST platforms — the solvability fallback. See
 *    `maybeSpawnGhostChain`'s doc for the full derivation.
 *
 * Positions are tracked in 0..1 frame fractions exactly like Platform/
 * PlatformSystem already do, for the same resize-for-free reason.
 */

import type { Container } from 'pixi.js';
import { Graphics } from 'pixi.js';
import type { TrackedObject } from '../../types.ts';
import {
  CROSSING_BLOCK_CENTER_Y_FRACTION,
  CROSSING_BLOCK_GOAL_FILL,
  CROSSING_BLOCK_GOAL_TOP_BAR,
  CROSSING_BLOCK_HEIGHT_FRACTION,
  CROSSING_BLOCK_START_FILL,
  CROSSING_BLOCK_START_TOP_BAR,
  CROSSING_BLOCK_WIDTH_FRACTION,
  CROSSING_GHOST_DRIFT_RANGE_PX,
  CROSSING_GHOST_DRIFT_SPEED_RADIANS_PER_SECOND,
  CROSSING_GHOST_FILL,
  CROSSING_GHOST_GAP_SAFETY_FACTOR,
  CROSSING_GHOST_HEIGHT_FRACTION,
  CROSSING_GHOST_POOL_SIZE,
  CROSSING_GHOST_TOP_BAR,
  CROSSING_GHOST_TRIGGER_SECONDS,
  CROSSING_GHOST_WIDTH_FRACTION,
  CROSSING_LEFT_BLOCK_CENTER_X_FRACTION,
  CROSSING_PREVIEW_DOT_ALPHA,
  CROSSING_PREVIEW_DOT_COLOR,
  CROSSING_PREVIEW_DOT_COUNT,
  CROSSING_PREVIEW_DOT_RADIUS,
  CROSSING_PREVIEW_DURATION_SECONDS,
  CROSSING_RIGHT_BLOCK_CENTER_X_FRACTION,
  GRAVITY,
  PLATFORM_FADE_SECONDS,
  PLATFORM_FOLLOW_LERP_RATE,
  PLATFORM_GRACE_SECONDS,
  PLATFORM_POOL_SIZE,
} from '../config.ts';
import { Platform } from '../entities/Platform.ts';
import { clamp, expDecay } from '../util/math.ts';
import { crossingMaxHorizontalReach } from '../util/solvability.ts';

/** Sentinel trackIds for the two anchor blocks — negative, so they can never
 * collide with a real TrackedObject.id (documented non-negative, never
 * reused, in types.ts). Unused for lookup (the blocks are held in dedicated
 * fields, never searched for by id) — set purely for readability/debugging. */
const LEFT_BLOCK_TRACK_ID = -1;
const RIGHT_BLOCK_TRACK_ID = -2;

/** One fixed ghost-pool slot's bookkeeping, built once at construction
 * (allocation at construction time is fine — only per-update allocation is
 * forbidden) and reused for the life of the system. */
interface GhostSlot {
  readonly platform: Platform;
  active: boolean;
  /** Oscillation phase, radians — advanced every frame while active. */
  phase: number;
  /** Center the oscillation is applied around, 0..1 fraction of canvas. */
  baseXFraction: number;
  baseYFraction: number;
}

export class CrossingSystem {
  private readonly leftBlock = new Platform();
  private readonly rightBlock = new Platform();

  private readonly realPool: Platform[] = [];
  private readonly realActive: Platform[] = [];

  private readonly ghosts: GhostSlot[] = [];

  /** Combined landing-candidate buffer Game.ts reads every frame for the
   * one-way surface resolution + landing assist. Rebuilt (cleared + re-
   * pushed, never reallocated) at the end of every `update()` call — see
   * that method. Returned by reference; callers must treat it as read-only. */
  private readonly candidates: Platform[] = [];

  /** 1 = current leg is left→right (goal is the right block); -1 = the
   * return leg. Flips on every completeCrossing(). */
  private legDirection: 1 | -1 = 1;
  private crossings = 0;

  /** Seconds since the most recent STABLE TrackedObject update, of any id —
   * reset to 0 in onTrackedObjects. Drives the ghost-chain fallback. */
  private timeSinceStableTrack = 0;
  private ghostChainActive = false;

  // --- Trajectory preview — pooled dots, built once. ---
  private readonly previewDots: Graphics[] = [];

  constructor(container: Container) {
    container.addChild(this.leftBlock.view, this.rightBlock.view);

    for (let i = 0; i < CROSSING_GHOST_POOL_SIZE; i++) {
      const platform = new Platform();
      platform.view.visible = false;
      platform.setPalette(CROSSING_GHOST_FILL, CROSSING_GHOST_TOP_BAR);
      container.addChild(platform.view);
      this.ghosts.push({ platform, active: false, phase: 0, baseXFraction: 0, baseYFraction: 0 });
    }

    // A modest fixed pool for REAL tracked platforms, reusing
    // PLATFORM_POOL_SIZE — same "a handful, per the brief" reasoning
    // PlatformSystem's own pool already documents.
    for (let i = 0; i < PLATFORM_POOL_SIZE; i++) {
      const platform = new Platform();
      platform.view.visible = false;
      container.addChild(platform.view);
      this.realPool.push(platform);
    }

    for (let i = 0; i < CROSSING_PREVIEW_DOT_COUNT; i++) {
      const dot = new Graphics().circle(0, 0, CROSSING_PREVIEW_DOT_RADIUS).fill({ color: CROSSING_PREVIEW_DOT_COLOR });
      dot.visible = false;
      dot.alpha = CROSSING_PREVIEW_DOT_ALPHA;
      container.addChild(dot);
      this.previewDots.push(dot);
    }
  }

  /** Every landing candidate — both anchor blocks plus every active real and
   * ghost platform — for Game.ts's per-frame surface resolution. Returned by
   * reference; only valid until the next `update()` call. */
  get platforms(): readonly Platform[] {
    return this.candidates;
  }

  get startBlock(): Platform {
    return this.legDirection === 1 ? this.leftBlock : this.rightBlock;
  }

  get goalBlock(): Platform {
    return this.legDirection === 1 ? this.rightBlock : this.leftBlock;
  }

  /** True when `platform` is the currently-designated goal — Game.ts checks
   * this once it detects the player is grounded on it. */
  isGoal(platform: Platform): boolean {
    return platform === this.goalBlock;
  }

  get crossingsCompleted(): number {
    return this.crossings;
  }

  /** 1 = current leg is left→right (goal is the right block); -1 = the
   * return leg. Game.ts uses this only to decide which way the player
   * should face after completeCrossing() re-anchors them on the new
   * start block. */
  get direction(): 1 | -1 {
    return this.legDirection;
  }

  /** Full reset for a fresh attempt (Game.start()/reset()) or a mode switch
   * — clears every real/ghost platform back to its pool, restarts the ghost
   * timer and always resumes on the LEFT→RIGHT leg. Caller must follow this
   * with an `update(0, width, height, null)` call to project the anchor
   * blocks' fractions against the live canvas before the first render — the
   * same "layout, then a zero-dt settle pass" pattern Game.ts's own
   * applyLayout already uses for the runner's platforms. */
  reset(): void {
    for (let i = 0; i < this.realActive.length; i++) {
      const platform = this.realActive[i]!;
      platform.deactivate();
      this.realPool.push(platform);
    }
    this.realActive.length = 0;

    for (let i = 0; i < this.ghosts.length; i++) {
      const slot = this.ghosts[i]!;
      slot.active = false;
      slot.platform.deactivate();
    }

    this.legDirection = 1;
    this.crossings = 0;
    this.timeSinceStableTrack = 0;
    this.ghostChainActive = false;
    this.candidates.length = 0;
    this.hideTrajectoryPreview();

    this.leftBlock.activate(LEFT_BLOCK_TRACK_ID, CROSSING_LEFT_BLOCK_CENTER_X_FRACTION, CROSSING_BLOCK_CENTER_Y_FRACTION, CROSSING_BLOCK_WIDTH_FRACTION, CROSSING_BLOCK_HEIGHT_FRACTION);
    this.rightBlock.activate(RIGHT_BLOCK_TRACK_ID, CROSSING_RIGHT_BLOCK_CENTER_X_FRACTION, CROSSING_BLOCK_CENTER_Y_FRACTION, CROSSING_BLOCK_WIDTH_FRACTION, CROSSING_BLOCK_HEIGHT_FRACTION);
    this.retintBlocks();
  }

  /** Fires a few times a second, straight off Game's own onTrackedObjects.
   * Reads `objects` synchronously only, never retains it — same contract as
   * PlatformSystem.onTrackedObjects, which this mirrors for real tracks. */
  onTrackedObjects(objects: readonly TrackedObject[]): void {
    for (let i = 0; i < objects.length; i++) {
      const track = objects[i]!;
      if (!track.stable) continue;
      this.timeSinceStableTrack = 0;

      const existing = this.findRealByTrackId(track.id);
      if (existing) {
        existing.retarget(track.x, track.y, track.width, track.height);
        continue;
      }
      const fresh = this.realPool.pop();
      if (!fresh) continue; // pool exhausted — extra tracks simply wait for a slot
      fresh.activate(track.id, track.x, track.y, track.width, track.height);
      // Real platforms keep Platform's DEFAULT palette (cyan) — no
      // setPalette call — so they read as "the same kind of thing" as the
      // runner's own windscreen platforms.
      this.realActive.push(fresh);
    }
  }

  /**
   * Per-frame update. `occupiedPlatform` is whichever real/ghost/anchor
   * platform Game.ts has currently resolved the player as standing on
   * (`null` if airborne/unresolved) — see the file doc for the hard
   * never-vanish-underfoot guarantee this drives.
   */
  update(dt: number, canvasWidth: number, canvasHeight: number, occupiedPlatform: Platform | null): void {
    // Anchor blocks: fixed fraction target, so followT=1 (snap) — after the
    // first call current==target already, so this only re-draws when the
    // canvas size itself changes (see Platform.updateVisual's own epsilon
    // check), not every frame.
    this.leftBlock.updateVisual(1, canvasWidth, canvasHeight, canvasHeight, 1);
    this.rightBlock.updateVisual(1, canvasWidth, canvasHeight, canvasHeight, 1);

    this.updateRealPlatforms(dt, canvasWidth, canvasHeight, occupiedPlatform);
    this.updateGhostPlatforms(dt, canvasWidth, canvasHeight);

    this.timeSinceStableTrack += dt;
    this.maybeSpawnGhostChain(canvasWidth);

    this.candidates.length = 0;
    this.candidates.push(this.leftBlock, this.rightBlock);
    for (let i = 0; i < this.realActive.length; i++) this.candidates.push(this.realActive[i]!);
    for (let i = 0; i < this.ghosts.length; i++) {
      const slot = this.ghosts[i]!;
      if (slot.active) this.candidates.push(slot.platform);
    }
  }

  /** A crossing just completed: swap which block is start vs. goal, retint
   * both, and drop the ghost chain — the return leg gets a fresh chance at
   * real tracking before falling back again (maybeSpawnGhostChain re-engages
   * on its own after CROSSING_GHOST_TRIGGER_SECONDS if it doesn't). */
  completeCrossing(): void {
    this.crossings++;
    this.legDirection = this.legDirection === 1 ? -1 : 1;
    this.retintBlocks();
    for (let i = 0; i < this.ghosts.length; i++) {
      const slot = this.ghosts[i]!;
      slot.active = false;
      slot.platform.deactivate();
    }
    this.ghostChainActive = false;
    this.timeSinceStableTrack = 0;
  }

  /** Positions the pooled dotted arc along the parabola a jump launched from
   * (originX, originY) at (vx, vy) — vy in the up-positive convention
   * Player/solvability already use — would follow, sampling
   * CROSSING_PREVIEW_DURATION_SECONDS of flight evenly across the pool. Dots
   * whose sample point has fallen off the bottom of the canvas are simply
   * hidden rather than the whole preview being cut short, so a big enough
   * canvas always shows the full arc down to where it would actually land. */
  showTrajectoryPreview(originX: number, originY: number, vx: number, vy: number, canvasWidth: number, canvasHeight: number): void {
    const step = CROSSING_PREVIEW_DURATION_SECONDS / CROSSING_PREVIEW_DOT_COUNT;
    for (let i = 0; i < this.previewDots.length; i++) {
      const t = step * (i + 1);
      const x = originX + vx * t;
      const yUp = vy * t - 0.5 * GRAVITY * t * t;
      const y = originY - yUp;
      const dot = this.previewDots[i]!;
      if (x < -CROSSING_PREVIEW_DOT_RADIUS || x > canvasWidth + CROSSING_PREVIEW_DOT_RADIUS || y > canvasHeight + CROSSING_PREVIEW_DOT_RADIUS) {
        dot.visible = false;
        continue;
      }
      dot.visible = true;
      dot.x = x;
      dot.y = y;
    }
  }

  hideTrajectoryPreview(): void {
    for (let i = 0; i < this.previewDots.length; i++) this.previewDots[i]!.visible = false;
  }

  private retintBlocks(): void {
    this.startBlock.setPalette(CROSSING_BLOCK_START_FILL, CROSSING_BLOCK_START_TOP_BAR);
    this.goalBlock.setPalette(CROSSING_BLOCK_GOAL_FILL, CROSSING_BLOCK_GOAL_TOP_BAR);
  }

  private findRealByTrackId(id: number): Platform | undefined {
    for (let i = 0; i < this.realActive.length; i++) {
      const platform = this.realActive[i]!;
      if (platform.trackId === id) return platform;
    }
    return undefined;
  }

  private updateRealPlatforms(dt: number, canvasWidth: number, canvasHeight: number, occupiedPlatform: Platform | null): void {
    const followT = expDecay(PLATFORM_FOLLOW_LERP_RATE, dt);
    const fadeStart = PLATFORM_GRACE_SECONDS - PLATFORM_FADE_SECONDS;

    for (let i = this.realActive.length - 1; i >= 0; i--) {
      const platform = this.realActive[i]!;

      if (platform === occupiedPlatform) {
        // HARD guarantee: the platform the player is standing on can never
        // even begin approaching its grace/fade window, every single frame
        // it's occupied — not merely "extended", reset outright.
        platform.missedTime = 0;
      } else {
        platform.missedTime += dt;
        if (platform.missedTime >= PLATFORM_GRACE_SECONDS) {
          platform.deactivate();
          this.realActive[i] = this.realActive[this.realActive.length - 1]!;
          this.realActive.pop();
          this.realPool.push(platform);
          continue;
        }
      }

      const fadeAlpha = platform.missedTime <= fadeStart ? 1 : clamp(1 - (platform.missedTime - fadeStart) / PLATFORM_FADE_SECONDS, 0, 1);
      // No ground-line concept in crossing mode — pass canvasHeight as the
      // clamp ceiling so Platform's own `Math.min(rawTopPx, maxTopY)` is
      // never actually binding (a real track's box is never drawn lower
      // than the bottom of the canvas anyway).
      platform.updateVisual(followT, canvasWidth, canvasHeight, canvasHeight, fadeAlpha);
    }
  }

  private updateGhostPlatforms(dt: number, canvasWidth: number, canvasHeight: number): void {
    for (let i = 0; i < this.ghosts.length; i++) {
      const slot = this.ghosts[i]!;
      if (!slot.active) continue;
      slot.phase += CROSSING_GHOST_DRIFT_SPEED_RADIANS_PER_SECOND * dt;
      const offsetFraction = (Math.sin(slot.phase) * CROSSING_GHOST_DRIFT_RANGE_PX) / canvasWidth;
      const centerXFraction = slot.baseXFraction + offsetFraction;
      slot.platform.retarget(centerXFraction, slot.baseYFraction, CROSSING_GHOST_WIDTH_FRACTION, CROSSING_GHOST_HEIGHT_FRACTION);
      // followT=1: the sine drift above IS the smooth continuous target
      // already (recomputed fresh every frame, unlike a real track's sparse
      // samples), so no additional glide-smoothing is wanted on top of it.
      slot.platform.updateVisual(1, canvasWidth, canvasHeight, canvasHeight, 1);
    }
  }

  /**
   * The crossing-mode equivalent of the runner's derived obstacle spacing
   * (util/solvability.ts): if real tracking goes quiet, the level must still
   * be solvable, so a synthetic chain of "ghost" platforms is spawned
   * spanning the CURRENT goal leg end-to-end, each hop sized so a full-power
   * jump (crossingMaxHorizontalReach, same height, dropPx=0 — ghosts sit at
   * the same CROSSING_BLOCK_CENTER_Y_FRACTION as the anchor blocks by
   * construction) can always cover it with CROSSING_GHOST_GAP_SAFETY_FACTOR
   * margin to spare. That margin comfortably absorbs the small
   * CROSSING_GHOST_DRIFT_RANGE_PX wander applied on top for "moves like
   * traffic" (worst case ±2×drift narrows a hop by well under the margin
   * reserved). Spawns at most once per "coverage gap" — see
   * completeCrossing()/reset() for the only two places `ghostChainActive`
   * is cleared, which is what lets it try again after each leg.
   */
  private maybeSpawnGhostChain(canvasWidth: number): void {
    if (this.ghostChainActive) return;
    if (this.timeSinceStableTrack < CROSSING_GHOST_TRIGGER_SECONDS) return;

    const startX = this.startBlock.right;
    const goalX = this.goalBlock.left;
    const span = this.legDirection === 1 ? goalX - startX : startX - goalX;
    if (span <= 0) return;
    this.ghostChainActive = true;

    const maxReach = crossingMaxHorizontalReach(canvasWidth, 0);
    const perHop = Math.max(1, maxReach * CROSSING_GHOST_GAP_SAFETY_FACTOR);
    const hopCount = Math.max(1, Math.ceil(span / perHop));
    const intermediateCount = clamp(hopCount - 1, 0, this.ghosts.length);

    for (let i = 0; i < intermediateCount; i++) {
      const t = (i + 1) / (intermediateCount + 1);
      const x = this.legDirection === 1 ? startX + span * t : startX - span * t;
      const slot = this.ghosts[i]!;
      slot.active = true;
      slot.phase = Math.random() * Math.PI * 2;
      slot.baseXFraction = x / canvasWidth;
      slot.baseYFraction = CROSSING_BLOCK_CENTER_Y_FRACTION;
      slot.platform.activate(-100 - i, slot.baseXFraction, slot.baseYFraction, CROSSING_GHOST_WIDTH_FRACTION, CROSSING_GHOST_HEIGHT_FRACTION);
      slot.platform.setPalette(CROSSING_GHOST_FILL, CROSSING_GHOST_TOP_BAR);
    }
    for (let i = intermediateCount; i < this.ghosts.length; i++) {
      const slot = this.ghosts[i]!;
      slot.active = false;
      slot.platform.deactivate();
    }
  }
}
