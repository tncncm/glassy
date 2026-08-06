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
  /**
   * Whether the user has opted into on-device object detection. Defaults to
   * FALSE: it costs a multi-megabyte download and real battery, so it must be
   * a deliberate choice, never a default-on surprise.
   */
  getVisionEnabled(): boolean;
  setVisionEnabled(enabled: boolean): void;
  /**
   * Drifting dots that match the vehicle's motion, to reduce motion sickness.
   * Defaults to TRUE: this is a comfort feature, and someone who needs it is
   * unlikely to go hunting through settings before they feel unwell.
   */
  getMotionCues(): boolean;
  setMotionCues(enabled: boolean): void;
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
/* Scene analysis — src/vision/SceneAnalyser.ts                        */
/* ------------------------------------------------------------------ */

/**
 * PRIVACY — the boundary moved here, read carefully.
 *
 * As of the horizon feature, Glassy DOES read camera frames. It draws the
 * <video> into a tiny offscreen canvas (a few dozen pixels wide), reduces it to
 * per-row gradient sums, and discards the pixels immediately. That is the whole
 * extent of it:
 *
 *   - nothing is recorded, uploaded, transmitted or persisted — there is no
 *     backend to send it to and no code that could
 *   - no frame, and no image derived from one, ever reaches localStorage
 *   - the only values that survive a single animation frame are a couple of
 *     numbers: an estimated horizon height and a confidence
 *   - analysis stops whenever the camera is suspended or stopped
 *
 * If you add anything here that keeps a frame, a crop, a thumbnail or a
 * fingerprint beyond the current tick, the user-facing privacy copy in
 * `UIController` becomes a lie. Change the copy first, or don't do it.
 */
export interface HorizonEstimate {
  /**
   * Estimated horizon as a 0..1 fraction of frame height, or `null` when no
   * row stood out enough to be worth trusting.
   */
  y: number | null;
  /** 0..1. Consumers should ignore estimates below their own threshold. */
  confidence: number;
}

export interface SceneAnalyserOptions {
  /** The live camera element. Never mutated, only sampled. */
  video: HTMLVideoElement;
  /** Analyses per second. Keep low — this competes with the render loop. */
  sampleHz?: number;
}

export interface SceneAnalyser {
  /** Begin sampling. Safe to call twice; a no-op without a live video. */
  start(): void;
  /** Stop sampling and drop the working buffers. Idempotent. */
  stop(): void;
  /**
   * Latest estimate. A cheap field read — safe to call every frame. Returns a
   * stable object; never allocates.
   */
  readonly horizon: HorizonEstimate;
}

/* ------------------------------------------------------------------ */
/* Object detection — src/vision/ObjectDetector.ts                     */
/* ------------------------------------------------------------------ */

/**
 * The subset of EfficientDet-Lite0's COCO labels Glassy reacts to. Everything
 * else the model reports is discarded immediately.
 */
export type DetectedKind =
  /** car, truck, bus, motorcycle → a hazard rolls in */
  | 'vehicle'
  /** person, bicycle → a collectible */
  | 'person'
  /** traffic light, stop sign, parking meter, bench → a power-up */
  | 'sign';

/**
 * One detection, normalised. Positions are 0..1 fractions of the frame so the
 * game never has to know the model's input resolution.
 */
export interface Detection {
  kind: DetectedKind;
  /** Centre of the box, 0..1 of frame width/height. */
  x: number;
  y: number;
  /** Box size, 0..1. */
  width: number;
  height: number;
  /** Model confidence, 0..1. */
  score: number;
}

/**
 * A detection followed across frames. The detector runs at a few Hz with a
 * jittery box; a platform built straight from raw detections would flicker and
 * jump. The tracker associates each detection with the object it belongs to,
 * smooths it, and keeps it alive briefly through missed frames.
 */
/**
 * How many columns the top-surface profile is sampled at, left to right.
 * Fixed so the arrays can be pooled and never reallocated.
 */
export const SURFACE_PROFILE_SAMPLES = 24;

export interface TrackedObject {
  /** Stable for the life of this object. Never reused. */
  id: number;
  kind: DetectedKind;
  /** Smoothed box centre and size, 0..1 of frame. */
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
  /**
   * The REFINED landing surface, all 0..1 fractions of the frame.
   *
   * The detector's bounding box is loose: it wraps the whole vehicle, mirrors
   * and a little background, and its top edge wobbles. Landing on that reads
   * as landing on an invisible rectangle floating near a car. These three
   * describe the actual roof line found inside the box by a cheap edge scan,
   * so the player lands ON the car.
   *
   * Falls back to the box's own top edge and sides when no refinement was
   * possible, so consumers can always use these unconditionally.
   */
  surfaceY: number;
  surfaceLeft: number;
  surfaceRight: number;
  /**
   * The vehicle's actual TOP PROFILE — bonnet, windscreen, roof — sampled at
   * `SURFACE_PROFILE_SAMPLES` evenly spaced columns between `surfaceLeft` and
   * `surfaceRight`. Each entry is a 0..1 fraction of frame height.
   *
   * A single `surfaceY` makes every vehicle a flat slab, which is why they
   * read as rectangles rather than cars. This follows the silhouette, so a
   * player can stand on the bonnet and walk up onto the roof.
   *
   * ALWAYS populated: filled with `surfaceY` when no better profile could be
   * recovered, so consumers can index it unconditionally. The array is REUSED
   * between ticks along with the object — read it synchronously, never retain
   * it. Off-road-vehicle detections (person/sign) get a flat profile.
   */
  surfaceProfile: Float32Array;
  /** Seconds since it was first seen. */
  age: number;
  /**
   * True once it has been confirmed across enough consecutive frames to be
   * worth building gameplay on. Consumers should ignore unstable objects for
   * anything the player can collide with.
   */
  stable: boolean;
}

