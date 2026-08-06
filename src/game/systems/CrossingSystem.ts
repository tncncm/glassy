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
  CROSSING_AIM_CANCEL_RADIUS_PX,
  CROSSING_AIM_CANCEL_RING_ALPHA,
  CROSSING_AIM_CANCEL_RING_COLOR,
  CROSSING_AIM_CANCEL_RING_THICKNESS,
  CROSSING_AIM_CANCEL_ZONE_ALPHA,
  CROSSING_AIM_CANCEL_ZONE_ARMED_ALPHA,
  CROSSING_AIM_CANCEL_ZONE_ARMED_COLOR,
  CROSSING_AIM_CANCEL_ZONE_ARMED_LABEL_TEXT,
  CROSSING_AIM_CANCEL_ZONE_COLOR,
  CROSSING_AIM_CANCEL_ZONE_HEIGHT_PX,
  CROSSING_AIM_CANCEL_ZONE_LABEL_COLOR,
  CROSSING_AIM_CANCEL_ZONE_LABEL_OUTLINE_COLOR,
  CROSSING_AIM_CANCEL_ZONE_LABEL_SIZE,
  CROSSING_AIM_CANCEL_ZONE_LABEL_TEXT,
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
  CROSSING_FLAG_OUTLINE_COLOR,
  CROSSING_FLAG_HEIGHT_PX,
  CROSSING_FLAG_POLE_HEIGHT_PX,
  CROSSING_FLAG_POLE_WIDTH_PX,
  CROSSING_FLAG_WIDTH_PX,
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
  CROSSING_LEFT_BLOCK_CENTER_X_FRACTION_EASY,
  CROSSING_LEFT_BLOCK_CENTER_X_FRACTION_HARD,
  CROSSING_PREVIEW_DOT_ALPHA,
  CROSSING_PREVIEW_DOT_COLOR,
  CROSSING_PREVIEW_DOT_COUNT,
  CROSSING_PREVIEW_DOT_RADIUS,
  CROSSING_RIGHT_BLOCK_CENTER_X_FRACTION_EASY,
  CROSSING_RIGHT_BLOCK_CENTER_X_FRACTION_HARD,
  CROSSING_TIMER_BAR_BG_ALPHA,
  CROSSING_TIMER_BAR_BG_COLOR,
  CROSSING_TIMER_BAR_COLOR_CRITICAL,
  CROSSING_TIMER_BAR_COLOR_PAUSED,
  CROSSING_TIMER_BAR_COLOR_SAFE,
  CROSSING_TIMER_BAR_COLOR_WARN,
  CROSSING_TIMER_BAR_CRITICAL_FRACTION,
  CROSSING_TIMER_BAR_HEIGHT_PX,
  CROSSING_TIMER_BAR_TOP_MARGIN_PX,
  CROSSING_TIMER_BAR_WARN_FRACTION,
  CROSSING_TIMER_BAR_WIDTH_FRACTION,
  CROSSING_TIMER_PAUSED_ALPHA_MAX,
  CROSSING_TIMER_PAUSED_ALPHA_MIN,
  CROSSING_TIMER_PAUSED_LABEL_COLOR,
  CROSSING_TIMER_PAUSED_LABEL_OUTLINE_COLOR,
  CROSSING_TIMER_PAUSED_LABEL_SIZE,
  CROSSING_TIMER_PAUSED_LABEL_TEXT,
  CROSSING_TIMER_PAUSED_LABEL_Y_PX,
  CROSSING_TIMER_PAUSED_PULSE_RATE,
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

/**
 * Builds one anchor-block pennant glyph (pole + triangular flag), drawn in
 * flat white so `.tint` can recolor it to whichever palette its owning block
 * currently holds (start=green, goal=gold — see retintBlocks()) without a
 * redraw. Local origin is the flag's ground point; callers position it at
 * the block's current top-center every frame.
 */
