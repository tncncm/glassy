/**
 * Game — orchestrates the whole gameplay layer: owns the Pixi Application,
 * wires GameLoop/Player/ObstacleSystem/ParticleSystem/InputSystem together,
 * and implements the `Game` contract from src/types.ts exactly.
 *
 * Rendering is driven entirely by GameLoop's own requestAnimationFrame chain
 * (the Application is built with `autoStart: false`); `update()` is the one
 * per-frame hot path in this whole layer and is written to allocate
 * nothing — no object/array literals, no closures, no `new`, no
 * Graphics/Text construction. Every entity/system it touches follows the
 * same rule (see their file headers).
 */

import { Application, Container, Graphics, Text } from 'pixi.js';
import type { CreateGame, Detection, Game, GameMode, GameOptions, GameOverResult, GameStatus, TrackedObject, VisionMode } from '../types.ts';
import {
  BASE_WORLD_SPEED,
  COLLECTIBLE_SCORE_BONUS,
  COLLISION_SHAKE_TRAUMA,
  CROSSING_EDGE_MARGIN_PX,
  CROSSING_EDGE_WARNING_SECONDS,
  CROSSING_FALL_MARGIN_PX,
  CROSSING_LANDING_ASSIST_HORIZONTAL_PX,
  CROSSING_LANDING_ASSIST_VERTICAL_PX,
  CROSSING_MIN_JUMP_VERTICAL_FRACTION,
  CROSSING_SCORE_BONUS_PER_CROSSING,
  CROSSING_SCORE_PER_PIXEL_PROGRESS,
  CROSSING_SCORE_PER_SECOND,
  CROSSING_WALK_SPEED,
  DASH_THROUGH_BONUS_SCORE,
  DASH_THROUGH_SHAKE_TRAUMA,
  DEBUG_TEXT_COLOR,
  DEBUG_TEXT_SIZE,
  DEBUG_TEXT_UPDATE_INTERVAL_SECONDS,
  DETECTION_KIND_COOLDOWN_SECONDS,
  DETECTION_MIN_SCORE,
  GROUND_LERP_RATE,
  GROUND_LINE_ALPHA,
  GROUND_LINE_COLOR,
  GROUND_LINE_GLOW_ALPHA,
  GROUND_LINE_GLOW_THICKNESS,
  GROUND_LINE_THICKNESS,
  GROUND_SHADOW_ALPHA,
  GROUND_SHADOW_HEIGHT,
  GROUND_Y_DEFAULT_FRACTION,
  GROUND_Y_MAX_FRACTION,
  GROUND_Y_MIN_FRACTION,
  HORIZON_HINT_BIAS_RATE,
  HORIZON_HINT_LOCKOUT_SECONDS,
  HORIZON_HINT_MIN_CONFIDENCE,
  MAX_WORLD_SPEED,
  PICKUP_COLLECTIBLE_COLOR,
  PICKUP_POWERUP_COLOR,
  PLATFORM_LANDING_MARGIN_PX,
  PLATFORM_LANDING_SCORE_BONUS,
  PLATFORM_ONE_WAY_TOLERANCE_PX,
  PLAYER_HEIGHT,
  PLAYER_X_FRACTION,
  POWERUP_SCORE_BONUS,
  SCORE_MILESTONE_STEP,
  SCORE_PER_SECOND_AT_BASE_SPEED,
  SHAKE_DECAY_RATE,
  SHAKE_MAGNITUDE_PX,
  SLAM_SHAKE_TRAUMA,
  SPEED_RAMP_SCORE_CONSTANT,
} from './config.ts';
import { Player } from './entities/Player.ts';
import type { Platform } from './entities/Platform.ts';
import { GameLoop } from './GameLoop.ts';
import { CrossingSystem } from './systems/CrossingSystem.ts';
import { InputSystem } from './systems/InputSystem.ts';
import { ObstacleSystem } from './systems/ObstacleSystem.ts';
import { ParticleSystem } from './systems/ParticleSystem.ts';
import { PickupSystem } from './systems/PickupSystem.ts';
import { PlatformSystem } from './systems/PlatformSystem.ts';
import { aabbOverlap, clamp, expDecay, lerp } from './util/math.ts';
import { crossingMaxJumpSpeed } from './util/solvability.ts';

/**
 * Scratch object reused by computeCrossingJumpVelocity, below — never
 * reallocated, so the per-frame keyboard-charge poll
 * (InputSystem.updateCrossingAim → onCrossingAimChange) allocates nothing.
 * Safe because every caller reads it synchronously, immediately after the
 * call — the same "reused, read synchronously" contract every pooled system
 * in this codebase already follows for its own active/reused arrays.
 */
const crossingJumpVelocityScratch = { vx: 0, vy: 0 };

/**
 * Converts a raw screen-space aim vector (y-down, arbitrary magnitude) plus
 * a 0..1 power into a launch velocity in the up-positive convention
 * Player/util/solvability.ts use. Enforces
 * CROSSING_MIN_JUMP_VERTICAL_FRACTION so every jump has real liftoff — see
 * that constant's doc in config.ts for why that also matters for
 * landing-assist correctness, not just game feel.
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

/** Off-screen margin used to size the ground-line rects so they always
 * cover the canvas even mid-resize, without needing a per-frame redraw. */
