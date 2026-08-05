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
import type { CreateGame, Game, GameOptions, GameOverResult, GameStatus } from '../types.ts';
import {
  BASE_WORLD_SPEED,
  COLLISION_SHAKE_TRAUMA,
  DASH_THROUGH_BONUS_SCORE,
  DASH_THROUGH_SHAKE_TRAUMA,
  DEBUG_TEXT_COLOR,
  DEBUG_TEXT_SIZE,
  DEBUG_TEXT_UPDATE_INTERVAL_SECONDS,
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
  PLAYER_HEIGHT,
  PLAYER_X_FRACTION,
  SCORE_MILESTONE_STEP,
  SCORE_PER_SECOND_AT_BASE_SPEED,
  SHAKE_DECAY_RATE,
  SHAKE_MAGNITUDE_PX,
  SLAM_SHAKE_TRAUMA,
  SPEED_RAMP_SCORE_CONSTANT,
} from './config.ts';
import { Player } from './entities/Player.ts';
import { GameLoop } from './GameLoop.ts';
import { InputSystem } from './systems/InputSystem.ts';
import { ObstacleSystem } from './systems/ObstacleSystem.ts';
import { ParticleSystem } from './systems/ParticleSystem.ts';
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
  const obstacleLayer = new Container();
  const particleLayer = new Container();
  const player = new Player();
  worldContainer.addChild(groundGraphics, obstacleLayer, player.view, particleLayer);

  const obstacles = new ObstacleSystem(obstacleLayer);
  const particles = new ParticleSystem(particleLayer);

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
  let groundYTargetFraction = GROUND_Y_DEFAULT_FRACTION;
  let groundY = groundYTargetFraction * canvasHeight;
  let scoreAccumulator = 0;
  let scoreInt = 0;
  let shakeTrauma = 0;
  let debugAccumulator = 0;

  // --- Horizon hint state (see setHorizonHint on the returned Game) --------
  /** Latest estimate from setHorizonHint; null = no usable estimate. */
  let horizonHintFraction: number | null = null;
  let horizonHintConfidence = 0;
  /** Counts down after any manual ground-line change; the hint is ignored
   * entirely while positive — the player's own placement always wins. */
  let horizonLockoutTimer = 0;

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

    const baseWorldSpeed =
      BASE_WORLD_SPEED + (MAX_WORLD_SPEED - BASE_WORLD_SPEED) * (1 - Math.exp(-scoreInt / SPEED_RAMP_SCORE_CONSTANT));
    const speedRatio = baseWorldSpeed / BASE_WORLD_SPEED;

    player.update(dt, groundY, speedRatio);
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

    // Dash boosts the world's scroll speed only (obstacles, not scoring —
    // score keeps accruing off the base ramp so dash isn't a passive score
    // farm; the only score effect of dashing is the explicit bonus below).
    const effectiveWorldSpeed = baseWorldSpeed * player.dashSpeedMultiplier;
    obstacles.update(dt, effectiveWorldSpeed, canvasWidth, groundY);
    particles.update(dt);

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
          `  obstacles ${active.length}  ground ${groundY.toFixed(0)}`;
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
      particles.reset();
      shakeTrauma = 0;
      worldContainer.x = 0;
      worldContainer.y = 0;
      groundGraphics.y = groundY;
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
      particles.reset();
      shakeTrauma = 0;
      worldContainer.x = 0;
      worldContainer.y = 0;
      groundY = groundTargetPx();
      groundGraphics.y = groundY;
      player.resetToIdle(groundY);
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
