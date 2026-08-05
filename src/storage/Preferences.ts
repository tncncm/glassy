/**
 * localStorage wrapper — the ONLY four values Glassy ever persists:
 * `bestScore`, `muted`, `visionEnabled`, `visionMode`. Nothing else.
 *
 * Every read and write is wrapped in try/catch: Safari private mode throws on
 * write (and some private-mode configurations throw on read too). On any
 * failure we fall back to an in-memory value so the app keeps working.
 */

import type { Preferences, VisionMode } from '../types.ts';

const BEST_SCORE_KEY = 'bestScore';
const MUTED_KEY = 'muted';
const VISION_ENABLED_KEY = 'visionEnabled';
const VISION_MODE_KEY = 'visionMode';

function parseBestScore(raw: string | null): number {
  if (raw === null) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function parseMuted(raw: string | null): boolean {
  return raw === 'true';
}

// Same shape as parseMuted, kept separate: the two keys are conceptually
// unrelated and must be free to diverge without one edit silently touching
// the other.
function parseVisionEnabled(raw: string | null): boolean {
  return raw === 'true';
}

// Defensive parsing: anything that isn't exactly one of the two known modes
// (missing key, corrupted value, a future/former variant) falls back to the
// 'window' default rather than propagating garbage into the game layer.
function parseVisionMode(raw: string | null): VisionMode {
  return raw === 'windscreen' ? 'windscreen' : 'window';
}

export function createPreferences(): Preferences {
  // In-memory fallback, used whenever localStorage is unavailable or throws.
  let memoryBestScore = 0;
  let memoryMuted = false;
  // Defaults to false: object detection costs a multi-megabyte download and
  // real battery, so it must be a deliberate opt-in, never default-on.
  let memoryVisionEnabled = false;
  // Defaults to 'window': the side-window framing is the original, better-
  // understood behaviour, so an unset preference must not silently switch a
  // returning user to windscreen mode.
  let memoryVisionMode: VisionMode = 'window';

  function readBestScore(): number {
    try {
      return parseBestScore(window.localStorage.getItem(BEST_SCORE_KEY));
    } catch {
      return memoryBestScore;
    }
  }

  function writeBestScore(value: number): void {
    memoryBestScore = value;
    try {
      window.localStorage.setItem(BEST_SCORE_KEY, String(value));
    } catch {
      // Safari private mode (or any storage failure): keep the in-memory copy.
    }
  }

  function readMuted(): boolean {
    try {
      return parseMuted(window.localStorage.getItem(MUTED_KEY));
    } catch {
      return memoryMuted;
    }
  }

  function writeMuted(value: boolean): void {
    memoryMuted = value;
    try {
      window.localStorage.setItem(MUTED_KEY, String(value));
    } catch {
      // Safari private mode (or any storage failure): keep the in-memory copy.
    }
  }

  function readVisionEnabled(): boolean {
    try {
      return parseVisionEnabled(window.localStorage.getItem(VISION_ENABLED_KEY));
    } catch {
      return memoryVisionEnabled;
    }
  }

  function writeVisionEnabled(value: boolean): void {
    memoryVisionEnabled = value;
    try {
      window.localStorage.setItem(VISION_ENABLED_KEY, String(value));
    } catch {
      // Safari private mode (or any storage failure): keep the in-memory copy.
    }
  }

  function readVisionMode(): VisionMode {
    try {
      return parseVisionMode(window.localStorage.getItem(VISION_MODE_KEY));
    } catch {
      return memoryVisionMode;
    }
  }

  function writeVisionMode(value: VisionMode): void {
    memoryVisionMode = value;
    try {
      window.localStorage.setItem(VISION_MODE_KEY, value);
    } catch {
      // Safari private mode (or any storage failure): keep the in-memory copy.
    }
  }

  return {
    getBestScore(): number {
      return readBestScore();
    },
    setBestScore(score: number): number {
      const safeScore = Number.isFinite(score) && score > 0 ? Math.floor(score) : 0;
      const current = readBestScore();
      if (safeScore > current) {
        writeBestScore(safeScore);
        return safeScore;
      }
      return current;
    },
    getMuted(): boolean {
      return readMuted();
    },
    setMuted(muted: boolean): void {
      writeMuted(muted);
    },
    getVisionEnabled(): boolean {
      return readVisionEnabled();
    },
    setVisionEnabled(enabled: boolean): void {
      writeVisionEnabled(enabled);
    },
    getVisionMode(): VisionMode {
      return readVisionMode();
    },
    setVisionMode(mode: VisionMode): void {
      writeVisionMode(mode);
    },
  };
}
