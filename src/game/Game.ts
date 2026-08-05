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
import type { CreateGame, Detection, Game, GameOptions, GameOverResult, GameStatus, TrackedObject, VisionMode } from '../types.ts';
import {
  BASE_WORLD_SPEED,
  COLLECTIBLE_SCORE_BONUS,
  COLLISION_SHAKE_TRAUMA,
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
import { InputSystem } from './systems/InputSystem.ts';
import { ObstacleSystem } from './systems/ObstacleSystem.ts';
import { ParticleSystem } from './systems/ParticleSystem.ts';
import { PickupSystem } from './systems/PickupSystem.ts';
import { PlatformSystem } from './systems/PlatformSystem.ts';
import { aabbOverlap, clamp, expDecay, lerp } from './util/math.ts';

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
  const obstacleLayer = new Container();
  const pickupLayer = new Container();
  const particleLayer = new Container();
  const player = new Player();
  // platformLayer sits above the ground line but below obstacles/player, so
  // a windscreen platform reads as part of the "ground" the player can
  // stand on rather than something floating in front of the action.
  worldContainer.addChild(groundGraphics, platformLayer, obstacleLayer, pickupLayer, player.view, particleLayer);

  const obstacles = new ObstacleSystem(obstacleLayer);
  const pickups = new PickupSystem(pickupLayer);
  const particles = new ParticleSystem(particleLayer);
  const platforms = new PlatformSystem(platformLayer);

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
    player.setX(width * PLAYER_X_FRACTION);
    redrawGround(width);
    groundY = groundTargetPx();
    groundGraphics.y = groundY;
    // Re-project every active platform's box against the NEW canvas size
    // right away (dt=0, so no timer advances) — otherwise a platform would
    // sit at a stale pixel rect from before the resize/orientation-change
    // until the next running update() call ticks it forward.
    platforms.update(0, width, height, groundY);
    if (status !== 'running') {
      // Keep the idle/paused/game-over frame visually in sync with the new
      // size instead of waiting for a step that will never come.
      if (status === 'idle') {
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
      if (status !== 'running') return;
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
     * Windscreen mode: real objects ahead, tracked across frames. Purely a
     * pass-through to PlatformSystem.onTrackedObjects (see that class's doc
     * for the full matching/spawn/expiry logic) — gated on BOTH `status`
     * (nothing should spawn while the loop isn't stepping, same reasoning as
     * onSceneDetections above) and `visionMode`, so a stray call in 'window'
     * mode (or before the player has switched modes at all) is a guaranteed
     * no-op. That guarantee is exactly what keeps 'window' mode's gameplay
     * byte-for-byte unchanged: PlatformSystem.onTrackedObjects is simply
     * never reached unless the player has explicitly chosen 'windscreen'.
     * Reads `objects` synchronously only, per the TrackedObject contract in
     * types.ts; never retains the array or its elements past this call.
     */
    onTrackedObjects(objects: readonly TrackedObject[]): void {
      if (status !== 'running' || visionMode !== 'windscreen') return;
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
