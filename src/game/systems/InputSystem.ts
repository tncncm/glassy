/**
 * InputSystem — pointer + keyboard input on the Pixi canvas.
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
 * All listeners are removed in destroy().
 */

import {
  DRAG_THRESHOLD_PX,
  KEYBOARD_GROUND_STEP_PX,
  SWIPE_THRESHOLD_PX,
  TAP_MAX_DURATION_MS,
  TAP_MAX_MOVEMENT_PX,
} from '../config.ts';

export interface InputCallbacks {
  /** A tap gesture, or Space/ArrowUp on the keyboard. */
  onJump(): void;
  /** A horizontal swipe, or Shift/D on the keyboard. Fires once per gesture
   * (or key press) — cooldown gating happens downstream in Player. */
  onDash(): void;
  /** A downward swipe while airborne, or S/ArrowDown while airborne on the
   * keyboard. Fires once per gesture (or key press). */
  onSlam(): void;
  /** A vertical drag while grounded (or W/S/ArrowDown while grounded on the
   * keyboard) — absolute target Y, in canvas-space px, the platform should
   * chase. Bounds-clamping is the caller's responsibility. */
  onGroundDragTo(targetY: number): void;
}

export interface InputSystemOptions {
  canvas: HTMLCanvasElement;
  callbacks: InputCallbacks;
  /** Current ground-line drag target, px — read once at gesture/key start
   * so drags and key nudges are relative to where the platform already is. */
  getGroundTargetY: () => number;
  /** Whether the player is currently airborne — read live (not just at
   * gesture start) so the slam-vs-drag split always reflects the player's
   * actual state at the moment a gesture commits. */
  getIsAirborne: () => boolean;
}

/** What a pointer gesture has committed to, if anything. `'none'` means
 * still undecided (or the whole gesture stayed within tap range). */
type GestureCommitment = 'none' | 'drag' | 'dash' | 'slam';

export class InputSystem {
  private readonly canvas: HTMLCanvasElement;
  private readonly callbacks: InputCallbacks;
  private readonly getGroundTargetY: () => number;
  private readonly getIsAirborne: () => boolean;

  private primaryPointerId: number | null = null;
  private startX = 0;
  private startY = 0;
  private startTime = 0;
  private commitment: GestureCommitment = 'none';
  private dragBaseY = 0;

  private readonly handlePointerDown: (event: PointerEvent) => void;
  private readonly handlePointerMove: (event: PointerEvent) => void;
  private readonly handlePointerUp: (event: PointerEvent) => void;
  private readonly handlePointerCancel: (event: PointerEvent) => void;
  private readonly handleKeyDown: (event: KeyboardEvent) => void;

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

    // Prevent iOS Safari from treating drags/taps on the canvas as page
    // scroll or pinch-zoom gestures.
    this.canvas.style.touchAction = 'none';

    this.canvas.addEventListener('pointerdown', this.handlePointerDown, { passive: false });
    this.canvas.addEventListener('pointermove', this.handlePointerMove, { passive: false });
    this.canvas.addEventListener('pointerup', this.handlePointerUp, { passive: false });
    this.canvas.addEventListener('pointercancel', this.handlePointerCancel, { passive: false });
    window.addEventListener('keydown', this.handleKeyDown);
  }

  destroy(): void {
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('pointercancel', this.handlePointerCancel);
    window.removeEventListener('keydown', this.handleKeyDown);
    this.primaryPointerId = null;
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
  }

  private onPointerMove(event: PointerEvent): void {
    if (event.pointerId !== this.primaryPointerId) return;
    event.preventDefault();
    const dx = event.clientX - this.startX;
    const dy = event.clientY - this.startY;

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
}
