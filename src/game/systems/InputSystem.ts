/**
 * InputSystem — pointer + keyboard input on the Pixi canvas, for BOTH game
 * modes. `setMode()` switches which gesture set is live; the two are
 * entirely separate code paths (see the per-mode sections below) so
 * 'runner''s behaviour is provably untouched by anything crossing-mode adds.
 *
 * ============================ RUNNER MODE ============================
 *
 * GESTURE ARBITRATION — a pointer gesture commits to exactly one meaning,
 * the instant it crosses a threshold, and can never resolve as anything
 * else afterward (the existing vertical-drag-vs-tap commitment pattern,
 * extended to two axes):
 *
 *   - Short, low-movement gesture (never committed) → tap → JUMP.
 *   - |dx| past SWIPE_THRESHOLD_PX AND |dx| > |dy| → commits to DASH, fires
 *     once immediately. Works whether grounded or airborne.
 *   - |dy| past DRAG_THRESHOLD_PX AND |dy| >= |dx|, DOWNWARD, AIRBORNE →
 *     commits to SLAM, fires once immediately.
 *   - |dy| past DRAG_THRESHOLD_PX AND |dy| >= |dx|, GROUNDED (any
 *     direction) → commits to GROUND DRAG, continuous for the rest of the
 *     gesture.
 *
 * The airborne/grounded split on vertical gestures is deliberate, not
 * incidental: a downward swipe means opposite things depending on whether
 * the player is in the air (slam) or standing on the platform (move the
 * platform down). Resolving on `isAirborne` at the moment the threshold is
 * crossed means a slam can never also be misread as a ground-drag, and vice
 * versa — this is enforced by committing to exactly one interpretation and
 * never revisiting it for the rest of that gesture, same as the original
 * drag-vs-tap rule.
 *
 * Only one pointer (the first to go down) is tracked at a time via its
 * `pointerId`; additional simultaneous touches are ignored until the
 * primary pointer is released, so a second finger landing on the glass
 * mid-gesture can't hijack or restart it.
 *
 * Desktop keyboard mirrors the same rules: Space/ArrowUp jump; Shift/D
 * dash; S/ArrowDown slams if airborne, else nudges the platform down (same
 * airborne/grounded split as the pointer gesture); W nudges the platform up.
 *
 * =========================== CROSSING MODE ============================
 *
 * Runner's whole gesture set doesn't apply here — there's no ground line to
 * drag, no dash, no slam. What's needed instead is TWO actions (walk,
 * aim-and-release jump) that can't both claim "touch anywhere", plus a
 * keyboard equivalent for desktop testing.
 *
 * CONTROL SCHEME CHOSEN — press-and-hold-to-walk, drag-to-aim:
 *
 *   - `pointerdown` → the character immediately starts walking toward
 *     whichever half of the canvas was pressed (left half = walk left,
 *     right half = walk right), continuing for as long as the pointer stays
 *     down inside CROSSING_AIM_DEADZONE_PX of its start point.
 *   - If the pointer then moves past that deadzone, the gesture COMMITS to
 *     AIMING instead: walking stops, and the drag vector from the press
 *     point to the current point becomes the jump's direction (a "pull the
 *     character where you want them to go" mapping — not an Angry-Birds
 *     slingshot reversal, which tested as far less intuitive for "cross the
 *     screen this way"). Drag distance maps to power, 0..1, saturating at
 *     CROSSING_AIM_MAX_DRAG_PX. `onCrossingAimChange` fires on every move so
 *     the caller can redraw the trajectory preview live.
 *   - `pointerup` while committed to aiming fires `onCrossingJumpRelease`
 *     with the last aim vector/power; released before ever committing (a
 *     plain tap, or a hold-then-release with no drag) just stops walking.
 *
 * This was picked over (a) a fixed on-screen d-pad — extra chrome, and the
 * brief asks for gameplay drawn with Pixi primitives, not more DOM/HUD —
 * and (b) a two-zone screen split (aim zone vs. walk zone) — that permanently
 * forfeits half the screen's width for aiming, which cramps exactly the
 * gesture that most needs room to be precise. Press-to-walk / drag-to-aim
 * uses the WHOLE canvas for both actions and only needs one deadzone
 * constant to arbitrate between them, mirroring the tap-vs-drag commitment
 * pattern runner mode already uses above.
 *
 * KEYBOARD: ArrowLeft/A and ArrowRight/D walk while held (real keyup
 * tracking, unlike runner's fire-once keys). Space HELD charges power
 * (0..1 over CROSSING_KEYBOARD_CHARGE_SECONDS) and fires the jump on
 * release; ArrowUp/ArrowDown bias the launch angle steeper/flatter while
 * charging, defaulting to a 45°-ish arc in the current walk-facing
 * direction if neither is held. `updateCrossingAim()` must be polled once a
 * frame by the caller (Game.ts's crossing update loop) so a held Space
 * still drives a live trajectory-preview power readout even though holding
 * a key with no new keyboard event fires nothing on its own.
 *
 * All listeners (pointer + both keyboard directions) are removed in
 * destroy().
 */

