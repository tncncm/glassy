/**
 * Glassy — UIController.
 *
 * A pure view: builds every screen once as static DOM, toggles visibility by
 * class/attribute, and emits typed intents. It never touches Pixi, the
 * camera, game state or localStorage directly.
 *
 * Information architecture: Play is the front screen. The home screen shows
 * only what you need before you can plausibly ignore everything else — the
 * mandatory safety line, a one-line reminder to point the phone at the
 * windscreen, the Play button, mute, and best score. Everything explanatory
 * (the full pitch, the privacy explanation, the detection opt-in and its
 * cost, motion-comfort cues, the demo drive, the iOS install hint) lives one
 * tap away behind the "About" affordance, in a slide-in sheet that is part of
 * the `home` screen's own DOM — it is never a distinct `ScreenName`.
 */

import type {
  CameraFailure,
  DetectorState,
  DetectorStatus,
  GameOverResult,
  ScreenName,
  UIController,
  UIIntents,
} from '../types.ts';

const SCREEN_NAMES: readonly ScreenName[] = [
  'loading',
  'home',
  'permission',
  'rotate',
  'playing',
  'paused',
  'gameOver',
] as const;

interface FailureCopy {
  title: string;
  body: string;
}

const FAILURE_COPY: Record<CameraFailure, FailureCopy> = {
  denied: {
    title: 'Camera access denied',
    body:
      'Glassy can still be played without it. To use the camera backdrop, ' +
      'enable it in Settings → Privacy & Security → Camera, or ' +
      'Settings → Glassy on iOS, then try again.',
  },
  'not-found': {
    title: 'No camera found',
    body: "This device doesn't have a camera Glassy can use as a backdrop. You can still play with the animated background.",
  },
  'insecure-context': {
    title: 'Secure connection required',
    body:
      'Camera access needs a secure (HTTPS) connection, and this page ' +
      "isn't loaded over one. You can still play with the animated background.",
  },
  unsupported: {
    title: 'Camera not supported',
    body: "This browser doesn't support camera access. You can still play with the animated background.",
  },
  unavailable: {
    title: 'Camera unavailable',
    body: 'The camera could not be started — it may be in use by another app. You can still play with the animated background.',
  },
};

const MUTE_LABEL_ON = 'Mute sound';
const MUTE_LABEL_OFF = 'Unmute sound';
const MUTE_ICON_ON = '\u{1F50A}'; // speaker
const MUTE_ICON_OFF = '\u{1F507}'; // muted speaker

// Detection turns real vehicles into platforms; without it the game falls
// back to synthetic platforms and plays fine either way, so the copy leads
// with what turning it on buys the player, states the cost plainly, and never
// implies that "off" or "no cars detected" is a worse or losing state — the
// driver is sitting right there, and more traffic is never the goal.
const VISION_TITLE = 'Turn traffic into platforms';
const VISION_DESC = 'Spots real vehicles to land on. ~9 MB one-time download, more battery.';
const VISION_ARIA_LABEL =
  'Turn traffic into platforms. On-device AI spots real vehicles out the windscreen so you can land on them. Without it, synthetic platforms appear instead. Uses a one-time about 9 megabyte download and more battery. Off by default.';

// Motion-comfort cues: drifting dots that match the vehicle's real motion, the
// idea behind iOS's Vehicle Motion Cues. Named for what it does, not framed as
// "accessibility" — someone who needs it should be able to tell at a glance.
const MOTION_CUES_TITLE = 'Motion comfort cues';
const MOTION_CUES_DESC = "Drifting dots that match the car's real motion, to help with motion sickness.";
const MOTION_CUES_ARIA_LABEL =
  "Motion comfort cues. Drifting dots that match the car's real motion, to help with motion sickness. On by default.";

/**
 * Whether the opt-in toggle should render as ON. `idle` (never asked to
 * load) and `disabled` (user switched it off) both read as OFF; `loading`,
 * `ready` and `unavailable` all mean the user opted in — `unavailable` is a
 * failed *attempt*, not an off state, so the switch stays on and the status
 * line explains what happened.
 */
