/**
 * PRIVACY — read this before touching anything below.
 *
 * This is the ONLY place in Glassy that reads camera pixels. It draws the
 * live <video> into a tiny (48x27, see SAMPLE_WIDTH/SAMPLE_HEIGHT below)
 * offscreen canvas, reduces that single frame to per-row luminance-gradient
 * scores, and discards every pixel before the tick ends. The working canvas,
 * 2D context and scratch typed arrays are allocated once and reused forever;
 * the ImageData obtained from `getImageData` is read and dropped in the same
 * call, never stored on `this`/closure state.
 *
 * The only things that survive past a single sample are two numbers —
 * `horizon.y` and `horizon.confidence` — held in one object that is mutated
 * in place and handed back on every read.
 *
 * No recording, no upload, no `localStorage`, no `toDataURL`/`toBlob`/
 * `captureStream`/`MediaRecorder`, no `fetch`, no `console.log` of pixel
 * data. `stop()` drops every working buffer. If you are tempted to keep a
 * frame, a crop or a thumbnail around for longer than the current tick,
 * stop — read the matching PRIVACY comment above `HorizonEstimate` in
 * src/types.ts first, and change the user-facing copy before you change this.
 */

import type {
  SceneAnalyser,
  SceneAnalyserOptions,
  HorizonEstimate,
} from '../types.ts';

/**
 * Offscreen sample size. Tiny on purpose — this runs on an iPhone CPU/GPU
 * shared with a 60fps Pixi render over the same live video. Kept as a
 * module constant rather than an option: nothing in the contract asks for
 * it to be tunable, and a bigger buffer is exactly the mistake this file
 * exists to avoid.
 */
const SAMPLE_WIDTH = 48;
const SAMPLE_HEIGHT = 39;

/** Ignore the top/bottom of the frame — usually the car's window frame or
 * the dashboard, never the horizon. */
const EDGE_MARGIN_FRACTION = 0.1;

/** Default analyses per second. Deliberately low; the caller may override. */
const DEFAULT_SAMPLE_HZ = 6;

/**
 * Rows on each side to average into a row's "cluster" score (see `sample()`).
 * A multi-rail crash barrier is several close, parallel edges plus its own
 * shadow line; this turns them into one wide bump instead of N competing
 * narrow peaks, so the winning position doesn't hop rail-to-rail frame to
 * frame. Kept small and cheap — this is a plain neighbourhood mean, not a
 * separable/prefix-sum blur, because the band is only ~30 rows.
 */
const CLUSTER_RADIUS = 2;

/**
 * Rows on each side used for the final sub-row weighted centroid (see
 * `sample()`). Lets the reported y settle at the weighted middle of a
 * structure instead of snapping to whichever single row is nominally
 * strongest this tick.
 */
const CENTROID_RADIUS = 3;

/**
 * Once locked (smoothedY !== null), a row's cluster score is multiplied by
 * 1 / (1 + (distance / this) ** 2) before competing for "best row", where
 * distance is 0..1 of frame height from the current smoothed estimate. At
 * distance = this radius the weight has already halved; a competing
 * structure has to be substantially stronger than the locked one to win
 * before it even reaches the temporal jump-confirmation gate below. This is
 * the main fix for the crash-barrier case: three rails plus a shadow line
 * sit within a few percent of frame height of each other, so once we're on
 * one of them the others should almost never look more attractive.
 */
const LOCK_STICKINESS_RADIUS = 0.05;

/**
 * Peak-to-mean cluster-score ratio (0..1, see `sample()`) below which we
 * don't trust the picked row at all and report it as "no estimate".
 */
const CONFIDENCE_THRESHOLD = 0.15;

/** Exponential-smoothing factor applied to small, in-band moves. */
const SMOOTH_ALPHA = 0.25;

/**
 * A candidate more than this far (0..1 of frame height) from the current
 * smoothed estimate is a "jump" — probably a scene change, possibly a
 * one-off bad read — and must be confirmed by consecutive agreeing samples
 * before we follow it there.
 */