const GROUND_LINE_OVERDRAW_PX = 100;

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
  // real pointerdown/move/up: tap-to-jump and drag-to-move-platform would
  // be completely dead in production. The canvas re-enables it on itself.
  app.canvas.style.pointerEvents = 'auto';
  container.appendChild(app.canvas);

  // --- Scene graph -----------------------------------------------------
  const worldContainer = new Container();
  app.stage.addChild(worldContainer);

  const groundGraphics = new Graphics();
  const platformLayer = new Container();
  const crossingLayer = new Container();
  const obstacleLayer = new Container();
  const pickupLayer = new Container();
  const particleLayer = new Container();
  const player = new Player();
  // platformLayer sits above the ground line but below obstacles/player, so
  // a windscreen platform reads as part of the "ground" the player can
  // stand on rather than something floating in front of the action.
  // crossingLayer sits right beside it for the same reason — it's the
  // 'crossing'-mode equivalent (see CrossingSystem) and the two are never
  // both visible at once (see setGameMode below).
  worldContainer.addChild(groundGraphics, platformLayer, crossingLayer, obstacleLayer, pickupLayer, player.view, particleLayer);

  const obstacles = new ObstacleSystem(obstacleLayer);
  const pickups = new PickupSystem(pickupLayer);
  const particles = new ParticleSystem(particleLayer);
  const platforms = new PlatformSystem(platformLayer);
  const crossing = new CrossingSystem(crossingLayer);

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
  // Defaults to 'window', matching Preferences.getVisionMode()'s own default
  // (types.ts) — 'window' is exactly today's already-validated-as-fun
  // behaviour, so onTrackedObjects is a no-op until App explicitly opts in.
  let visionMode: VisionMode = 'window';
  let canvasWidth = initialWidth;
  let canvasHeight = initialHeight;
  let groundYTargetFraction = GROUND_Y_DEFAULT_FRACTION;
  let groundY = groundYTargetFraction * canvasHeight;
  let scoreAccumulator = 0;
  let scoreInt = 0;
  let shakeTrauma = 0;
  let debugAccumulator = 0;
  // Which platform (if any) the player's `groundY` reference currently
  // tracks — see the one-way surface-resolution block in update() and
  // Player.syncGroundReference's doc. `null` means "the real ground line".
  let currentSurfacePlatform: Platform | null = null;

  // --- Crossing-mode-only state (see updateCrossing/setGameMode below).
  // 'runner' mode never reads any of these — see the isolation argument in
  // this file's setGameMode doc. ---
  let gameMode: GameMode = 'runner';
  /** Which platform (real/ghost/anchor block) the player currently stands
   * on, crossing-mode's equivalent of `currentSurfacePlatform` — kept as a
   * SEPARATE variable rather than reused, precisely so a mode switch can
   * never accidentally carry a stale reference from one mode's resolution
   * logic into the other's. */
  let currentCrossingPlatform: Platform | null = null;
  /** The height-reference `player.updateCrossing(dt, surfaceY)` integrates
   * against — see the doc above updateCrossing() below for why this is
   * "live while grounded/selected, frozen while genuinely airborne with no
   * candidate" rather than always resolving to some universal fallback the
   * way the runner's real ground line does. */
  let crossingSurfaceReferenceY = 0;
  /** For the horizontal "ride along with the platform" effect (see
   * updateCrossing) — the standing platform's own center X the LAST frame it
   * was observed, so this frame's delta can be applied to the player. Reset
   * to `null` whenever the standing platform changes identity. */
  let crossingRideAlongPlatform: Platform | null = null;
  let crossingRideAlongCenterX = 0;
  /** Seconds the player has been grounded and outside the visible frame's
   * horizontal bounds — the edge-carry-off-frame loss telegraph (see
   * CROSSING_EDGE_WARNING_SECONDS in config.ts). */
  let crossingEdgeWarningTimer = 0;
  /** player.x as of the end of the previous updateCrossing() call — the
   * baseline the distance-progress score term measures against. */
  let crossingLastPlayerX = 0;

  // --- Horizon hint state (see setHorizonHint on the returned Game) --------
  /** Latest estimate from setHorizonHint; null = no usable estimate. */
  let horizonHintFraction: number | null = null;
  let horizonHintConfidence = 0;
  /** Counts down after any manual ground-line change; the hint is ignored
   * entirely while positive — the player's own placement always wins. */
  let horizonLockoutTimer = 0;

  // --- Scene detection state (see onSceneDetections on the returned Game
  // below) — one independent debounce timer per DetectedKind, so a truck
  // sitting in frame doesn't re-request a hazard every ~3Hz sample. Reset
  // to 0 on every fresh run so detections are immediately available again.
  let vehicleDetectionCooldown = 0;
  let personDetectionCooldown = 0;
  let signDetectionCooldown = 0;

  function groundTargetPx(): number {
    return groundYTargetFraction * canvasHeight;
  }

  function redrawGround(width: number): void {
    const left = -GROUND_LINE_OVERDRAW_PX;
    const spanWidth = width + GROUND_LINE_OVERDRAW_PX * 2;
    groundGraphics.clear();
    groundGraphics
      .rect(left, 0, spanWidth, GROUND_SHADOW_HEIGHT)
      .fill({ color: 0x000000, alpha: GROUND_SHADOW_ALPHA })
      .rect(left, -GROUND_LINE_GLOW_THICKNESS / 2, spanWidth, GROUND_LINE_GLOW_THICKNESS)
      .fill({ color: GROUND_LINE_COLOR, alpha: GROUND_LINE_GLOW_ALPHA })
      .rect(left, -GROUND_LINE_THICKNESS / 2, spanWidth, GROUND_LINE_THICKNESS)
      .fill({ color: GROUND_LINE_COLOR, alpha: GROUND_LINE_ALPHA });
  }

  function applyLayout(width: number, height: number): void {
    canvasWidth = width;
    canvasHeight = height;
    app.renderer.resize(width, height);
    if (gameMode === 'runner') {
      player.setX(width * PLAYER_X_FRACTION);
    }
    redrawGround(width);
    groundY = groundTargetPx();
    groundGraphics.y = groundY;
    // Re-project every active platform's box against the NEW canvas size
    // right away (dt=0, so no timer advances) — otherwise a platform would
    // sit at a stale pixel rect from before the resize/orientation-change
    // until the next running update() call ticks it forward. Same idea for
    // crossing mode's own anchor blocks/platforms below.
    platforms.update(0, width, height, groundY);
    if (gameMode === 'crossing') {
      crossing.update(0, width, height, currentCrossingPlatform);
    }
    if (status !== 'running') {
      // Keep the idle/paused/game-over frame visually in sync with the new
      // size instead of waiting for a step that will never come.
      if (status === 'idle' && gameMode === 'runner') {
        player.resetToIdle(groundY);
      }
      app.render();
    }
  }

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

  function update(dt: number): void {
    if (status !== 'running') return;
    // 'crossing' is an entirely separate physics/world model — see
    // updateCrossing()'s doc below. Branching here, before a single line of
    // the runner body executes, is what makes 'runner' mode provably
    // byte-for-byte unchanged: every statement from here to this function's
    // closing brace is EXACTLY what shipped before 'crossing' existed, and
    // none of it runs unless gameMode === 'runner'.
    if (gameMode !== 'runner') {
      updateCrossing(dt);
      return;
    }

    // --- Horizon hint: locked out for a while after any manual drag, and
    // even when accepted only ever nudges the TARGET a small fraction of
    // the way per second — GROUND_LERP_RATE below still owns the visual
    // line's own chase of that target, so this can never read as a snap.
    if (horizonLockoutTimer > 0) {
      horizonLockoutTimer = Math.max(0, horizonLockoutTimer - dt);
    } else if (horizonHintFraction !== null && horizonHintConfidence >= HORIZON_HINT_MIN_CONFIDENCE) {
      const clampedHint = clamp(horizonHintFraction, GROUND_Y_MIN_FRACTION, GROUND_Y_MAX_FRACTION);
      groundYTargetFraction = lerp(groundYTargetFraction, clampedHint, expDecay(HORIZON_HINT_BIAS_RATE, dt));
    }

    groundY = lerp(groundY, groundTargetPx(), expDecay(GROUND_LERP_RATE, dt));
    groundGraphics.y = groundY;

    // --- Windscreen platforms: glide/expire every frame regardless of
    // visionMode. In 'window' mode (or with nothing currently tracked)
    // `platforms.activePlatforms` is always empty, so the resolution loop
    // below leaves effectiveGroundY === groundY untouched and player.update
    // receives EXACTLY what it always has — that's what keeps 'window' mode
    // byte-for-byte unchanged rather than needing an if/else fork here.
    platforms.update(dt, canvasWidth, canvasHeight, groundY);

    // One-way ("land from above only") surface resolution: among every
    // active platform whose horizontal span covers the player's fixed x,
    // and whose top the player's PREVIOUS foot position was already at or
    // above (within PLATFORM_ONE_WAY_TOLERANCE_PX), pick the highest
    // (smallest-Y) qualifying top; otherwise fall back to the real ground
    // line. Candidacy additionally requires the player is NOT currently
    // rising (verticalVelocity <= 0) — without that, an ascending jump could
    // get caught on a platform's underside mid-flight, which is exactly the
    // "blocked from below" behaviour one-way platforms must never have. That
    // pair of checks is what gives BOTH one-way behaviours for free: a
    // player rising up through a platform's box never qualifies and passes
    // straight through, while the same player falling back down through the
    // exact same box does qualify and lands on it. It's also what makes a
    // platform spawning at/under a standing player harmless — a GROUNDED
    // player has verticalVelocity === 0 (passes the guard), but can only be
    // claimed by a platform whose top is essentially where their feet
    // already are (see PLATFORM_ONE_WAY_TOLERANCE_PX's comment) — one
    // meaningfully above their current feet is simply not selected.
    //
    // This is the ONLY thing that changes what "groundY" means to
    // Player.update() below — Player itself needs no platform-awareness
    // beyond the one-off continuity rebase right below. It just lands on
    // whatever surface Y it's handed each frame, exactly as it already does
    // for the draggable ground line.
    const prevFootY = player.groundContactY;
    let selectedPlatform: Platform | null = null;
    let effectiveGroundY = groundY;
    if (player.verticalVelocity <= 0) {
      const activePlatforms = platforms.activePlatforms;
      for (let i = 0; i < activePlatforms.length; i++) {
        const platform = activePlatforms[i]!;
        if (player.x < platform.left - PLATFORM_LANDING_MARGIN_PX || player.x > platform.right + PLATFORM_LANDING_MARGIN_PX) continue;
        if (prevFootY > platform.top + PLATFORM_ONE_WAY_TOLERANCE_PX) continue;
        if (selectedPlatform === null || platform.top < effectiveGroundY) {
          selectedPlatform = platform;
          effectiveGroundY = platform.top;
        }
      }
    }
    // Rebase airborneHeight ONLY on a genuine surface-IDENTITY switch
    // (ground→platform landing, platform→ground detachment/expiry,
    // platform→platform) — never for the ordinary case of the SAME surface
    // continuing to move smoothly (the ground line's own drag/horizon-hint
    // lerp, or a platform's own follow-glide), which must keep working
    // exactly as it already does. Gating on identity is also what makes
    // 'window' mode provably untouched: with zero platforms ever active,
    // `selectedPlatform` and `currentSurfacePlatform` are permanently both
    // null, this branch never runs, and player.update() below receives
    // exactly `groundY` — byte-for-byte the pre-existing call. See
    // Player.syncGroundReference's doc for why this rebase can never itself
    // introduce a pop, no matter how far apart the two surfaces are.
    if (selectedPlatform !== currentSurfacePlatform) {
      player.syncGroundReference(effectiveGroundY);
      currentSurfacePlatform = selectedPlatform;
    }
    const wasOnPlatformThisFrame = selectedPlatform !== null;

    const baseWorldSpeed =
      BASE_WORLD_SPEED + (MAX_WORLD_SPEED - BASE_WORLD_SPEED) * (1 - Math.exp(-scoreInt / SPEED_RAMP_SCORE_CONSTANT));
    const speedRatio = baseWorldSpeed / BASE_WORLD_SPEED;

    player.update(dt, effectiveGroundY, speedRatio);
    if (player.justJumped || player.justDoubleJumped) {
      particles.spawnDust(player.x, player.groundContactY);
      callbacks.onSound('jump');
    }
    if (player.justDashed) {
      callbacks.onSound('dash');
    }
    if (player.justSlamLanded) {
      // Slam landing supersedes the ordinary landing dust/sound below —
      // justLanded is also true this same frame, but the shockwave is the
      // more specific, more impactful event.
      particles.spawnRing(player.x, player.groundContactY);
      shakeTrauma = Math.min(1, shakeTrauma + SLAM_SHAKE_TRAUMA);
      callbacks.onSound('slam');
    } else if (player.justLanded) {
      particles.spawnDust(player.x, player.groundContactY);
      callbacks.onSound('land');
    }
    // Modest bonus for landing on a real vehicle specifically — covers both
    // an ordinary landing and a slam-landing onto one (Player.justLanded is
    // true in both cases; see its doc comment).
    if (player.justLanded && wasOnPlatformThisFrame) {
      scoreAccumulator += PLATFORM_LANDING_SCORE_BONUS;
    }

    // Dash boosts the world's scroll speed only (obstacles, not scoring —
    // score keeps accruing off the base ramp so dash isn't a passive score
    // farm; the only score effect of dashing is the explicit bonus below).
    const effectiveWorldSpeed = baseWorldSpeed * player.dashSpeedMultiplier;
    obstacles.update(dt, effectiveWorldSpeed, canvasWidth, groundY);
    pickups.update(dt, effectiveWorldSpeed, canvasWidth, groundY);
    particles.update(dt);

    // Per-kind scene-detection debounce timers — see onSceneDetections.
    if (vehicleDetectionCooldown > 0) vehicleDetectionCooldown = Math.max(0, vehicleDetectionCooldown - dt);
    if (personDetectionCooldown > 0) personDetectionCooldown = Math.max(0, personDetectionCooldown - dt);
    if (signDetectionCooldown > 0) signDetectionCooldown = Math.max(0, signDetectionCooldown - dt);

    // Pickups REWARD rather than kill — checked independently of the hazard
    // collision pass below (and regardless of dash invulnerability, which
    // has nothing to do with picking something up). Iterated backward
    // because pickups.remove() swap-pops the active array.
    const activePickups = pickups.activePickups;
    for (let i = activePickups.length - 1; i >= 0; i--) {
      const pickup = activePickups[i]!;
      if (
        aabbOverlap(player.left, player.top, player.right, player.bottom, pickup.left, pickup.top, pickup.right, pickup.bottom)
      ) {
        if (pickup.shape === 'collectible') {
          scoreAccumulator += COLLECTIBLE_SCORE_BONUS;
          particles.spawnSparkle(pickup.x, pickup.y, PICKUP_COLLECTIBLE_COLOR);
          callbacks.onSound('score');
        } else {
          player.grantDashRecharge();
          scoreAccumulator += POWERUP_SCORE_BONUS;
          particles.spawnSparkle(pickup.x, pickup.y, PICKUP_POWERUP_COLOR);
          callbacks.onSound('dash');
        }
        pickups.remove(i);
      }
    }

    const active = obstacles.activeObstacles;
    let collided = false;
    if (player.isInvulnerable) {
      // No collision at all during the dash invulnerability window — instead,
      // award the dash-through bonus once per obstacle actually passed
      // through (not once per frame of overlap).
      for (let i = 0; i < active.length; i++) {
        const obstacle = active[i]!;
        if (
          !obstacle.dashBonusAwarded &&
          aabbOverlap(
            player.left,
            player.top,
            player.right,
            player.bottom,
            obstacle.x,
            obstacle.top,
            obstacle.x + obstacle.width,
            obstacle.top + obstacle.height,
          )
        ) {
          obstacle.dashBonusAwarded = true;
          scoreAccumulator += DASH_THROUGH_BONUS_SCORE;
          particles.spawnBurst(obstacle.x + obstacle.width * 0.5, obstacle.top + obstacle.height * 0.5);
          shakeTrauma = Math.min(1, shakeTrauma + DASH_THROUGH_SHAKE_TRAUMA);
          callbacks.onSound('score');
        }
      }
    } else {
      for (let i = 0; i < active.length; i++) {
        const obstacle = active[i]!;
        if (
          aabbOverlap(
            player.left,
            player.top,
            player.right,
            player.bottom,
            obstacle.x,
            obstacle.top,
            obstacle.x + obstacle.width,
            obstacle.top + obstacle.height,
          )
        ) {
          collided = true;
          break;
        }
      }
    }

    if (collided) {
      handleCollision();
    } else {
      scoreAccumulator += SCORE_PER_SECOND_AT_BASE_SPEED * speedRatio * dt;
      const newScoreInt = Math.floor(scoreAccumulator);
      if (newScoreInt !== scoreInt) {
        const crossedMilestone = Math.floor(newScoreInt / SCORE_MILESTONE_STEP) > Math.floor(scoreInt / SCORE_MILESTONE_STEP);
        scoreInt = newScoreInt;
        callbacks.onScoreChange(scoreInt);
        if (crossedMilestone) callbacks.onSound('score');
      }
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

    if (debugText !== null) {
      debugAccumulator += dt;
      if (debugAccumulator >= DEBUG_TEXT_UPDATE_INTERVAL_SECONDS) {
        debugAccumulator = 0;
        const fps = dt > 0 ? 1 / dt : 0;
        debugText.text =
          `fps ${fps.toFixed(0)}  score ${scoreInt}  speed ${effectiveWorldSpeed.toFixed(0)}` +
          `  obstacles ${active.length}  pickups ${activePickups.length}  ground ${groundY.toFixed(0)}` +
          `  mode ${visionMode}  platforms ${platforms.activePlatforms.length}`;
      }
    }

    app.render();
  }

  /**
   * 'crossing' mode's entire per-frame step — the counterpart to the runner
   * body above, sharing only the Player rig, the pooled particle/audio
   * systems, and `handleCollision()` (reused as-is for the fall/edge-carry
   * loss: its body already only reads player.x/groundContactY/scoreInt and
   * fires the generic particles/shake/sounds/best-score/callback, none of
   * which is runner-specific).
   *
   * SURFACE RESOLUTION mirrors the runner's one-way platform rule above
   * (same "only while not rising, pick the highest qualifying candidate"
   * shape) but widened into a genuine landing-assist magnet
   * (CROSSING_LANDING_ASSIST_VERTICAL_PX/HORIZONTAL_PX, generous by design —
   * see those constants' doc) and, critically, with NO real-ground-line
   * fallback: when nothing qualifies, `crossingSurfaceReferenceY` is left
   * exactly where it was rather than snapping to some universal floor that
   * doesn't exist in this mode, so free-fall physics stay perfectly
   * continuous whether that's mid-jump-arc or genuinely falling with
   * nothing below.
   */
  function updateCrossing(dt: number): void {
    inputSystem.updateCrossingAim();

    // Positions (blocks/real-track glide/ghost drift/ghost-chain fallback)
    // are settled BEFORE resolution reads them below — same ordering as the
    // runner's own `platforms.update()` → one-way-resolution sequence above,
    // so the resolution loop always sees this frame's fresh boxes, not last
    // frame's. `currentCrossingPlatform` here is still last frame's
    // resolved surface, which is exactly the "occupied as of now" moment the
    // never-vanish-underfoot freeze needs.
    crossing.update(dt, canvasWidth, canvasHeight, currentCrossingPlatform);

    const prevFootY = player.groundContactY;
    const wasRising = player.verticalVelocity > 0;
    let selectedPlatform: Platform | null = null;
    if (!wasRising) {
      const candidates = crossing.platforms;
      for (let i = 0; i < candidates.length; i++) {
        const platform = candidates[i]!;
        if (player.x < platform.left - CROSSING_LANDING_ASSIST_HORIZONTAL_PX || player.x > platform.right + CROSSING_LANDING_ASSIST_HORIZONTAL_PX) continue;
        if (prevFootY > platform.top + CROSSING_LANDING_ASSIST_VERTICAL_PX) continue;
        if (selectedPlatform === null || platform.top < crossingSurfaceReferenceY) {
          selectedPlatform = platform;
          crossingSurfaceReferenceY = platform.top;
        }
      }
    }
    if (selectedPlatform !== null) {
      // Ride every frame it stays selected, not just on identity change —
      // this is what makes standing on a gliding real/ghost platform track
      // its motion smoothly instead of only snapping in on first contact.
      crossingSurfaceReferenceY = selectedPlatform.top;
    }
    if (selectedPlatform !== currentCrossingPlatform) {
      // Deliberately does NOT rebase onto anything when the NEW surface is
      // `null` (see this function's doc) — only a genuine new candidate
      // ever moves the reference; losing a candidate just freezes it.
      if (selectedPlatform !== null) {
        player.syncGroundReference(crossingSurfaceReferenceY);
      }
      currentCrossingPlatform = selectedPlatform;
    }

    // Horizontal ride-along: a platform can carry the player, not just
    // support them — required for "a vehicle carries the player off the
    // edge" to be physically possible at all (see the edge-carry check
    // below). Computed from the SAME platform's own delta since last frame,
    // so walking freely on top of it still works independently.
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
      callbacks.onSound('land');
    }

    // --- Win: grounded on the currently-designated goal block. ---
    if (selectedPlatform !== null && player.isGrounded && crossing.isGoal(selectedPlatform)) {
      handleCrossingWin();
      app.render();
      return;
    }

    // --- Lose #1: fell below the visible frame. ---
    if (player.top > canvasHeight + CROSSING_FALL_MARGIN_PX) {
      handleCollision();
      return;
    }

    // --- Lose #2: carried (or walked) out of the horizontal frame while
    // grounded — telegraphed via a reddening body tint for
    // CROSSING_EDGE_WARNING_SECONDS before it actually ends the run, per the
    // brief ("must be visibly telegraphed first").
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

    if (debugText !== null) {
      debugAccumulator += dt;
      if (debugAccumulator >= DEBUG_TEXT_UPDATE_INTERVAL_SECONDS) {
        debugAccumulator = 0;
        const fps = dt > 0 ? 1 / dt : 0;
        debugText.text =
          `fps ${fps.toFixed(0)}  score ${scoreInt}  crossings ${crossing.crossingsCompleted}` +
          `  platforms ${crossing.platforms.length}  mode crossing`;
      }
    }

    app.render();
  }

  /** Reaching the goal block: score it, celebrate briefly, swap which block
   * is start vs. goal (CrossingSystem.completeCrossing), and re-anchor the
   * player standing exactly on the block they just reached so the return
   * leg begins cleanly. Endless — never ends the run. */
  function handleCrossingWin(): void {
    crossing.completeCrossing();
    scoreAccumulator += CROSSING_SCORE_BONUS_PER_CROSSING;
    particles.spawnSparkle(player.x, player.groundContactY, PICKUP_COLLECTIBLE_COLOR);
    shakeTrauma = Math.min(1, shakeTrauma + DASH_THROUGH_SHAKE_TRAUMA);
    callbacks.onSound('score');

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

    const newScoreInt = Math.floor(scoreAccumulator);
    if (newScoreInt !== scoreInt) {
      scoreInt = newScoreInt;
      callbacks.onScoreChange(scoreInt);
    }
  }

  /** Shared by start()/reset() for 'crossing' mode: drops every crossing
   * entity/timer back to a fresh attempt standing on the LEFT block, facing
   * right. Does not touch `status` or the render loop — callers decide
   * those, same division of responsibility the runner's own inline reset
   * blocks already have. */
  function resetCrossingEntities(): void {
    particles.reset();
    crossing.reset();
    // Settle the anchor blocks' pixel positions against the live canvas
    // size immediately (dt=0) — same "layout, then a zero-dt settle pass"
    // Game.ts already uses for the runner's own platforms in applyLayout.
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
    worldContainer.x = 0;
    worldContainer.y = 0;
  }

  const loop = new GameLoop(update);

  const inputSystem = new InputSystem({
    canvas: app.canvas,
    getGroundTargetY: groundTargetPx,
    getIsAirborne: () => !player.isGrounded,
    callbacks: {
      onJump(): void {
        if (status === 'running') {
          player.requestJump();
        }
      },
      onDash(): void {
        if (status === 'running') {
          player.requestDash();
        }
      },
      onSlam(): void {
        if (status === 'running') {
          player.requestSlam();
        }
      },
      onGroundDragTo(targetY: number): void {
        groundYTargetFraction = clamp(targetY / canvasHeight, GROUND_Y_MIN_FRACTION, GROUND_Y_MAX_FRACTION);
        // The player's own placement always wins over the horizon hint —
        // lock the hint out for a while rather than let it immediately
        // start pulling the target back the instant this drag ends.
        horizonLockoutTimer = HORIZON_HINT_LOCKOUT_SECONDS;
      },
      onCrossingWalk(direction: -1 | 0 | 1): void {
        if (status === 'running' && gameMode === 'crossing') {
          player.setWalkVelocity(direction * CROSSING_WALK_SPEED);
        }
      },
      onCrossingAimChange(dirX: number, dirY: number, power: number): void {
        if (status !== 'running' || gameMode !== 'crossing') return;
        const maxSpeed = crossingMaxJumpSpeed(canvasWidth);
        const velocity = computeCrossingJumpVelocity(dirX, dirY, power, maxSpeed);
        crossing.showTrajectoryPreview(player.x, player.groundContactY, velocity.vx, velocity.vy, canvasWidth, canvasHeight);
      },
      onCrossingJumpRelease(dirX: number, dirY: number, power: number): void {
        crossing.hideTrajectoryPreview();
        if (status !== 'running' || gameMode !== 'crossing') return;
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
  player.resetToIdle(groundY);
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
      if (gameMode === 'runner') {
        groundY = groundTargetPx();
        player.resetToIdle(groundY);
        obstacles.reset();
        pickups.reset();
        particles.reset();
        platforms.reset();
        currentSurfacePlatform = null;
        shakeTrauma = 0;
        worldContainer.x = 0;
        worldContainer.y = 0;
        groundGraphics.y = groundY;
        vehicleDetectionCooldown = 0;
        personDetectionCooldown = 0;
        signDetectionCooldown = 0;
      } else {
        resetCrossingEntities();
      }
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
      if (gameMode === 'runner') {
        obstacles.reset();
        pickups.reset();
        particles.reset();
        platforms.reset();
        currentSurfacePlatform = null;
        shakeTrauma = 0;
        worldContainer.x = 0;
        worldContainer.y = 0;
        groundY = groundTargetPx();
        groundGraphics.y = groundY;
        player.resetToIdle(groundY);
        vehicleDetectionCooldown = 0;
        personDetectionCooldown = 0;
        signDetectionCooldown = 0;
      } else {
        resetCrossingEntities();
      }
      app.render();
    },

    resize(width: number, height: number): void {
      applyLayout(width, height);
    },

    setHorizonHint(y: number | null, confidence: number): void {
      // Deliberately just two primitive field writes — safe from any game
      // state (idle/paused/over/running) and from any call frequency; the
      // gating (confidence floor, manual-drag lockout, slow bias-only
      // application) all happens inside update(), which is the only place
      // that ever reads these two fields.
      horizonHintFraction = y;
      horizonHintConfidence = confidence;
    },

    /**
     * Scene detection is a FLAVOUR input, never a spawn command — see the
     * "Scene-detection-driven spawns" section of config.ts. This method
     * only ever does two things per accepted detection: (1) start that
     * DetectedKind's debounce timer, and (2) hand a themed REQUEST to the
     * relevant pooled system (ObstacleSystem.requestVehicle /
     * PickupSystem.requestCollectible / requestPowerup). Those systems
     * decide entirely on their own — via the same solvability-derived
     * cadence (ObstacleSystem) or spacing cadence (PickupSystem) they
     * already used before this feature existed — whether and when a
     * request actually turns into a spawn. That's what guarantees a burst
     * of detections can never produce a burst of spawns, and what makes
     * "detection off" byte-identical to the pre-detection game: with zero
     * requests ever queued, both systems just fall back to their original
     * behaviour.
     *
     * `vehicle` → ObstacleSystem hazard (jump-clearable, bulkier palette).
     * `person` → PickupSystem collectible (chased for a score bonus).
     * `sign` → PickupSystem power-up. Chosen effect: an INSTANT DASH
     * RECHARGE (Player.grantDashRecharge), not a shield or score
     * multiplier. Rationale: the existing moveset's only defensive/offense
     * tool beyond jump/slam is the dash (brief invulnerability + a
     * dash-through bonus for `wide` obstacles) gated by
     * DASH_COOLDOWN_SECONDS — a shield would just be a second, redundant
     * flavour of invulnerability, and a score multiplier doesn't interact
     * with player *action* at all. Recharging the dash on demand instead
     * removes exactly the cooldown friction the existing dash-ready
     * indicator already visualises, so the reward is legible immediately
     * (the indicator dot flips to its ready cyan the same frame) and it
     * directly feeds the pre-existing DASH_THROUGH_BONUS_SCORE loop rather
     * than adding an unrelated mechanic.
     *
     * Safe to call in ANY GameStatus — a single field read (`status`) and
     * an early return covers idle/paused/over, since nothing here should
     * act while the loop isn't stepping. Cheap and allocation-free: a
     * plain indexed `for` loop and primitive comparisons only; `detections`
     * is read synchronously and never retained past this call, per the
     * `Game` interface's contract.
     */
    onSceneDetections(detections: readonly Detection[]): void {
      // Scene-detection-flavoured hazards/pickups are a 'runner'-only
      // concept — crossing mode has no obstacles or pickups, so this is a
      // guaranteed no-op there regardless of what App.ts happens to still be
      // calling during/after a mode switch.
      if (status !== 'running' || gameMode !== 'runner') return;
      for (let i = 0; i < detections.length; i++) {
        const detection = detections[i]!;
        if (detection.score < DETECTION_MIN_SCORE) continue;
        switch (detection.kind) {
          case 'vehicle':
            if (vehicleDetectionCooldown <= 0) {
              obstacles.requestVehicle();
              vehicleDetectionCooldown = DETECTION_KIND_COOLDOWN_SECONDS;
            }
            break;
          case 'person':
            if (personDetectionCooldown <= 0) {
              pickups.requestCollectible();
              personDetectionCooldown = DETECTION_KIND_COOLDOWN_SECONDS;
            }
            break;
          case 'sign':
            if (signDetectionCooldown <= 0) {
              pickups.requestPowerup();
              signDetectionCooldown = DETECTION_KIND_COOLDOWN_SECONDS;
            }
            break;
          default:
            break;
        }
      }
    },

    /**
     * Windscreen mode: real objects ahead, tracked across frames.
     *
     * 'crossing' mode routes straight to CrossingSystem.onTrackedObjects,
     * UNGATED by `visionMode` — the type doc on GameMode already says
     * 'crossing' only makes sense paired with windscreen framing and that
     * the CALLER (App.ts) enforces that pairing, so re-checking it here
     * would just be redundant. This also matches how the mode is tested
     * (synthetic TrackedObjects fed directly via the debug handle without
     * necessarily also calling setVisionMode).
     *
     * 'runner' mode is otherwise a pass-through to
     * PlatformSystem.onTrackedObjects (see that class's doc for the full
     * matching/spawn/expiry logic) — gated on BOTH `status` (nothing should
     * spawn while the loop isn't stepping, same reasoning as
     * onSceneDetections above) and `visionMode`, so a stray call in 'window'
     * mode (or before the player has switched modes at all) is a guaranteed
     * no-op. That guarantee is exactly what keeps 'window' mode's gameplay
     * byte-for-byte unchanged: PlatformSystem.onTrackedObjects is simply
     * never reached unless the player has explicitly chosen 'windscreen'.
     * Reads `objects` synchronously only, per the TrackedObject contract in
     * types.ts; never retains the array or its elements past this call.
     */
    onTrackedObjects(objects: readonly TrackedObject[]): void {
      if (status !== 'running') return;
      if (gameMode === 'crossing') {
        crossing.onTrackedObjects(objects);
        return;
      }
      if (visionMode !== 'windscreen') return;
      platforms.onTrackedObjects(objects);
    },

    /**
     * Switches which way the phone is pointed. 'window' is exactly today's
     * validated-as-fun behaviour and stays fully intact — this method's only
     * effect on it is that onTrackedObjects becomes (and remains) a no-op.
     * Any switch also drops every active platform outright: a platform is a
     * screen-space overlay tied to a specific real-world framing, so
     * carrying one across a mode change (or even just re-selecting the same
     * windscreen framing after the camera view has changed) would risk a
     * stale box sitting somewhere no longer meaningful. Nothing else resets
     * — score, obstacles, run state are untouched, matching how switching
     * modes never resets an in-progress run for scene detections either.
     */
    setVisionMode(mode: VisionMode): void {
      if (visionMode === mode) return;
      visionMode = mode;
      platforms.reset();
      // If the player happened to be riding a platform at the moment of the
      // switch, this intentionally does NOT rebase them back onto the real
      // ground — with no live camera framing behind 'windscreen' mode being
      // switched away from, there is no meaningful "where they should end
      // up" to preserve continuity toward, and a sudden mode switch is
      // already an abrupt context change from the player's point of view.
      // The next update() simply resumes using the real ground line, same
      // as if no platform had ever existed.
      currentSurfacePlatform = null;
    },

    /**
     * Switch between the endless runner and the crossing game.
     *
     * ISOLATION: every layer this touches is either (a) a Container's
     * `.visible` flag — the runner's ground/obstacle/pickup/platform layers
     * and crossing's own layer are mutually exclusive, so whichever mode
     * isn't active renders nothing, at negligible cost — or (b) a full
     * `reset()`-equivalent on the systems that own per-run state, so no
     * entity or timer from the mode being left can leak into the one being
     * entered. `gameMode` itself is the ONE flag every runner-mode code path
     * in `update()`/`start()`/`reset()` above branches on FIRST, before any
     * of the original runner logic — see those functions' own comments.
     *
     * Safe to call from any GameStatus, including mid-run (`running`): the
     * brief requires a mid-session switch to be clean, not merely a
     * between-runs one. If currently running, the newly-entered mode starts
     * stepping immediately from its own fresh state (equivalent to calling
     * start() for that mode) rather than leaving the loop stepping over a
     * half-initialised world.
     */
    setGameMode(mode: GameMode): void {
      if (gameMode === mode) return;
      const wasRunning = status === 'running';
      gameMode = mode;
      inputSystem.setMode(mode);

      // Drop every per-mode entity/timer regardless of prior status, so a
      // switch from 'paused' or 'over' can't leave stale obstacles/platforms
      // sitting around for whichever mode is entered next either.
      obstacles.reset();
      pickups.reset();
      platforms.reset();
      currentSurfacePlatform = null;
      crossing.reset();
      currentCrossingPlatform = null;
      crossingRideAlongPlatform = null;
      crossingEdgeWarningTimer = 0;
      shakeTrauma = 0;
      worldContainer.x = 0;
      worldContainer.y = 0;

      const enteringCrossing = mode === 'crossing';
      groundGraphics.visible = !enteringCrossing;
      platformLayer.visible = !enteringCrossing;
      obstacleLayer.visible = !enteringCrossing;
      pickupLayer.visible = !enteringCrossing;
      crossingLayer.visible = enteringCrossing;

      if (enteringCrossing) {
        resetCrossingEntities();
      } else {
        // Crossing mode leaves `player`'s x wherever the player last walked/
        // jumped/drifted to (originX has no fixed-column concept there) —
        // resetToIdle() re-applies whatever originX already holds, it does
        // NOT restore the runner's fixed column, so that has to happen
        // explicitly here. Without this, switching back to 'runner' mid-
        // session would resume with the player stranded at its last
        // crossing-mode x instead of PLAYER_X_FRACTION, until the next
        // resize happened to fix it via applyLayout's own player.setX() call.
        player.setX(canvasWidth * PLAYER_X_FRACTION);
        groundY = groundTargetPx();
        groundGraphics.y = groundY;
        player.resetToIdle(groundY);
      }

      if (wasRunning) {
        scoreAccumulator = 0;
        scoreInt = 0;
        callbacks.onScoreChange(scoreInt);
        status = 'running';
      } else {
        app.render();
      }
    },

    destroy(): void {
      loop.stop();
      inputSystem.destroy();
      app.destroy(true, { children: true });
    },
  };

  // Dev-only test seam, same gating as the debugText FPS overlay above: the
  // vision layer (src/vision/**) is the only production caller of
  // setHorizonHint, and it isn't wired up in every environment this runs in
  // (e.g. an automated harness with no camera). Exposing the already-public
  // Game handle on `window` behind the same `?debug`/`#debug` flag lets such
  // a harness *drive* setHorizonHint directly — it grants no capability
  // beyond what the real Game contract already exposes, and every assertion
  // still has to come from rendered pixels, not from this handle.
  if (debug === true) {
    (window as unknown as { __glassyGame?: Game }).__glassyGame = game;
  }

  return game;
};