function isVisionOn(status: DetectorStatus): boolean {
  return status === 'loading' || status === 'ready' || status === 'unavailable';
}

function requireElement<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) {
    throw new Error(`UIController: missing required element "${selector}"`);
  }
  return el;
}

const TEMPLATE = `
  <div class="screen" data-screen="loading" role="status" aria-live="polite">
    <div class="loading__mark">Glassy<span class="loading__dot">.</span></div>
    <div class="loading__spinner" aria-hidden="true"></div>
  </div>

  <div class="screen screen--home" data-screen="home">
    <div class="home">
      <div class="home__topbar">
        <span class="home__wordmark">Glassy</span>
        <div class="home__topbar-actions">
          <button type="button" class="btn btn--icon" data-action="toggle-mute" data-mute-button aria-pressed="false" aria-label="${MUTE_LABEL_ON}">${MUTE_ICON_ON}</button>
          <button type="button" class="btn btn--icon" data-action="toggle-settings" data-settings-button aria-expanded="false" aria-label="About Glassy and settings">ℹ️</button>
        </div>
      </div>

      <div class="home__center">
        <button type="button" class="btn btn--primary btn--play" data-action="play">Play</button>
        <div class="home__best">
          <span class="home__best-label">Best</span>
          <span class="home__best-value" data-role="home-best">0</span>
        </div>
      </div>

      <div class="home__footer">
        <p class="home__hint"><span aria-hidden="true">\u{1F697}</span> Point it at the windscreen, in landscape.</p>
        <div class="safety-line">
          <span class="safety-line__icon" aria-hidden="true">⚠️</span>
          <span>Passenger use only. Do not use while driving.</span>
        </div>
      </div>
    </div>

    <div class="sheet" data-role="settings-sheet" hidden>
      <div class="sheet__scrim" data-action="close-settings" aria-hidden="true"></div>
      <div class="sheet__panel" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <div class="sheet__header">
          <h2 class="sheet__title" id="sheet-title">About Glassy</h2>
          <button type="button" class="btn btn--icon" data-action="close-settings" data-settings-close aria-label="Close">✕</button>
        </div>
        <div class="sheet__body">
          <p class="sheet__pitch">Hold your phone up to the windscreen and hop your character across real traffic — left block to right block. Don't fall.</p>

          <p class="privacy-line">Your camera shows the road live on your screen — it's never recorded. Glassy looks at the picture only on your phone, to find the horizon and, if you turn on detection below, to spot real vehicles to jump on. Nothing is ever uploaded, sent anywhere, or saved — no frame and no detection is ever stored. The detection model downloads once to your phone and runs there; there's no server.</p>

          <div class="toggle" data-role="vision">
            <button
              type="button"
              class="toggle__control"
              data-action="toggle-vision"
              data-vision-button
              aria-pressed="false"
              aria-label="${VISION_ARIA_LABEL}"
            >
              <span class="toggle__switch" aria-hidden="true"></span>
              <span class="toggle__copy">
                <span class="toggle__title">${VISION_TITLE}</span>
                <span class="toggle__desc">${VISION_DESC}</span>
              </span>
            </button>
            <p class="toggle__status" data-role="vision-status" hidden>
              <span data-role="vision-status-text"></span>
            </p>
            <div class="toggle__progress" data-role="vision-progress" hidden aria-hidden="true">
              <div class="toggle__progress-fill" data-role="vision-progress-fill"></div>
            </div>
          </div>

          <div class="toggle" data-role="motion-cues">
            <button
              type="button"
              class="toggle__control"
              data-action="toggle-motion-cues"
              data-motion-cues-button
              aria-pressed="true"
              aria-label="${MOTION_CUES_ARIA_LABEL}"
            >
              <span class="toggle__switch" aria-hidden="true"></span>
              <span class="toggle__copy">
                <span class="toggle__title">${MOTION_CUES_TITLE}</span>
                <span class="toggle__desc">${MOTION_CUES_DESC}</span>
              </span>
            </button>
          </div>

          <button type="button" class="btn btn--secondary btn--demo btn--block" data-action="play-demo">
            Try the demo drive
            <span class="btn__hint">Dashcam clip, no camera needed</span>
          </button>

          <p class="install-hint" data-install-hint hidden>
            For true full screen on iPhone: tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>, and open Glassy from there.
          </p>
        </div>
      </div>
    </div>
  </div>

  <div class="screen" data-screen="permission">
    <div class="panel permission__panel">
      <div class="permission__state" data-state="pre-request">
        <div class="permission__icon" aria-hidden="true">\u{1F4F7}</div>
        <h2 class="permission__title">Camera as your windscreen view</h2>
        <p class="permission__body">Your rear camera becomes a live view behind the game, like looking through the windscreen. It's analysed only on your phone — to find the horizon, and to spot traffic if you turned that on. Nothing is recorded, saved, or sent anywhere; there's no server to send it to.</p>
        <div class="btn-row">
          <button type="button" class="btn btn--primary" data-action="continue">Continue</button>
        </div>
        <button type="button" class="btn btn--secondary" data-action="play-without-camera-pre">Play without camera</button>
        <button type="button" class="btn btn--secondary btn--demo" data-action="play-demo">
          Try the demo drive
          <span class="btn__hint">Dashcam clip, no camera needed</span>
        </button>
      </div>
      <div class="permission__state" data-state="failure" hidden>
        <div class="permission__icon" aria-hidden="true">\u{1F6AB}</div>
        <h2 class="permission__title" data-role="failure-title"></h2>
        <p class="permission__body" data-role="failure-body"></p>
        <div class="btn-row">
          <button type="button" class="btn btn--primary" data-action="retry">Try again</button>
          <button type="button" class="btn btn--secondary" data-action="play-without-camera-fail">Play without camera</button>
        </div>
        <button type="button" class="btn btn--secondary btn--demo" data-action="play-demo">
          Try the demo drive
          <span class="btn__hint">Dashcam clip, no camera needed</span>
        </button>
      </div>
    </div>
  </div>

  <div class="screen" data-screen="rotate" role="status" aria-live="polite">
    <div class="rotate-glyph" aria-hidden="true"></div>
    <h2 class="rotate__title">Rotate your device</h2>
    <p class="rotate__body">Glassy plays in landscape. Turn your phone sideways to continue — it'll resume automatically.</p>
  </div>

  <div class="screen" data-screen="playing">
    <div class="hud">
      <div class="panel hud__score">
        <div class="stat">
          <span class="stat__label">Score</span>
          <span class="stat__value" data-role="playing-score">0</span>
        </div>
      </div>
      <div class="hud__controls">
        <button type="button" class="btn btn--icon" data-action="pause" aria-label="Pause">⏸</button>
        <button type="button" class="btn btn--icon" data-action="toggle-mute" data-mute-button aria-pressed="false" aria-label="${MUTE_LABEL_ON}">${MUTE_ICON_ON}</button>
      </div>
    </div>
  </div>

  <div class="screen" data-screen="paused">
    <div class="panel paused__panel">
      <h2 class="paused__title">Paused</h2>
      <div class="btn-row">
        <button type="button" class="btn btn--primary" data-action="resume">Resume</button>
      </div>
      <div class="btn-row">
        <button type="button" class="btn btn--secondary" data-action="restart">Restart</button>
        <button type="button" class="btn btn--secondary" data-action="quit">Quit to home</button>
      </div>
      <div class="btn-row">
        <button type="button" class="btn btn--icon" data-action="toggle-mute" data-mute-button aria-pressed="false" aria-label="${MUTE_LABEL_ON}">${MUTE_ICON_ON}</button>
      </div>
    </div>
  </div>

  <div class="screen" data-screen="gameOver">
    <div class="panel game-over__panel">
      <h2 class="game-over__title">Game over</h2>
      <span class="badge--new-best" data-role="new-best" hidden>✦ New best!</span>
      <div class="game-over__stats">
        <div class="stat">
          <span class="stat__label">Score</span>
          <span class="stat__value" data-role="gameover-score">0</span>
        </div>
        <div class="stat">
          <span class="stat__label">Best</span>
          <span class="stat__value" data-role="gameover-best">0</span>
        </div>
      </div>
      <div class="btn-row">
        <button type="button" class="btn btn--primary" data-action="restart" data-role="gameover-restart">Play again</button>
        <button type="button" class="btn btn--secondary" data-action="quit" data-role="gameover-quit">Home</button>
      </div>
    </div>
  </div>

  <div class="debug-overlay" data-role="debug" aria-hidden="true" hidden></div>
`;

