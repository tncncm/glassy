/**
 * App — the ONE state machine in Glassy.
 *
 * Camera, game, audio, preferences and UI are dumb collaborators. They never
 * reach into each other; every interaction is routed through here via the
 * typed callbacks declared in src/types.ts.
 *
 *   loading → home → requestingCamera → playing ⇄ paused ⇄ rotate → gameOver
 *
 * `rotate` is an interrupt rather than a peer state: portrait can strike from
 * `playing` or `paused`, so we remember what to return to (`resumeStateAfterRotate`)
 * instead of encoding every edge.
 */

import { createCameraController } from '../camera/CameraController.ts';
import { attachDevVideo, devVideoSource } from '../dev/videoBackdrop.ts';
import { createGame } from '../game/Game.ts';
import { createAudioSystem } from '../game/systems/AudioSystem.ts';
import { createPreferences } from '../storage/Preferences.ts';
import {
  DOM_IDS,
  type AudioSystem,
  type CameraController,
  type CameraState,
  type Game,
  type GameOverResult,
  type Preferences,
  type SoundName,
  type Detection,
  type DetectorState,
  type ObjectDetector,
  type SceneAnalyser,
  type TrackedObject,
  type VisionMode,
  type UIController,
  type UIIntents,
} from '../types.ts';
import { createUIController } from '../ui/UIController.ts';
import { createObjectDetector } from '../vision/ObjectDetector.ts';
import { createSceneAnalyser } from '../vision/SceneAnalyser.ts';

/**
 * Internal app state. Distinct from `ScreenName`: `requestingCamera` is a real
 * state (getUserMedia is in flight) that shares the `permission` screen, and
 * `rotate` is an interrupt overlaying whatever we were doing.
 */
type AppState =
  | 'loading'
  | 'home'
  | 'requestingCamera'
  | 'playing'
  | 'paused'
  | 'rotate'
  | 'gameOver';

/**
 * Below this height in landscape we're almost certainly in portrait on a phone.
 * Measured, not `screen.orientation` — iOS Safari's orientation APIs are not
 * dependable and `lock()` is unsupported there entirely.
 */
const MIN_LANDSCAPE_ASPECT = 1.0;
/** Desktop/tablet windows can be tall without being a phone held upright. */
const ROTATE_PROMPT_MAX_SHORT_EDGE = 820;

/**
 * How often the latest horizon estimate is handed to the game. The analyser
 * samples at its own (low) rate; this only reads the value it already computed,
 * so it is cheap — but there is no point pushing faster than the analyser moves.
 */
const HORIZON_PUSH_INTERVAL_MS = 200;

/** See the comment in `syncSceneAnalysis`. */
const HORIZON_HINT_ENABLED = true;

export interface App {
  start(): Promise<void>;
  destroy(): void;
}

