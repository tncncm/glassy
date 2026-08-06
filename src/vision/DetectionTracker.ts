/**
 * DetectionTracker — turns jittery per-frame detections into stable objects.
 *
 * PRIVACY: this file never sees a pixel. It receives boxes that are already
 * plain numbers and keeps only numbers. Nothing here is stored or sent.
 *
 * Why it exists: the detector runs at a few Hz and its box wobbles frame to
 * frame, and it drops out entirely for a frame now and then. Building a
 * platform the player stands on directly from raw detections would make it
 * flicker, teleport and vanish underfoot. So each detection is associated with
 * the object it belongs to, its box is smoothed, and a track survives a few
 * missed frames before it is given up on.
 *
 * The bias throughout is: slightly behind and steady beats exactly-right and
 * twitchy. A platform that lags 100ms is fine; one that jitters is unusable.
 */

import type { DetectedKind, Detection, TrackedObject } from '../types.ts';

/** Boxes overlapping less than this are never considered the same object. */
const MIN_IOU_TO_MATCH = 0.2;
/** Consecutive confirmations before a track is trusted for gameplay. */
const CONFIRMATIONS_TO_STABILISE = 3;
/** Seconds a track survives with no matching detection before it is dropped. */
const MAX_COAST_SECONDS = 0.9;
/** Exponential smoothing rate (1/s) for position and size. */
const SMOOTHING_RATE = 8;
/** Hard cap; far above any plausible scene, purely a runaway guard. */
const MAX_TRACKS = 12;

interface Track {
  id: number;
  kind: DetectedKind;
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
  ageSeconds: number;
  secondsSinceSeen: number;
  confirmations: number;
  /** False once expired, so the slot can be reused without reallocating. */
  active: boolean;
  /** Set each pass so a detection can't claim two tracks. */
  matchedThisPass: boolean;
}

function iou(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): number {
  const aLeft = ax - aw / 2, aRight = ax + aw / 2;
  const aTop = ay - ah / 2, aBottom = ay + ah / 2;
  const bLeft = bx - bw / 2, bRight = bx + bw / 2;
  const bTop = by - bh / 2, bBottom = by + bh / 2;

  const overlapW = Math.min(aRight, bRight) - Math.max(aLeft, bLeft);
  const overlapH = Math.min(aBottom, bBottom) - Math.max(aTop, bTop);
  if (overlapW <= 0 || overlapH <= 0) return 0;

  const overlap = overlapW * overlapH;
  const union = aw * ah + bw * bh - overlap;
  return union > 0 ? overlap / union : 0;
}

/** `1 - e^(-rate*dt)`, the same frame-rate-independent smoothing used in game. */
function smoothingFactor(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

export interface DetectionTracker {
  /**
   * Fold a fresh batch of detections in. `dt` is seconds since the previous
   * update. Returns the live tracks — a REUSED array of REUSED objects, valid
   * only until the next call. Read it synchronously; never retain it.
   */
  update(detections: readonly Detection[], dt: number): readonly TrackedObject[];
  /** Forget everything. Used when the scene changes (e.g. mode switch). */
  reset(): void;
}

export function createDetectionTracker(): DetectionTracker {
  // Everything is preallocated: this runs a few times a second forever.
  const tracks: Track[] = Array.from({ length: MAX_TRACKS }, () => ({
    id: 0, kind: 'vehicle', x: 0, y: 0, width: 0, height: 0, score: 0,
    ageSeconds: 0, secondsSinceSeen: 0, confirmations: 0,
    active: false, matchedThisPass: false,
  }));
  const output: TrackedObject[] = Array.from({ length: MAX_TRACKS }, () => ({
    id: 0, kind: 'vehicle', x: 0, y: 0, width: 0, height: 0, score: 0,
    surfaceY: 0, surfaceLeft: 0, surfaceRight: 0,
    age: 0, stable: false,
  }));
  const live: TrackedObject[] = [];

  let nextId = 1;

  function claimSlot(): Track | null {
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (t && !t.active) return t;
    }
    return null;
  }

  function update(detections: readonly Detection[], dt: number): readonly TrackedObject[] {
    const step = Math.max(0, Math.min(dt, 1));

    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (t) t.matchedThisPass = false;
    }

    // Greedy association. A handful of boxes against a handful of tracks —
    // the Hungarian algorithm would be correct and pointless at this size.
    for (let d = 0; d < detections.length; d++) {
      const det = detections[d];
      if (!det) continue;

      let best: Track | null = null;
      let bestIou = MIN_IOU_TO_MATCH;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        if (!t || !t.active || t.matchedThisPass || t.kind !== det.kind) continue;
        const overlap = iou(t.x, t.y, t.width, t.height, det.x, det.y, det.width, det.height);
        if (overlap > bestIou) {
          bestIou = overlap;
          best = t;
        }
      }

      if (best) {
        const k = smoothingFactor(SMOOTHING_RATE, step);
        best.x += (det.x - best.x) * k;
        best.y += (det.y - best.y) * k;
        best.width += (det.width - best.width) * k;
        best.height += (det.height - best.height) * k;
        best.score = det.score;
        best.secondsSinceSeen = 0;
        best.matchedThisPass = true;
        if (best.confirmations < CONFIRMATIONS_TO_STABILISE) best.confirmations++;
        continue;
      }

      // Unmatched detection: a new object, if we have room. Starts unstable,
      // so a single-frame false positive can never reach gameplay.
      const slot = claimSlot();
      if (!slot) continue;
      slot.id = nextId++;
      slot.kind = det.kind;
      slot.x = det.x;
      slot.y = det.y;
      slot.width = det.width;
      slot.height = det.height;
      slot.score = det.score;
      slot.ageSeconds = 0;
      slot.secondsSinceSeen = 0;
      slot.confirmations = 1;
      slot.active = true;
      slot.matchedThisPass = true;
    }

    // Age everything, coast the unmatched, expire what's been gone too long.
    live.length = 0;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (!t || !t.active) continue;

      t.ageSeconds += step;
      if (!t.matchedThisPass) {
        t.secondsSinceSeen += step;
        if (t.secondsSinceSeen > MAX_COAST_SECONDS) {
          t.active = false;
          continue;
        }
      }

      const slot = output[live.length];
      if (!slot) continue;
      slot.id = t.id;
      slot.kind = t.kind;
      slot.x = t.x;
      slot.y = t.y;
      slot.width = t.width;
      slot.height = t.height;
      slot.score = t.score;
      // Fallback landing surface: the box's own top edge and sides. Callers
      // (see ObjectDetector.ts) may refine this via RoofFinder before the
      // object is handed out; if refinement doesn't run or doesn't trust
      // its answer this tick, this is what ships — always populated, never
      // left at a stale or zero value.
      slot.surfaceY = t.y - t.height / 2;
      slot.surfaceLeft = t.x - t.width / 2;
      slot.surfaceRight = t.x + t.width / 2;
      slot.age = t.ageSeconds;
      slot.stable = t.confirmations >= CONFIRMATIONS_TO_STABILISE;
      live.push(slot);
    }

    return live;
  }

  function reset(): void {
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (t) t.active = false;
    }
    live.length = 0;
  }

  return { update, reset };
}