class GlassyUIController implements UIController {
  private readonly root: HTMLElement;
  private readonly intents: UIIntents;

  private readonly screens: Record<ScreenName, HTMLElement>;
  private readonly focusTargets: Record<ScreenName, HTMLElement | null>;

  private readonly homeBestEl: HTMLElement;
  private readonly playingScoreEl: HTMLElement;
  private readonly gameOverScoreEl: HTMLElement;
  private readonly gameOverBestEl: HTMLElement;
  private readonly newBestBadge: HTMLElement;
  private readonly debugEl: HTMLElement;
  private readonly installHintEl: HTMLElement;

  private readonly permissionPreRequestEl: HTMLElement;
  private readonly permissionFailureEl: HTMLElement;
  private readonly failureTitleEl: HTMLElement;
  private readonly failureBodyEl: HTMLElement;
  private readonly continueButtonEl: HTMLElement;
  private readonly retryButtonEl: HTMLElement;

  private readonly muteButtons: HTMLButtonElement[];
  private readonly visionButtons: HTMLButtonElement[];
  private readonly visionStatusEl: HTMLElement;
  private readonly visionStatusTextEl: HTMLElement;
  private readonly visionProgressEl: HTMLElement;
  private readonly visionProgressFillEl: HTMLElement;
  private readonly motionCuesButtons: HTMLButtonElement[];

