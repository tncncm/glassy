/**
 * Game — orchestrates the whole gameplay layer: owns the Pixi Application,
 * wires GameLoop/Player/CrossingSystem/ParticleSystem/InputSystem together,
 * and implements the `Game` contract from src/types.ts exactly.
 *
 * There is exactly one game: the crossing (see CrossingSystem's doc). The
 * player crosses the static camera frame left to right, then right to left,
 * endlessly, by walking and aim-jumping across real tracked vehicles turned
 * into platforms, with a synthetic "ghost" fallback guaranteeing the
 * crossing is always solvable even with nothing real being tracked.
 *
 * Rendering is driven entirely by GameLoop's own requestAnimationFrame chain
 * (the Application is built with `autoStart: false`); `update()` is the one
 * per-frame hot path in this whole layer and is written to allocate
 * nothing — no object/array literals, no closures, no `new`, no
 * Graphics/Text construction. Every entity/system it touches follows the
 * same rule (see their file headers).
 */

import { Application, Container, Text } from 'pixi.js';
import type { CreateGame, Game, GameOptions, GameOverResult, GameStatus, MotionState, TrackedObject } from '../types.ts';
import {
  CROSSING_AIM_CANCEL_RADIUS_PX,
  CROSSING_AIM_MAX_DRAG_PX,
  COLLISION_SHAKE_TRAUMA,
  CROSSING_DIFFICULTY_RAMP_CROSSINGS,
  CROSSING_EDGE_MARGIN_PX,
  CROSSING_EDGE_WARNING_SECONDS,
  CROSSING_FALL_MARGIN_PX,
  CROSSING_GOAL_SHAKE_TRAUMA,
  CROSSING_GOAL_SPARKLE_COLOR,
  CROSSING_HITSTOP_SECONDS,
  CROSSING_HOP_REACTION_SECONDS,
  CROSSING_LANDING_ASSIST_HORIZONTAL_PX_EASY,
  CROSSING_LANDING_ASSIST_HORIZONTAL_PX_HARD,
  CROSSING_LANDING_ASSIST_VERTICAL_PX_EASY,
  CROSSING_LANDING_ASSIST_VERTICAL_PX_HARD,
  CROSSING_LANDING_SHAKE_TRAUMA_MAX,
  CROSSING_LANDING_SHAKE_TRAUMA_PER_PXPS,
  CROSSING_MIN_JUMP_VERTICAL_FRACTION,
  CROSSING_PERFECT_LANDING_BONUS,
  CROSSING_PERFECT_LANDING_COMBO_MAX_MULTIPLIER,
  CROSSING_PERFECT_LANDING_COMBO_STEP,
  CROSSING_PERFECT_LANDING_SHAKE_TRAUMA,
  CROSSING_PERFECT_LANDING_SPARKLE_COLOR,
  CROSSING_PERFECT_LANDING_WIDTH_FRACTION_EASY,
  CROSSING_PERFECT_LANDING_WIDTH_FRACTION_HARD,
  CROSSING_PREVIEW_DURATION_MARGIN,
  CROSSING_SCORE_BONUS_PER_CROSSING,
  CROSSING_SCORE_PER_PIXEL_PROGRESS,
  CROSSING_SCORE_PER_SECOND,
  CROSSING_TARGET_HOPS_PER_CROSSING,
  CROSSING_TIMER_FLOOR_GENEROSITY,
  CROSSING_TIMER_SHRINK_PER_CROSSING_SECONDS,
  CROSSING_TIMER_START_GENEROSITY,
  CROSSING_WALK_SPEED,
  DEBUG_TEXT_COLOR,
  DEBUG_TEXT_SIZE,
  DEBUG_TEXT_UPDATE_INTERVAL_SECONDS,
  GYRO_STABILIZATION_GAIN_PX_PER_DEG,
  GYRO_STABILIZATION_LEAK_RATE,
  GYRO_STABILIZATION_MAX_OFFSET_PX,
  PLAYER_HEIGHT,
  SHAKE_DECAY_RATE,
  SHAKE_MAGNITUDE_PX,
} from './config.ts';
import { Player } from './entities/Player.ts';
import type { Platform } from './entities/Platform.ts';
import { GameLoop } from './GameLoop.ts';
import { CrossingSystem } from './systems/CrossingSystem.ts';
import { InputSystem } from './systems/InputSystem.ts';
import { MotionCueSystem } from './systems/MotionCueSystem.ts';
import { ParticleSystem } from './systems/ParticleSystem.ts';
import { clamp, lerp } from './util/math.ts';
import { crossingFullPowerFlightTimeSeconds, crossingMaxHorizontalReach, crossingMaxJumpSpeed } from './util/solvability.ts';

