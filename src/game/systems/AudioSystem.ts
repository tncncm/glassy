/**
 * AudioSystem — every sound Glassy makes is synthesised at runtime with the
 * Web Audio API. No fetch, no base64, no sample files.
 *
 * Lifecycle contract (see types.ts):
 *  - The AudioContext is constructed lazily, inside `unlock()`, which the
 *    caller must invoke from a user gesture (the Play tap). It is never
 *    constructed at module load — a context created on load starts
 *    `suspended` on iOS and can sit there uselessly if the gesture never
 *    arrives, or interfere with other audio on the page.
 *  - iOS Safari starts every AudioContext `suspended`. `unlock()` awaits
 *    `resume()` and then plays a one-sample silent buffer through a real
 *    source node — the classic WebKit unlock trick. Some iOS versions only
 *    fully commit to "unlocked" after a buffer has actually played once,
 *    so `resume()` alone is not trusted on its own.
 *  - `suspend()` / `resume()` handle backgrounding. iOS re-suspends contexts
 *    when the PWA is hidden (and Safari also exposes a `interrupted` state,
 *    e.g. for a phone call, which we treat identically to `suspended`).
 *    `resume()` tracks whether the system was actually running before the
 *    suspend so it never resurrects a context the app deliberately muted-out
 *    or never unlocked in the first place.
 *  - Nothing here ever throws. Construction, unlock, and every `play()` call
 *    are wrapped in try/catch. If the browser has no AudioContext, or
 *    construction fails for any reason, the whole system silently degrades
 *    to a no-op implementation and the game stays fully playable.
 */

import type { AudioSystem, SoundName } from '../../types.ts';

/** Safari-only constructor name; not present in lib.dom's Window type. */
interface WebkitWindow {
  webkitAudioContext?: typeof AudioContext;
}

function getAudioContextCtor(): typeof AudioContext | undefined {
  const w = window as unknown as WebkitWindow;
  return window.AudioContext ?? w.webkitAudioContext;
}

/** Master output level; sounds are mixed well under this so nothing clips. */
const MASTER_GAIN = 0.6;
/** Mute/unmute ramp time — avoids the click of an instant gain jump. */
const MUTE_RAMP_SECONDS = 0.05;
/** Floor for exponential ramps — they can never target exactly 0. */
const SILENCE_FLOOR = 0.0001;
/** Per-sound retrigger guard so e.g. `score` can't machine-gun. */
const RETRIGGER_GUARD_SECONDS = 0.03;
/** Hard cap on simultaneous one-shot voices. */
const MAX_VOICES = 8;
/** Length of the pre-baked noise buffer used for land/collide bursts. */
const NOISE_BUFFER_SECONDS = 0.3;

function createNoOpAudioSystem(): AudioSystem {
  let muted = false;
  return {
    unlock: async (): Promise<void> => {
      // No AudioContext available in this browser — nothing to unlock.
    },
    play: (): void => {
      // Silently do nothing.
    },
    setMuted: (value: boolean): void => {
      muted = value;
    },
    isMuted: (): boolean => muted,
    suspend: (): void => {
      // Nothing running.
    },
    resume: (): void => {
      // Nothing to resume.
    },
    dispose: (): void => {
      // Nothing to release.
    },
  };
}