import type { GameMode } from '../../types.ts';
import {
  CROSSING_AIM_DEADZONE_PX,
  CROSSING_AIM_MAX_DRAG_PX,
  CROSSING_KEYBOARD_CHARGE_SECONDS,
  DRAG_THRESHOLD_PX,
  KEYBOARD_GROUND_STEP_PX,
  SWIPE_THRESHOLD_PX,
  TAP_MAX_DURATION_MS,
  TAP_MAX_MOVEMENT_PX,
} from '../config.ts';
import { clamp } from '../util/math.ts';

export interface InputCallbacks {
  /** A tap gesture, or Space/ArrowUp on the keyboard. Runner mode only. */
  onJump(): void;
  /** A horizontal swipe, or Shift/D on the keyboard. Fires once per gesture
   * (or key press) — cooldown gating happens downstream in Player. Runner
   * mode only. */
  onDash(): void;
  /** A downward swipe while airborne, or S/ArrowDown while airborne on the
   * keyboard. Fires once per gesture (or key press). Runner mode only. */
  onSlam(): void;
  /** A vertical drag while grounded (or W/S/ArrowDown while grounded on the
   * keyboard) — absolute target Y, in canvas-space px, the platform should
   * chase. Bounds-clamping is the caller's responsibility. Runner mode only. */
  onGroundDragTo(targetY: number): void;
  /** Crossing mode only — walk direction changed (pointer half held/
   * released, or a walk key went down/up). `0` means stop. */
  onCrossingWalk(direction: -1 | 0 | 1): void;
  /** Crossing mode only — fires on every update to an in-progress aim (drag
   * vector in screen-space px, `power` 0..1 saturating at
   * CROSSING_AIM_MAX_DRAG_PX or CROSSING_KEYBOARD_CHARGE_SECONDS) so the
   * caller can keep a trajectory preview in sync. */
  onCrossingAimChange(dirX: number, dirY: number, power: number): void;
  /** Crossing mode only — the aim gesture committed and released; fire the
   * jump with this final vector/power. */
  onCrossingJumpRelease(dirX: number, dirY: number, power: number): void;
  /** Crossing mode only — an in-progress aim was abandoned (pointer
   * cancelled, or a mode switch mid-gesture) with no jump — hide the
   * trajectory preview. */
  onCrossingAimCancel(): void;
}

export interface InputSystemOptions {
  canvas: HTMLCanvasElement;
  callbacks: InputCallbacks;
  /** Current ground-line drag target, px — read once at gesture/key start
   * so drags and key nudges are relative to where the platform already is.
   * Runner mode only; never called while in 'crossing'. */
  getGroundTargetY: () => number;
  /** Whether the player is currently airborne — read live (not just at
   * gesture start) so the slam-vs-drag split always reflects the player's
   * actual state at the moment a gesture commits. Runner mode only; never
   * called while in 'crossing'. */
  getIsAirborne: () => boolean;
}

/** What a pointer gesture has committed to, if anything. `'none'` means
 * still undecided (or the whole gesture stayed within tap range). Runner
 * mode only — crossing mode tracks its own commitment via
 * `crossingAiming`/`crossingWalkDirection` below. */
type GestureCommitment = 'none' | 'drag' | 'dash' | 'slam';

/** Launch-angle bias selected by ArrowUp/ArrowDown while keyboard-charging
 * a crossing jump — see currentKeyboardAimDirection(). */
type KeyboardAimBias = 'default' | 'steep' | 'flat';

export class InputSystem {
  private readonly canvas: HTMLCanvasElement;
  private readonly callbacks: InputCallbacks;
  private readonly getGroundTargetY: () => number;
  private readonly getIsAirborne: () => boolean;

  private mode: GameMode = 'runner';

  private primaryPointerId: number | null = null;
  private startX = 0;
  private startY = 0;
  private startTime = 0;
  private commitment: GestureCommitment = 'none';
  private dragBaseY = 0;