const JUMP_THRESHOLD = 0.08;

/** How close two jump candidates must land to count as "agreeing". */
const JUMP_AGREEMENT_TOLERANCE = 0.05;

/** Consecutive agreeing samples required before a jump is accepted. */
const JUMP_CONFIRM_SAMPLES = 2;

/**
 * Once a jump is confirmed, ease the smoothed value toward it at this rate
 * per sample rather than snapping straight there in one tick — "confirmed
 * then smooth", not "confirmed then instant".
 */
const JUMP_EASE_ALPHA = 0.35;

/** Distance (0..1 of frame height) at which an eased jump is considered
 * settled and normal small-move smoothing resumes. */
const JUMP_SETTLE_DISTANCE = 0.01;

/**
 * Consecutive low-confidence/rejected samples after which we give up on the
 * smoothed estimate entirely and go back to reporting `y: null`. About 1.3s
 * at the default 6Hz — long enough to ride out a shaky bump, short enough
 * that a genuinely horizon-less scene (parking garage, tunnel) stops biasing
 * the ground line forever. Shorter than it might look: with the lock-radius
 * proximity weighting above, a real, fast repositioning of the tracked
 * structure (the car bouncing, a dip in the road) shows up as exactly this
 * — a run of rejects while the true edge sits outside the lock radius — so
 * this also doubles as "how long we tolerate being spatially stale" before
 * releasing the lock and re-searching the whole frame.
 */
const REJECT_STREAK_TO_NULL = 8;

/** Keeps peak/mean ratio finite when both are ~0 (flat, edge-less frame). */
const EPSILON = 1e-3;

/**
 * Luma-gradient magnitude (0..255 scale) that counts as a "strong" edge for
 * the absolute-strength half of the confidence score below. A crisp
 * sky/ground boundary sits well above this; a foggy, low-contrast scene
 * does not, even if it is the peakiest row in the frame.
 */