  private readonly settingsSheetEl: HTMLElement;
  private readonly settingsButtonEl: HTMLButtonElement;
  private readonly settingsCloseButtons: HTMLButtonElement[];
  private readonly homeMainEl: HTMLElement;

  private currentScreen: ScreenName = 'loading';
  private lastScore = -1;
  private lastBest = -1;
  private lastMuted: boolean | null = null;
  private hasCameraFailure = false;
  private lastDetectorStatus: DetectorStatus | null = null;
  private lastDetectorProgress: number | null = null;
  private lastMotionCues: boolean | null = null;
  private settingsOpen = false;

  constructor(root: HTMLElement, intents: UIIntents) {
    this.root = root;
    this.intents = intents;

    this.root.innerHTML = TEMPLATE;

    const screens = {} as Record<ScreenName, HTMLElement>;
    for (const name of SCREEN_NAMES) {
      screens[name] = requireElement<HTMLElement>(this.root, `[data-screen="${name}"]`);
    }
    this.screens = screens;

    this.homeBestEl = requireElement(this.root, '[data-role="home-best"]');
    this.playingScoreEl = requireElement(this.root, '[data-role="playing-score"]');
    this.gameOverScoreEl = requireElement(this.root, '[data-role="gameover-score"]');
    this.gameOverBestEl = requireElement(this.root, '[data-role="gameover-best"]');
    this.newBestBadge = requireElement(this.root, '[data-role="new-best"]');
    this.debugEl = requireElement(this.root, '[data-role="debug"]');

    this.permissionPreRequestEl = requireElement(
      this.root,
      '[data-screen="permission"] [data-state="pre-request"]',
    );
    this.permissionFailureEl = requireElement(
      this.root,
      '[data-screen="permission"] [data-state="failure"]',
    );
    this.failureTitleEl = requireElement(this.root, '[data-role="failure-title"]');
    this.failureBodyEl = requireElement(this.root, '[data-role="failure-body"]');
    this.continueButtonEl = requireElement(this.root, '[data-action="continue"]');
    this.retryButtonEl = requireElement(this.root, '[data-action="retry"]');

    this.installHintEl = requireElement(this.root, '[data-install-hint]');

    this.muteButtons = Array.from(
      this.root.querySelectorAll<HTMLButtonElement>('[data-mute-button]'),
    );
    this.visionButtons = Array.from(
      this.root.querySelectorAll<HTMLButtonElement>('[data-vision-button]'),
    );
    this.visionStatusEl = requireElement(this.root, '[data-role="vision-status"]');
    this.visionStatusTextEl = requireElement(this.root, '[data-role="vision-status-text"]');
    this.visionProgressEl = requireElement(this.root, '[data-role="vision-progress"]');
    this.visionProgressFillEl = requireElement(this.root, '[data-role="vision-progress-fill"]');
    this.motionCuesButtons = Array.from(
      this.root.querySelectorAll<HTMLButtonElement>('[data-motion-cues-button]'),
    );

    this.settingsSheetEl = requireElement(this.root, '[data-role="settings-sheet"]');
    this.settingsButtonEl = requireElement<HTMLButtonElement>(this.root, '[data-settings-button]');
    // Deliberately excludes the scrim: it also closes the sheet (via the same
    // data-action, handled generically in handleClick) but it isn't a real
    // focusable control, so it must never be a candidate for focusSettingsClose().
    this.settingsCloseButtons = Array.from(
      this.root.querySelectorAll<HTMLButtonElement>('[data-settings-close]'),
    );
    this.homeMainEl = requireElement(this.root, '.home');

    this.focusTargets = {
      loading: null,
      home: requireElement<HTMLElement>(this.root, '[data-screen="home"] [data-action="play"]'),
      // 'permission' resolves dynamically in applyScreen — it has two mutually
      // exclusive panels (pre-request vs failure) with different primary buttons.
      permission: null,
      rotate: null,
      playing: null,
      paused: requireElement<HTMLElement>(
        this.root,
        '[data-screen="paused"] [data-action="resume"]',
      ),
      gameOver: requireElement<HTMLElement>(
        this.root,
        '[data-screen="gameOver"] [data-role="gameover-restart"]',
      ),
    };

    this.root.addEventListener('click', this.handleClick);
    this.root.addEventListener('keydown', this.handleKeydown);

    this.applyScreen(this.currentScreen);
    this.setMuted(false);
    this.setDetectorState({ status: 'idle' });
    this.setMotionCues(true);
    this.setupViewportGuard();
  }

