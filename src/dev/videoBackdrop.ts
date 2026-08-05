/**
 * DEV-ONLY: play Glassy over a recorded video instead of a live camera.
 *
 * Exists so the vision stack can be judged on real driving footage without
 * getting in a car — the ground line following a real crash barrier, hazards
 * spawning off real vehicles. The SceneAnalyser and ObjectDetector both take
 * the same <video> element the camera would fill, so they need no changes and
 * behave exactly as they do in production.
 *
 * Every call site is behind `import.meta.env.DEV`, so this whole module is
 * dropped from a production build by dead-code elimination. It must never
 * become load-bearing for shipped behaviour.
 *
 *   npm run dev
 *   http://localhost:5173/?video=/tools/video-sim/.tmp/input.mp4
 */

/** The `?video=` path, or null when not in dev / not requested. */
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
 * Attach a looping local video to the backdrop element, standing in for the
 * camera stream. Resolves once it is actually playing; never throws.
 */
export async function attachDevVideo(
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
    console.info('[glassy/dev] playing over %s — camera bypassed', src);
    return true;
  } catch (err) {
    console.error('[glassy/dev] video backdrop failed', err);
    return false;
  }
}
