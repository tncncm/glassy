/**
 * Glassy — shared contracts.
 *
 * This file is the single seam between the four independently-built layers
 * (camera, ui, audio, game) and the `App` state machine that wires them.
 * Every layer imports from here; no layer imports from another layer.
 *
 * Owned by the integrator. Layer specialists implement against it and must not
 * widen or reshape it without the integrator changing this file first.
 */

/* ------------------------------------------------------------------ */
/* DOM contract                                                        */
/* ------------------------------------------------------------------ */

/**
 * Element ids `index.html` must provide. The camera layer and the Pixi layer
 * look these up; the UI layer creates them.
 */
export const DOM_IDS = {
  /** Full-viewport <video> holding the live camera feed (layer 0). */
  video: 'glassy-video',
  /** Full-viewport <canvas> for the animated no-camera gradient (layer 0). */
  fallback: 'glassy-fallback',
  /** Container the transparent Pixi canvas is appended into (layer 1). */
  stage: 'glassy-stage',
  /** Container for all DOM screens (layer 2). */
  ui: 'glassy-ui',
} as const;

/* ------------------------------------------------------------------ */
/* Preferences — src/storage/Preferences.ts                            */
/* ------------------------------------------------------------------ */

/**
 * The ONLY two values Glassy ever persists. Every access must be wrapped in
 * try/catch: Safari private mode throws on localStorage.
 */
export interface Preferences {
  getBestScore(): number;
  /** Persists only if `score` beats the stored value. Returns the new best. */
  setBestScore(score: number): number;
  getMuted(): boolean;
  setMuted(muted: boolean): void;
}

/* ------------------------------------------------------------------ */
/* Camera — src/camera/CameraController.ts                             */
/* ------------------------------------------------------------------ */

export type CameraStatus =
  /** Never started. */
  | 'idle'
  /** getUserMedia in flight — the permission prompt may be on screen. */
  | 'starting'
  /** A rear-facing (or any) track is live and painting the <video>. */
  | 'live'
  /** Camera unavailable or refused; the animated gradient is running instead. */
  | 'fallback';

export type CameraFailure =
  /** User (or policy) denied the permission prompt. */
  | 'denied'
  /** No camera device present. */
  | 'not-found'
  /** Page is not a secure context — getUserMedia is unavailable over plain http. */
  | 'insecure-context'
  /** Browser has no mediaDevices.getUserMedia at all. */
  | 'unsupported'
  /** Device present but busy / hardware error / anything else. */
  | 'unavailable';

export interface CameraState {
  status: CameraStatus;
  /** Set only when `status === 'fallback'`. */
  failure?: CameraFailure;
}

export interface CameraControllerOptions {
  video: HTMLVideoElement;
  fallbackCanvas: HTMLCanvasElement;
  /** Fires on every state transition, including the initial start attempt. */
  onStateChange?: (state: CameraState) => void;
}

export interface CameraController {
  readonly state: CameraState;
  /**
   * MUST be called from a user gesture. Resolves once the camera is live or the
   * fallback has taken over — it never rejects and never throws.
   */
  start(): Promise<CameraState>;
  /**
   * Enter fallback deliberately, WITHOUT attempting getUserMedia — the user
   * chose "play without camera", so no permission prompt may be raised. The
   * resulting state carries no `failure`: this is a choice, not an error.
   */
  useFallback(): CameraState;
  /** Release the track and stop the fallback animation. Idempotent. */
  stop(): void;
  /** Backgrounded / paused: pause playback and the fallback RAF to save power. */
  suspend(): void;
  /** Foregrounded: resume playback, re-acquiring the track if iOS killed it. */
  resume(): Promise<void>;
  /** Viewport changed — resize the fallback canvas backing store. */
  resize(width: number, height: number): void;
}

/* ------------------------------------------------------------------ */
/* Audio — src/game/systems/AudioSystem.ts                             */
/* ------------------------------------------------------------------ */

