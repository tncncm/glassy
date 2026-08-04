/**
 * localStorage wrapper — the ONLY two values Glassy ever persists.
 *
 * Every read and write is wrapped in try/catch: Safari private mode throws on
 * write (and some private-mode configurations throw on read too). On any
 * failure we fall back to an in-memory value so the app keeps working.
 */

import type { Preferences } from '../types.ts';

const BEST_SCORE_KEY = 'bestScore';
const MUTED_KEY = 'muted';

function parseBestScore(raw: string | null): number {
  if (raw === null) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function parseMuted(raw: string | null): boolean {
  return raw === 'true';
}

export function createPreferences(): Preferences {
  // In-memory fallback, used whenever localStorage is unavailable or throws.
  let memoryBestScore = 0;
  let memoryMuted = false;

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
  };
}
