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
    video.src = src;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error(`could not load ${src}`));
    });
    await video.play();
    return true;
  } catch (err) {
    console.error('[glassy] video backdrop failed', err);
    return false;
  }
}
