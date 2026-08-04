/**
 * InputSystem — pointer + keyboard input on the Pixi canvas.
 *
 * A short, low-movement pointer gesture is a tap (jump). A vertical drag
 * past DRAG_THRESHOLD_PX commits the gesture to "move the platform" and it
 * can then never also resolve as a jump. Only one pointer (the first to go
 * down) is tracked at a time via its `pointerId`; additional simultaneous
 * touches are ignored until the primary pointer is released, so a second
 * finger landing on the glass mid-drag can't hijack or restart the gesture.
 *
 * Desktop keyboard is supported for local dev: Space/ArrowUp jump, W/S (and
 * ArrowDown) nudge the platform up/down. All listeners are removed in
 * destroy().
 */

import {
  DRAG_THRESHOLD_PX,
  KEYBOARD_GROUND_STEP_PX,
  TAP_MAX_DURATION_MS,
  TAP_MAX_MOVEMENT_PX,
} from '../config.ts';

export interface InputCallbacks {
  /** A tap gesture, or Space/ArrowUp on the keyboard. */
  onJump(): void;
  /** A vertical drag (or W/S/ArrowDown on the keyboard) — absolute target Y,
   * in canvas-space px, the platform should chase. Bounds-clamping is the
   * caller's responsibility. */
  onGroundDragTo(targetY: number): void;
}

export interface InputSystemOptions {
  canvas: HTMLCanvasElement;
  callbacks: InputCallbacks;
  /** Current ground-line drag target, px — read once at gesture/key start
   * so drags and key nudges are relative to where the platform already is. */
  getGroundTargetY: () => number;
}

export class InputSystem {
  private readonly canvas: HTMLCanvasElement;
  private readonly callbacks: InputCallbacks;
  private readonly getGroundTargetY: () => number;

  private primaryPointerId: number | null = null;
  private startX = 0;
  private startY = 0;
  private startTime = 0;
  private dragging = false;
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
    this.dragging = false;
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
    const dy = event.clientY - this.startY;
    if (!this.dragging && Math.abs(dy) > DRAG_THRESHOLD_PX) {
      this.dragging = true;
    }
    if (this.dragging) {
      this.callbacks.onGroundDragTo(this.dragBaseY + dy);
    }
  }

  private onPointerUp(event: PointerEvent): void {
    if (event.pointerId !== this.primaryPointerId) return;
    event.preventDefault();
    this.releasePrimary(event.pointerId);

    const duration = performance.now() - this.startTime;
    const dx = event.clientX - this.startX;
    const dy = event.clientY - this.startY;
    const movement = Math.max(Math.abs(dx), Math.abs(dy));
    if (!this.dragging && duration <= TAP_MAX_DURATION_MS && movement <= TAP_MAX_MOVEMENT_PX) {
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
    this.dragging = false;
  }

  private onKeyDown(event: KeyboardEvent): void {
    switch (event.code) {
      case 'Space':
      case 'ArrowUp':
        if (event.repeat) return;
        event.preventDefault();
        this.callbacks.onJump();
        break;
      case 'KeyW':
        event.preventDefault();
        this.callbacks.onGroundDragTo(this.getGroundTargetY() - KEYBOARD_GROUND_STEP_PX);
        break;
      case 'KeyS':
      case 'ArrowDown':
        event.preventDefault();
        this.callbacks.onGroundDragTo(this.getGroundTargetY() + KEYBOARD_GROUND_STEP_PX);
        break;
      default:
        break;
    }
  }
}