function buildCrossingFlag(): Graphics {
  const poleTop = -CROSSING_FLAG_POLE_HEIGHT_PX;
  return new Graphics()
    .rect(-CROSSING_FLAG_POLE_WIDTH_PX / 2, poleTop, CROSSING_FLAG_POLE_WIDTH_PX, CROSSING_FLAG_POLE_HEIGHT_PX)
    .fill({ color: 0xffffff })
    .moveTo(CROSSING_FLAG_POLE_WIDTH_PX / 2, poleTop)
    .lineTo(CROSSING_FLAG_POLE_WIDTH_PX / 2 + CROSSING_FLAG_WIDTH_PX, poleTop + CROSSING_FLAG_HEIGHT_PX / 2)
    .lineTo(CROSSING_FLAG_POLE_WIDTH_PX / 2, poleTop + CROSSING_FLAG_HEIGHT_PX)
    .closePath()
    .fill({ color: 0xffffff })
    .stroke({ width: 1, color: CROSSING_FLAG_OUTLINE_COLOR });
}

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

  // SAFETY AUDIT: there used to be a `ghostTouchedThisLeg` flag here, feeding
  // a "no-ghost crossing" bonus. It has been deleted — see
  // CROSSING_PERFECT_LANDING_COMBO_MAX_MULTIPLIER's neighboring doc in
  // config.ts for why. Ghost platforms are ordinary, first-class landing
  // surfaces from a scoring point of view; nothing in this class tracks
  // whether a leg touched one.

  /** Live vertical center (0..1 fraction of canvas height) every anchor
   * block and freshly-spawned ghost platform is placed at — starts at the
   * DEFAULT and is nudged toward accepted horizon hints in `update()`. See
   * `setHorizonHint`'s doc. */
  private roadCenterYFraction = CROSSING_BLOCK_CENTER_Y_FRACTION;
  private horizonHintFraction: number | null = null;
  private horizonHintConfidence = 0;

  // --- Trajectory preview — pooled dots, built once. ---
  private readonly previewDots: Graphics[] = [];
  private readonly cancelRing: Graphics;
  private cancelRingDrawn = false;

  // --- Second cancel affordance: a labelled banner fixed at the screen's
  // top edge, shown only while aiming — see CROSSING_AIM_CANCEL_ZONE_* in
  // config.ts for why this lives at a screen-fixed edge rather than
  // world-anchored like the ring above. HUD-layer (never shaken/hitstopped),
  // drawn once in flat white and recolored via `.tint` between its idle and
  // armed states, same trick buildCrossingFlag() already uses. ---
  private readonly cancelZoneBg = new Graphics();
  private readonly cancelZoneLabel: Text;
  private cancelZoneLastWidth = -1;

  // --- Anchor-block pennant glyphs — see CROSSING_FLAG_* in config.ts.
  // Shape-coded (not just color-coded) start/goal markers, floating above
  // each block; repositioned every frame, recolored (tint) only on retint. ---
  private readonly startFlag: Graphics;
  private readonly goalFlag: Graphics;

  // --- HUD: per-leg countdown bar + combo counter, pre-built once. The bar
  // fill is drawn ONCE at full width and animated purely via `.scale.x` +
  // `.tint` every frame (never re-drawn) — see updateHud()'s doc for why a
  // continuously-changing countdown must not redraw Graphics geometry every
  // frame. ---
  private readonly timerBarBg = new Graphics();
  private readonly timerBarFill = new Graphics();
  private readonly comboText: Text;
  private readonly pausedLabel: Text;
  private lastHudWidth = -1;
  private lastComboDisplayed = -1;
  private timerBarX = 0;
  private timerBarWidth = 0;
  /** Advances only while the timer is paused — drives the "waiting" breathing
   * pulse (see CROSSING_TIMER_PAUSED_* in config.ts) so the pause reads as a
   * deliberate state, never a stall. */
  private pausedPulsePhase = 0;

  /**
   * `worldContainer` holds everything that should shake along with the rest
   * of the scene on impact (blocks, platforms, the trajectory preview).
   * `hudContainer` is a SIBLING outside the world's shake transform — see
   * Game.ts's scene graph — so the timer bar/combo counter stay perfectly
   * readable even while the world is shaking from a hard landing.
   */
  constructor(worldContainer: Container, hudContainer: Container) {
    worldContainer.addChild(this.leftBlock.view, this.rightBlock.view);

    this.startFlag = buildCrossingFlag();
    this.goalFlag = buildCrossingFlag();
    worldContainer.addChild(this.startFlag, this.goalFlag);

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

    this.cancelRing = new Graphics();
    this.cancelRing.visible = false;
    worldContainer.addChild(this.cancelRing);

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

    this.pausedLabel = new Text({
      text: CROSSING_TIMER_PAUSED_LABEL_TEXT,
      style: {
        fontSize: CROSSING_TIMER_PAUSED_LABEL_SIZE,
        fill: CROSSING_TIMER_PAUSED_LABEL_COLOR,
        fontFamily: 'sans-serif',
        fontWeight: 'bold',
        stroke: { color: CROSSING_TIMER_PAUSED_LABEL_OUTLINE_COLOR, width: 2 },
      },
    });
    this.pausedLabel.anchor.set(0.5, 0);
    this.pausedLabel.y = CROSSING_TIMER_PAUSED_LABEL_Y_PX;
    this.pausedLabel.visible = false;
    hudContainer.addChild(this.pausedLabel);

    // Cancel zone banner — drawn once in flat white (`.tint` recolors it
    // idle/armed, see showCancelZone()); geometry is a plain full-width rect
    // rebuilt only when canvasWidth actually changes, same pattern the timer
    // bar above already uses.
    this.cancelZoneBg.visible = false;
    hudContainer.addChild(this.cancelZoneBg);
    this.cancelZoneLabel = new Text({
      text: CROSSING_AIM_CANCEL_ZONE_LABEL_TEXT,
      style: {
        fontSize: CROSSING_AIM_CANCEL_ZONE_LABEL_SIZE,
        fill: CROSSING_AIM_CANCEL_ZONE_LABEL_COLOR,
        fontFamily: 'sans-serif',
        fontWeight: 'bold',
        stroke: { color: CROSSING_AIM_CANCEL_ZONE_LABEL_OUTLINE_COLOR, width: 2 },
      },
    });
    this.cancelZoneLabel.anchor.set(0.5, 0.5);
    this.cancelZoneLabel.visible = false;
    hudContainer.addChild(this.cancelZoneLabel);
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

  /** 0..1, how far through the spatial difficulty ramp the run is —
   * `crossings / CROSSING_DIFFICULTY_RAMP_CROSSINGS`, clamped. The single
   * curve every "escalate through space, never through traffic" dial in this
   * class (leg span, ghost gap safety factor) rides — see config.ts's
   * CROSSING_DIFFICULTY_RAMP_CROSSINGS doc. Game.ts computes the same curve
   * independently off `crossingsCompleted` for its own dials (landing-assist
   * box, PERFECT precision) so the whole escalation reads as one thing. */
  private get difficultyT(): number {
    return clamp(this.crossings / CROSSING_DIFFICULTY_RAMP_CROSSINGS, 0, 1);
  }

  /** Live anchor-block X centers (0..1 fraction of canvas width) — see
   * CROSSING_LEFT/RIGHT_BLOCK_CENTER_X_FRACTION_EASY/HARD's doc in
   * config.ts: the leg literally gets longer as the player gets better,
   * which is "difficulty through space" applied to the crossing's own
   * geometry rather than its timing or its traffic. */
  private get leftBlockXFraction(): number {
    return lerp(CROSSING_LEFT_BLOCK_CENTER_X_FRACTION_EASY, CROSSING_LEFT_BLOCK_CENTER_X_FRACTION_HARD, this.difficultyT);
  }

  private get rightBlockXFraction(): number {
    return lerp(CROSSING_RIGHT_BLOCK_CENTER_X_FRACTION_EASY, CROSSING_RIGHT_BLOCK_CENTER_X_FRACTION_HARD, this.difficultyT);
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
    this.candidates.length = 0;
    this.hideTrajectoryPreview();

    this.leftBlock.activate(LEFT_BLOCK_TRACK_ID, this.leftBlockXFraction, this.roadCenterYFraction, CROSSING_BLOCK_WIDTH_FRACTION, CROSSING_BLOCK_HEIGHT_FRACTION);
    this.rightBlock.activate(RIGHT_BLOCK_TRACK_ID, this.rightBlockXFraction, this.roadCenterYFraction, CROSSING_BLOCK_WIDTH_FRACTION, CROSSING_BLOCK_HEIGHT_FRACTION);
    this.retintBlocks();
  }

  /** Fires a few times a second, straight off Game's own onTrackedObjects.
   * Reads `objects` synchronously only, never retains it. */
  onTrackedObjects(objects: readonly TrackedObject[]): void {
    for (let i = 0; i < objects.length; i++) {
      const track = objects[i]!;
      if (!track.stable) continue;
      this.timeSinceStableTrack = 0;

      // Use the REFINED roof, not the detector's loose box. `surfaceY` is the
      // actual roof line found inside the box and `surfaceLeft/Right` its true
      // width — the box wraps mirrors, arches and some background, so landing
      // on its top edge reads as landing on an invisible rectangle hovering
      // near a car instead of on the car. The body still extends down to the
      // box's bottom so the platform visually covers the vehicle; only the
      // landing surface moves. See RoofFinder.ts; these always have a
      // box-edge fallback, so no null handling is needed here.
      const surfaceTop = track.surfaceY;
      const bodyBottom = track.y + track.height / 2;
      const roofHeight = Math.max(bodyBottom - surfaceTop, track.height * 0.2);
      const roofCenterY = surfaceTop + roofHeight / 2;
      const roofWidth = Math.max(track.surfaceRight - track.surfaceLeft, track.width * 0.2);
      const roofCenterX = (track.surfaceLeft + track.surfaceRight) / 2;

      // The actual top silhouette — bonnet, windscreen, roof — not just a
      // flat top edge; see Platform's file doc and types.ts's
      // TrackedObject.surfaceProfile. Platform copies this synchronously and
      // never retains it, matching the reused-array contract.
      const existing = this.findRealByTrackId(track.id);
      if (existing) {
        existing.retarget(roofCenterX, roofCenterY, roofWidth, roofHeight, track.surfaceProfile);
        continue;
      }
      const fresh = this.realPool.pop();
      if (!fresh) continue; // pool exhausted — extra tracks simply wait for a slot
      fresh.activate(track.id, roofCenterX, roofCenterY, roofWidth, roofHeight, track.surfaceProfile);
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
   *
   * `gyroOffsetXPx`/`gyroOffsetYPx` (default 0) is this frame's
   * gyro-stabilisation correction (see GYRO_STABILIZATION_* in config.ts and
   * Game.ts's leaky-integrator derivation) — applied ONLY to REAL tracked
   * platforms (`updateRealPlatforms`), never to ghosts (synthetic, nothing
   * to correct) or the anchor blocks (already smoothed independently via the
   * horizon hint).
   */
  update(dt: number, canvasWidth: number, canvasHeight: number, occupiedPlatform: Platform | null, gyroOffsetXPx = 0, gyroOffsetYPx = 0): void {
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

    // Anchor blocks: X tracks the live spatial-difficulty span, Y tracks the
    // live road height every frame; followT=1 (snap) since both are already
    // the slow-smoothed/ramped values — Platform's own glide would just be
    // redundant smoothing on top of smoothing.
    const leftXFraction = this.leftBlockXFraction;
    const rightXFraction = this.rightBlockXFraction;
    this.leftBlock.retarget(leftXFraction, this.roadCenterYFraction, CROSSING_BLOCK_WIDTH_FRACTION, CROSSING_BLOCK_HEIGHT_FRACTION);
    this.rightBlock.retarget(rightXFraction, this.roadCenterYFraction, CROSSING_BLOCK_WIDTH_FRACTION, CROSSING_BLOCK_HEIGHT_FRACTION);
    this.leftBlock.updateVisual(1, canvasWidth, canvasHeight, 1);
    this.rightBlock.updateVisual(1, canvasWidth, canvasHeight, 1);

    this.updateRealPlatforms(dt, canvasWidth, canvasHeight, occupiedPlatform, gyroOffsetXPx, gyroOffsetYPx);
    this.updateGhostPlatforms(dt, canvasWidth, canvasHeight);

    this.timeSinceStableTrack += dt;
    this.maybeSpawnGhostChain(canvasWidth);

    // Pennant glyphs float above whichever block currently holds each role.
    const startBlock = this.startBlock;
    const goalBlock = this.goalBlock;
    this.startFlag.x = (startBlock.left + startBlock.right) / 2;
    this.startFlag.y = startBlock.top;
    this.goalFlag.x = (goalBlock.left + goalBlock.right) / 2;
    this.goalFlag.y = goalBlock.top;

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
   * on its own after CROSSING_GHOST_TRIGGER_SECONDS if it doesn't). Does NOT
   * itself reposition the blocks for the new `crossings` count (which just
   * changed the spatial-difficulty span) — callers that need the new
   * `startBlock`'s position synchronously (Game.ts's handleCrossingWin) must
   * follow this with an `update(0, ...)` settle pass first, same convention
   * `reset()`'s own doc already establishes. */
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
      // landing candidate's ACTUAL surface height AT THIS X (the profile,
      // not a flat top — see Platform.surfaceYAt's doc) within its
      // horizontal span — dots must show WHERE the jump actually lands, not
      // the free-flight parabola continuing on through a platform that would
      // already have caught it. Linearly interpolate between this sample and
      // the previous one for a landing marker that reads as "here", not
      // "somewhere in this step".
      for (let p = 0; p < this.candidates.length; p++) {
        const platform = this.candidates[p]!;
        if (x < platform.left || x > platform.right) continue;
        const surfaceAtX = platform.surfaceYAt(x);
        if (prevY <= surfaceAtX && y >= surfaceAtX) {
          const frac = y > prevY ? (surfaceAtX - prevY) / (y - prevY) : 1;
          const landingT = prevT + (t - prevT) * frac;
          x = originX + vx * landingT;
          y = surfaceAtX;
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
    this.cancelRing.visible = false;
    this.cancelZoneBg.visible = false;
    this.cancelZoneLabel.visible = false;
  }

  /**
   * The "release here to cancel" ring, drawn at the press point while aiming.
   *
   * The cancel gesture already existed — drag back to where you pressed — but
   * nothing on screen said so, and the user reported it as missing. Drawing it
   * is the whole fix; the logic was fine.
   */
  showCancelRing(x: number, y: number, armed: boolean): void {
    if (!this.cancelRingDrawn) {
      this.cancelRingDrawn = true;
      this.cancelRing
        .circle(0, 0, CROSSING_AIM_CANCEL_RADIUS_PX)
        .stroke({
          width: CROSSING_AIM_CANCEL_RING_THICKNESS,
          color: CROSSING_AIM_CANCEL_RING_COLOR,
          alpha: 1,
        });
    }
    this.cancelRing.x = x;
    this.cancelRing.y = y;
    this.cancelRing.visible = true;
    // Solid when releasing would cancel; ghosted while it is merely available.
    this.cancelRing.alpha = armed ? 1 : CROSSING_AIM_CANCEL_RING_ALPHA;
    this.cancelRing.scale.set(armed ? 1.12 : 1);
  }

  /**
   * The SECOND cancel affordance — see CROSSING_AIM_CANCEL_ZONE_* in
   * config.ts and InputSystem's class doc for the full gesture this backs. A
   * labelled banner spanning the top edge of the canvas, shown only while
   * aiming; `armed` is InputSystem's own top-edge-proximity check against
   * the REAL pointer position (not anything derived here), so the highlight
   * is exact, not a re-derivation. Geometry (a plain full-width rect) is
   * rebuilt only when canvasWidth actually changes — same "redraw on
   * dimension change, restyle via `.tint`/`.alpha` every frame" pattern the
   * timer bar above already uses.
   */
  showCancelZone(canvasWidth: number, armed: boolean): void {
    if (Math.abs(canvasWidth - this.cancelZoneLastWidth) > 0.5) {
      this.cancelZoneLastWidth = canvasWidth;
      this.cancelZoneBg.clear().rect(0, 0, canvasWidth, CROSSING_AIM_CANCEL_ZONE_HEIGHT_PX).fill({ color: 0xffffff });
      this.cancelZoneLabel.x = canvasWidth / 2;
      // Bottom-anchored within the band, not vertically centered — the
      // timer bar + the "WAITING FOR A LANDING SPOT" paused label both live
      // in the first ~32px from the top (see their own Y constants), and
      // aiming while the timer is paused is a completely ordinary thing to
      // do, so both CAN be on screen at once. Sitting low in the band keeps
      // this legible instead of overlapping them.
      this.cancelZoneLabel.y = CROSSING_AIM_CANCEL_ZONE_HEIGHT_PX - 18;
    }
    this.cancelZoneBg.visible = true;
    this.cancelZoneLabel.visible = true;
    this.cancelZoneBg.tint = armed ? CROSSING_AIM_CANCEL_ZONE_ARMED_COLOR : CROSSING_AIM_CANCEL_ZONE_COLOR;
    this.cancelZoneBg.alpha = armed ? CROSSING_AIM_CANCEL_ZONE_ARMED_ALPHA : CROSSING_AIM_CANCEL_ZONE_ALPHA;
    this.cancelZoneLabel.text = armed ? CROSSING_AIM_CANCEL_ZONE_ARMED_LABEL_TEXT : CROSSING_AIM_CANCEL_ZONE_LABEL_TEXT;
  }

  /**
   * The per-leg countdown, back — see Game.ts's `isProgressReachable`/
   * `legTimeRemaining` for the fairness rule that makes this safe to have
   * again: the clock only runs while a reachable landing spot exists, so it
   * can only ever punish dithering, never the road. `timerFraction` is
   * remaining/total (0..1, already computed by Game.ts); `timerPaused` is
   * true whenever nothing is currently reachable.
   *
   * The bar's FILL geometry is drawn once (full width) the first time (or
   * whenever `canvasWidth` actually changes) and animated every other frame
   * purely via `.scale.x` (width) and `.tint` (color) — never re-drawn —
   * because unlike Platform's box (which only changes shape occasionally),
   * this literally changes every single frame the clock is running, and
   * redrawing Graphics geometry every frame is exactly the per-frame
   * allocation this whole layer is built to avoid.
   */
  updateHud(dt: number, canvasWidth: number, comboCount: number, timerFraction: number, timerPaused: boolean): void {
    if (Math.abs(canvasWidth - this.lastHudWidth) > 0.5) {
      this.lastHudWidth = canvasWidth;
      this.comboText.x = canvasWidth / 2;
      this.pausedLabel.x = canvasWidth / 2;

      this.timerBarWidth = canvasWidth * CROSSING_TIMER_BAR_WIDTH_FRACTION;
      this.timerBarX = (canvasWidth - this.timerBarWidth) / 2;
      const radius = CROSSING_TIMER_BAR_HEIGHT_PX / 2;
      this.timerBarBg
        .clear()
        .roundRect(this.timerBarX, CROSSING_TIMER_BAR_TOP_MARGIN_PX, this.timerBarWidth, CROSSING_TIMER_BAR_HEIGHT_PX, radius)
        .fill({ color: CROSSING_TIMER_BAR_BG_COLOR, alpha: CROSSING_TIMER_BAR_BG_ALPHA });
      // Full-width fill geometry, local origin at its own left edge, so
      // `.scale.x` alone can shrink it toward that edge without a redraw.
      this.timerBarFill.clear().roundRect(0, 0, Math.max(1, this.timerBarWidth), CROSSING_TIMER_BAR_HEIGHT_PX, radius).fill({ color: 0xffffff });
      this.timerBarFill.x = this.timerBarX;
      this.timerBarFill.y = CROSSING_TIMER_BAR_TOP_MARGIN_PX;
    }

    const clampedFraction = clamp(timerFraction, 0, 1);
    this.timerBarFill.scale.x = clampedFraction;
    this.timerBarFill.visible = clampedFraction > 0.002;

    if (timerPaused) {
      this.pausedPulsePhase += CROSSING_TIMER_PAUSED_PULSE_RATE * dt;
      const pulse = (Math.sin(this.pausedPulsePhase) + 1) * 0.5;
      this.timerBarFill.tint = CROSSING_TIMER_BAR_COLOR_PAUSED;
      this.timerBarFill.alpha = lerp(CROSSING_TIMER_PAUSED_ALPHA_MIN, CROSSING_TIMER_PAUSED_ALPHA_MAX, pulse);
      this.pausedLabel.visible = true;
      this.pausedLabel.alpha = lerp(CROSSING_TIMER_PAUSED_ALPHA_MIN, CROSSING_TIMER_PAUSED_ALPHA_MAX, pulse);
    } else {
      this.pausedPulsePhase = 0;
      this.timerBarFill.alpha = 1;
      this.pausedLabel.visible = false;
      this.timerBarFill.tint =
        clampedFraction <= CROSSING_TIMER_BAR_CRITICAL_FRACTION
          ? CROSSING_TIMER_BAR_COLOR_CRITICAL
          : clampedFraction <= CROSSING_TIMER_BAR_WARN_FRACTION
            ? CROSSING_TIMER_BAR_COLOR_WARN
            : CROSSING_TIMER_BAR_COLOR_SAFE;
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
    this.startFlag.tint = CROSSING_BLOCK_START_FILL;
    this.goalFlag.tint = CROSSING_BLOCK_GOAL_FILL;
  }

  private findRealByTrackId(id: number): Platform | undefined {
    for (let i = 0; i < this.realActive.length; i++) {
      const platform = this.realActive[i]!;
      if (platform.trackId === id) return platform;
    }
    return undefined;
  }

  private updateRealPlatforms(
    dt: number,
    canvasWidth: number,
    canvasHeight: number,
    occupiedPlatform: Platform | null,
    gyroOffsetXPx: number,
    gyroOffsetYPx: number,
  ): void {
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
      // Gyro-stabilisation nudge — REAL platforms only, see this method's
      // caller and GYRO_STABILIZATION_* in config.ts.
      platform.updateVisual(followT, canvasWidth, canvasHeight, fadeAlpha, gyroOffsetXPx, gyroOffsetYPx);
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