export async function createApp(root: HTMLElement): Promise<App> {
  /* ---------------------------------------------------------------- */
  /* Collaborators                                                     */
  /* ---------------------------------------------------------------- */

  const video = requireElement<HTMLVideoElement>(DOM_IDS.video);
  const fallbackCanvas = requireElement<HTMLCanvasElement>(DOM_IDS.fallback);
  const stage = requireElement<HTMLElement>(DOM_IDS.stage);

  const preferences: Preferences = createPreferences();
  const audio: AudioSystem = createAudioSystem(preferences.getMuted());

  let state: AppState = 'loading';
  /** Where to go back to once the device is rotated back to landscape. */
  let resumeStateAfterRotate: AppState = 'home';
  /** True once a play gesture has unlocked audio; iOS needs a real gesture. */
  let audioUnlocked = false;
  let destroyed = false;
  /** Dev-only: true when a recorded clip is standing in for the camera. */
  let usingDevVideo = false;

  const ui: UIController = createUIController(root, createIntents());

  const camera: CameraController = createCameraController({
    video,
    fallbackCanvas,
    onStateChange: handleCameraStateChange,
  });

  /**
   * Reads shrunken frames to estimate the horizon. Runs ONLY while the camera
   * is live and the game is actually being played — never on the menus, never
   * on the fallback background (there is no real scene to analyse), never while
   * backgrounded. See the privacy note in types.ts.
   */
  const scene: SceneAnalyser = createSceneAnalyser({ video });
  /** Pushes the latest estimate into the game. The game decides whether to use it. */
  let horizonTimer: number | null = null;

  /**
   * Optional on-device object detection. Opt-in, default off: it costs a
   * multi-megabyte download and real battery, so it is never turned on for
   * someone who didn't ask. Everything about the game works without it.
   */
  const detector: ObjectDetector = createObjectDetector({
    video,
    mode: preferences.getVisionMode(),
    onStateChange(next: DetectorState): void {
      ui.setDetectorState(next);
    },
    onDetections(detections: readonly Detection[]): void {
      // The array is reused by the detector — hand it straight on, and the
      // game reads it synchronously. Neither side retains it.
      game.onSceneDetections(detections);
    },
    onTrackedObjects(objects: readonly TrackedObject[]): void {
      // Windscreen mode: these become platforms. Reused array on both sides.
      game.onTrackedObjects(objects);
    },
  });

  const game: Game = await createGame({
    container: stage,
    preferences,
    debug: isDebugEnabled(),
    callbacks: {
      onScoreChange(score: number): void {
        ui.setScore(score);
      },
      onGameOver(result: GameOverResult): void {
        handleGameOver(result);
      },
      onSound(name: SoundName): void {
        audio.play(name);
      },
    },
  });

  /* ---------------------------------------------------------------- */
  /* Intents from the UI                                               */
  /* ---------------------------------------------------------------- */

  function createIntents(): UIIntents {
    return {
      onPlay(): void {
        // Deliberately context-sensitive: types.ts has no separate "continue"
        // intent, and the permission screen's Continue button must ITSELF be
        // the user gesture that calls getUserMedia. So from `home` this only
        // shows the explainer; from the explainer it actually asks.
        audio.play('click');
        unlockAudio();
        // Must ride this gesture — a fullscreen request outside one is refused.
        requestFullscreenIfSupported();
        if (state === 'home') {
          ui.setCameraFailure(null);
          go('requestingCamera', { requestCamera: false });
          return;
        }
        if (state === 'requestingCamera') {
          void requestCameraThenPlay();
        }
      },
      onPause(): void {
        audio.play('click');
        if (state === 'playing') go('paused');
      },
      onResume(): void {
        audio.play('click');
        if (state === 'paused') go('playing');
      },
      onRestart(): void {
        audio.play('click');
        unlockAudio();
        beginRun();
      },
      onQuitToHome(): void {
        audio.play('click');
        // Don't strand the user in a chromeless window on the home screen.
        exitFullscreenIfActive();
        go('home');
      },
      onToggleMute(): void {
        const muted = !audio.isMuted();
        audio.setMuted(muted);
        preferences.setMuted(muted);
        ui.setMuted(muted);
        // Played after unmuting so the user gets confirmation it worked.
        audio.play('click');
      },
      onPlayWithoutCamera(): void {
        audio.play('click');
        unlockAudio();
        // Never re-attempt getUserMedia here — the user has explicitly opted
        // out, and a prompt would be a betrayal of that choice.
        camera.useFallback();
        beginRun();
      },
      onRetryCamera(): void {
        audio.play('click');
        unlockAudio();
        ui.setCameraFailure(null);
        void requestCameraThenPlay();
      },
      onSelectVisionMode(mode: VisionMode): void {
        audio.play('click');
        preferences.setVisionMode(mode);
        ui.setVisionMode(mode);
        detector.setMode(mode);
        game.setVisionMode(mode);
      },
      onToggleVision(): void {
        audio.play('click');
        const enabled = !preferences.getVisionEnabled();
        preferences.setVisionEnabled(enabled);
        if (!enabled) {
          detector.stop();
          ui.setDetectorState({ status: 'disabled' });
          return;
        }
        // Prefetch immediately rather than waiting for the first run. Two
        // reasons: a ~16MB download should not begin the moment the player
        // taps Play, and without it the toggle would sit visually "off" until
        // a camera run started, which reads as broken. start() then stop()
        // loads the model without leaving inference running.
        void detector.start().then(() => {
          if (!destroyed) syncDetector();
        });
      },
    };
  }

  /* ---------------------------------------------------------------- */
  /* Camera                                                            */
  /* ---------------------------------------------------------------- */

  async function requestCameraThenPlay(): Promise<void> {
    go('requestingCamera', { requestCamera: false });

    // Dev-only: ?video=<path> plays over a recorded clip instead of the
    // camera, so the vision stack can be judged on real footage.
    //
    // The `import.meta.env.DEV` test must be the OUTER guard, written
    // literally like this: Vite substitutes it with `false` in a production
    // build, so Rollup eliminates the whole branch and then tree-shakes
    // videoBackdrop.ts away entirely. Testing a runtime helper instead would
    // leave the dev code sitting in the shipped bundle.
    if (import.meta.env.DEV) {
      const devSrc = devVideoSource();
      if (devSrc) {
        usingDevVideo = await attachDevVideo(video, fallbackCanvas, devSrc);
        if (destroyed) return;
        if (usingDevVideo) {
          beginRun();
          return;
        }
      }
    }

    // start() never rejects; it resolves with whatever state it reached.
    const result = await camera.start();
    if (destroyed) return;

    if (result.status === 'live') {
      beginRun();
      return;
    }
    // Fallback: stay on the permission screen and explain what happened, so
    // the user can retry or knowingly continue without the camera.
    ui.setCameraFailure(result.failure ?? 'unavailable');
    ui.show('permission');
  }

  /**
   * Analysis is tied to "camera live AND actively playing". Anything else —
   * menus, pause, fallback, backgrounded — stops it, so we never read frames
   * we have no gameplay reason to read.
   */
  function syncSceneAnalysis(): void {
    // Measured against real Italian motorway footage (tools/video-sim), the
    // estimator locks onto the crash barrier's top rail rather than the
    // skyline — and that is what we want: the barrier IS the running surface
    // the player is trying to line up with.
    //
    // It first shipped wandering over 0.50..0.88 of frame height (it hopped
    // between the barrier's three parallel rails), which would have slid the
    // ground by a third of the screen mid-run. After cluster-locking and
    // stickiness in SceneAnalyser: range 0.52..0.75, std dev 0.067, and a
    // 5-6x smoother frame-to-frame step. What remains is genuine perspective
    // drift of the rail itself, which SHOULD be tracked.
    //
    // The game still treats this as a hint only: a manual drag overrides it
    // for 4s and low confidence is ignored.
    const liveSource = camera.state.status === 'live' || usingDevVideo;
    const shouldRun = HORIZON_HINT_ENABLED && state === 'playing' && liveSource;
    if (shouldRun) {
      scene.start();
      if (horizonTimer === null) {
        horizonTimer = window.setInterval(pushHorizonHint, HORIZON_PUSH_INTERVAL_MS);
      }
      return;
    }
    scene.stop();
    if (horizonTimer !== null) {
      window.clearInterval(horizonTimer);
      horizonTimer = null;
    }
    // Drop any stale bias so the ground returns to the player's own choice.
    game.setHorizonHint(null, 0);
  }

  function pushHorizonHint(): void {
    const estimate = scene.horizon;
    game.setHorizonHint(estimate.y, estimate.confidence);
  }

  /**
   * Detection runs only when the user opted in AND we're actually playing with
   * a live camera. Same rule as the horizon analyser: no frames are examined
   * for any state where there's no gameplay reason to examine them.
   */
  function syncDetector(): void {
    if (!preferences.getVisionEnabled()) {
      detector.stop();
      return;
    }
    // Stop only when there is something to stop: a live camera we're not
    // playing over. With no live camera the detector cannot read a frame
    // anyway (it skips every tick), so leaving it loaded costs nothing and
    // keeps the opt-in toggle showing the state the user actually chose.
    if ((camera.state.status === 'live' || usingDevVideo) && state !== 'playing') {
      detector.stop();
      return;
    }
    void detector.start();
  }

  function handleCameraStateChange(next: CameraState): void {
    // A camera that drops out must also stop the analyser.
    if (next.status !== 'live') {
      syncSceneAnalysis();
      syncDetector();
    }
    // A camera that dies mid-run (unplugged, seized by another app, iOS
    // reclaiming it) must degrade into a playable game, never a black screen.
    // The fallback background is already painting by the time we get here.
    if (next.status === 'fallback' && (state === 'playing' || state === 'paused')) {
      console.warn('[glassy] camera lost mid-run, continuing on fallback', next.failure);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Run lifecycle                                                     */
  /* ---------------------------------------------------------------- */

  function beginRun(): void {
    ui.setScore(0);
    if (isPortrait()) {
      // Start the run anyway but hold it paused behind the rotate prompt, so
      // rotating back drops straight into play.
      game.start();
      game.pause();
      resumeStateAfterRotate = 'playing';
      go('rotate');
      return;
    }
    game.start();
    go('playing');
  }

  function handleGameOver(result: GameOverResult): void {
    ui.setBest(result.best);
    ui.setGameOver(result);
    go('gameOver');
  }

  /* ---------------------------------------------------------------- */
  /* State machine                                                     */
  /* ---------------------------------------------------------------- */

  function go(next: AppState, options?: { requestCamera: boolean }): void {
    if (destroyed) return;
    const previous = state;
    state = next;

    switch (next) {
      case 'loading':
        ui.show('loading');
        break;

      case 'home':
        // Leaving a run entirely: stop the game and release the camera so the
        // hardware indicator goes out while the user sits on the home screen.
        if (previous === 'playing' || previous === 'paused' || previous === 'gameOver') {
          game.reset();
          camera.stop();
        }
        ui.setBest(preferences.getBestScore());
        ui.show('home');
        break;

      case 'requestingCamera':
        ui.show('permission');
        if (options?.requestCamera) void requestCameraThenPlay();
        break;

      case 'playing':
        if (previous === 'paused' || previous === 'rotate') {
          game.resume();
          void camera.resume();
        } else if (previous === 'gameOver') {
          // beginRun() already called game.start() for the fresh run, but the
          // camera was suspended by go('gameOver') below and is not resumed
          // by any other path — without this, restarting from the Game Over
          // screen leaves the live feed frozen on its last frame (or the
          // fallback animation stopped) for the entire new run.
          void camera.resume();
        }
        ui.show('playing');
        break;

      case 'paused':
        game.pause();
        camera.suspend();
        ui.show('paused');
        break;

      case 'rotate':
        game.pause();
        ui.show('rotate');
        break;

      case 'gameOver':
        camera.suspend();
        ui.show('gameOver');
        break;
    }

    // Every transition re-evaluates whether we should be reading frames at all.
    syncSceneAnalysis();
    syncDetector();
  }

  /* ---------------------------------------------------------------- */
  /* Orientation, visibility, resize                                   */
  /* ---------------------------------------------------------------- */

  function isPortrait(): boolean {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w >= h * MIN_LANDSCAPE_ASPECT) return false;
    // A tall desktop window is not a phone held upright — don't nag.
    return Math.min(w, h) <= ROTATE_PROMPT_MAX_SHORT_EDGE;
  }

  function handleOrientation(): void {
    if (destroyed) return;
    const portrait = isPortrait();

    if (portrait && (state === 'playing' || state === 'paused')) {
      resumeStateAfterRotate = state;
      go('rotate');
      return;
    }
    if (!portrait && state === 'rotate') {
      go(resumeStateAfterRotate === 'paused' ? 'paused' : 'playing');
    }
  }

  function handleResize(): void {
    if (destroyed) return;
    const width = window.innerWidth;
    const height = window.innerHeight;
    game.resize(width, height);
    camera.resize(width, height);
    handleOrientation();
  }

  function handleVisibility(): void {
    if (destroyed) return;
    if (document.hidden) {
      audio.suspend();
      camera.suspend();
      // Auto-pause a live run rather than letting the player die offscreen.
      if (state === 'playing') go('paused');
      return;
    }
    audio.resume();
    // Only wake the camera where it's actually on screen. `paused` deliberately
    // stays suspended until the user resumes.
    if (state === 'playing') void camera.resume();
  }

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */

  function unlockAudio(): void {
    if (audioUnlocked) return;
    audioUnlocked = true;
    // Fire-and-forget: unlock() never throws, and a browser without audio must
    // not block the game from starting.
    void audio.unlock();
  }

  /* ---------------------------------------------------------------- */
  /* Wiring                                                            */
  /* ---------------------------------------------------------------- */

  const orientationQuery = window.matchMedia('(orientation: portrait)');

  window.addEventListener('resize', handleResize);
  window.addEventListener('orientationchange', handleResize);
  orientationQuery.addEventListener('change', handleOrientation);
  document.addEventListener('visibilitychange', handleVisibility);

  async function start(): Promise<void> {
    ui.setMuted(audio.isMuted());
    ui.setBest(preferences.getBestScore());
    ui.setScore(0);
    // Only nag where it's the only option and isn't already done.
    ui.setInstallHintVisible(isIPhoneSafari() && !isStandalone());
    // Reflect the stored opt-in without starting a download on load.
    ui.setDetectorState({ status: preferences.getVisionEnabled() ? 'idle' : 'disabled' });
    const savedMode = preferences.getVisionMode();
    ui.setVisionMode(savedMode);
    game.setVisionMode(savedMode);
    handleResize();

    // Opportunistic only — unsupported on iOS Safari and must never be
    // load-bearing. The measured rotate screen is the real mechanism.
    tryLockLandscape();

    go('loading');
    // One frame of loading so the shell paints before the home screen lands.
    await nextFrame();
    if (destroyed) return;
    go('home');
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    window.removeEventListener('resize', handleResize);
    window.removeEventListener('orientationchange', handleResize);
    orientationQuery.removeEventListener('change', handleOrientation);
    document.removeEventListener('visibilitychange', handleVisibility);
    scene.stop();
    detector.dispose();
    if (horizonTimer !== null) {
      window.clearInterval(horizonTimer);
      horizonTimer = null;
    }
    game.destroy();
    camera.stop();
    audio.dispose();
  }

  return { start, destroy };
}

/* ------------------------------------------------------------------ */
/* Module-level helpers                                                */
/* ------------------------------------------------------------------ */

function requireElement<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`[glassy] missing required element #${id}`);
  return element as unknown as T;
}

function nextFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/** Dev-only: `?debug` or `#debug` turns on the in-canvas FPS readout. */
function isDebugEnabled(): boolean {
  try {
    return (
      new URLSearchParams(window.location.search).has('debug') ||
      window.location.hash === '#debug'
    );
  } catch {
    return false;
  }
}

/** True when launched from the home screen as an installed PWA. */
function isStandalone(): boolean {
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia('(display-mode: standalone)').matches;
}

/** iPhone/iPod Safari — the one platform with no Fullscreen API at all. */
function isIPhoneSafari(): boolean {
  return /iPhone|iPod/.test(navigator.userAgent);
}

/**
 * Go full screen if the platform allows it. MUST be called from a user gesture.
 *
 * iPhone Safari implements none of this — `requestFullscreen` is simply absent
 * (iPad has had it since iPadOS 13). There is no workaround: on iPhone the only
 * real full screen is installing the PWA to the home screen, which is why the
 * home screen carries that hint instead. Every failure here is swallowed.
 */
function requestFullscreenIfSupported(): void {
  try {
    const el = document.documentElement as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void> | void;
    };
    if (document.fullscreenElement) return;
    if (typeof el.requestFullscreen === 'function') {
      void el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    } else if (typeof el.webkitRequestFullscreen === 'function') {
      void el.webkitRequestFullscreen();
    }
  } catch {
    /* not supported — the app is perfectly playable windowed */
  }
}

function exitFullscreenIfActive(): void {
  try {
    if (document.fullscreenElement && typeof document.exitFullscreen === 'function') {
      void document.exitFullscreen().catch(() => {});
    }
  } catch {
    /* nothing to exit */
  }
}

/**
 * `screen.orientation.lock()` is unsupported on iOS Safari and rejects on most
 * desktop browsers. Purely opportunistic — every failure is swallowed.
 */
function tryLockLandscape(): void {
  try {
    const orientation = screen.orientation as ScreenOrientation & {
      lock?: (o: string) => Promise<void>;
    };
    void orientation.lock?.('landscape').catch(() => {});
  } catch {
    /* not supported — the rotate screen handles it */
  }
}
