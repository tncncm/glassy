/**
 * PRIVACY INVARIANT — read before touching this file.
 *
 * The camera stream produced here is attached to a <video> element and to
 * NOTHING else. This controller must never call `drawImage()` with the video
 * as a source, never read pixels (`getImageData`, `readPixels`, ...), never
 * construct a `MediaRecorder`, never upload a frame, and never persist any
 * media. The only two values Glassy ever persists live in
 * `src/storage/Preferences.ts` (best score, mute) — camera frames are not
 * among them. If you find code here that reads frames into a canvas, that is
 * a bug: remove it.
 */

import type {
  CameraController,
  CameraControllerOptions,
  CameraFailure,
  CameraState,
} from '../types.ts';
import { createFallbackBackground, type FallbackBackground } from './FallbackBackground.ts';

/** Modest target — never demand 4K, rear camera preferred but not required. */
const IDEAL_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1280 },
    height: { ideal: 720 },
  },
  audio: false,
};

/** Retried only when the ideal constraints are unsatisfiable on this device. */
const MINIMAL_CONSTRAINTS: MediaStreamConstraints = {
  video: true,
  audio: false,
};

function errorName(error: unknown): string | null {
  if (error instanceof DOMException) return error.name;
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof (error as { name: unknown }).name === 'string'
  ) {
    return (error as { name: string }).name;
  }
  return null;
}

/**
 * Maps a getUserMedia rejection to the CameraFailure union.
 *
 *   NotAllowedError / SecurityError               -> denied
 *   NotFoundError / OverconstrainedError (final)   -> not-found
 *   NotReadableError / AbortError                  -> unavailable
 *   anything else                                  -> unavailable
 */
function mapError(error: unknown): CameraFailure {
  switch (errorName(error)) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'denied';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'not-found';
    case 'NotReadableError':
    case 'AbortError':
      return 'unavailable';
    default:
      return 'unavailable';
  }
}

/** Ideal constraints first; retry with minimal constraints if they're unsatisfiable. */
async function acquireStream(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia(IDEAL_CONSTRAINTS);
  } catch (err) {
    if (errorName(err) === 'OverconstrainedError') {
      return await navigator.mediaDevices.getUserMedia(MINIMAL_CONSTRAINTS);
    }
    throw err;
  }
}

export function createCameraController(options: CameraControllerOptions): CameraController {
  const { video, fallbackCanvas, onStateChange } = options;
  const fallback: FallbackBackground = createFallbackBackground(fallbackCanvas);
  // `#glassy-video` and `#glassy-fallback` share the same z-index (see
  // styles.css) — the fallback canvas is later in DOM order, so it paints on
  // top of the video. FallbackBackground's canvas is opaque and, once
  // painted, is never repainted-away by stop() alone, so it must be
  // explicitly hidden whenever it isn't the active layer or it permanently
  // occludes the live camera feed.
  fallbackCanvas.hidden = true;

  let state: CameraState = { status: 'idle' };
  let stream: MediaStream | null = null;
  let currentTrack: MediaStreamTrack | null = null;
  /** True between suspend() and resume(): track-loss events are expected and ignored. */
  let suspended = false;
  let startPromise: Promise<CameraState> | null = null;

  // Safari cares about the properties, not just the HTML attributes.
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;

  function setState(next: CameraState): void {
    state = next;
    onStateChange?.(next);
  }

  function handleTrackLoss(): void {
    // Backgrounding on iOS can mute/end the track by design; suspend()/resume()
    // own that path. Only an unexpected loss while active is a real failure.
    if (suspended) return;
    enterFallback('unavailable');
  }

  function attachTrackListeners(track: MediaStreamTrack): void {
    track.addEventListener('ended', handleTrackLoss);
    track.addEventListener('mute', handleTrackLoss);
  }

  function detachTrackListeners(track: MediaStreamTrack): void {
    track.removeEventListener('ended', handleTrackLoss);
    track.removeEventListener('mute', handleTrackLoss);
  }

  function stopStream(): void {
    if (currentTrack) {
      detachTrackListeners(currentTrack);
      currentTrack = null;
    }
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      stream = null;
    }
  }

  function enterFallback(failure: CameraFailure): CameraState {
    stopStream();
    video.pause();
    video.srcObject = null;
    fallbackCanvas.hidden = false;
    fallback.start();
    const next: CameraState = { status: 'fallback', failure };
    setState(next);
    return next;
  }

  /**
   * Deliberate fallback — the user chose to play without the camera, so we
   * must NOT call getUserMedia (that would raise the very prompt they
   * declined). Same teardown as `enterFallback`, but the resulting state
   * carries no `failure`, because nothing failed.
   */
  function useFallback(): CameraState {
    stopStream();
    video.pause();
    video.srcObject = null;
    fallbackCanvas.hidden = false;
    fallback.start();
    const next: CameraState = { status: 'fallback' };
    setState(next);
    return next;
  }

  async function attachStream(newStream: MediaStream): Promise<CameraState> {
    stopStream();
    stream = newStream;
    const track = newStream.getVideoTracks()[0] ?? null;
    currentTrack = track;
    if (track) attachTrackListeners(track);

    video.srcObject = newStream;
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;

    try {
      await video.play();
    } catch (err) {
      // Safari can reject play() (e.g. a race with backgrounding) even though
      // the track itself is live. Don't fail start — the next gesture/resume
      // retries play(). See resume() for the retry.
      console.warn('[glassy/camera] video.play() rejected; will retry', err);
    }

    fallback.stop();
    fallbackCanvas.hidden = true;
    const next: CameraState = { status: 'live' };
    setState(next);
    return next;
  }

  async function doStart(): Promise<CameraState> {
    setState({ status: 'starting' });

    if (!window.isSecureContext) {
      return enterFallback('insecure-context');
    }
    if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      return enterFallback('unsupported');
    }

    try {
      const newStream = await acquireStream();
      return await attachStream(newStream);
    } catch (err) {
      return enterFallback(mapError(err));
    }
  }

  async function start(): Promise<CameraState> {
    if (startPromise) return startPromise;
    if (state.status === 'live') return state;

    const promise = doStart().finally(() => {
      startPromise = null;
    });
    startPromise = promise;
    return promise;
  }

  function stop(): void {
    suspended = false;
    fallback.stop();
    fallbackCanvas.hidden = true;
    stopStream();
    video.pause();
    video.srcObject = null;
    if (state.status !== 'idle') {
      setState({ status: 'idle' });
    }
  }

  function suspend(): void {
    if (suspended) return;
    suspended = true;
    fallback.stop();
    video.pause();
  }

  async function resume(): Promise<void> {
    suspended = false;

    try {
      if (state.status === 'fallback') {
        fallback.start();
        return;
      }

      if (state.status === 'live') {
        const trackDead =
          !currentTrack || currentTrack.readyState === 'ended' || !currentTrack.enabled;

        if (trackDead) {
          // iOS silently killed the track while backgrounded. Re-acquire via
          // the same start path rather than showing a frozen last frame.
          stopStream();
          video.srcObject = null;
          await doStart();
          return;
        }

        try {
          await video.play();
        } catch (err) {
          console.warn('[glassy/camera] resume() play() rejected; will retry', err);
        }
      }
    } catch (err) {
      // resume() must never throw.
      console.warn('[glassy/camera] resume() failed unexpectedly', err);
    }
  }

  function resize(width: number, height: number): void {
    fallback.resize(width, height);
  }

  return {
    get state(): CameraState {
      return state;
    },
    start,
    useFallback,
    stop,
    suspend,
    resume,
    resize,
  };
}