  get screen(): ScreenName {
    return this.currentScreen;
  }

  show(screen: ScreenName): void {
    this.currentScreen = screen;
    // Leaving home closes the sheet instantly — nothing to animate, the
    // screen it lives on is about to disappear anyway.
    if (screen !== 'home' && this.settingsOpen) {
      this.setSettingsOpen(false, { focusTrigger: false });
    }
    this.applyScreen(screen);
  }

  setScore(score: number): void {
    if (score === this.lastScore) return;
    this.lastScore = score;
    this.playingScoreEl.textContent = String(score);
  }

  setBest(best: number): void {
    if (best === this.lastBest) return;
    this.lastBest = best;
    this.homeBestEl.textContent = String(best);
    this.gameOverBestEl.textContent = String(best);
  }

  setMuted(muted: boolean): void {
    if (muted === this.lastMuted) return;
    this.lastMuted = muted;
    const label = muted ? MUTE_LABEL_OFF : MUTE_LABEL_ON;
    const icon = muted ? MUTE_ICON_OFF : MUTE_ICON_ON;
    for (const btn of this.muteButtons) {
      btn.textContent = icon;
      btn.setAttribute('aria-label', label);
      btn.setAttribute('aria-pressed', muted ? 'true' : 'false');
    }
  }

  setGameOver(result: GameOverResult): void {
    this.gameOverScoreEl.textContent = String(result.score);
    this.gameOverBestEl.textContent = String(result.best);
    this.lastBest = result.best;
    if (result.isNewBest) {
      this.newBestBadge.removeAttribute('hidden');
    } else {
      this.newBestBadge.setAttribute('hidden', '');
    }
  }