export type SoundName =
  | 'jump'
  | 'land'
  | 'collide'
  | 'score'
  | 'gameOver'
  | 'click';

export interface AudioSystem {
  /**
   * Create/resume the AudioContext. MUST be called from a user gesture; iOS
   * starts every context suspended. Never throws.
   */
  unlock(): Promise<void>;
  /** Fire-and-forget. A no-op when muted, locked or unavailable. Never throws. */
  play(name: SoundName): void;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
  /** Backgrounded — suspend the context. */
  suspend(): void;
  /** Foregrounded — resume the context if it was running before. */
  resume(): void;
  dispose(): void;
}

/* ------------------------------------------------------------------ */
/* Game — src/game/Game.ts                                             */
/* ------------------------------------------------------------------ */

export interface GameOverResult {
  score: number;
  best: number;
  isNewBest: boolean;
}

/** Everything the game emits outward. `App` supplies all of them. */
export interface GameCallbacks {
  /** Every time the integer score changes. Cheap — no allocation. */
  onScoreChange(score: number): void;
  /** Collision. The game has already stopped stepping when this fires. */
  onGameOver(result: GameOverResult): void;
  /** Play a sound. `App` routes this to the AudioSystem. */
  onSound(name: SoundName): void;
}

export interface GameOptions {
  /** The element the Pixi canvas is appended to. */
  container: HTMLElement;
  callbacks: GameCallbacks;
  /** Supplies and persists the best score. */
  preferences: Preferences;
  /** Dev-only FPS/debug overlay. */
  debug?: boolean;
}

export type GameStatus = 'idle' | 'running' | 'paused' | 'over';

export interface Game {
  readonly status: GameStatus;
  readonly score: number;
  /** Reset to a fresh run and begin stepping. */
  start(): void;
  /** Freeze the loop; the canvas keeps its last frame. Idempotent. */
  pause(): void;
  /** Unfreeze, swallowing the elapsed wall-clock gap. Idempotent. */
  resume(): void;
  /** Return to the idle attract state without destroying resources. */
  reset(): void;
  /** Viewport changed. */
  resize(width: number, height: number): void;
  /** Tear down Pixi and remove all listeners. */
  destroy(): void;
}

/**
 * Async factory — PixiJS v8 requires `await app.init()`, so construction cannot
 * happen in a constructor. Implemented in `src/game/Game.ts`.
 */
export type CreateGame = (options: GameOptions) => Promise<Game>;

/* ------------------------------------------------------------------ */
/* UI — src/ui/UIController.ts                                         */
/* ------------------------------------------------------------------ */

export type ScreenName =
  | 'loading'
  | 'home'
  /** Explaining why we are about to ask for the camera, or reporting refusal. */
  | 'permission'
  /** Portrait on a phone — gameplay is landscape-only. */
  | 'rotate'
  /** In-game: score + pause button only. */
  | 'playing'
  | 'paused'
  | 'gameOver';

/** Typed intents the view emits. The UI layer never decides what they mean. */
export interface UIIntents {
  /** Home → Play. The user gesture that unlocks audio and the camera. */
  onPlay(): void;
  onPause(): void;
  onResume(): void;
  onRestart(): void;
  onQuitToHome(): void;
  onToggleMute(): void;
  /** Permission screen → proceed with the animated gradient instead. */
  onPlayWithoutCamera(): void;
  /** Permission screen → try getUserMedia again. */
  onRetryCamera(): void;
}

export interface UIController {
  readonly screen: ScreenName;
  show(screen: ScreenName): void;
  setScore(score: number): void;
  setBest(best: number): void;
  setMuted(muted: boolean): void;
  /** Render the game-over panel before `show('gameOver')`. */
  setGameOver(result: GameOverResult): void;
  /**
   * Explain a camera outcome on the permission screen. `null` clears it back to
   * the pre-request explainer.
   */
  setCameraFailure(failure: CameraFailure | null): void;
  /** Dev-only FPS readout; ignored when the debug flag is off. */
  setDebugText(text: string): void;
}