  // --- Crossing-mode-only gesture/keyboard state — untouched by, and never
  // read from, any runner-mode code path above. ---
  private crossingWalkDirection: -1 | 0 | 1 = 0;
  private crossingAiming = false;
  private crossingWalkKeyLeft = false;
  private crossingWalkKeyRight = false;
  /** Last non-zero walk direction — the default horizontal aim direction for
   * a keyboard jump charged with neither arrow-walk key held. */
  private crossingKeyboardFacing: 1 | -1 = 1;
  private crossingAimVerticalBias: KeyboardAimBias = 'default';
  private crossingKeyboardCharging = false;
  private crossingKeyboardChargeStart = 0;

  private readonly handlePointerDown: (event: PointerEvent) => void;
  private readonly handlePointerMove: (event: PointerEvent) => void;
  private readonly handlePointerUp: (event: PointerEvent) => void;
  private readonly handlePointerCancel: (event: PointerEvent) => void;
  private readonly handleKeyDown: (event: KeyboardEvent) => void;
  private readonly handleKeyUp: (event: KeyboardEvent) => void;

  constructor(options: InputSystemOptions) {
    this.canvas = options.canvas;
    this.callbacks = options.callbacks;
    this.getGroundTargetY = options.getGroundTargetY;
    this.getIsAirborne = options.getIsAirborne;

    this.handlePointerDown = this.onPointerDown.bind(this);
    this.handlePointerMove = this.onPointerMove.bind(this);
    this.handlePointerUp = this.onPointerUp.bind(this);
    this.handlePointerCancel = this.onPointerCancel.bind(this);
    this.handleKeyDown = this.onKeyDown.bind(this);
    this.handleKeyUp = this.onKeyUp.bind(this);

    // Prevent iOS Safari from treating drags/taps on the canvas as page
    // scroll or pinch-zoom gestures.
    this.canvas.style.touchAction = 'none';

    this.canvas.addEventListener('pointerdown', this.handlePointerDown, { passive: false });
    this.canvas.addEventListener('pointermove', this.handlePointerMove, { passive: false });
    this.canvas.addEventListener('pointerup', this.handlePointerUp, { passive: false });
    this.canvas.addEventListener('pointercancel', this.handlePointerCancel, { passive: false });
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
  }

  destroy(): void {
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('pointercancel', this.handlePointerCancel);
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    this.primaryPointerId = null;
  }

  /** Switches which gesture set is live. Cancels any gesture/charge
   * in-flight from the mode being left, so a switch mid-drag or mid-hold can
   * never strand a commit with no matching release. Idempotent. */
  setMode(mode: GameMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.commitment = 'none';
    this.crossingWalkDirection = 0;
    this.crossingAiming = false;
    this.crossingWalkKeyLeft = false;
    this.crossingWalkKeyRight = false;
    this.crossingAimVerticalBias = 'default';
    this.crossingKeyboardCharging = false;
  }

  /** Crossing mode only: called once per frame by the caller's crossing
   * update loop — see the class doc's KEYBOARD section for why a held Space
   * needs to be polled rather than driven by keyboard events alone. A no-op
   * outside 'crossing' mode or when nothing is currently charging. */
  updateCrossingAim(): void {
    if (this.mode !== 'crossing' || !this.crossingKeyboardCharging) return;
    const elapsedSeconds = (performance.now() - this.crossingKeyboardChargeStart) / 1000;
    const power = clamp(elapsedSeconds / CROSSING_KEYBOARD_CHARGE_SECONDS, 0, 1);
    const { dirX, dirY } = this.currentKeyboardAimDirection();
    this.callbacks.onCrossingAimChange(dirX, dirY, power);
  }

  private onPointerDown(event: PointerEvent): void {
    if (this.primaryPointerId !== null) return;
    event.preventDefault();
    this.primaryPointerId = event.pointerId;
    this.startX = event.clientX;
    this.startY = event.clientY;
    this.startTime = performance.now();
    this.commitment = 'none';
    this.dragBaseY = this.getGroundTargetY();
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      // Capture is best-effort; absence just means a fast drag off-canvas
      // stops tracking, which is an acceptable degradation.
    }