/**
 * Per-leg countdown budget (seconds), escalating with crossings completed —
 * derived from the same hop-count/flight-time kinematics util/solvability.ts
 * already provides (CROSSING_TARGET_HOPS_PER_CROSSING full-power hops, each
 * budgeted its own flight time plus a reaction-time margin), not a guessed
 * seconds value. See CROSSING_TIMER_* in config.ts for the generosity/floor
 * multipliers. THE CLOCK ITSELF only ever ticks down while
 * `isProgressReachable()` is true (see that function) — this is just the
 * BUDGET each leg starts with, escalating leg over leg exactly like every
 * other difficulty dial in this file.
 */
function crossingLegTimeSeconds(canvasWidth: number, crossingsCompleted: number): number {
  const perHopSeconds = crossingFullPowerFlightTimeSeconds(canvasWidth) + CROSSING_HOP_REACTION_SECONDS;
  const baseBudget = CROSSING_TARGET_HOPS_PER_CROSSING * perHopSeconds;
  const firstLegBudget = baseBudget * CROSSING_TIMER_START_GENEROSITY;
  const floorBudget = baseBudget * CROSSING_TIMER_FLOOR_GENEROSITY;
  const shrunkBudget = firstLegBudget - CROSSING_TIMER_SHRINK_PER_CROSSING_SECONDS * crossingsCompleted;
  return Math.max(floorBudget, shrunkBudget);
}

/**
 * Scratch object reused by computeCrossingJumpVelocity, below — never
 * reallocated, so the per-frame keyboard-charge poll
 * (InputSystem.updateCrossingAim → onCrossingAimChange) allocates nothing.
 * Safe because every caller reads it synchronously, immediately after the
 * call.
 */
const crossingJumpVelocityScratch = { vx: 0, vy: 0 };

/**
 * Converts a raw screen-space aim vector (y-down, arbitrary magnitude) plus
 * a 0..1 power into a launch velocity in the up-positive convention
 * Player/util/solvability.ts use. Enforces CROSSING_MIN_JUMP_VERTICAL_
 * FRACTION so every jump has real liftoff — see that constant's doc in
 * config.ts for why that also matters for landing-assist correctness, not
 * just game feel.
 */
function computeCrossingJumpVelocity(dirX: number, dirY: number, power: number, maxSpeed: number): { vx: number; vy: number } {
  let nx = dirX;
  let ny = dirY;
  let length = Math.sqrt(nx * nx + ny * ny);
  if (length < 1e-4) {
    // No meaningful direction (e.g. a keyboard charge released with zero
    // held keys and no vertical bias) — default to forward-and-up.
    nx = 1;
    ny = -1;
    length = Math.SQRT2;
  }
  nx /= length;
  ny /= length;
  let upVy = -ny;
  if (upVy < CROSSING_MIN_JUMP_VERTICAL_FRACTION) {
    upVy = CROSSING_MIN_JUMP_VERTICAL_FRACTION;
    const horizontalMagnitude = Math.sqrt(Math.max(0, 1 - upVy * upVy));
    nx = nx >= 0 ? horizontalMagnitude : -horizontalMagnitude;
  }
  const speed = clamp(power, 0, 1) * maxSpeed;
  crossingJumpVelocityScratch.vx = nx * speed;
  crossingJumpVelocityScratch.vy = upVy * speed;
  return crossingJumpVelocityScratch;
}