  setCameraFailure(failure: CameraFailure | null): void {
    this.hasCameraFailure = failure !== null;
    if (failure === null) {
      this.permissionPreRequestEl.removeAttribute('hidden');
      this.permissionFailureEl.setAttribute('hidden', '');
    } else {
      const copy = FAILURE_COPY[failure];
      this.failureTitleEl.textContent = copy.title;
      this.failureBodyEl.textContent = copy.body;
      this.permissionPreRequestEl.setAttribute('hidden', '');
      this.permissionFailureEl.removeAttribute('hidden');
    }
    // The visible panel (and therefore the correct primary button) just
    // changed under the active screen — refresh focus if we're on it.
    if (this.currentScreen === 'permission') {
      this.applyScreen('permission');
    }
  }

  setDetectorState(state: DetectorState): void {
    const progress = state.progress ?? null;
    if (state.status === this.lastDetectorStatus && progress === this.lastDetectorProgress) {
      return;
    }
    this.lastDetectorStatus = state.status;
    this.lastDetectorProgress = progress;

    const on = isVisionOn(state.status);
    for (const btn of this.visionButtons) {
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }

    switch (state.status) {
      case 'loading': {
        this.visionStatusEl.removeAttribute('hidden');
        this.visionProgressEl.removeAttribute('hidden');
        if (progress !== null) {
          const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);
          this.visionStatusTextEl.textContent = `Downloading on-device AI… ${pct}%`;
          this.visionProgressEl.classList.remove('toggle__progress--indeterminate');
          this.visionProgressFillEl.style.width = `${pct}%`;
        } else {
          // No progress figure yet — show real motion, never a fabricated number.
          this.visionStatusTextEl.textContent = 'Downloading on-device AI…';
          this.visionProgressEl.classList.add('toggle__progress--indeterminate');
          this.visionProgressFillEl.style.width = '';
        }
        break;
      }
      case 'ready':
        this.visionStatusEl.removeAttribute('hidden');
        this.visionProgressEl.setAttribute('hidden', '');
        this.visionProgressEl.classList.remove('toggle__progress--indeterminate');
        this.visionStatusTextEl.textContent = 'On-device AI ready.';
        break;
      case 'unavailable':
        this.visionStatusEl.removeAttribute('hidden');
        this.visionProgressEl.setAttribute('hidden', '');
        this.visionProgressEl.classList.remove('toggle__progress--indeterminate');
        this.visionStatusTextEl.textContent =
          "Detection couldn't start — the game plays normally without it.";
        break;
      case 'idle':
      case 'disabled':
        this.visionStatusEl.setAttribute('hidden', '');
        this.visionProgressEl.setAttribute('hidden', '');
        this.visionProgressEl.classList.remove('toggle__progress--indeterminate');
        break;
      default:
        break;
    }
  }

  setMotionCues(enabled: boolean): void {
    if (enabled === this.lastMotionCues) return;
    this.lastMotionCues = enabled;
    for (const btn of this.motionCuesButtons) {
      btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    }
  }

  setDebugText(text: string): void {
    if (text.length === 0) {
      this.debugEl.setAttribute('hidden', '');
      this.debugEl.textContent = '';
      return;
    }
    this.debugEl.removeAttribute('hidden');
    this.debugEl.textContent = text;
  }

  setInstallHintVisible(visible: boolean): void {
    if (visible) this.installHintEl.removeAttribute('hidden');
    else this.installHintEl.setAttribute('hidden', '');
  }

  // -------------------------------------------------------------------- //
  // Internals
  // -------------------------------------------------------------------- //

  private applyScreen(screen: ScreenName): void {
    for (const name of SCREEN_NAMES) {
      const el = this.screens[name];
      const active = name === screen;
      el.classList.toggle('screen--active', active);
      if (active) {
        el.removeAttribute('aria-hidden');
        el.removeAttribute('inert');
      } else {
        el.setAttribute('aria-hidden', 'true');
        el.setAttribute('inert', '');
      }
    }

    // The settings sheet overrides the home screen's own default focus
    // target while it's open — it owns focus, not the Play button.
    if (screen === 'home' && this.settingsOpen) {
      this.focusSettingsClose();
      return;
    }

    const target =
      screen === 'permission'
        ? this.hasCameraFailure
          ? this.retryButtonEl
          : this.continueButtonEl
        : this.focusTargets[screen];
    if (target) {
      try {
        target.focus({ preventScroll: true });
      } catch {
        // Focus can fail in exotic embedding contexts; never fatal.
      }
    }
  }

  /**
   * Opens/closes the "About" sheet. Purely presentational: this never
   * touches game state or preferences, and never emits a UIIntent by itself
   * — only the toggles and buttons inside it do that.
   */
  private setSettingsOpen(open: boolean, options: { focusTrigger: boolean }): void {
    this.settingsOpen = open;
    if (open) {
      this.settingsSheetEl.removeAttribute('hidden');
      this.homeMainEl.setAttribute('inert', '');
      this.settingsButtonEl.setAttribute('aria-expanded', 'true');
      this.focusSettingsClose();
    } else {
      this.settingsSheetEl.setAttribute('hidden', '');
      this.homeMainEl.removeAttribute('inert');
      this.settingsButtonEl.setAttribute('aria-expanded', 'false');
      if (options.focusTrigger) {
        try {
          this.settingsButtonEl.focus({ preventScroll: true });
        } catch {
          // Never fatal.
        }
      }
    }
  }

  private focusSettingsClose(): void {
    const closeButton = this.settingsCloseButtons[0];
    if (!closeButton) return;
    try {
      closeButton.focus({ preventScroll: true });
    } catch {
      // Never fatal.
    }
  }

  private readonly handleClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const actionEl = target.closest<HTMLElement>('[data-action]');
    if (!actionEl || !this.root.contains(actionEl)) return;
    const action = actionEl.dataset['action'];

    switch (action) {
      case 'play':
      case 'continue':
        this.intents.onPlay();
        break;
      case 'pause':
        this.intents.onPause();
        break;
      case 'resume':
        this.intents.onResume();
        break;
      case 'restart':
        this.intents.onRestart();
        break;
      case 'quit':
        this.intents.onQuitToHome();
        break;
      case 'toggle-mute':
        this.intents.onToggleMute();
        break;
      case 'toggle-vision':
        this.intents.onToggleVision();
        break;
      case 'toggle-motion-cues':
        this.intents.onToggleMotionCues();
        break;
      case 'toggle-settings':
        this.setSettingsOpen(!this.settingsOpen, { focusTrigger: true });
        break;
      case 'close-settings':
        this.setSettingsOpen(false, { focusTrigger: true });
        break;
      case 'play-without-camera-pre':
      case 'play-without-camera-fail':
        this.intents.onPlayWithoutCamera();
        break;
      case 'retry':
        this.intents.onRetryCamera();
        break;
      case 'play-demo':
        // The demo can be launched from the settings sheet on home; close it
        // first so the click doesn't leave a stray open sheet on whatever
        // screen we land on next.
        if (this.settingsOpen) this.setSettingsOpen(false, { focusTrigger: false });
        this.intents.onPlayDemoVideo();
        break;
      default:
        break;
    }
  };

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.settingsOpen) {
      this.setSettingsOpen(false, { focusTrigger: true });
    }
  };

  private setupViewportGuard(): void {
    const setAppVh = (): void => {
      const vv = window.visualViewport;
      const height = vv ? vv.height : window.innerHeight;
      document.documentElement.style.setProperty('--app-vh', `${height * 0.01}px`);
    };

    setAppVh();
    window.addEventListener('resize', setAppVh);
    window.addEventListener('orientationchange', setAppVh);
    window.visualViewport?.addEventListener('resize', setAppVh);
  }
}

export function createUIController(root: HTMLElement, intents: UIIntents): UIController {
  return new GlassyUIController(root, intents);
}