export function createAudioSystem(initialMuted: boolean): AudioSystem {
  const detectedCtor = getAudioContextCtor();
  if (!detectedCtor) {
    return createNoOpAudioSystem();
  }
  // Re-bound to a non-optional const: TS narrowing of the outer `let`-like
  // check above does not persist into the nested closures defined below.
  const Ctor: typeof AudioContext = detectedCtor;

  let ctx: AudioContext | null = null;
  let masterGain: GainNode | null = null;
  let noiseBuffer: AudioBuffer | null = null;
  let muted = initialMuted;
  /** True once unlock() has successfully resumed the context at least once. */
  let unlocked = false;
  /** Tracks whether we were actually running before a suspend(), so resume() never un-suspends a deliberately-idle system. */
  let wasRunningBeforeSuspend = false;
  let activeVoices = 0;
  const lastPlayedAt = new Map<SoundName, number>();
  let disposed = false;

  function buildNoiseBuffer(context: AudioContext): AudioBuffer {
    const frameCount = Math.floor(context.sampleRate * NOISE_BUFFER_SECONDS);
    const buffer = context.createBuffer(1, frameCount, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  function ensureContext(): AudioContext | null {
    if (disposed) return null;
    if (ctx) return ctx;
    try {
      const created = new Ctor();
      const gain = created.createGain();
      gain.gain.value = muted ? SILENCE_FLOOR : MASTER_GAIN;
      gain.connect(created.destination);
      ctx = created;
      masterGain = gain;
      noiseBuffer = buildNoiseBuffer(created);
      return created;
    } catch {
      ctx = null;
      masterGain = null;
      noiseBuffer = null;
      return null;
    }
  }

  /** Play a near-silent one-frame buffer — the reliable WebKit unlock trick. */
  function primeSilentBuffer(context: AudioContext): void {
    try {
      const buffer = context.createBuffer(1, 1, context.sampleRate);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.start(0);
      source.stop(context.currentTime + 0.001);
    } catch {
      // Best-effort; absence of this trick just means slightly less reliable unlock.
    }
  }

  async function unlock(): Promise<void> {
    if (disposed) return;
    try {
      const context = ensureContext();
      if (!context) return;
      if (context.state !== 'running') {
        await context.resume();
      }
      primeSilentBuffer(context);
      unlocked = context.state === 'running';
      wasRunningBeforeSuspend = unlocked;
    } catch {
      // Swallow — play() will simply no-op if the context never came up.
    }
  }

  function canPlay(): boolean {
    if (disposed || muted || !unlocked) return false;
    if (!ctx || !masterGain || !noiseBuffer) return false;
    return ctx.state === 'running';
  }

  function now(): number {
    return ctx ? ctx.currentTime : 0;
  }

  /** Envelope helper: ramp a gain up then decay it exponentially to silence. */
  function applyEnvelope(
    gainNode: GainNode,
    startTime: number,
    peak: number,
    attack: number,
    decayEnd: number,
  ): void {
    const g = gainNode.gain;
    g.cancelScheduledValues(startTime);
    g.setValueAtTime(SILENCE_FLOOR, startTime);
    g.linearRampToValueAtTime(peak, startTime + attack);
    g.exponentialRampToValueAtTime(SILENCE_FLOOR, decayEnd);
  }

  function releaseVoice(): void {
    activeVoices = Math.max(0, activeVoices - 1);
  }

  function playJump(context: AudioContext, destination: GainNode, startTime: number): void {
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(320, startTime);
    osc.frequency.exponentialRampToValueAtTime(720, startTime + 0.09);
    applyEnvelope(gain, startTime, 0.5, 0.008, startTime + 0.09);
    osc.connect(gain);
    gain.connect(destination);
    osc.start(startTime);
    osc.stop(startTime + 0.1);
    osc.onended = (): void => {
      osc.disconnect();
      gain.disconnect();
      releaseVoice();
    };
  }

  function playLand(context: AudioContext, destination: GainNode, startTime: number, buffer: AudioBuffer): void {
    // Low sine thud.
    const osc = context.createOscillator();
    const oscGain = context.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(160, startTime);
    osc.frequency.exponentialRampToValueAtTime(70, startTime + 0.08);
    applyEnvelope(oscGain, startTime, 0.6, 0.004, startTime + 0.08);
    osc.connect(oscGain);
    oscGain.connect(destination);
    osc.start(startTime);
    osc.stop(startTime + 0.09);

    // Filtered noise burst under it.
    const noise = context.createBufferSource();
    noise.buffer = buffer;
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(500, startTime);
    const noiseGain = context.createGain();
    applyEnvelope(noiseGain, startTime, 0.25, 0.002, startTime + 0.07);
    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(destination);
    noise.start(startTime);
    noise.stop(startTime + 0.08);

    noise.onended = (): void => {
      osc.disconnect();
      oscGain.disconnect();
      noise.disconnect();
      filter.disconnect();
      noiseGain.disconnect();
      releaseVoice();
    };
  }

  function playCollide(context: AudioContext, destination: GainNode, startTime: number, buffer: AudioBuffer): void {
    const duration = 0.22;
    // Detuned descending sawtooth crunch.
    const osc = context.createOscillator();
    const osc2 = context.createOscillator();
    const oscGain = context.createGain();
    osc.type = 'sawtooth';
    osc2.type = 'sawtooth';
    osc.frequency.setValueAtTime(220, startTime);
    osc.frequency.exponentialRampToValueAtTime(60, startTime + duration);
    osc2.frequency.setValueAtTime(233, startTime);
    osc2.frequency.exponentialRampToValueAtTime(58, startTime + duration);
    applyEnvelope(oscGain, startTime, 0.5, 0.003, startTime + duration);
    osc.connect(oscGain);
    osc2.connect(oscGain);
    oscGain.connect(destination);
    osc.start(startTime);
    osc2.start(startTime);
    osc.stop(startTime + duration + 0.01);
    osc2.stop(startTime + duration + 0.01);

    // Noise burst with a downward lowpass sweep for the "crunch".
    const noise = context.createBufferSource();
    noise.buffer = buffer;
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(4000, startTime);
    filter.frequency.exponentialRampToValueAtTime(200, startTime + duration);
    const noiseGain = context.createGain();
    applyEnvelope(noiseGain, startTime, 0.35, 0.002, startTime + duration);
    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(destination);
    noise.start(startTime);
    noise.stop(startTime + duration + 0.01);

    noise.onended = (): void => {
      osc.disconnect();
      osc2.disconnect();
      oscGain.disconnect();
      noise.disconnect();
      filter.disconnect();
      noiseGain.disconnect();
      releaseVoice();
    };
  }

  function playScore(context: AudioContext, destination: GainNode, startTime: number): void {
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1100, startTime);
    applyEnvelope(gain, startTime, 0.2, 0.002, startTime + 0.05);
    osc.connect(gain);
    gain.connect(destination);
    osc.start(startTime);
    osc.stop(startTime + 0.06);
    osc.onended = (): void => {
      osc.disconnect();
      gain.disconnect();
      releaseVoice();
    };
  }

  function playGameOver(context: AudioContext, destination: GainNode, startTime: number): void {
    const notes = [440, 349.23, 261.63]; // A4 -> F4 -> C4, a short descending motif.
    const noteDuration = 0.18;
    const oscs: OscillatorNode[] = [];
    const gains: GainNode[] = [];
    notes.forEach((freq, i) => {
      const t = startTime + i * noteDuration;
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t);
      applyEnvelope(gain, t, 0.45, 0.005, t + noteDuration * 0.95);
      osc.connect(gain);
      gain.connect(destination);
      osc.start(t);
      osc.stop(t + noteDuration);
      oscs.push(osc);
      gains.push(gain);
    });
    const last = oscs[oscs.length - 1];
    if (last) {
      last.onended = (): void => {
        oscs.forEach((o) => o.disconnect());
        gains.forEach((g) => g.disconnect());
        releaseVoice();
      };
    } else {
      releaseVoice();
    }
  }

  function playClick(context: AudioContext, destination: GainNode, startTime: number): void {
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1500, startTime);
    applyEnvelope(gain, startTime, 0.15, 0.001, startTime + 0.03);
    osc.connect(gain);
    gain.connect(destination);
    osc.start(startTime);
    osc.stop(startTime + 0.035);
    osc.onended = (): void => {
      osc.disconnect();
      gain.disconnect();
      releaseVoice();
    };
  }

  function play(name: SoundName): void {
    try {
      if (!canPlay()) return;
      if (activeVoices >= MAX_VOICES) return;

      const context = ctx;
      const destination = masterGain;
      const buffer = noiseBuffer;
      if (!context || !destination || !buffer) return;

      const t = now();
      const last = lastPlayedAt.get(name);
      if (last !== undefined && t - last < RETRIGGER_GUARD_SECONDS) return;
      lastPlayedAt.set(name, t);

      activeVoices += 1;
      switch (name) {
        case 'jump':
          playJump(context, destination, t);
          break;
        case 'land':
          playLand(context, destination, t, buffer);
          break;
        case 'collide':
          playCollide(context, destination, t, buffer);
          break;
        case 'score':
          playScore(context, destination, t);
          break;
        case 'gameOver':
          playGameOver(context, destination, t);
          break;
        case 'click':
          playClick(context, destination, t);
          break;
        default: {
          // Exhaustiveness guard — SoundName is a closed union.
          const _exhaustive: never = name;
          releaseVoice();
          void _exhaustive;
        }
      }
    } catch {
      // A single failed sound must never break the game.
    }
  }

  function setMuted(value: boolean): void {
    muted = value;
    try {
      if (ctx && masterGain) {
        const target = muted ? SILENCE_FLOOR : MASTER_GAIN;
        const g = masterGain.gain;
        const t = ctx.currentTime;
        g.cancelScheduledValues(t);
        g.setValueAtTime(g.value, t);
        g.linearRampToValueAtTime(target, t + MUTE_RAMP_SECONDS);
      }
    } catch {
      // Ignore — mute state is still tracked in `muted` for isMuted()/play().
    }
  }

  function isMuted(): boolean {
    return muted;
  }

  function suspend(): void {
    try {
      if (!ctx) return;
      wasRunningBeforeSuspend = ctx.state === 'running';
      if (ctx.state === 'running') {
        void ctx.suspend();
      }
    } catch {
      // Ignore — nothing we can do if suspend() itself throws.
    }
  }

  function resume(): void {
    try {
      if (!ctx || !unlocked) return;
      if (!wasRunningBeforeSuspend) return;
      const state = ctx.state as AudioContextState | 'interrupted';
      if (state === 'suspended' || state === 'interrupted') {
        void ctx.resume();
      }
    } catch {
      // Ignore — a failed resume just means the next play() no-ops.
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    try {
      lastPlayedAt.clear();
      if (masterGain) {
        masterGain.disconnect();
      }
      if (ctx) {
        void ctx.close();
      }
    } catch {
      // Ignore — best-effort teardown.
    } finally {
      ctx = null;
      masterGain = null;
      noiseBuffer = null;
      unlocked = false;
      wasRunningBeforeSuspend = false;
    }
  }

  return { unlock, play, setMuted, isMuted, suspend, resume, dispose };
}