export const createGame: CreateGame = async (options: GameOptions): Promise<Game> => {
  const { container, callbacks, preferences, debug } = options;

  const initialWidth = container.clientWidth || window.innerWidth || 1;
  const initialHeight = container.clientHeight || window.innerHeight || 1;

  const app = new Application();
  await app.init({
    width: initialWidth,
    height: initialHeight,
    backgroundAlpha: 0,
    antialias: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
    autoStart: false,
  });

  app.canvas.style.width = '100%';
  app.canvas.style.height = '100%';
  app.canvas.style.display = 'block';
  // The contractual mount point (#glassy-stage, see DOM_IDS.stage in
  // src/types.ts) is `pointer-events: none` in src/styles.css so an empty
  // stage never blocks clicks meant for the UI/video layers around it.
  // `pointer-events` is inherited, so without this the canvas — and every
  // InputSystem listener attached to it — would silently never receive a
  // real pointerdown/move/up: walking and aim-jumping would be completely
  // dead in production. The canvas re-enables it on itself.
  app.canvas.style.pointerEvents = 'auto';
  container.appendChild(app.canvas);

  // --- Scene graph -----------------------------------------------------
  // worldContainer is what screen shake displaces — blocks, platforms, the
  // player and particles all shake together on impact. hudContainer is a
  // SIBLING outside that transform, so the timer bar/combo counter stay
  // perfectly readable even mid-shake.
  const worldContainer = new Container();
  app.stage.addChild(worldContainer);

  const crossingLayer = new Container();
  const particleLayer = new Container();
  const player = new Player();
  worldContainer.addChild(crossingLayer, player.view, particleLayer);

  const hudLayer = new Container();
  app.stage.addChild(hudLayer);

  const particles = new ParticleSystem(particleLayer);
  const crossing = new CrossingSystem(crossingLayer, hudLayer);

  // Motion-comfort cues: peripheral dots, deliberately a SIBLING on top of
  // everything else (including the HUD) — they must stay visible and never
  // get caught in screen shake (worldContainer's transform) or hitstop, since
  // they represent the vehicle's real motion, not the game's. See
  // MotionCueSystem's doc and Game.setMotion/setMotionCuesEnabled below.
  const motionCues = new MotionCueSystem(app.stage);

  let debugText: Text | null = null;
  if (debug === true) {
    debugText = new Text({
      text: '',
      style: { fontSize: DEBUG_TEXT_SIZE, fill: DEBUG_TEXT_COLOR, fontFamily: 'monospace' },
    });
    debugText.x = 8;
    debugText.y = 8;
    app.stage.addChild(debugText);
  }

  // --- Mutable game state ------------------------------------------------
  let status: GameStatus = 'idle';
  let canvasWidth = initialWidth;
  let canvasHeight = initialHeight;
  let scoreAccumulator = 0;
  let scoreInt = 0;
  let shakeTrauma = 0;
  let debugAccumulator = 0;
  /** Counts down after a perfect landing or a goal arrival — while positive,
   * update() renders but skips physics/scoring entirely, for a brief
   * satisfying freeze-frame on the game's best moments. See
   * CROSSING_HITSTOP_SECONDS in config.ts. */
  let hitStopTimer = 0;

  /** Which platform (real/ghost/anchor block) the player currently stands
   * on — `null` means airborne/unresolved. */
  let currentCrossingPlatform: Platform | null = null;
  /** The height-reference `player.updateCrossing(dt, surfaceY)` integrates
   * against — live while grounded/selected, frozen while genuinely airborne
   * with no candidate (see Player.updateCrossing's doc). */
  let crossingSurfaceReferenceY = 0;
  /** For the horizontal "ride along with the platform" effect — the
   * standing platform's own center X the LAST frame it was observed, so this
   * frame's delta can be applied to the player. Reset to `null` whenever the
   * standing platform changes identity. */
  let crossingRideAlongPlatform: Platform | null = null;
  let crossingRideAlongCenterX = 0;
  /** Seconds the player has been grounded and outside the visible frame's
   * horizontal bounds — the edge-carry-off-frame loss telegraph. */
  let crossingEdgeWarningTimer = 0;
  /** player.x as of the end of the previous update() call — the baseline
   * the distance-progress score term measures against. */
  let crossingLastPlayerX = 0;

  /** Consecutive PERFECT landings (see CROSSING_PERFECT_LANDING_WIDTH_
   * FRACTION_EASY/HARD) — broken by any non-perfect landing, persists across
   * completed crossings within a single run. Scales the perfect-landing
   * score bonus and drives the visible combo counter in the HUD. */
  let comboCount = 0;

  /** Per-leg countdown — see crossingLegTimeSeconds()'s doc and
   * isProgressReachable() below for the fairness rule that governs when it
   * actually ticks. */
  let legTimeBudget = 0;
  let legTimeRemaining = 0;
  /** True whenever `isProgressReachable()` was false as of the last frame —
   * read by CrossingSystem.updateHud to draw the "waiting" state. Recomputed
   * every running frame, never guessed. */
  let timerPaused = false;

  /** Latest device motion — a STABLE, externally-owned object the caller
   * (App, wiring MotionSensor.state) is expected to pass in every frame; see
   * Game.setMotion's doc in types.ts. `null` until the first call, and
   * whenever motion is genuinely unavailable this stays whatever was last
   * received with `available: false`, which every reader below already
   * treats as "no signal". Retaining the reference (not copying fields) is
   * intentional and allocation-free — see setMotion() on the returned `game`
   * object. */
  let motionState: MotionState | null = null;

  /** Gyro-stabilisation's leaky-integrator state (see GYRO_STABILIZATION_* in
   * config.ts) — a single hand-rolled high-pass filter on rotation rate,
   * recomputed every running frame and applied only to REAL tracked
   * platforms via CrossingSystem.update()'s gyroOffset params. */
  let gyroOffsetX = 0;
  let gyroOffsetY = 0;

  /**
   * SAFETY + FAIRNESS: the per-leg clock only ever ticks while at least one
   * landing candidate OTHER than the platform currently stood on is within
   * this frame's full-power jump envelope — i.e. progress is genuinely
   * possible right now. Ghost platforms guarantee something eventually
   * enters range (see CrossingSystem.maybeSpawnGhostChain), so a paused
   * clock resuming is always the player's own cue "you can move now",
   * exactly matching the brief: an empty road pauses the clock rather than
   * failing the player for it, and a busy one is never advantaged over an
   * empty one because REAL and GHOST candidates are checked identically
   * here — this function does not know or care which kind a candidate is.
   * Uses the same closed-form jump-reach derivation
   * (`crossingMaxHorizontalReach`) the ghost-chain solvability guarantee
   * itself is built from, not a guessed distance.
   */
  function isProgressReachable(): boolean {
    const originX = player.x;
    const originY = player.groundContactY;
    const candidates = crossing.platforms;
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]!;
      if (candidate === currentCrossingPlatform) continue;
      let horizontalDistance = 0;
      if (originX < candidate.left) horizontalDistance = candidate.left - originX;
      else if (originX > candidate.right) horizontalDistance = originX - candidate.right;
      const dropPx = candidate.top - originY;
      if (horizontalDistance <= crossingMaxHorizontalReach(canvasWidth, dropPx)) return true;
    }
    return false;
  }

  function applyLayout(width: number, height: number): void {
    canvasWidth = width;
    canvasHeight = height;
    app.renderer.resize(width, height);
    // Re-project every active block/platform against the NEW canvas size
    // right away (dt=0, so no timer advances) — otherwise they'd sit at a
    // stale pixel rect from before the resize/orientation-change until the
    // next running update() call ticks them forward.
    crossing.update(0, width, height, currentCrossingPlatform);
    motionCues.resize(width, height);
    if (status !== 'running') {
      app.render();
    }
  }

  /** Shared failure path: fall below the frame, edge-carry loss, or the
   * per-leg timer running out. The particle burst/shake/sounds/best-score
   * flow is identical regardless of which loss condition fired. */
  function handleCollision(): void {
    status = 'over';
    loop.stop();
    particles.spawnBurst(player.x, player.groundContactY - PLAYER_HEIGHT * 0.5);
    shakeTrauma = COLLISION_SHAKE_TRAUMA;
    callbacks.onSound('collide');
    callbacks.onSound('gameOver');

    const previousBest = preferences.getBestScore();
    const best = preferences.setBestScore(scoreInt);
    const isNewBest = scoreInt > previousBest;
    const result: GameOverResult = { score: scoreInt, best, isNewBest };
    callbacks.onGameOver(result);
  }

  /**
   * The whole per-frame step. SURFACE RESOLUTION: among every landing
   * candidate (both anchor blocks, every active real/ghost platform) whose
   * horizontal span covers the player's x within a generous landing-assist
   * box, and whose top the player's PREVIOUS foot position was already at
   * or above, pick the highest (smallest-Y) qualifying top — but only while
   * the player isn't currently rising, so an ascending jump can never get
   * caught on a platform's underside. That pair of checks gives one-way
   * behaviour for free: rising through a platform's box never qualifies and
   * passes straight through; falling back down through the same box does
   * qualify and lands on it.
   *
   * The landing-assist box's own size is NOT a fixed constant — it shrinks
   * with `crossing.crossingsCompleted` (see CROSSING_LANDING_ASSIST_*_EASY/
   * HARD in config.ts), which is the "narrower landing tolerance" half of
   * the difficulty escalation; the ghost-chain's own hop precision (see
   * CrossingSystem.maybeSpawnGhostChain) is the other half, ramped on the
   * same CROSSING_DIFFICULTY_RAMP_CROSSINGS schedule so it reads as one
   * coherent curve.
   */
  function update(dt: number): void {
    if (status !== 'running') return;

    if (hitStopTimer > 0) {
      // Physics/scoring frozen, but the loop keeps rendering — a few frames
      // of stillness right on a perfect landing or a goal arrival reads as
      // "impact", not lag, because it's short and the world visibly holds.
      hitStopTimer = Math.max(0, hitStopTimer - dt);
      app.render();
      return;
    }

    inputSystem.updateCrossingAim();
    motionCues.update(dt, motionState);

    // Gyro stabilisation: a single hand-rolled first-order high-pass
    // (leaky-integrator) filter on rotation rate — `offset' = rate*GAIN -
    // offset*LEAK`. Fast, sign-reversing hand tremor survives the leak and
    // produces a real corrective nudge; a slow, sustained rotation (a
    // genuine vehicle turn) drains out of the SAME leak roughly as fast as
    // it accumulates, so it can only ever reach a small, hard-clamped
    // steady-state term — never one that grows to fight real motion. See
    // GYRO_STABILIZATION_* in config.ts for the measured bound. Always
    // computed (decaying toward 0 when motion is unavailable), applied only
    // to REAL tracked platforms inside crossing.update() below.
    const rotationAlpha = motionState !== null && motionState.available ? motionState.rotationAlpha : 0;
    const rotationBeta = motionState !== null && motionState.available ? motionState.rotationBeta : 0;
    const gyroLeak = Math.exp(-GYRO_STABILIZATION_LEAK_RATE * dt);
    gyroOffsetX = clamp((gyroOffsetX + rotationAlpha * GYRO_STABILIZATION_GAIN_PX_PER_DEG * dt) * gyroLeak, -GYRO_STABILIZATION_MAX_OFFSET_PX, GYRO_STABILIZATION_MAX_OFFSET_PX);
    gyroOffsetY = clamp((gyroOffsetY + rotationBeta * GYRO_STABILIZATION_GAIN_PX_PER_DEG * dt) * gyroLeak, -GYRO_STABILIZATION_MAX_OFFSET_PX, GYRO_STABILIZATION_MAX_OFFSET_PX);

    // Positions (blocks/real-track glide/ghost drift/ghost-chain fallback,
    // and the live horizon-driven road height) are settled BEFORE resolution
    // reads them below, so the resolution loop always sees this frame's
    // fresh boxes, not last frame's. `currentCrossingPlatform` here is still
    // last frame's resolved surface, which is exactly the "occupied as of
    // now" moment the never-vanish-underfoot freeze (and the horizon hint's
    // own "never move the blocks mid-jump" rule) need.
    crossing.update(dt, canvasWidth, canvasHeight, currentCrossingPlatform, gyroOffsetX, gyroOffsetY);

    const difficultyT = clamp(crossing.crossingsCompleted / CROSSING_DIFFICULTY_RAMP_CROSSINGS, 0, 1);
    const assistVerticalPx = lerp(CROSSING_LANDING_ASSIST_VERTICAL_PX_EASY, CROSSING_LANDING_ASSIST_VERTICAL_PX_HARD, difficultyT);
    const assistHorizontalPx = lerp(CROSSING_LANDING_ASSIST_HORIZONTAL_PX_EASY, CROSSING_LANDING_ASSIST_HORIZONTAL_PX_HARD, difficultyT);

    const prevFootY = player.groundContactY;
    const wasRising = player.verticalVelocity > 0;
    let selectedPlatform: Platform | null = null;
    if (!wasRising) {
      const candidates = crossing.platforms;
      for (let i = 0; i < candidates.length; i++) {
        const platform = candidates[i]!;
        if (player.x < platform.left - assistHorizontalPx || player.x > platform.right + assistHorizontalPx) continue;
        // Interpolate the ACTUAL surface height at the player's x (clamped
        // onto the platform's own span) rather than a flat top — see
        // Platform.surfaceYAt's doc. This is what lets the player land on a
        // bonnet and walk up onto a roof instead of everything reading as an
        // invisible flat slab.
        const surfaceAtX = platform.surfaceYAt(clamp(player.x, platform.left, platform.right));
        if (prevFootY > surfaceAtX + assistVerticalPx) continue;
        if (selectedPlatform === null || surfaceAtX < crossingSurfaceReferenceY) {
          selectedPlatform = platform;
          crossingSurfaceReferenceY = surfaceAtX;
        }
      }
    }
    if (selectedPlatform !== null) {
      // Ride every frame it stays selected, not just on identity change —
      // and RE-SAMPLED at the player's CURRENT x, not just re-read — so
      // standing on a gliding real/ghost platform tracks its motion smoothly
      // AND walking across a sloped surface follows the incline, both from
      // the same per-frame re-sample. The profile itself can only move a
      // `followT`-sized step per frame toward its latest tracked shape (see
      // Platform.updateVisual's doc), so this can never read as a shove.
      crossingSurfaceReferenceY = selectedPlatform.surfaceYAt(clamp(player.x, selectedPlatform.left, selectedPlatform.right));
    }
    if (selectedPlatform !== currentCrossingPlatform) {
      // Deliberately does NOT rebase onto anything when the NEW surface is
      // `null` — only a genuine new candidate ever moves the reference;
      // losing a candidate just freezes it.
      if (selectedPlatform !== null) {
        player.syncGroundReference(crossingSurfaceReferenceY);
      }
      currentCrossingPlatform = selectedPlatform;
    }

    // Horizontal ride-along: a platform can carry the player, not just
    // support them — required for "a vehicle carries the player off the
    // edge" to be physically possible at all. Computed from the SAME
    // platform's own delta since last frame, so walking freely on top of it
    // still works independently.
    if (selectedPlatform !== null) {
      const centerX = (selectedPlatform.left + selectedPlatform.right) / 2;
      if (crossingRideAlongPlatform === selectedPlatform) {
        player.driftX(centerX - crossingRideAlongCenterX);
      }
      crossingRideAlongPlatform = selectedPlatform;
      crossingRideAlongCenterX = centerX;
    } else {
      crossingRideAlongPlatform = null;
    }

    player.updateCrossing(dt, crossingSurfaceReferenceY, selectedPlatform !== null);

    if (player.justJumped) {
      particles.spawnDust(player.x, player.groundContactY);
      callbacks.onSound('jump');
      crossing.hideTrajectoryPreview();
    }

    if (player.justLanded) {
      particles.spawnDust(player.x, player.groundContactY);
      // Screen shake scales with how hard the player hit the ground — a
      // gentle hop barely shakes, a long fall from a missed jump shakes hard.
      const impactShake = Math.min(CROSSING_LANDING_SHAKE_TRAUMA_MAX, player.landingImpactSpeed * CROSSING_LANDING_SHAKE_TRAUMA_PER_PXPS);
      shakeTrauma = Math.min(1, shakeTrauma + impactShake);

      let isPerfect = false;
      if (selectedPlatform !== null) {
        // PERFECT precision escalates on the SAME difficultyT curve as the
        // landing-assist box and the ghost gap safety factor — see
        // CROSSING_PERFECT_LANDING_WIDTH_FRACTION_EASY/HARD's doc in
        // config.ts. Deliberately does not care whether `selectedPlatform`
        // is real or ghost — see the safety audit on
        // CROSSING_PERFECT_LANDING_COMBO_MAX_MULTIPLIER in config.ts.
        const perfectWidthFraction = lerp(CROSSING_PERFECT_LANDING_WIDTH_FRACTION_EASY, CROSSING_PERFECT_LANDING_WIDTH_FRACTION_HARD, difficultyT);
        const platformWidthPx = selectedPlatform.right - selectedPlatform.left;
        const centerX = (selectedPlatform.left + selectedPlatform.right) / 2;
        isPerfect = Math.abs(player.x - centerX) <= platformWidthPx * perfectWidthFraction;
      }

      if (isPerfect) {
        comboCount++;
        const multiplier = Math.min(CROSSING_PERFECT_LANDING_COMBO_MAX_MULTIPLIER, 1 + (comboCount - 1) * CROSSING_PERFECT_LANDING_COMBO_STEP);
        scoreAccumulator += CROSSING_PERFECT_LANDING_BONUS * multiplier;
        particles.spawnSparkle(player.x, player.groundContactY, CROSSING_PERFECT_LANDING_SPARKLE_COLOR);
        shakeTrauma = Math.min(1, shakeTrauma + CROSSING_PERFECT_LANDING_SHAKE_TRAUMA);
        hitStopTimer = CROSSING_HITSTOP_SECONDS;
        callbacks.onSound('dash'); // repurposed: perfect-landing chime, see types.ts's SoundName doc
      } else {
        comboCount = 0;
        callbacks.onSound('land');
      }
    }

    // --- Win: grounded on the currently-designated goal block. ---
    if (selectedPlatform !== null && player.isGrounded && crossing.isGoal(selectedPlatform)) {
      handleCrossingWin();
      app.render();
      return;
    }

    // --- Timer: the clock only runs while progress is genuinely reachable
    // (see isProgressReachable's doc above) — punishes dithering, never the
    // road. A paused clock is a real, visible state (CrossingSystem draws it
    // distinctly), not a silent freeze, so it never reads as a bug. ---
    timerPaused = !isProgressReachable();
    if (!timerPaused) {
      legTimeRemaining = Math.max(0, legTimeRemaining - dt);
      if (legTimeRemaining <= 0) {
        handleCollision();
        return;
      }
    }

    // --- Lose #1: fell below the visible frame. ---
    if (player.top > canvasHeight + CROSSING_FALL_MARGIN_PX) {
      handleCollision();
      return;
    }

    // --- Lose #2: carried (or walked) out of the horizontal frame while
    // grounded — telegraphed via a reddening body tint for
    // CROSSING_EDGE_WARNING_SECONDS before it actually ends the run.
    const outsideFrame = player.x < -CROSSING_EDGE_MARGIN_PX || player.x > canvasWidth + CROSSING_EDGE_MARGIN_PX;
    if (player.isGrounded && outsideFrame) {
      crossingEdgeWarningTimer += dt;
      player.setEdgeWarningIntensity(clamp(crossingEdgeWarningTimer / CROSSING_EDGE_WARNING_SECONDS, 0, 1));
      if (crossingEdgeWarningTimer >= CROSSING_EDGE_WARNING_SECONDS) {
        handleCollision();
        return;
      }
    } else if (crossingEdgeWarningTimer > 0) {
      crossingEdgeWarningTimer = 0;
      player.setEdgeWarningIntensity(0);
    }

    // --- Score: survival + any horizontal movement (walking OR being
    // carried both count — this is a "keep moving" incentive, not a
    // direction-specific one). ---
    scoreAccumulator += CROSSING_SCORE_PER_SECOND * dt + Math.abs(player.x - crossingLastPlayerX) * CROSSING_SCORE_PER_PIXEL_PROGRESS;
    crossingLastPlayerX = player.x;
    const newScoreInt = Math.floor(scoreAccumulator);
    if (newScoreInt !== scoreInt) {
      scoreInt = newScoreInt;
      callbacks.onScoreChange(scoreInt);
    }

    if (shakeTrauma > 0) {
      shakeTrauma = Math.max(0, shakeTrauma - SHAKE_DECAY_RATE * dt);
      const magnitude = shakeTrauma * shakeTrauma * SHAKE_MAGNITUDE_PX;
      worldContainer.x = (Math.random() * 2 - 1) * magnitude;
      worldContainer.y = (Math.random() * 2 - 1) * magnitude;
    } else if (worldContainer.x !== 0 || worldContainer.y !== 0) {
      worldContainer.x = 0;
      worldContainer.y = 0;
    }

    crossing.updateHud(dt, canvasWidth, comboCount, legTimeBudget > 0 ? legTimeRemaining / legTimeBudget : 0, timerPaused);

    if (debugText !== null) {
      debugAccumulator += dt;
      if (debugAccumulator >= DEBUG_TEXT_UPDATE_INTERVAL_SECONDS) {
        debugAccumulator = 0;
        const fps = dt > 0 ? 1 / dt : 0;
        debugText.text =
          `fps ${fps.toFixed(0)}  score ${scoreInt}  crossings ${crossing.crossingsCompleted}` +
          `  platforms ${crossing.platforms.length}` +
          `  combo ${comboCount}`;
      }
    }

    app.render();
  }

  /**
   * Reaching the goal block: score it — identically whether the leg was
   * crossed on real tracks, ghost platforms, or a mix; see the safety audit
   * on CROSSING_PERFECT_LANDING_COMBO_MAX_MULTIPLIER in config.ts for why
   * there is deliberately no bonus keyed on "avoided the ghosts" — celebrate
   * with a heavier particle/sound/shake beat than an ordinary landing, swap
   * which block is start vs. goal, re-anchor the player standing exactly on
   * the block they just reached so the return leg begins cleanly, and roll
   * the next leg's (harder, both in timer budget and in leg span) numbers.
   * Endless — never ends the run.
   */
  function handleCrossingWin(): void {
    crossing.completeCrossing();
    // completeCrossing() just changed `crossings`, which also moves the
    // spatial-difficulty leg span (see CrossingSystem.leftBlockXFraction's
    // doc) — settle block positions against that NEW span (dt=0, no timers
    // advance) before reading `crossing.startBlock` below, or this would
    // read the stale pre-win position for one frame.
    crossing.update(0, canvasWidth, canvasHeight, null);

    scoreAccumulator += CROSSING_SCORE_BONUS_PER_CROSSING;
    particles.spawnRing(player.x, player.groundContactY);
    particles.spawnSparkle(player.x, player.groundContactY, CROSSING_GOAL_SPARKLE_COLOR);
    shakeTrauma = Math.min(1, shakeTrauma + CROSSING_GOAL_SHAKE_TRAUMA);
    hitStopTimer = Math.max(hitStopTimer, CROSSING_HITSTOP_SECONDS);
    callbacks.onSound('score');
    callbacks.onSound('slam'); // repurposed: a heavy goal-arrival thud, see types.ts's SoundName doc

    const newStart = crossing.startBlock;
    const newStartTopY = newStart.top;
    const newStartCenterX = (newStart.left + newStart.right) / 2;
    const facingRight = crossing.direction === 1;
    player.resetForCrossing(newStartCenterX, newStartTopY, facingRight);
    currentCrossingPlatform = newStart;
    crossingSurfaceReferenceY = newStartTopY;
    crossingRideAlongPlatform = null;
    crossingEdgeWarningTimer = 0;
    crossingLastPlayerX = newStartCenterX;

    legTimeBudget = crossingLegTimeSeconds(canvasWidth, crossing.crossingsCompleted);
    legTimeRemaining = legTimeBudget;
    timerPaused = false;

    const newScoreInt = Math.floor(scoreAccumulator);
    if (newScoreInt !== scoreInt) {
      scoreInt = newScoreInt;
      callbacks.onScoreChange(scoreInt);
    }
  }

  /** Shared by start()/reset(): drops every crossing entity/timer back to a
   * fresh attempt standing on the LEFT block, facing right. Does not touch
   * `status` or the render loop — callers decide those. */
  function resetCrossingEntities(): void {
    particles.reset();
    crossing.reset();
    // Settle the anchor blocks' pixel positions against the live canvas
    // size immediately (dt=0) — same "layout, then a zero-dt settle pass"
    // applyLayout already uses.
    crossing.update(0, canvasWidth, canvasHeight, null);
    const start = crossing.startBlock;
    const startCenterX = (start.left + start.right) / 2;
    player.resetForCrossing(startCenterX, start.top, true);
    currentCrossingPlatform = start;
    crossingSurfaceReferenceY = start.top;
    crossingRideAlongPlatform = null;
    crossingEdgeWarningTimer = 0;
    crossingLastPlayerX = startCenterX;
    shakeTrauma = 0;
    hitStopTimer = 0;
    comboCount = 0;
    gyroOffsetX = 0;
    gyroOffsetY = 0;
    legTimeBudget = crossingLegTimeSeconds(canvasWidth, 0);
    legTimeRemaining = legTimeBudget;
    timerPaused = false;
    worldContainer.x = 0;
    worldContainer.y = 0;
    crossing.updateHud(0, canvasWidth, 0, 1, false);
  }

  const loop = new GameLoop(update);

  const inputSystem = new InputSystem({
    canvas: app.canvas,
    callbacks: {
      onCrossingWalk(direction: -1 | 0 | 1): void {
        if (status === 'running') {
          player.setWalkVelocity(direction * CROSSING_WALK_SPEED);
        }
      },
      onCrossingAimChange(dirX: number, dirY: number, power: number, overCancelZone: boolean): void {
        if (status !== 'running') return;
        const maxSpeed = crossingMaxJumpSpeed(canvasWidth);
        const velocity = computeCrossingJumpVelocity(dirX, dirY, power, maxSpeed);
        const previewDuration = crossingFullPowerFlightTimeSeconds(canvasWidth) * CROSSING_PREVIEW_DURATION_MARGIN;
        crossing.showTrajectoryPreview(player.x, player.groundContactY, velocity.vx, velocity.vy, canvasWidth, canvasHeight, previewDuration);
        // Cancel ring at the press point. `power` is the drag distance
        // normalised to the max, so the cancel radius maps to a fixed slice
        // of it — armed when releasing now would abort rather than jump.
        const cancelPower = CROSSING_AIM_CANCEL_RADIUS_PX / CROSSING_AIM_MAX_DRAG_PX;
        crossing.showCancelRing(
          player.x - dirX * power * CROSSING_AIM_MAX_DRAG_PX,
          player.groundContactY - dirY * power * CROSSING_AIM_MAX_DRAG_PX,
          power <= cancelPower,
        );
        // Second cancel affordance — the screen-edge banner. `overCancelZone`
        // is InputSystem's own check against the real pointer position; this
        // just forwards it to drive the highlight.
        crossing.showCancelZone(canvasWidth, overCancelZone);
      },
      onCrossingJumpRelease(dirX: number, dirY: number, power: number): void {
        crossing.hideTrajectoryPreview();
        if (status !== 'running') return;
        const maxSpeed = crossingMaxJumpSpeed(canvasWidth);
        const velocity = computeCrossingJumpVelocity(dirX, dirY, power, maxSpeed);
        player.requestDirectionalJump(velocity.vx, velocity.vy);
      },
      onCrossingAimCancel(): void {
        crossing.hideTrajectoryPreview();
      },
    },
  });

  applyLayout(initialWidth, initialHeight);
  resetCrossingEntities();
  app.render();

  const game: Game = {
    get status(): GameStatus {
      return status;
    },
    get score(): number {
      return scoreInt;
    },

    start(): void {
      scoreAccumulator = 0;
      scoreInt = 0;
      resetCrossingEntities();
      status = 'running';
      loop.start();
    },

    pause(): void {
      if (status !== 'running') return;
      status = 'paused';
      loop.stop();
    },

    resume(): void {
      if (status !== 'paused') return;
      status = 'running';
      loop.start();
    },

    reset(): void {
      loop.stop();
      status = 'idle';
      scoreAccumulator = 0;
      scoreInt = 0;
      resetCrossingEntities();
      app.render();
    },

    resize(width: number, height: number): void {
      applyLayout(width, height);
    },

    setHorizonHint(y: number | null, confidence: number): void {
      // A thin, allocation-free forward — see CrossingSystem.setHorizonHint's
      // doc for the gating (confidence floor, "never move the blocks under
      // the player mid-jump") this is repurposed for.
      crossing.setHorizonHint(y, confidence);
    },

    /**
     * Latest device motion — retains the reference (never copies fields),
     * which is safe and allocation-free because the caller's own MotionState
     * is a stable, reused object (see types.ts's doc on MotionSensor.state).
     * Drives the motion-comfort cues and the gyro-stabilisation leaky
     * integrator, both read from `motionState` inside update(). Safe to call
     * from any status — it only ever writes a variable.
     */
    setMotion(state: MotionState): void {
      motionState = state;
    },

    /** Whether to draw the motion-sickness comfort cues — see
     * MotionCueSystem.setEnabled, which itself defaults to true, so cues are
     * already on even if this is never called. */
    setMotionCuesEnabled(enabled: boolean): void {
      motionCues.setEnabled(enabled);
    },

    /**
     * Windscreen: real objects ahead, tracked across frames. Routed straight
     * to CrossingSystem, which turns `stable` ones into platforms the
     * player can land on. Gated on `status` only — nothing should spawn
     * while the loop isn't stepping. Reads `objects` synchronously only, per
     * the TrackedObject contract in types.ts; never retains the array or its
     * elements past this call.
     */
    onTrackedObjects(objects: readonly TrackedObject[]): void {
      if (status !== 'running') return;
      crossing.onTrackedObjects(objects);
    },

    destroy(): void {
      loop.stop();
      inputSystem.destroy();
      app.destroy(true, { children: true });
    },
  };

  // Dev-only test seam, same gating as the debugText FPS overlay above: the
  // vision layer (src/vision/**) is the only production caller of
  // setHorizonHint/onTrackedObjects, and it isn't wired up in every
  // environment this runs in (e.g. an automated harness with no camera).
  // Exposing the already-public Game handle on `window` behind the same
  // `?debug`/`#debug` flag lets such a harness *drive* the game directly —
  // it grants no capability beyond what the real Game contract already
  // exposes, and every assertion still has to come from rendered pixels or
  // this handle's own read-only state, not anything hidden.
  if (debug === true) {
    (window as unknown as { __glassyGame?: Game }).__glassyGame = game;
  }

  return game;
};
