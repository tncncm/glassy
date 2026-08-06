/**
 * PRIVACY INVARIANT — read before touching this file.
 *
 * Device motion (rotation rate, linear acceleration) is read live, filtered in
 * place, and handed to the caller as numbers. Nothing here is ever written to
 * `localStorage`, `fetch`-ed anywhere, or retained beyond the current sample —
 * there is no buffer of past readings, no history, no export. The only two
 * values Glassy ever persists live in `src/storage/Preferences.ts` (best
 * score, mute); motion samples are not among them and never will be. If you
 * find code here that stores or transmits a reading, that is a bug: remove it.
 */

import type { MotionSensor, MotionSensorOptions, MotionState } from '../types.ts';

/**
 * iOS 13+ gates `devicemotion` behind an explicit, gesture-triggered
 * permission prompt exposed as a *static* method on the constructor — it does
 * not exist on the prototype, and does not exist at all outside iOS Safari.
 * Every other platform (desktop, Android Chrome) fires `devicemotion` freely
 * once a listener is attached, so on those platforms `request()` is a no-op
 * that resolves `true` as long as the event type exists at all.
 *
 * Declared narrowly, here only — this is not a real DOM API and does not
 * belong in a global `.d.ts`.
 */
interface DeviceMotionEventConstructorWithPermission {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

/**
 * Default exponential low-pass rate for rotation, in 1/s (i.e. the filter's
 * time constant tau = 1/rate). Rotation drives hand-shake stabilisation: the
 * consumer subtracts this from apparent frame motion, so it must track the
 * true underlying rotation with low lag. Hand tremor/shake energy sits
 * roughly in the 2-8Hz band; a 6/s rate (tau ~167ms, ~95% settled in
 * ~3*tau = 500ms) removes single-sample sensor noise (see measurements below)
 * while staying fast enough that the subtraction doesn't fight a laggy
 * estimate of the very shake it's trying to cancel.
 */
const DEFAULT_ROTATION_SMOOTHING_RATE = 6;

/**
 * Acceleration drives the comfort dots, not stabilisation, and vehicle
 * acceleration (accelerating away from lights, easing into a turn) changes on
 * the order of seconds, not the tens-of-milliseconds hand shake operates on.
 * A single shared rate is a real compromise here — see the note below — so
 * acceleration is deliberately smoothed harder than rotation: heavier
 * smoothing suppresses the vibration noise riding on top of the real vehicle
 * motion (engine, road texture, the phone tapping against a hand) without
 * costing the comfort cue anything, since nothing about "drifting dots"
 * benefits from tracking a 6Hz wiggle.
 *
 * `options.smoothingRate` is the single knob the public API exposes (see
 * `MotionSensorOptions` in types.ts, which this file must implement exactly
 * and not extend). Rather than silently applying one rate to everything and
 * calling it tuned, acceleration is filtered at a fixed fraction of whatever
 * rotation rate is in effect — configurable in aggregate, but honest that the
 * two channels want different time constants.
 */
const ACCELERATION_RATE_FACTOR = 0.3;

/** Guards against a caller passing 0 or a negative rate and freezing the filter permanently. */
const MIN_SMOOTHING_RATE = 0.1;

function finiteOrZero(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function permissionCtor(): DeviceMotionEventConstructorWithPermission | null {
  if (typeof DeviceMotionEvent === 'undefined') return null;
  return DeviceMotionEvent as unknown as DeviceMotionEventConstructorWithPermission;
}

export function createMotionSensor(options: MotionSensorOptions): MotionSensor {
  const rotationRate = Math.max(MIN_SMOOTHING_RATE, options.smoothingRate ?? DEFAULT_ROTATION_SMOOTHING_RATE);
  const accelerationRate = Math.max(MIN_SMOOTHING_RATE, rotationRate * ACCELERATION_RATE_FACTOR);

  // The single object handed out via `state` — mutated in place, never
  // reallocated, so `state` is a cheap, allocation-free field read every frame.
  const state: MotionState = {
    available: false,
    rotationAlpha: 0,
    rotationBeta: 0,
    rotationGamma: 0,
    accelerationX: 0,
    accelerationY: 0,
    accelerationZ: 0,
  };

  /** Set true only once request() has resolved truthy. start() no-ops until then. */
  let permitted = false;
  /** Whether the devicemotion listener is currently attached. */
  let listening = false;
  /** Event.timeStamp of the previous sample, for a real (not assumed) dt. `null` before the first sample since (re)attaching. */
  let lastEventTime: number | null = null;

  function handleDeviceMotion(event: DeviceMotionEvent): void {
    // Trivial by construction: a handful of reads, one exp() per channel pair,
    // a subtract-multiply-add per field. No allocation, no branching beyond
    // the first-sample seed below — safe at 60Hz+.
    const rawAlpha = finiteOrZero(event.rotationRate?.alpha);
    const rawBeta = finiteOrZero(event.rotationRate?.beta);
    const rawGamma = finiteOrZero(event.rotationRate?.gamma);
    // Some devices report `acceleration` (gravity-excluded) as null even
    // while `rotationRate` works. Degrading to 0 here — rather than NaN — is
    // exactly what `available` semantics promise: a device missing one
    // channel still reports the other, never poisons the whole state.
    const rawAX = finiteOrZero(event.acceleration?.x);
    const rawAY = finiteOrZero(event.acceleration?.y);
    const rawAZ = finiteOrZero(event.acceleration?.z);

    const now = typeof event.timeStamp === 'number' ? event.timeStamp : performance.now();
    const dt = lastEventTime === null ? 0 : Math.max(0, (now - lastEventTime) / 1000);
    lastEventTime = now;

    if (dt <= 0) {
      // First sample since (re)attaching: seed directly rather than filtering
      // from a stale/zero baseline, so start() doesn't visibly ramp up from 0.
      state.rotationAlpha = rawAlpha;
      state.rotationBeta = rawBeta;
      state.rotationGamma = rawGamma;
      state.accelerationX = rawAX;
      state.accelerationY = rawAY;
      state.accelerationZ = rawAZ;
    } else {
      // Exponential low-pass: smoothed += (1 - e^(-dt*rate)) * (raw - smoothed).
      // Framed in continuous time (rate, not a per-frame constant) so the
      // filter behaves the same whether events arrive at 60Hz or 30Hz.
      const rotAlphaGain = 1 - Math.exp(-dt * rotationRate);
      const accAlphaGain = 1 - Math.exp(-dt * accelerationRate);

      state.rotationAlpha += rotAlphaGain * (rawAlpha - state.rotationAlpha);
      state.rotationBeta += rotAlphaGain * (rawBeta - state.rotationBeta);
      state.rotationGamma += rotAlphaGain * (rawGamma - state.rotationGamma);
      state.accelerationX += accAlphaGain * (rawAX - state.accelerationX);
      state.accelerationY += accAlphaGain * (rawAY - state.accelerationY);
      state.accelerationZ += accAlphaGain * (rawAZ - state.accelerationZ);
    }

    state.available = true;
  }

  async function request(): Promise<boolean> {
    if (typeof window === 'undefined' || typeof DeviceMotionEvent === 'undefined') {
      permitted = false;
      return false;
    }

    const ctor = permissionCtor();
    if (ctor && typeof ctor.requestPermission === 'function') {
      try {
        const result = await ctor.requestPermission();
        permitted = result === 'granted';
        return permitted;
      } catch {
        // Refused, or called outside a user gesture (WebKit throws for that
        // too) — either way this is an expected outcome, not a bug.
        permitted = false;
        return false;
      }
    }

    // No gating API: devicemotion fires without a prompt on this platform.
    permitted = true;
    return true;
  }

  function start(): void {
    if (!permitted || listening) return;
    lastEventTime = null;
    window.addEventListener('devicemotion', handleDeviceMotion);
    listening = true;
  }

  function stop(): void {
    if (listening) {
      window.removeEventListener('devicemotion', handleDeviceMotion);
      listening = false;
    }
    lastEventTime = null;
    // No events arriving means nothing here is trustworthy — reset in place
    // (same object, no allocation) rather than leaving a stale last reading
    // that looks live to a caller who only checks `available`.
    state.available = false;
    state.rotationAlpha = 0;
    state.rotationBeta = 0;
    state.rotationGamma = 0;
    state.accelerationX = 0;
    state.accelerationY = 0;
    state.accelerationZ = 0;
  }

  return {
    request,
    start,
    stop,
    get state(): MotionState {
      return state;
    },
  };
}
