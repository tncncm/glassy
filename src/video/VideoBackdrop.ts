/**
 * Play Glassy over a recorded clip instead of a live camera.
 *
 * Two callers:
 *   - the DEMO button, shipped in production, so windscreen mode can be tried
 *     on a phone without being in a moving car;
 *   - a dev-only `?video=<path>` override for testing arbitrary footage.
 *
 * The vision stack needs no changes either way: SceneAnalyser and
 * ObjectDetector both read the same <video> element the camera would fill.
 *
 * PRIVACY: a clip loaded here is treated exactly like a camera frame — read
 * on-device, never uploaded, never stored. The demo clip is a static asset
 * served from our own origin.
 */

/**
 * The bundled demo clip. Fetched only when the user presses the demo button,
 * so nobody pays for it who doesn't ask.
 */
export const DEMO_VIDEO_SRC = '/demo/dashcam.mp4';

/**
 * Ceiling on waiting for the clip's first frame. A missing or stalled file
 * must not leave the player staring at a black screen — past this we give up
 * and let the caller fall back to the animated gradient.
 */
const LOAD_TIMEOUT_MS = 8000;

/**
 * Dev-only `?video=` override. Callers MUST wrap the call in
 * `if (import.meta.env.DEV)` so the branch is statically eliminated —
 * testing this at runtime instead would ship the dev path in the bundle.
 */
export function devVideoSource(): string | null {
  if (!import.meta.env.DEV) return null;
  try {
    const src = new URLSearchParams(window.location.search).get('video');
    return src && src.length > 0 ? src : null;
  } catch {
    return null;
  }
}

/**
 * Attach a looping local video as the backdrop, standing in for the camera.
 * Resolves once it is actually playing; never throws.
 */
export async function attachVideoBackdrop(
  video: HTMLVideoElement,
  fallbackCanvas: HTMLCanvasElement,
  src: string,
): Promise<boolean> {
  try {
    // The fallback gradient canvas sits above the video and would hide it.
    fallbackCanvas.hidden = true;
    video.srcObject = null;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.src = src;

    /*
     * play() MUST be called here, synchronously after setting src, and NOT
     * after awaiting `loadeddata`.
     *
     * iOS Safari only honours play() while the page still has user
     * activation, and activation does not survive an await. Waiting for the
     * video to load first — the obvious ordering — gets the promise rejected
     * with NotAllowedError on a real iPhone while working fine on desktop.
     * Calling it now is legal even though no data has arrived yet: WebKit
     * queues the request and starts as soon as it can.
     */
    const playing = video.play();

    // Then wait for actual data, with a ceiling so a stalled or missing file
    // can't hang the game on a black screen.
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        if (video.readyState >= 2) {
          resolve();
          return;
        }
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error(`could not load ${src}`));
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out loading ${src}`)), LOAD_TIMEOUT_MS),
      ),
    ]);

    // A rejected play() is not fatal on its own — the element may still be
    // primed and start on the next tick — but a video with no data is.
    await playing.catch((err: unknown) => {
      console.warn('[glassy] video play() rejected; continuing', err);
    });

    return video.readyState >= 2;
  } catch (err) {
    console.error('[glassy] video backdrop failed', err);
    return false;
  }
}