export type DetectorStatus =
  /** Never asked to load. */
  | 'idle'
  /** Fetching the wasm runtime and model. Can take a while on mobile data. */
  | 'loading'
  /** Loaded and inferring. */
  | 'ready'
  /** Deliberately switched off by the user. */
  | 'disabled'
  /** Browser can't run it, or loading failed. The game is unaffected. */
  | 'unavailable';

export interface DetectorState {
  status: DetectorStatus;
  /** 0..1 while `loading`, for the UI. */
  progress?: number;
}

export interface ObjectDetectorOptions {
  video: HTMLVideoElement;
  /** Inferences per second. Keep low — this is a neural net on a phone. */
  sampleHz?: number;
  onStateChange?: (state: DetectorState) => void;
  /**
   * Fires per accepted detection, at most a few times a second. The array is
   * REUSED between calls — read it synchronously, never retain it.
   */
  /**
   * Tracked, smoothed objects — the same detections associated across frames.
   * Use this, not `onDetections`, for anything the player can stand on. The
   * array is REUSED between calls: read it synchronously, never retain it.
   */
  onTrackedObjects?: (objects: readonly TrackedObject[]) => void;
}

export interface ObjectDetector {
  readonly state: DetectorState;
  /**
   * Download the runtime + model and begin inferring. Never rejects: failure
   * lands in `unavailable` and the game carries on. Safe to call twice.
   */
  start(): Promise<DetectorState>;
  /** Stop inferring. Keeps the loaded model so a restart is instant. */
  stop(): void;
  /** Stop and release the model entirely. */
  dispose(): void;
}

/* ------------------------------------------------------------------ */
/* Device motion — src/motion/MotionSensor.ts                          */
/* ------------------------------------------------------------------ */

/**
 * The phone's own movement, which in a car is constant and unavoidable.
 *
 * Two uses, both important:
 *  - STABILISATION. Nobody can hold a phone still while someone else drives.
 *    That shake moves the whole camera frame, so every tracked box moves with
 *    it, so every platform jitters. Rotation rate lets us subtract the part of
 *    the motion that was the hand, not the world.
 *  - COMFORT. Staring at a screen inside a moving vehicle causes motion
 *    sickness. Drifting dots that match the vehicle's real motion — the idea
 *    behind iOS's Vehicle Motion Cues — measurably help.
 *
 * PRIVACY: motion is read live and never stored or transmitted, exactly like
 * camera frames.
 */
export interface MotionState {
  /** True once permission is granted and events are arriving. */
  available: boolean;
  /** Rotation rate in deg/s. Phone shake shows up here. */
  rotationAlpha: number;
  rotationBeta: number;
  rotationGamma: number;
  /** Linear acceleration excluding gravity, m/s². Vehicle motion shows here. */
  accelerationX: number;
  accelerationY: number;
  accelerationZ: number;
}

export interface MotionSensorOptions {
  /** Low-pass smoothing rate (1/s). Raw sensor data is far too noisy to use. */
  smoothingRate?: number;
}

export interface MotionSensor {
  /**
   * iOS requires DeviceMotionEvent.requestPermission() from a user gesture.
   * Resolves false when unavailable or refused — never throws, and the game
   * must work fine without it.
   */
  request(): Promise<boolean>;
  start(): void;
  stop(): void;
  /** Cheap field read, safe every frame. Stable object, never allocates. */
  readonly state: MotionState;
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
  | 'click'
  | 'dash'
  | 'slam';

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
  /**
   * The camera's estimated horizon, as a 0..1 fraction of screen height, or
   * `null` when there is no usable estimate. The crossing game uses it to sit
   * the fixed start/goal blocks at road level, so the level adapts to however
   * the phone is actually being held instead of assuming a fixed height.
   */
  setHorizonHint(y: number | null, confidence: number): void;
  /**
   * Latest device motion. Used to damp hand-shake out of platform positions
   * and to drive the motion-comfort cues. Safe to call every frame; must not
   * allocate. The game works normally when motion is unavailable.
   */
  setMotion(state: MotionState): void;
  /** Whether to draw the motion-sickness comfort cues. */
  setMotionCuesEnabled(enabled: boolean): void;
  /**
   * Something real was spotted out the window. The game MAY turn this into a
   * themed spawn — a hazard, a collectible, a power-up — but it is free to
   * ignore it, and MUST keep every spawn inside the solvability envelope. The
   * array is reused by the caller: read it synchronously, never retain it.
   * Never required for the game to function.
   */
  /**
   * Windscreen mode: real objects ahead, tracked across frames. The game turns
   * `stable` ones into platforms the player can land on, positioned to follow
   * the real vehicle on screen. Reused array — read synchronously.
   */
  onTrackedObjects(objects: readonly TrackedObject[]): void;
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
  /**
   * Play against a bundled demo clip instead of the camera. Exists so the
   * windscreen mode can be tried on a phone without being in a moving car —
   * the vision stack runs on the clip exactly as it would on a live feed.
   */
  onPlayDemoVideo(): void;
  /** The user flipped the on-device object-detection opt-in. */
  onToggleVision(): void;
  /** The user flipped the motion-comfort cues. */
  onToggleMotionCues(): void;
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
  /**
   * Reflect the detector in the UI: the opt-in toggle's position, and a
   * download//status line while `loading` or after failure.
   */
  setDetectorState(state: DetectorState): void;
  /** Reflect the motion-cues setting. */
  setMotionCues(enabled: boolean): void;
  /**
   * Show the "Add to Home Screen" hint. Only meaningful on iOS Safari, where
   * the Fullscreen API does not exist and installing the PWA is the only way
   * to actually get a full screen.
   */
  setInstallHintVisible(visible: boolean): void;
}
