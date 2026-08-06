/**
 * InputSystem — pointer + keyboard input on the Pixi canvas. There is
 * exactly one gesture set (crossing mode's own) — the whole gesture budget
 * belongs to it, no arbitration against any other mode's gestures needed.
 *
 * TWO actions (walk, aim-and-release jump) that can't both claim "touch
 * anywhere", plus a keyboard equivalent for desktop testing.
 *
 * CONTROL SCHEME — press-and-hold-to-walk, drag-to-aim:
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
 *   - If the pointer then drags back to within CROSSING_AIM_CANCEL_RADIUS_PX
 *     of the press
 *     point before release, the gesture UN-COMMITS back to walking — an
 *     "I changed my mind" escape hatch a fixed one-way commitment wouldn't
 *     allow, so second-guessing an aim never fires an accidental
 *     near-zero-power jump.
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
 * constant to arbitrate between them.
 *
 * KEYBOARD: ArrowLeft/A and ArrowRight/D walk while held (real keyup
 * tracking). Space HELD charges power (0..1 over
 * CROSSING_KEYBOARD_CHARGE_SECONDS) and fires the jump on release;
 * ArrowUp/ArrowDown bias the launch angle steeper/flatter while charging,
 * defaulting to a 45°-ish arc in the current walk-facing direction if
 * neither is held. `updateCrossingAim()` must be polled once a frame by the
 * caller (Game.ts's update loop) so a held Space still drives a live
 * trajectory-preview power readout even though holding a key with no new
 * keyboard event fires nothing on its own.
 *
 * All listeners (pointer + both keyboard directions) are removed in
 * destroy().
 */

import { CROSSING_AIM_CANCEL_RADIUS_PX, CROSSING_AIM_DEADZONE_PX, CROSSING_AIM_MAX_DRAG_PX, CROSSING_KEYBOARD_CHARGE_SECONDS } from '../config.ts';
import { clamp } from '../util/math.ts';

export interface InputCallbacks {
  /** Walk direction changed (pointer half held/released, or a walk key went
   * down/up). `0` means stop. */
  onCrossingWalk(direction: -1 | 0 | 1): void;
  /** Fires on every update to an in-progress aim (drag vector in
   * screen-space px, `power` 0..1 saturating at CROSSING_AIM_MAX_DRAG_PX or
   * CROSSING_KEYBOARD_CHARGE_SECONDS) so the caller can keep a trajectory
   * preview in sync. */
  onCrossingAimChange(dirX: number, dirY: number, power: number): void;
  /** The aim gesture committed and released; fire the jump with this final
   * vector/power. */
  onCrossingJumpRelease(dirX: number, dirY: number, power: number): void;
  /** An in-progress aim was abandoned (pointer cancelled) with no jump —
   * hide the trajectory preview. */
  onCrossingAimCancel(): void;
}

export interface InputSystemOptions {
  canvas: HTMLCanvasElement;
  callbacks: InputCallbacks;
}

/** Launch-angle bias selected by ArrowUp/ArrowDown while keyboard-charging a
 * jump — see currentKeyboardAimDirection(). */
type KeyboardAimBias = 'default' | 'steep' | 'flat';

export class InputSystem {
  private readonly canvas: HTMLCanvasElement;
  private readonly callbacks: InputCallbacks;

  private primaryPointerId: number | null = null;
  private startX = 0;
  private startY = 0;

  private walkDirection: -1 | 0 | 1 = 0;
  private aiming = false;
  private walkKeyLeft = false;
  private walkKeyRight = false;
  /** Last non-zero walk direction — the default horizontal aim direction for
   * a keyboard jump charged with neither arrow-walk key held, and the
   * direction resumed if an aim gesture un-commits back to walking. */
  private keyboardFacing: 1 | -1 = 1;
  private aimVerticalBias: KeyboardAimBias = 'default';
  private keyboardCharging = false;
  private keyboardChargeStart = 0;

  private readonly handlePointerDown: (event: PointerEvent) => void;
  private readonly handlePointerMove: (event: PointerEvent) => void;
  private readonly handlePointerUp: (event: PointerEvent) => void;
  private readonly handlePointerCancel: (event: PointerEvent) => void;
  private readonly handleKeyDown: (event: KeyboardEvent) => void;
  private readonly handleKeyUp: (event: KeyboardEvent) => void;

  constructor(options: InputSystemOptions) {
    this.canvas = options.canvas;
    this.callbacks = options.callbacks;

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

  /** Called once per frame by the caller's update loop — see the class
   * doc's KEYBOARD section for why a held Space needs to be polled rather
   * than driven by keyboard events alone. A no-op when nothing is currently
   * charging. */
  updateCrossingAim(): void {
    if (!this.keyboardCharging) return;
    const elapsedSeconds = (performance.now() - this.keyboardChargeStart) / 1000;
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
    this.aiming = false;
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      // Capture is best-effort; absence just means a fast drag off-canvas
      // stops tracking, which is an acceptable degradation.
    }

    const direction = this.halfDirectionFor(event.clientX);
    this.walkDirection = direction;
    this.keyboardFacing = direction;
    this.callbacks.onCrossingWalk(direction);
  }

