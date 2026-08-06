/**
 * CrossingSystem — everything specific to the crossing world: the fixed
 * start/goal anchor blocks, real tracked-vehicle platforms, the ghost-
 * platform solvability fallback, the dotted trajectory preview, the
 * horizon-driven road height, and the timer/combo HUD.
 *
 * It reuses the `Platform` ENTITY (box + glide + top-bar rendering) as-is,
 * recoloring instances via the small additive `Platform.setPalette`
 * override (see that method's doc for why a plain `Container.tint` multiply
 * can't produce a legible gold from the entity's cyan base) to tell
 * real / ghost / start / goal apart.
 *
 * THREE kinds of `Platform` this owns:
 *  - Two ANCHOR blocks (`leftBlock`/`rightBlock`) — position tracks
 *    `roadCenterYFraction` (see the horizon-hint section below), always
 *    active, never expire. Which one currently counts as the player's start
 *    vs. goal flips on every completed crossing (see
 *    `direction`/`completeCrossing`) rather than moving the blocks
 *    themselves — "swap the blocks" reads as swapping their ROLE.
 *  - REAL platforms — one per stable TrackedObject, same activate/retarget/
 *    expire idea as before, but with a HARD never-vanish-underfoot
 *    guarantee: `update()`'s `occupiedPlatform` parameter's missed-track
 *    timer is forced to 0 every single frame it's occupied, not just
 *    "extended" — so it can never even begin approaching its grace/fade
 *    window while the player is standing on it.
 *  - GHOST platforms — the solvability fallback. See
 *    `maybeSpawnGhostChain`'s doc for the full derivation.
 *
 * Positions are tracked in 0..1 frame fractions exactly like Platform
 * already does, for the same resize-for-free reason.
 */