const STRONG_EDGE_MAGNITUDE = 18;

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function createSceneAnalyser(options: SceneAnalyserOptions): SceneAnalyser {
  const { video } = options;
  const sampleHz = options.sampleHz ?? DEFAULT_SAMPLE_HZ;
  const sampleIntervalMs = 1000 / Math.max(1, sampleHz);

  // The one object ever handed back from `.horizon`. Mutated in place,
  // never replaced — satisfies the "never allocate" / "stable object"
  // contract for a field read every render frame.
  const horizon: HorizonEstimate = { y: null, confidence: 0 };

  // Working buffers. Allocated once on first successful sample, dropped on
  // stop() (and permanently, if the canvas ever turns out to be tainted).
  let ctx: Context2D | null = null;
  let lumaBuffer: Float32Array | null = null; // SAMPLE_WIDTH * SAMPLE_HEIGHT
  let rowScores: Float32Array | null = null; // SAMPLE_HEIGHT, raw per-row gradient
  let clusterScores: Float32Array | null = null; // SAMPLE_HEIGHT, neighbourhood-smoothed

  let timer: ReturnType<typeof setInterval> | null = null;
  let disabledBySecurityError = false;
  let warnedOnce = false;

  // Smoothing/hysteresis state — internal only, never exposed.
  let smoothedY: number | null = null;
  let pendingY: number | null = null;
  let pendingCount = 0;
  let rejectStreak = 0;
  // Set once a jump has been confirmed; while non-null we ease smoothedY
  // toward it a bit per sample instead of re-running jump detection.
  let confirmedTargetY: number | null = null;

  function trySetupBuffers(): boolean {
    if (ctx && lumaBuffer && rowScores && clusterScores) return true;
    try {
      let context: Context2D | null = null;
      if (typeof OffscreenCanvas !== 'undefined') {
        const oc = new OffscreenCanvas(SAMPLE_WIDTH, SAMPLE_HEIGHT);
        context = oc.getContext('2d', { willReadFrequently: true, alpha: false });
      } else {
        const el = document.createElement('canvas');
        el.width = SAMPLE_WIDTH;
        el.height = SAMPLE_HEIGHT;
        context = el.getContext('2d', { willReadFrequently: true, alpha: false });
      }
      if (!context) return false;
      ctx = context;
      lumaBuffer = new Float32Array(SAMPLE_WIDTH * SAMPLE_HEIGHT);
      rowScores = new Float32Array(SAMPLE_HEIGHT);
      clusterScores = new Float32Array(SAMPLE_HEIGHT);
      return true;
    } catch {
      ctx = null;
      lumaBuffer = null;
      rowScores = null;
      clusterScores = null;
      return false;
    }
  }

  function dropBuffers(): void {
    ctx = null;
    lumaBuffer = null;
    clusterScores = null;
    rowScores = null;
  }

  function resetSmoothing(): void {
    smoothedY = null;
    pendingY = null;
    pendingCount = 0;
    rejectStreak = 0;
    confirmedTargetY = null;
  }

  function applyAcceptedSample(candidateY: number, confidence: number): void {
    rejectStreak = 0;

    if (smoothedY === null) {
      smoothedY = candidateY;
      pendingY = null;
      pendingCount = 0;
      confirmedTargetY = null;
    } else if (confirmedTargetY !== null) {
      // Mid-flight toward an already-confirmed jump: keep easing there
      // regardless of what this tick's raw candidate says, so a confirmed
      // move still reads as one continuous glide rather than a snap
      // followed by a re-triggered hysteresis dance.
      smoothedY = smoothedY + JUMP_EASE_ALPHA * (confirmedTargetY - smoothedY);
      if (Math.abs(confirmedTargetY - smoothedY) <= JUMP_SETTLE_DISTANCE) {
        smoothedY = confirmedTargetY;
        confirmedTargetY = null;
      }
    } else if (Math.abs(candidateY - smoothedY) <= JUMP_THRESHOLD) {
      smoothedY = smoothedY + SMOOTH_ALPHA * (candidateY - smoothedY);
      pendingY = null;
      pendingCount = 0;
    } else {
      // Big jump — require consecutive agreement before following it, so a
      // single stray bad read can't snap the ground line across the screen.
      if (pendingY !== null && Math.abs(candidateY - pendingY) <= JUMP_AGREEMENT_TOLERANCE) {
        pendingCount++;
      } else {
        pendingY = candidateY;
        pendingCount = 1;
      }
      if (pendingCount >= JUMP_CONFIRM_SAMPLES) {
        // Confirmed — start easing toward it over the next several samples
        // rather than assigning it immediately.
        confirmedTargetY = pendingY;
        pendingY = null;
        pendingCount = 0;
        smoothedY = smoothedY + JUMP_EASE_ALPHA * (confirmedTargetY - smoothedY);
      }
    }

    horizon.y = smoothedY;
    horizon.confidence = confidence;
  }

  function applyRejectedSample(): void {
    // No usable estimate this tick. Drop any in-progress jump confirmation
    // — a later jump candidate has to re-earn agreement rather than match a
    // stale pending value from seconds ago — but keep the last smoothed `y`
    // on screen; a stable-but-momentarily-unconfirmed horizon beats a
    // flickering one. Report confidence 0 so the consumer can tell this
    // tick found nothing. After a long enough streak of nothing, give up
    // and go back to null entirely.
    pendingY = null;
    pendingCount = 0;
    rejectStreak++;

    if (rejectStreak >= REJECT_STREAK_TO_NULL) {
      smoothedY = null;
      confirmedTargetY = null;
    }

    horizon.y = smoothedY;
    horizon.confidence = 0;
  }

  function sample(): void {
    if (disabledBySecurityError) return;
    if (document.hidden) return;
    if (video.readyState < 2) return;
    if (video.videoWidth === 0 || video.videoHeight === 0) return;
    if (!trySetupBuffers() || !ctx || !lumaBuffer || !rowScores || !clusterScores) return;

    try {
      ctx.drawImage(video, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
      const imageData = ctx.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
      const data = imageData.data;

      const luma = lumaBuffer;
      for (let i = 0; i < luma.length; i++) {
        const o = i * 4;
        const r = data[o] ?? 0;
        const g = data[o + 1] ?? 0;
        const b = data[o + 2] ?? 0;
        luma[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      }
      // `imageData`/`data` are not referenced again after this loop — the
      // only thing carried forward is `luma`, a reused scratch buffer of
      // brightness numbers.

      const marginRows = Math.round(SAMPLE_HEIGHT * EDGE_MARGIN_FRACTION);
      const bandStart = Math.max(1, marginRows);
      const bandEnd = Math.min(SAMPLE_HEIGHT - 1, SAMPLE_HEIGHT - marginRows);

      const scores = rowScores;
      const clusters = clusterScores;

      // Pass 1: raw per-row gradient score, same definition as before —
      // mean absolute luma difference against the row above.
      for (let y = bandStart; y < bandEnd; y++) {
        const rowOffset = y * SAMPLE_WIDTH;
        const prevOffset = (y - 1) * SAMPLE_WIDTH;
        let sum = 0;
        for (let x = 0; x < SAMPLE_WIDTH; x++) {
          const cur = luma[rowOffset + x] ?? 0;
          const prev = luma[prevOffset + x] ?? 0;
          sum += Math.abs(cur - prev);
        }
        scores[y] = sum / SAMPLE_WIDTH;
      }

      // Pass 2: neighbourhood-smoothed "cluster" score. A multi-rail crash
      // barrier is several close parallel edges plus its own shadow line;
      // averaging over CLUSTER_RADIUS turns that into one wide bump instead
      // of several narrow ones fighting for the single-row maximum, so the
      // winning position stops hopping rail-to-rail frame to frame. This is
      // a plain neighbourhood mean (not a running/prefix-sum blur) — the
      // band is only ~30 rows, so the extra passes stay cheap.
      let clusterSum = 0;
      let clusterCount = 0;
      let globalBestRow = -1;
      let globalBestCluster = -Infinity;
      for (let y = bandStart; y < bandEnd; y++) {
        const lo = Math.max(bandStart, y - CLUSTER_RADIUS);
        const hi = Math.min(bandEnd - 1, y + CLUSTER_RADIUS);
        let sum = 0;
        let count = 0;
        for (let k = lo; k <= hi; k++) {
          sum += scores[k] ?? 0;
          count++;
        }
        const c = count > 0 ? sum / count : 0;
        clusters[y] = c;
        clusterSum += c;
        clusterCount++;
        if (c > globalBestCluster) {
          globalBestCluster = c;
          globalBestRow = y;
        }
      }

      if (globalBestRow < 0 || clusterCount === 0) {
        applyRejectedSample();
        return;
      }

      const clusterMean = clusterSum / clusterCount;

      // Pass 3: pick the row to report. Cold (no lock yet), take the
      // strongest cluster in the frame, same as the old single-row logic.
      // Locked, heavily favour rows near the current smoothed estimate: a
      // competing structure (fence, treeline, a different rail) has to be
      // substantially stronger to win here, and even then still has to
      // clear the temporal jump-confirmation gate in applyAcceptedSample
      // before the lock actually moves. Distance-weighting like this is
      // what stops the estimate drifting across a barrier's full height —
      // without it, three rails a few rows apart swap which one "wins" run
      // to run purely on lighting noise, dragging the reported y with them.
      let pickedRow = globalBestRow;
      let pickedCluster = globalBestCluster;
      if (smoothedY !== null) {
        let bestEffective = -Infinity;
        let bestEffectiveRow = -1;
        let bestEffectiveCluster = 0;
        for (let y = bandStart; y < bandEnd; y++) {
          const rowY = y / (SAMPLE_HEIGHT - 1);
          const distance = Math.abs(rowY - smoothedY);
          const weight = 1 / (1 + (distance / LOCK_STICKINESS_RADIUS) ** 2);
          const c = clusters[y] ?? 0;
          const effective = c * weight;
          if (effective > bestEffective) {
            bestEffective = effective;
            bestEffectiveRow = y;
            bestEffectiveCluster = c;
          }
        }
        if (bestEffectiveRow >= 0) {
          pickedRow = bestEffectiveRow;
          pickedCluster = bestEffectiveCluster;
        }
      }

      // Confidence reflects trust in the row we actually picked (which may
      // be a sticky, not-quite-strongest-this-tick pick), not the frame's
      // global maximum — see the two-factor shape/strength reasoning below,
      // unchanged from before, just applied to cluster scores now.
      //  - shape: normalised peak-to-mean ratio, bounded to [0, 1). A lone
      //    strong structure against a flat background trends to 1; a
      //    uniformly "busy" frame (noise) — where every row is about as
      //    gradient-y as every other — trends to 0 regardless of how strong
      //    the gradients are in absolute terms.
      //  - strength: the picked row's absolute cluster gradient against a
      //    fixed scale, bounded to [0, 1). Without this a foggy, nearly-flat
      //    scene can still produce a "peaky-looking" row purely because its
      //    background noise happens to be even flatter, despite the edge
      //    itself being too faint to be worth trusting.
      const shape = (pickedCluster - clusterMean) / (pickedCluster + clusterMean + EPSILON);
      const strength = Math.min(1, pickedCluster / STRONG_EDGE_MAGNITUDE);
      const confidence = Math.min(1, Math.max(0, shape * strength));

      if (confidence < CONFIDENCE_THRESHOLD) {
        applyRejectedSample();
        return;
      }

      // Sub-row weighted centroid around the picked row, using the raw
      // (unsmoothed) per-row scores so the estimate settles at a structure's
      // weighted middle instead of snapping to whichever exact row is
      // nominally strongest this tick — the other half of the fix for
      // hopping between adjacent rails.
      let centroidNum = 0;
      let centroidDen = 0;
      const cLo = Math.max(bandStart, pickedRow - CENTROID_RADIUS);
      const cHi = Math.min(bandEnd - 1, pickedRow + CENTROID_RADIUS);
      for (let y = cLo; y <= cHi; y++) {
        const w = Math.max(0, (scores[y] ?? 0) - clusterMean);
        centroidNum += y * w;
        centroidDen += w;
      }
      const centroidRow = centroidDen > EPSILON ? centroidNum / centroidDen : pickedRow;

      const candidateY = centroidRow / (SAMPLE_HEIGHT - 1);
      applyAcceptedSample(candidateY, confidence);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'SecurityError') {
        // Tainted canvas — this will throw forever, so stop for good
        // instead of retrying every ~166ms and warning on every attempt.
        disabledBySecurityError = true;
        dropBuffers();
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
        if (!warnedOnce) {
          warnedOnce = true;
          console.warn(
            '[SceneAnalyser] canvas read blocked by a SecurityError; horizon estimation disabled for this session.',
          );
        }
      }
      applyRejectedSample();
    }
  }

  return {
    start(): void {
      if (timer !== null) return;
      if (disabledBySecurityError) return;
      // No readiness check here: `sample()` itself skips ticks until the
      // video has real dimensions and decoded data, so a call before the
      // stream is live just idles harmlessly rather than needing a no-op
      // guard against a "missing" video element (the contract's `video` is
      // always a real element, just not always playing yet).
      timer = setInterval(sample, sampleIntervalMs);
    },
    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      dropBuffers();
      resetSmoothing();
      horizon.y = null;
      horizon.confidence = 0;
    },
    get horizon(): HorizonEstimate {
      return horizon;
    },
  };
}