  private onPointerMove(event: PointerEvent): void {
    if (event.pointerId !== this.primaryPointerId) return;
    event.preventDefault();
    const dx = event.clientX - this.startX;
    const dy = event.clientY - this.startY;
    const distance = Math.hypot(dx, dy);

    if (!this.aiming) {
      if (distance <= CROSSING_AIM_DEADZONE_PX) return;
      this.aiming = true;
      if (this.walkDirection !== 0) {
        this.walkDirection = 0;
        this.callbacks.onCrossingWalk(0);
      }
    } else if (distance <= CROSSING_AIM_CANCEL_RADIUS_PX) {
      // Un-commit: the pointer dragged back near the press point before
      // release — resume walking instead of leaving a near-zero-power aim
      // as the only option (see class doc).
      this.aiming = false;
      this.callbacks.onCrossingAimCancel();
      const direction = this.halfDirectionFor(event.clientX);
      this.walkDirection = direction;
      this.keyboardFacing = direction;
      this.callbacks.onCrossingWalk(direction);
      return;
    }

    const power = clamp(distance, 0, CROSSING_AIM_MAX_DRAG_PX) / CROSSING_AIM_MAX_DRAG_PX;
    this.callbacks.onCrossingAimChange(dx, dy, power);
  }

  private onPointerUp(event: PointerEvent): void {
    if (event.pointerId !== this.primaryPointerId) return;
    event.preventDefault();
    const dx = event.clientX - this.startX;
    const dy = event.clientY - this.startY;
    this.releasePrimary(event.pointerId);
    if (this.aiming) {
      this.aiming = false;
      const power = clamp(Math.hypot(dx, dy), 0, CROSSING_AIM_MAX_DRAG_PX) / CROSSING_AIM_MAX_DRAG_PX;
      this.callbacks.onCrossingJumpRelease(dx, dy, power);
    } else if (this.walkDirection !== 0) {
      this.walkDirection = 0;
      this.callbacks.onCrossingWalk(0);
    }
  }

  private onPointerCancel(event: PointerEvent): void {
    if (event.pointerId !== this.primaryPointerId) return;
    if (this.aiming) {
      this.aiming = false;
      this.callbacks.onCrossingAimCancel();
    } else if (this.walkDirection !== 0) {
      this.walkDirection = 0;
      this.callbacks.onCrossingWalk(0);
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
  }

  /** Which half of the canvas a client-space x falls in, as a walk
   * direction — shared by pointerdown and the aim-un-commit path. */
  private halfDirectionFor(clientX: number): -1 | 1 {
    const rect = this.canvas.getBoundingClientRect();
    return clientX - rect.left < rect.width / 2 ? -1 : 1;
  }

  private onKeyDown(event: KeyboardEvent): void {
    switch (event.code) {
      case 'ArrowLeft':
      case 'KeyA':
        event.preventDefault();
        this.walkKeyLeft = true;
        this.updateWalkFromKeys();
        break;
      case 'ArrowRight':
      case 'KeyD':
        event.preventDefault();
        this.walkKeyRight = true;
        this.updateWalkFromKeys();
        break;
      case 'Space':
        if (event.repeat) return;
        event.preventDefault();
        this.keyboardCharging = true;
        this.keyboardChargeStart = performance.now();
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.aimVerticalBias = 'steep';
        break;
      case 'ArrowDown':
        event.preventDefault();
        this.aimVerticalBias = 'flat';
        break;
      default:
        break;
    }
  }

  private onKeyUp(event: KeyboardEvent): void {
    switch (event.code) {
      case 'ArrowLeft':
      case 'KeyA':
        this.walkKeyLeft = false;
        this.updateWalkFromKeys();
        break;
      case 'ArrowRight':
      case 'KeyD':
        this.walkKeyRight = false;
        this.updateWalkFromKeys();
        break;
      case 'Space': {
        if (!this.keyboardCharging) break;
        this.keyboardCharging = false;
        const elapsedSeconds = (performance.now() - this.keyboardChargeStart) / 1000;
        const power = clamp(elapsedSeconds / CROSSING_KEYBOARD_CHARGE_SECONDS, 0, 1);
        const { dirX, dirY } = this.currentKeyboardAimDirection();
        this.callbacks.onCrossingJumpRelease(dirX, dirY, power);
        break;
      }
      case 'ArrowUp':
      case 'ArrowDown':
        this.aimVerticalBias = 'default';
        break;
      default:
        break;
    }
  }

  /** Reconciles the two walk keys into a single direction and fires
   * onCrossingWalk only on an actual change — mirrors the "0 means stop"
   * contract the pointer path already follows. Tracks the last non-zero
   * direction as `keyboardFacing`, the default aim direction for a charge
   * started with neither arrow-walk key held. */
  private updateWalkFromKeys(): void {
    let direction: -1 | 0 | 1 = 0;
    if (this.walkKeyLeft && !this.walkKeyRight) direction = -1;
    else if (this.walkKeyRight && !this.walkKeyLeft) direction = 1;
    if (direction !== 0) this.keyboardFacing = direction;
    if (direction !== this.walkDirection) {
      this.walkDirection = direction;
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
    let dirX: number = this.keyboardFacing;
    if (this.walkKeyLeft && !this.walkKeyRight) dirX = -1;
    else if (this.walkKeyRight && !this.walkKeyLeft) dirX = 1;
    const dirY = this.aimVerticalBias === 'steep' ? -1.6 : this.aimVerticalBias === 'flat' ? -0.4 : -1;
    return { dirX, dirY };
  }
}