    if (this.mode === 'crossing') {
      const rect = this.canvas.getBoundingClientRect();
      const direction: -1 | 1 = event.clientX - rect.left < rect.width / 2 ? -1 : 1;
      this.crossingWalkDirection = direction;
      this.crossingKeyboardFacing = direction;
      this.callbacks.onCrossingWalk(direction);
    }
  }

  private onPointerMove(event: PointerEvent): void {
    if (event.pointerId !== this.primaryPointerId) return;
    event.preventDefault();
    const dx = event.clientX - this.startX;
    const dy = event.clientY - this.startY;

    if (this.mode === 'crossing') {
      if (!this.crossingAiming) {
        if (Math.hypot(dx, dy) <= CROSSING_AIM_DEADZONE_PX) return;
        this.crossingAiming = true;
        if (this.crossingWalkDirection !== 0) {
          this.crossingWalkDirection = 0;
          this.callbacks.onCrossingWalk(0);
        }
      }
      const power = clamp(Math.hypot(dx, dy), 0, CROSSING_AIM_MAX_DRAG_PX) / CROSSING_AIM_MAX_DRAG_PX;
      this.callbacks.onCrossingAimChange(dx, dy, power);
      return;
    }

    if (this.commitment === 'none') {
      // Horizontal commit takes priority when both axes have crossed their
      // threshold in the same instant — an exact tie is vanishingly rare on
      // real touch input, and either resolution would be defensible.
      if (Math.abs(dx) > SWIPE_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy)) {
        this.commitment = 'dash';
        this.callbacks.onDash();
        return;
      }
      if (Math.abs(dy) > DRAG_THRESHOLD_PX && Math.abs(dy) >= Math.abs(dx)) {
        if (dy > 0 && this.getIsAirborne()) {
          this.commitment = 'slam';
          this.callbacks.onSlam();
        } else if (!this.getIsAirborne()) {
          this.commitment = 'drag';
          this.callbacks.onGroundDragTo(this.dragBaseY + dy);
        }
        // Airborne + non-downward-dominant vertical movement has no defined
        // meaning yet — stay uncommitted in case the gesture resolves into
        // one of the above on a later move event.
      }
      return;
    }

    if (this.commitment === 'drag') {
      this.callbacks.onGroundDragTo(this.dragBaseY + dy);
    }
    // 'dash' and 'slam' are one-shot: fired once on commit, nothing more to
    // do for the rest of this gesture.
  }

  private onPointerUp(event: PointerEvent): void {
    if (event.pointerId !== this.primaryPointerId) return;
    event.preventDefault();

    if (this.mode === 'crossing') {
      const dx = event.clientX - this.startX;
      const dy = event.clientY - this.startY;
      this.releasePrimary(event.pointerId);
      if (this.crossingAiming) {
        this.crossingAiming = false;
        const power = clamp(Math.hypot(dx, dy), 0, CROSSING_AIM_MAX_DRAG_PX) / CROSSING_AIM_MAX_DRAG_PX;
        this.callbacks.onCrossingJumpRelease(dx, dy, power);
      } else if (this.crossingWalkDirection !== 0) {
        this.crossingWalkDirection = 0;
        this.callbacks.onCrossingWalk(0);
      }
      return;
    }

    this.releasePrimary(event.pointerId);
    const duration = performance.now() - this.startTime;
    const dx = event.clientX - this.startX;
    const dy = event.clientY - this.startY;
    const movement = Math.max(Math.abs(dx), Math.abs(dy));
    if (this.commitment === 'none' && duration <= TAP_MAX_DURATION_MS && movement <= TAP_MAX_MOVEMENT_PX) {
      this.callbacks.onJump();
    }
  }

  private onPointerCancel(event: PointerEvent): void {
    if (event.pointerId !== this.primaryPointerId) return;
    if (this.mode === 'crossing') {
      if (this.crossingAiming) {
        this.crossingAiming = false;
        this.callbacks.onCrossingAimCancel();
      } else if (this.crossingWalkDirection !== 0) {
        this.crossingWalkDirection = 0;
        this.callbacks.onCrossingWalk(0);
      }
    }
    this.releasePrimary(event.pointerId);
  }

  private releasePrimary(pointerId: number): void {
    try {
      this.canvas.releasePointerCapture(pointerId);
    } catch {
      // Nothing to release.
    }
    this.primaryPointerId = null;
    this.commitment = 'none';
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (this.mode === 'crossing') {
      switch (event.code) {
        case 'ArrowLeft':
        case 'KeyA':
          event.preventDefault();
          this.crossingWalkKeyLeft = true;
          this.updateCrossingWalkFromKeys();
          break;
        case 'ArrowRight':
        case 'KeyD':
          event.preventDefault();
          this.crossingWalkKeyRight = true;
          this.updateCrossingWalkFromKeys();
          break;
        case 'Space':
          if (event.repeat) return;
          event.preventDefault();
          this.crossingKeyboardCharging = true;
          this.crossingKeyboardChargeStart = performance.now();
          break;
        case 'ArrowUp':
          event.preventDefault();
          this.crossingAimVerticalBias = 'steep';
          break;
        case 'ArrowDown':
          event.preventDefault();
          this.crossingAimVerticalBias = 'flat';
          break;
        default:
          break;
      }
      return;
    }

    switch (event.code) {
      case 'Space':
      case 'ArrowUp':
        if (event.repeat) return;
        event.preventDefault();
        this.callbacks.onJump();
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
      case 'KeyD':
        if (event.repeat) return;
        event.preventDefault();
        this.callbacks.onDash();
        break;
      case 'KeyW':
        event.preventDefault();
        this.callbacks.onGroundDragTo(this.getGroundTargetY() - KEYBOARD_GROUND_STEP_PX);
        break;
      case 'KeyS':
      case 'ArrowDown':
        event.preventDefault();
        if (this.getIsAirborne()) {
          if (!event.repeat) this.callbacks.onSlam();
        } else {
          this.callbacks.onGroundDragTo(this.getGroundTargetY() + KEYBOARD_GROUND_STEP_PX);
        }
        break;
      default:
        break;
    }
  }

  /** Crossing mode only — see the class doc's KEYBOARD section. Runner mode
   * has no keyup behaviour at all (every runner key fires once on keydown),
   * so this is unconditionally a no-op outside 'crossing'. */
  private onKeyUp(event: KeyboardEvent): void {
    if (this.mode !== 'crossing') return;
    switch (event.code) {
      case 'ArrowLeft':
      case 'KeyA':
        this.crossingWalkKeyLeft = false;
        this.updateCrossingWalkFromKeys();
        break;
      case 'ArrowRight':
      case 'KeyD':
        this.crossingWalkKeyRight = false;
        this.updateCrossingWalkFromKeys();
        break;
      case 'Space': {
        if (!this.crossingKeyboardCharging) break;
        this.crossingKeyboardCharging = false;
        const elapsedSeconds = (performance.now() - this.crossingKeyboardChargeStart) / 1000;
        const power = clamp(elapsedSeconds / CROSSING_KEYBOARD_CHARGE_SECONDS, 0, 1);
        const { dirX, dirY } = this.currentKeyboardAimDirection();
        this.callbacks.onCrossingJumpRelease(dirX, dirY, power);
        break;
      }
      case 'ArrowUp':
      case 'ArrowDown':
        this.crossingAimVerticalBias = 'default';
        break;
      default:
        break;
    }
  }

  /** Reconciles the two walk keys into a single direction and fires
   * onCrossingWalk only on an actual change — mirrors the "0 means stop"
   * contract the pointer path already follows. Tracks the last non-zero
   * direction as `crossingKeyboardFacing`, the default aim direction for a
   * charge started with neither arrow-walk key held. */
  private updateCrossingWalkFromKeys(): void {
    let direction: -1 | 0 | 1 = 0;
    if (this.crossingWalkKeyLeft && !this.crossingWalkKeyRight) direction = -1;
    else if (this.crossingWalkKeyRight && !this.crossingWalkKeyLeft) direction = 1;
    if (direction !== 0) this.crossingKeyboardFacing = direction;
    if (direction !== this.crossingWalkDirection) {
      this.crossingWalkDirection = direction;
      this.callbacks.onCrossingWalk(direction);
    }
  }

  /** Screen-space (y-down) aim direction for a keyboard-charged jump:
   * horizontal sign from whichever walk key is currently held (falling back
   * to the last walk direction, defaulting rightward), vertical steepness
   * from the last ArrowUp/ArrowDown bias while charging. Magnitude is
   * arbitrary — only the direction is used, normalised downstream by the
   * same aim-vector math the pointer path feeds. */
  private currentKeyboardAimDirection(): { dirX: number; dirY: number } {
    let dirX: number = this.crossingKeyboardFacing;
    if (this.crossingWalkKeyLeft && !this.crossingWalkKeyRight) dirX = -1;
    else if (this.crossingWalkKeyRight && !this.crossingWalkKeyLeft) dirX = 1;
    const dirY = this.crossingAimVerticalBias === 'steep' ? -1.6 : this.crossingAimVerticalBias === 'flat' ? -0.4 : -1;
    return { dirX, dirY };
  }
}
