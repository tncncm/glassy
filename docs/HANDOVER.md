# Glassy — handover for the build session

Written 2026-08-04 at the end of the setup session. Everything below is either **verified fact**
or a **decision already made**. The next session should not re-litigate any of it — it should build.

---

## 1. Status: what is already done

| Item | State |
| --- | --- |
| Project directory | `/Users/enricotenca/Projects/Glassy` — was empty apart from `.vscode/` |
| Git repo | initialised, branch `main`, `.gitignore` + `README.md` committed |
| GitHub remote | `origin` = `git@github.com:tncncm/glassy.git` — **push verified**, repo was empty |
| GitHub auth | SSH key `~/.ssh/id_ed25519_tncncm`, `ssh -T git@github.com` → "Hi tncncm!" |
| Git identity | repo-local `user.email = enricomariatenca@gmail.com`, `user.name = Enrico Maria Tenca` (the **global** identity is `system@roarington.com` — do not use it here) |
| Fly.io | `flyctl v0.4.76`, `flyctl auth whoami` → `enricomariatenca@gmail.com`, personal org, 3 existing apps — **deploy access confirmed** |
| Toolchain | Node v22.15.0, npm 11.6.2, git 2.53.0. `gh` CLI is **not installed** — use plain git over SSH |
| Agents | 7 specialists written to `.claude/agents/` |
| App code | **none yet** — this is the work |

## 2. Agent roster and routing

| Agent | Owns |
| --- | --- |
| `pixi-game-engineer` | `src/game/**` except AudioSystem — entities, systems, physics, config, scoring |
| `camera-media-engineer` | `src/camera/**` — getUserMedia, lifecycle, errors, no-camera fallback |
| `ui-screens-engineer` | `index.html`, `src/ui/**`, `src/styles.css`, `src/storage/Preferences.ts` |
| `pwa-platform-engineer` | `vite.config.ts`, `tsconfig.json`, `package.json`, `public/` icons, manifest, service worker |
| `audio-engineer` | `src/game/systems/AudioSystem.ts` |
| `build-verifier` | typecheck, production build, `dist/` + PWA artifact inspection, smoke test |
| `fly-deploy-engineer` | `Dockerfile`, `fly.toml`, deploy, live-URL verification, git push |

Agent definitions are only loaded at session start — that is the sole reason this handover exists.

## 3. Architecture decisions (already made)

- **Two layers, not one.** A `<video>` element fills the viewport; a PixiJS canvas with
  `backgroundAlpha: 0` sits above it; the DOM UI sits above that. Pixi never touches the video,
  and the game never reads camera pixels. This is what makes the no-camera fallback trivial:
  swap the video for an animated CSS/canvas gradient and nothing in the game changes.
- **`App.ts` is the only state machine.** States: `loading → home → requestingCamera →
  playing ⇄ paused ⇄ rotate → gameOver`. Camera, game and UI are dumb collaborators wired by
  `App`; they communicate through typed callbacks, never by reaching into each other.
- **`UIController` is a pure view.** Pre-built DOM toggled by class, typed intent callbacks out.
  No game logic, no Pixi references.
- **Hand-rolled physics.** Gravity, vertical velocity, jump impulse, AABB collision, landing
  detection. Delta time in seconds, clamped to ~0.05 s so a backgrounded tab cannot tunnel the
  player through an obstacle.
- **Solvability is derived, not guessed.** Minimum obstacle spacing comes from the jump arc
  (apex time and horizontal reach at current speed) computed from `config.ts`, so difficulty
  ramping can never produce an impossible gap.
- **Pooling everywhere.** Obstacles and particles are recycled; `Graphics` and `Text` objects are
  created once. Nothing is allocated inside `update()`.
- **Deployment is static.** Multi-stage Dockerfile (Node build → tiny static server serving
  `dist/`) on Fly.io, `force_https = true`, machines scaling to zero. HTTPS is not optional:
  mobile `getUserMedia` refuses to run without it.

## 4. Build plan

**Phase 0 — scaffold (inline, no agent).** `npm create vite@latest . -- --template vanilla-ts`,
install `pixi.js` + `vite-plugin-pwa`, strict `tsconfig`, verify `npm run build` on the skeleton
before any feature work lands. Commit.

**Phase 1 — parallel foundations.** Run concurrently, they touch disjoint files:
`pwa-platform-engineer` (vite/PWA/manifest/icons/iOS meta) · `ui-screens-engineer` (all screens,
CSS, safe areas, Preferences) · `camera-media-engineer` (CameraController + fallback) ·
`audio-engineer` (AudioSystem). Define the shared TypeScript interfaces **before** dispatching so
the seams line up. Then `build-verifier`. Commit.

**Phase 2 — gameplay.** `pixi-game-engineer` builds the game layer against those interfaces:
Player, Obstacle, ObstacleSystem, ParticleSystem, InputSystem, GameLoop, Game, config, scoring,
screen shake, particles. Then `build-verifier`. Commit.

**Phase 3 — integration.** Wire `App.ts` inline: state machine, orientation handling, visibility
handling, pause/resume, dev-only FPS flag. `build-verifier` runs the full checklist. Commit + push.

**Phase 4 — deploy.** `fly-deploy-engineer`: Dockerfile, `fly.toml`, `flyctl deploy`, verify the
live HTTPS URL, push to GitHub.

## 5. Verification checklist (from the brief — must be worked through before claiming done)

Installs · dev server starts · `tsc --noEmit` clean · production build succeeds · Pixi initialises ·
camera starts only after user interaction · rear camera preferred · no-camera fallback playable ·
transparent canvas overlays video · tap jumps · vertical drag moves the platform · obstacles spawn
and move · collision ends the game · score works · best score persists · pause/resume works · mute
works and persists · portrait warning works · safe areas respected · manifest generated · service
worker generated · icons exist · no camera footage uploaded or stored.

Anything requiring a real iPhone, a real camera or on-device HTTPS must be reported as
**not verifiable in this environment** — never as passed.

## 6. Final deliverables the session owes the user

Architecture summary · main files created · how to run locally · how to expose on the LAN
(`npm run dev -- --host`) · why mobile camera access needs HTTPS · simplest HTTPS test path for an
iPhone (the Fly.io URL is the answer; a local tunnel is the backup) · known limitations · and a
suggested next step for lightweight landscape-aware interaction later (e.g. cheap horizon/edge
estimation from a downscaled frame to bias platform height — explicitly *not* in this prototype).

## 7. Traps to avoid

- **PixiJS v8, not v7.** `await app.init({...})`; `Graphics` is `.rect(...).fill(...)`, there is no
  `beginFill`/`drawRect`/`endFill`. Check the installed typings before inventing an API.
- iOS `<video>` needs `playsinline` + `muted` + `autoplay` or it opens fullscreen or refuses to play.
- iOS `AudioContext` starts suspended and re-suspends on backgrounding — resume behind a gesture.
- `localStorage` throws in Safari private mode — wrap every access.
- `screen.orientation.lock()` is unsupported on iOS Safari; detect orientation by measurement and
  show the rotate screen. An opportunistic `lock()` in a try/catch is fine, load-bearing use is not.
- Cache headers: `index.html`, the manifest and the service worker must be `no-cache`, or installed
  PWAs get stuck on a stale shell.
- Cap `devicePixelRatio` (≈2) — a 3× iPhone rendering full-res canvas over live video will not hold 60 FPS.
