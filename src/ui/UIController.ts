/**
 * Glassy — UIController.
 *
 * A pure view: builds every screen once as static DOM, toggles visibility by
 * class/attribute, and emits typed intents. It never touches Pixi, the
 * camera, game state or localStorage directly.
 */

import type {
  CameraFailure,
  DetectorState,
  DetectorStatus,
  GameOverResult,
  ScreenName,
  UIController,
  UIIntents,
  VisionMode,
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

const VISION_TITLE = 'Spot real things out the window';
const VISION_DESC = 'On-device AI: one-time ~9 MB download, more battery.';
const VISION_ARIA_LABEL =
  'Spot real things out the window. Uses on-device AI: one-time about 9 megabyte download, more battery. Off by default.';
const VISION_ICON = '\u{1F50D}'; // magnifying glass

interface VisionModeOption {
  mode: VisionMode;
  label: string;
  desc: string;
}

// Copy is deliberately concrete about the physical action ("phone pointed")
// and the consequence (what the camera sees / what the game does with it) —
// the two modes must be legible without trying both.
const VISION_MODE_OPTIONS: readonly VisionModeOption[] = [
  {
    mode: 'window',
    label: 'Side window',
    desc: 'Phone pointed out the side. Scenery rushes past.',
  },
  {
    mode: 'windscreen',
    label: 'Windscreen',
    desc: 'Phone pointed forward. Jump onto the vehicle ahead.',
  },
];

/** Narrows a raw dataset string to VisionMode, or null if it isn't one. */
function parseVisionMode(value: string | undefined): VisionMode | null {
  return value === 'window' || value === 'windscreen' ? value : null;
}

/**
 * One radio option. `aria-label` always carries the full "label. consequence"
 * sentence, independent of whether the description is visually shown — CSS
 * (the paused screen's compact layout, and the short-height media query on
 * the home screen) is free to hide `.vision-mode__desc` to save vertical
 * space without ever taking the consequence away from screen reader users.
 */
function visionModeOptionHtml(option: VisionModeOption): string {
  const checked = option.mode === 'window';
  return `
    <button
      type="button"
      class="vision-mode__option"
      data-action="select-vision-mode"
      data-vision-mode-button
      data-mode="${option.mode}"
      role="radio"
      aria-checked="${checked ? 'true' : 'false'}"
      tabindex="${checked ? '0' : '-1'}"
      aria-label="${option.label}. ${option.desc}"
    >
      <span class="vision-mode__dot" aria-hidden="true"></span>
      <span class="vision-mode__text">
        <span class="vision-mode__label">${option.label}</span>
        <span class="vision-mode__desc">${option.desc}</span>
      </span>
    </button>`;
}

/**
 * A full radiogroup, rendered once per screen that hosts it (home + paused)
 * so both can toggle by class with no per-transition DOM churn, same as every
 * other screen element.
 */
function visionModeGroupHtml(compact: boolean): string {
  const options = VISION_MODE_OPTIONS.map((opt) => visionModeOptionHtml(opt)).join('');
  return `
    <div
      class="vision-mode${compact ? ' vision-mode--compact' : ''}"
      data-role="vision-mode-group"
      role="radiogroup"
      aria-label="Camera framing"
    >${options}
    </div>`;
}

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

  <div class="screen" data-screen="home">
    <div class="panel home__panel">
      <h1 class="home__title">Glassy</h1>
      <p class="home__pitch">A tiny endless runner that plays over your car window.</p>
      <div class="stat home__best">
        <span class="stat__label">Best</span>
        <span class="stat__value" data-role="home-best">0</span>
      </div>
      <div class="safety-line">
        <span class="safety-line__icon" aria-hidden="true">⚠️</span>
        <span>Passenger use only. Do not use while driving.</span>
      </div>
      <p class="privacy-line">Your camera is the backdrop — shown live on your screen, never recorded. Glassy looks at the picture only on your phone, to find the horizon and, if you turn it on below, to spot real things like cars and signs. Nothing is ever uploaded or sent anywhere — no frame and no detection is ever stored. The detection model downloads once to your phone and runs there; there's no server.</p>
      <div class="vision" data-role="vision">
        <button
          type="button"
          class="vision__toggle"
          data-action="toggle-vision"
          data-vision-button
          aria-pressed="false"
          aria-label="${VISION_ARIA_LABEL}"
        >
          <span class="vision__switch" aria-hidden="true"></span>
          <span class="vision__copy">
            <span class="vision__title">${VISION_TITLE}</span>
            <span class="vision__desc">${VISION_DESC}</span>
          </span>
        </button>
        <p class="vision__status" data-role="vision-status" hidden>
          <span data-role="vision-status-text"></span>
        </p>
        <div class="vision__progress" data-role="vision-progress" hidden aria-hidden="true">
          <div class="vision__progress-fill" data-role="vision-progress-fill"></div>
        </div>
        ${visionModeGroupHtml(false)}
      </div>
      <div class="home__actions">
        <button type="button" class="btn btn--primary btn--block" data-action="play">Play</button>
        <button type="button" class="btn btn--icon home__mute" data-action="toggle-mute" data-mute-button aria-pressed="false" aria-label="${MUTE_LABEL_ON}">${MUTE_ICON_ON}</button>
      </div>
      <p class="install-hint" data-install-hint hidden>
        For true full screen on iPhone: tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>, and open Glassy from there.
      </p>
    </div>
  </div>

  <div class="screen" data-screen="permission">
    <div class="panel permission__panel">
      <div class="permission__state" data-state="pre-request">
        <div class="permission__icon" aria-hidden="true">\u{1F4F7}</div>
        <h2 class="permission__title">Camera as a backdrop</h2>
        <p class="permission__body">Glassy uses your rear camera as a live backdrop behind the game. It looks at the picture only on your phone — to find the horizon and, if you turned on real-world detection, to spot things like cars and signs. Nothing is ever recorded, saved or sent anywhere: no frame and no detection ever leaves your phone, and there's no server for it to reach.</p>
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
        <button type="button" class="btn btn--icon" data-action="toggle-vision" data-vision-button aria-pressed="false" aria-label="${VISION_ARIA_LABEL}">${VISION_ICON}</button>
      </div>
      ${visionModeGroupHtml(true)}
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
  private readonly visionModeButtons: HTMLButtonElement[];
  private readonly visionModeGroups: HTMLElement[];

  private currentScreen: ScreenName = 'loading';
  private lastScore = -1;
  private lastBest = -1;
  private lastMuted: boolean | null = null;
  private hasCameraFailure = false;
  private lastDetectorStatus: DetectorStatus | null = null;
  private lastDetectorProgress: number | null = null;
  private lastVisionMode: VisionMode | null = null;

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
    this.visionModeButtons = Array.from(
      this.root.querySelectorAll<HTMLButtonElement>('[data-vision-mode-button]'),
    );
    this.visionModeGroups = Array.from(
      this.root.querySelectorAll<HTMLElement>('[data-role="vision-mode-group"]'),
    );

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
    this.setVisionMode('window');
    this.setupViewportGuard();
  }

  get screen(): ScreenName {
    return this.currentScreen;
  }

  show(screen: ScreenName): void {
    this.currentScreen = screen;
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
    // The framing choice only matters once detection is actually on — read it
    // as inactive/secondary rather than hiding it (the user may want to
    // preset it before opting in) or disabling it (which would need its own
    // explanation for why a control it can plainly reach doesn't respond).
    for (const group of this.visionModeGroups) {
      group.classList.toggle('vision-mode--inactive', !on);
    }

    switch (state.status) {
      case 'loading': {
        this.visionStatusEl.removeAttribute('hidden');
        this.visionProgressEl.removeAttribute('hidden');
        if (progress !== null) {
          const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);
          this.visionStatusTextEl.textContent = `Downloading on-device AI… ${pct}%`;
          this.visionProgressEl.classList.remove('vision__progress--indeterminate');
          this.visionProgressFillEl.style.width = `${pct}%`;
        } else {
          // No progress figure yet — show real motion, never a fabricated number.
          this.visionStatusTextEl.textContent = 'Downloading on-device AI…';
          this.visionProgressEl.classList.add('vision__progress--indeterminate');
          this.visionProgressFillEl.style.width = '';
        }
        break;
      }
      case 'ready':
        this.visionStatusEl.removeAttribute('hidden');
        this.visionProgressEl.setAttribute('hidden', '');
        this.visionProgressEl.classList.remove('vision__progress--indeterminate');
        this.visionStatusTextEl.textContent = 'On-device AI ready.';
        break;
      case 'unavailable':
        this.visionStatusEl.removeAttribute('hidden');
        this.visionProgressEl.setAttribute('hidden', '');
        this.visionProgressEl.classList.remove('vision__progress--indeterminate');
        this.visionStatusTextEl.textContent =
          "Detection couldn't start — the game plays normally without it.";
        break;
      case 'idle':
      case 'disabled':
        this.visionStatusEl.setAttribute('hidden', '');
        this.visionProgressEl.setAttribute('hidden', '');
        this.visionProgressEl.classList.remove('vision__progress--indeterminate');
        break;
      default:
        break;
    }
  }

  setVisionMode(mode: VisionMode): void {
    if (mode === this.lastVisionMode) return;
    this.lastVisionMode = mode;
    for (const btn of this.visionModeButtons) {
      const checked = parseVisionMode(btn.dataset['mode']) === mode;
      btn.setAttribute('aria-checked', checked ? 'true' : 'false');
      btn.tabIndex = checked ? 0 : -1;
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
      case 'select-vision-mode': {
        const mode = parseVisionMode(actionEl.dataset['mode']);
        if (mode) this.intents.onSelectVisionMode(mode);
        break;
      }
      case 'play-without-camera-pre':
      case 'play-without-camera-fail':
        this.intents.onPlayWithoutCamera();
        break;
      case 'retry':
        this.intents.onRetryCamera();
        break;
      case 'play-demo':
        this.intents.onPlayDemoVideo();
        break;
      default:
        break;
    }
  };

  /**
   * Roving-tabindex arrow-key navigation for the vision-mode radiogroups.
   * Individual radios are already reachable and activatable via Tab +
   * Enter/Space (native `<button>` behaviour); this adds the conventional
   * left/right (and up/down) radio-group navigation on top.
   */
  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (
      event.key !== 'ArrowLeft' &&
      event.key !== 'ArrowRight' &&
      event.key !== 'ArrowUp' &&
      event.key !== 'ArrowDown'
    ) {
      return;
    }
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.getAttribute('role') !== 'radio') return;
    const group = target.closest<HTMLElement>('[role="radiogroup"]');
    if (!group || !this.root.contains(group)) return;
    const options = Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    const index = options.indexOf(target as HTMLButtonElement);
    if (index === -1) return;
    event.preventDefault();
    const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
    const next = options[(index + delta + options.length) % options.length];
    const mode = parseVisionMode(next?.dataset['mode']);
    if (next && mode) {
      next.focus();
      this.intents.onSelectVisionMode(mode);
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