import type { Container } from 'pixi.js';
import { Graphics, Text } from 'pixi.js';
import type { TrackedObject } from '../../types.ts';
import {
  CROSSING_BLOCK_CENTER_Y_FRACTION,
  CROSSING_BLOCK_CENTER_Y_MAX_FRACTION,
  CROSSING_BLOCK_CENTER_Y_MIN_FRACTION,
  CROSSING_BLOCK_GOAL_FILL,
  CROSSING_BLOCK_GOAL_TOP_BAR,
  CROSSING_BLOCK_HEIGHT_FRACTION,
  CROSSING_BLOCK_START_FILL,
  CROSSING_BLOCK_START_TOP_BAR,
  CROSSING_BLOCK_WIDTH_FRACTION,
  CROSSING_COMBO_TEXT_COLOR,
  CROSSING_COMBO_TEXT_OUTLINE_COLOR,
  CROSSING_COMBO_TEXT_SIZE,
  CROSSING_DIFFICULTY_RAMP_CROSSINGS,
  CROSSING_GHOST_DRIFT_RANGE_PX,
  CROSSING_GHOST_DRIFT_SPEED_RADIANS_PER_SECOND,
  CROSSING_GHOST_FILL,
  CROSSING_GHOST_GAP_SAFETY_FACTOR_EASY,
  CROSSING_GHOST_GAP_SAFETY_FACTOR_HARD,
  CROSSING_GHOST_HEIGHT_FRACTION,
  CROSSING_GHOST_POOL_SIZE,
  CROSSING_GHOST_TOP_BAR,
  CROSSING_GHOST_TRIGGER_SECONDS,
  CROSSING_GHOST_WIDTH_FRACTION,
  CROSSING_HORIZON_BIAS_RATE,
  CROSSING_HORIZON_MIN_CONFIDENCE,
  CROSSING_LEFT_BLOCK_CENTER_X_FRACTION,
  CROSSING_PREVIEW_DOT_ALPHA,
  CROSSING_PREVIEW_DOT_COLOR,
  CROSSING_PREVIEW_DOT_COUNT,
  CROSSING_PREVIEW_DOT_RADIUS,
  CROSSING_RIGHT_BLOCK_CENTER_X_FRACTION,
  GRAVITY,
  PLATFORM_FADE_SECONDS,
  PLATFORM_FOLLOW_LERP_RATE,
  PLATFORM_GRACE_SECONDS,
  PLATFORM_POOL_SIZE,
} from '../config.ts';
import { Platform } from '../entities/Platform.ts';
import { clamp, expDecay, lerp } from '../util/math.ts';
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
  /** True once the player has stood on any ghost platform during the
   * CURRENT leg — cleared on completeCrossing()/reset(). Game.ts reads this
   * (via `hasTouchedGhostThisLeg`) to award the no-ghost crossing bonus. */
  private ghostTouchedThisLeg = false;

  /** Live vertical center (0..1 fraction of canvas height) every anchor
   * block and freshly-spawned ghost platform is placed at — starts at the
   * DEFAULT and is nudged toward accepted horizon hints in `update()`. See
   * `setHorizonHint`'s doc. */
  private roadCenterYFraction = CROSSING_BLOCK_CENTER_Y_FRACTION;
  private horizonHintFraction: number | null = null;
  private horizonHintConfidence = 0;

  // --- Trajectory preview — pooled dots, built once. ---
  private readonly previewDots: Graphics[] = [];

  // --- HUD: per-leg countdown bar + combo counter, pre-built once. ---
  private readonly timerBarBg = new Graphics();
  private readonly timerBarFill = new Graphics();
  private readonly comboText: Text;
  private lastHudWidth = -1;
  private lastComboDisplayed = -1;

  /**
   * `worldContainer` holds everything that should shake along with the rest
   * of the scene on impact (blocks, platforms, the trajectory preview).
   * `hudContainer` is a SIBLING outside the world's shake transform — see
   * Game.ts's scene graph — so the timer bar/combo counter stay perfectly
   * readable even while the world is shaking from a hard landing.
   */
  constructor(worldContainer: Container, hudContainer: Container) {
    worldContainer.addChild(this.leftBlock.view, this.rightBlock.view);

    for (let i = 0; i < CROSSING_GHOST_POOL_SIZE; i++) {
      const platform = new Platform();
      platform.view.visible = false;
      platform.setPalette(CROSSING_GHOST_FILL, CROSSING_GHOST_TOP_BAR);
      worldContainer.addChild(platform.view);
      this.ghosts.push({ platform, active: false, phase: 0, baseXFraction: 0, baseYFraction: 0 });
    }

    // A modest fixed pool for REAL tracked platforms, reusing
    // PLATFORM_POOL_SIZE — "a handful", per the brief.
    for (let i = 0; i < PLATFORM_POOL_SIZE; i++) {
      const platform = new Platform();
      platform.view.visible = false;
      worldContainer.addChild(platform.view);
      this.realPool.push(platform);
    }

    for (let i = 0; i < CROSSING_PREVIEW_DOT_COUNT; i++) {
      const dot = new Graphics().circle(0, 0, CROSSING_PREVIEW_DOT_RADIUS).fill({ color: CROSSING_PREVIEW_DOT_COLOR });
      dot.visible = false;
      dot.alpha = CROSSING_PREVIEW_DOT_ALPHA;
      worldContainer.addChild(dot);
      this.previewDots.push(dot);
    }

    hudContainer.addChild(this.timerBarBg, this.timerBarFill);
    this.comboText = new Text({
      text: '',
      style: {
        fontSize: CROSSING_COMBO_TEXT_SIZE,
        fill: CROSSING_COMBO_TEXT_COLOR,
        fontFamily: 'sans-serif',
        fontWeight: 'bold',
        stroke: { color: CROSSING_COMBO_TEXT_OUTLINE_COLOR, width: 3 },
      },
    });
    this.comboText.anchor.set(0.5, 0);
    this.comboText.visible = false;
    hudContainer.addChild(this.comboText);
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

  /** See `ghostTouchedThisLeg`'s field doc. */
  get hasTouchedGhostThisLeg(): boolean {
    return this.ghostTouchedThisLeg;
  }

  /** Game.ts calls this on every landing (not just perfect ones) so a leg
   * crossed even partly via a ghost platform is correctly disqualified from
   * the no-ghost bonus, however the leg ultimately ends. A no-op for a
   * landing on a real track or an anchor block. */
  noteLanded(platform: Platform): void {
    if (this.isGhostPlatform(platform)) this.ghostTouchedThisLeg = true;
  }

  /**
   * The camera's estimated horizon (see types.ts's `Game.setHorizonHint`),
   * repurposed here to position the road (and therefore the start/goal
   * blocks and any ghost platforms) at the height the phone is actually
   * being held at, rather than a fixed guess. Deliberately just two
   * primitive field writes — the gating (confidence floor, and the "never
   * move the blocks under the player mid-jump" rule) all happens in
   * `update()`, the only place that reads these two fields, using its own
   * `occupiedPlatform` argument as the "is it currently safe to nudge the
   * road" signal (non-null = the player was grounded on something as of the
   * last resolved frame — see that parameter's use below).
   */
  setHorizonHint(y: number | null, confidence: number): void {
    this.horizonHintFraction = y;
    this.horizonHintConfidence = confidence;
  }

  /** Full reset for a fresh attempt (Game.start()/reset()) — clears every
   * real/ghost platform back to its pool, restarts the ghost timer and
   * always resumes on the LEFT→RIGHT leg. Deliberately does NOT reset
   * `roadCenterYFraction`: it reflects the physical framing of the phone,
   * not run state, so an established horizon lock should survive a restart.
   * Caller must follow this with an `update(0, width, height, null)` call to
   * project the anchor blocks' fractions against the live canvas before the
   * first render. */
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
    this.ghostTouchedThisLeg = false;
    this.candidates.length = 0;
    this.hideTrajectoryPreview();

    this.leftBlock.activate(LEFT_BLOCK_TRACK_ID, CROSSING_LEFT_BLOCK_CENTER_X_FRACTION, this.roadCenterYFraction, CROSSING_BLOCK_WIDTH_FRACTION, CROSSING_BLOCK_HEIGHT_FRACTION);
    this.rightBlock.activate(RIGHT_BLOCK_TRACK_ID, CROSSING_RIGHT_BLOCK_CENTER_X_FRACTION, this.roadCenterYFraction, CROSSING_BLOCK_WIDTH_FRACTION, CROSSING_BLOCK_HEIGHT_FRACTION);
    this.retintBlocks();
  }

  /** Fires a few times a second, straight off Game's own onTrackedObjects.
   * Reads `objects` synchronously only, never retains it. */
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
      // setPalette call — so they read as "the same kind of thing" as
      // whatever else is cyan-coded (the trajectory preview's landing zone).
      this.realActive.push(fresh);
    }
  }

  /**
   * Per-frame update. `occupiedPlatform` is whichever real/ghost/anchor
   * platform Game.ts has currently resolved the player as standing on
   * (`null` if airborne/unresolved) — see the file doc for the hard
   * never-vanish-underfoot guarantee this drives, and `setHorizonHint`'s doc
   * for how it doubles as the "safe to nudge the road" signal.
   */
  update(dt: number, canvasWidth: number, canvasHeight: number, occupiedPlatform: Platform | null): void {
    // Horizon hint: only ever nudges the road while the player isn't
    // mid-jump (approximated by "was resolved as grounded on something as
    // of last frame" — a one-frame staleness that's imperceptible at this
    // rate), and even then only a small fraction of the way per second, so
    // it can never read as the ground shifting under an in-flight jump.
    if (
      occupiedPlatform !== null &&
      this.horizonHintFraction !== null &&
      this.horizonHintConfidence >= CROSSING_HORIZON_MIN_CONFIDENCE
    ) {
      const clampedHint = clamp(this.horizonHintFraction, CROSSING_BLOCK_CENTER_Y_MIN_FRACTION, CROSSING_BLOCK_CENTER_Y_MAX_FRACTION);
      this.roadCenterYFraction = lerp(this.roadCenterYFraction, clampedHint, expDecay(CROSSING_HORIZON_BIAS_RATE, dt));
    }

    // Anchor blocks: target tracks the live road height every frame;
    // followT=1 (snap) since roadCenterYFraction is already the
    // slow-smoothed value — Platform's own glide would just be redundant
    // smoothing on top of smoothing.
    this.leftBlock.retarget(CROSSING_LEFT_BLOCK_CENTER_X_FRACTION, this.roadCenterYFraction, CROSSING_BLOCK_WIDTH_FRACTION, CROSSING_BLOCK_HEIGHT_FRACTION);
    this.rightBlock.retarget(CROSSING_RIGHT_BLOCK_CENTER_X_FRACTION, this.roadCenterYFraction, CROSSING_BLOCK_WIDTH_FRACTION, CROSSING_BLOCK_HEIGHT_FRACTION);
    this.leftBlock.updateVisual(1, canvasWidth, canvasHeight, 1);
    this.rightBlock.updateVisual(1, canvasWidth, canvasHeight, 1);

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
    this.ghostTouchedThisLeg = false;
  }

  /** Positions the pooled dotted arc along the parabola a jump launched from
   * (originX, originY) at (vx, vy) — vy in the up-positive convention
   * Player/solvability already use — would follow, sampling
   * `durationSeconds` of flight evenly across the pool (see
   * CROSSING_PREVIEW_DURATION_MARGIN in config.ts for how the caller derives
   * that from the current jump envelope). Dots whose sample point has fallen
   * off the bottom of the canvas are simply hidden rather than the whole
   * preview being cut short, so a big enough canvas always shows the full
   * arc down to where it would actually land. */
  showTrajectoryPreview(originX: number, originY: number, vx: number, vy: number, canvasWidth: number, canvasHeight: number, durationSeconds: number): void {
    const step = durationSeconds / CROSSING_PREVIEW_DOT_COUNT;
    let prevT = 0;
    let prevY = originY;
    let stopped = false;
    for (let i = 0; i < this.previewDots.length; i++) {
      const dot = this.previewDots[i]!;
      if (stopped) {
        dot.visible = false;
        continue;
      }

      const t = step * (i + 1);
      let x = originX + vx * t;
      const yUp = vy * t - 0.5 * GRAVITY * t * t;
      let y = originY - yUp;

      // Stop the preview the instant the ballistic arc would cross a
      // landing candidate's top edge within its horizontal span — dots must
      // show WHERE the jump actually lands, not the free-flight parabola
      // continuing on through a platform that would already have caught it.
      // Linearly interpolate between this sample and the previous one for a
      // landing marker that reads as "here", not "somewhere in this step".
      for (let p = 0; p < this.candidates.length; p++) {
        const platform = this.candidates[p]!;
        if (x < platform.left || x > platform.right) continue;
        if (prevY <= platform.top && y >= platform.top) {
          const frac = y > prevY ? (platform.top - prevY) / (y - prevY) : 1;
          const landingT = prevT + (t - prevT) * frac;
          x = originX + vx * landingT;
          y = platform.top;
          stopped = true;
          break;
        }
      }

      if (x < -CROSSING_PREVIEW_DOT_RADIUS || x > canvasWidth + CROSSING_PREVIEW_DOT_RADIUS || y > canvasHeight + CROSSING_PREVIEW_DOT_RADIUS) {
        dot.visible = false;
      } else {
        dot.visible = true;
        dot.x = x;
        dot.y = y;
      }
      prevT = t;
      prevY = y;
    }
  }

  hideTrajectoryPreview(): void {
    for (let i = 0; i < this.previewDots.length; i++) this.previewDots[i]!.visible = false;
  }

  /** Redraws the timer bar (background once per width change, fill every
   * call — its width changes essentially every frame) and updates the combo
   * counter text (only touched when the count actually changes, since a
   * Pixi Text content write re-lays-out glyphs). `timerFraction` is
   * remaining/total, 0..1. */
  /**
   * The timer bar is gone — a countdown punished the player for how much real
   * traffic happened to exist, which they cannot control. Only the combo
   * readout remains.
   */
  updateHud(canvasWidth: number, comboCount: number): void {
    if (Math.abs(canvasWidth - this.lastHudWidth) > 0.5) {
      this.lastHudWidth = canvasWidth;
      this.comboText.x = canvasWidth / 2;
    }

    if (comboCount !== this.lastComboDisplayed) {
      this.lastComboDisplayed = comboCount;
      this.comboText.visible = comboCount > 1;
      if (comboCount > 1) this.comboText.text = `PERFECT x${comboCount}`;
    }
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

  private isGhostPlatform(platform: Platform): boolean {
    for (let i = 0; i < this.ghosts.length; i++) {
      if (this.ghosts[i]!.platform === platform) return true;
    }
    return false;
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
      platform.updateVisual(followT, canvasWidth, canvasHeight, fadeAlpha);
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
      slot.platform.updateVisual(1, canvasWidth, canvasHeight, 1);
    }
  }

  /**
   * The crossing-mode equivalent of an obstacle spacing derivation: if real
   * tracking goes quiet, the level must still be solvable, so a synthetic
   * chain of "ghost" platforms is spawned spanning the CURRENT goal leg
   * end-to-end, each hop sized so a full-power jump
   * (crossingMaxHorizontalReach, same height, dropPx=0 — ghosts sit at the
   * live `roadCenterYFraction`, same as the anchor blocks, by construction)
   * can always cover it with margin to spare.
   *
   * That margin — and therefore how many intermediate platforms are needed
   * to tile the span — TIGHTENS as the player completes more crossings (see
   * CROSSING_GHOST_GAP_SAFETY_FACTOR_EASY/HARD and
   * CROSSING_DIFFICULTY_RAMP_CROSSINGS in config.ts): a smaller margin means
   * each hop demands closer-to-full-power precision AND needs fewer
   * platforms to cover the same distance, which is what makes "narrower
   * landing tolerance, fewer ghost platforms" a single escalating dial
   * rather than two separately-tuned ones. The margin never reaches 1, so a
   * hop timed a little early or late is never mathematically unlandable —
   * see CROSSING_GHOST_POOL_SIZE's doc for why the pool is sized for the
   * EASY (loosest, most-platforms-needed) end of that range, not the hard one.
   *
   * Spawns at most once per "coverage gap" — see completeCrossing()/reset()
   * for the only two places `ghostChainActive` is cleared, which is what
   * lets it try again after each leg.
   */
  private maybeSpawnGhostChain(canvasWidth: number): void {
    if (this.ghostChainActive) return;
    if (this.timeSinceStableTrack < CROSSING_GHOST_TRIGGER_SECONDS) return;

    const startX = this.startBlock.right;
    const goalX = this.goalBlock.left;
    const span = this.legDirection === 1 ? goalX - startX : startX - goalX;
    if (span <= 0) return;
    this.ghostChainActive = true;

    const difficultyT = clamp(this.crossings / CROSSING_DIFFICULTY_RAMP_CROSSINGS, 0, 1);
    const safetyFactor = lerp(CROSSING_GHOST_GAP_SAFETY_FACTOR_EASY, CROSSING_GHOST_GAP_SAFETY_FACTOR_HARD, difficultyT);

    const maxReach = crossingMaxHorizontalReach(canvasWidth, 0);
    const perHop = Math.max(1, maxReach * safetyFactor);
    const hopCount = Math.max(1, Math.ceil(span / perHop));
    const intermediateCount = clamp(hopCount - 1, 0, this.ghosts.length);

    for (let i = 0; i < intermediateCount; i++) {
      const t = (i + 1) / (intermediateCount + 1);
      const x = this.legDirection === 1 ? startX + span * t : startX - span * t;
      const slot = this.ghosts[i]!;
      slot.active = true;
      slot.phase = Math.random() * Math.PI * 2;
      slot.baseXFraction = x / canvasWidth;
      slot.baseYFraction = this.roadCenterYFraction;
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
