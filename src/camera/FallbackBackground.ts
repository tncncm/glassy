/**
 * Animated "moving scenery past a car window" background, rendered with plain
 * 2D canvas primitives. Used whenever `CameraController` cannot show a live
 * camera feed, so the game stays fully playable with no camera at all.
 *
 * Zero external assets. Zero per-frame allocation: every gradient/shape is
 * either a hoisted constant or computed from numeric offsets recomputed each
 * frame — nothing is `new`'d inside the RAF loop.
 */

export interface FallbackBackground {
  /** Start (or resume) the RAF loop. Safe to call repeatedly. */
  start(): void;
  /** Cancel the RAF loop. Safe to call repeatedly, including before start(). */
  stop(): void;
  /** Resize the backing store (DPR-capped) and redraw one frame immediately. */
  resize(width: number, height: number): void;
}

/** A single horizontal parallax layer of drifting shapes. */
interface Band {
  /** Fraction of canvas height where the band's baseline sits (0 = top). */
  baselineFrac: number;
  /** Fraction of canvas height each shape rises above the baseline. */
  reliefFrac: number;
  /** Horizontal drift speed in backing-store px/sec (reference width 1280). */
  speed: number;
  /** Spacing between shape centers, in backing-store px (reference width 1280). */
  spacing: number;
  /** Shape radius as a fraction of `spacing`. */
  radiusFrac: number;
  fill: string;
}

// Furthest band drifts slowest and is palest; nearest band drifts fastest and
// is darkest — classic parallax read as "distance".
const BANDS: readonly Band[] = [
  { baselineFrac: 0.62, reliefFrac: 0.10, speed: 18, spacing: 220, radiusFrac: 0.45, fill: 'rgba(255,255,255,0.16)' },
  { baselineFrac: 0.74, reliefFrac: 0.16, speed: 42, spacing: 160, radiusFrac: 0.5, fill: 'rgba(255,255,255,0.22)' },
  { baselineFrac: 0.88, reliefFrac: 0.22, speed: 90, spacing: 110, radiusFrac: 0.55, fill: 'rgba(255,255,255,0.30)' },
];

const REFERENCE_WIDTH = 1280;
const MAX_DPR = 2;
/** Backing store is rendered below CSS size and upscaled — cheap under a live Pixi canvas. */
const RENDER_SCALE = 0.5;
/** Clamp large gaps (tab was backgrounded) so a resumed RAF doesn't jump the scenery. */
const MAX_DT = 0.1;
/** Reduced-motion users still see life in the background, just much slower. */
const REDUCED_MOTION_FACTOR = 0.12;

export function createFallbackBackground(canvas: HTMLCanvasElement): FallbackBackground {
  const ctx = canvas.getContext('2d', { alpha: false });

  if (!ctx) {
    // Extremely unlikely (2D context unavailable) — degrade to a no-op so the
    // caller never has to special-case a missing context.
    return { start(): void {}, stop(): void {}, resize(): void {} };
  }

  const context = ctx;
  const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  let backingWidth = Math.max(1, canvas.width || 1);
  let backingHeight = Math.max(1, canvas.height || 1);
  let skyGradient = makeSkyGradient(context, backingHeight);

  let rafId: number | null = null;
  let lastTimestamp = 0;
  let elapsed = 0;

  function draw(): void {
    context.fillStyle = skyGradient;
    context.fillRect(0, 0, backingWidth, backingHeight);

    const widthScale = backingWidth / REFERENCE_WIDTH;

    for (const band of BANDS) {
      const spacing = band.spacing * widthScale;
      const radius = spacing * band.radiusFrac;
      const baseline = backingHeight * band.baselineFrac;
      const relief = backingHeight * band.reliefFrac;
      const offset = (elapsed * band.speed * widthScale) % spacing;

      context.fillStyle = band.fill;
      context.beginPath();
      // One extra shape on each side so the wrap is seamless at the edges.
      for (let x = -spacing - offset; x < backingWidth + spacing; x += spacing) {
        context.moveTo(x + radius, baseline);
        context.arc(x, baseline, radius, 0, Math.PI, true);
        context.lineTo(x - radius, baseline + relief);
        context.lineTo(x + radius, baseline + relief);
        context.closePath();
      }
      context.fill();

      // Wash the strip below the band's baseline with the same translucent
      // fill so nearer bands layer over the ones behind them.
      context.fillRect(0, baseline, backingWidth, backingHeight - baseline);
    }
  }

  function frame(timestamp: number): void {
    if (lastTimestamp === 0) lastTimestamp = timestamp;
    const dt = Math.min(MAX_DT, Math.max(0, (timestamp - lastTimestamp) / 1000));
    lastTimestamp = timestamp;

    const speedFactor = reducedMotionQuery.matches ? REDUCED_MOTION_FACTOR : 1;
    elapsed += dt * speedFactor;

    draw();
    rafId = requestAnimationFrame(frame);
  }

  function start(): void {
    if (rafId !== null) return;
    lastTimestamp = 0;
    rafId = requestAnimationFrame(frame);
  }

  function stop(): void {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function resize(width: number, height: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    backingWidth = Math.max(1, Math.round(width * dpr * RENDER_SCALE));
    backingHeight = Math.max(1, Math.round(height * dpr * RENDER_SCALE));
    canvas.width = backingWidth;
    canvas.height = backingHeight;
    skyGradient = makeSkyGradient(context, backingHeight);
    draw();
  }

  // Establish a sane initial backing store even if the caller hasn't called
  // resize() yet — e.g. start() invoked before the first layout pass.
  resize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);

  return { start, stop, resize };
}

function makeSkyGradient(context: CanvasRenderingContext2D, height: number): CanvasGradient {
  // Gradients are position-bound, so this is only ever rebuilt on resize —
  // never inside the per-frame draw() call.
  const gradient = context.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, '#6f8fae');
  gradient.addColorStop(0.55, '#93a9bd');
  gradient.addColorStop(1, '#b7c2c9');
  return gradient;
}
