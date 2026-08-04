/**
 * GameLoop — owns a single requestAnimationFrame chain and hands the
 * orchestrator a clamped, delta-time-in-seconds `step(dt)` callback. Pixi's
 * own ticker/autoStart is deliberately left off (the Application is
 * constructed with `autoStart: false`); this is the one driver of both game
 * state and rendering, so there is never a question of which loop "owns" a
 * frame.
 *
 * `start()` is also how `resume()` is implemented: it resets `lastTime` to
 * "now", so the frame immediately after a pause/backgrounding sees a normal
 * single-frame dt instead of the entire wall-clock gap the tab was hidden
 * for. That gap-swallowing is the whole reason this is its own module
 * instead of an inline `requestAnimationFrame` call in Game.ts.
 */

import { MAX_DELTA_SECONDS } from './config.ts';
import { clamp } from './util/math.ts';

export type StepFn = (dtSeconds: number) => void;

export class GameLoop {
  private readonly step: StepFn;
  private readonly frame: (time: number) => void;
  private rafHandle: number | null = null;
  private lastTime = 0;

  constructor(step: StepFn) {
    this.step = step;
    this.frame = this.onFrame.bind(this);
  }

  get isRunning(): boolean {
    return this.rafHandle !== null;
  }

  /** Idempotent. Also used to resume — see class doc. */
  start(): void {
    if (this.rafHandle !== null) return;
    this.lastTime = performance.now();
    this.rafHandle = requestAnimationFrame(this.frame);
  }

  /** Idempotent. */
  stop(): void {
    if (this.rafHandle === null) return;
    cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
  }

  private onFrame(time: number): void {
    const dtSeconds = clamp((time - this.lastTime) / 1000, 0, MAX_DELTA_SECONDS);
    this.lastTime = time;
    this.step(dtSeconds);
    // Only re-arm if still running — `step` can synchronously call stop()
    // (e.g. a collision ending the run) and must not have a frame race back in.
    if (this.rafHandle !== null) {
      this.rafHandle = requestAnimationFrame(this.frame);
    }
  }
}
