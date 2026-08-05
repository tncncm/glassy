# Glassy

Mobile-first PWA: the phone's rear camera is a live "car side window" background, and a
transparent PixiJS canvas renders a tiny endless-runner character above it.

The core-loop prototype validated (2026-08-05: "è divertente"). The camera is still primarily a
moving backdrop, but there is now **one deliberately minimal piece of scene analysis**: a
horizon estimate that *biases* the running surface. It is a hint only — the player's drag always
wins, and the game stays fully playable when the estimate is absent or wrong. **No ML models, no
object detection** — those would need external assets and blow the frame budget on iPhone.

Primary target: **iPhone Safari + installed iOS PWA, landscape**. Secondary: Chrome, Edge, Android Chrome.

## Stack — fixed, do not expand further

Vite · TypeScript (strict) · PixiJS v8 · vite-plugin-pwa · **`@mediapipe/tasks-vision`**.
No backend, no login, no cloud, no analytics, no React, no game engine, no physics engine, no
state library. Plain TypeScript and DOM APIs. All visuals are Pixi primitives and all audio is
synthesised.

**Asset rule (relaxed 2026-08-05, once and deliberately):** the ONLY permitted binary assets are
the MediaPipe vision wasm runtime and the EfficientDet-Lite0 int8 detector model, both
**self-hosted from `public/`** — never a CDN, never fetched from Google at runtime. No images,
no fonts, no audio files, no other models. Everything else stays procedural.

## Commands

```bash
npm run dev        # dev server
npm run dev -- --host   # expose on the LAN
npx tsc --noEmit   # strict typecheck
npm run build      # production build (must pass before any commit that claims completion)
npm run preview    # serve dist/
```

## Non-negotiable invariants

- **Privacy:** camera frames are **read and analysed on-device only**, by `src/vision/**` —
  a tiny gradient pass for the horizon, and an EfficientDet-Lite0 detector that returns object
  labels and boxes. **Inference is local; there is no network call in the inference path and no
  backend to call.** Nothing is recorded, uploaded, transmitted or persisted: no frame, crop,
  thumbnail, embedding, fingerprint or detection result may outlive the current tick, and no
  detection is ever written to storage. `localStorage` holds only `bestScore`, `muted` and
  `visionEnabled`. Nothing else is persisted, ever.
  **If this boundary moves again, the user-facing privacy copy must change first.**
- **Detection is strictly additive.** The game must play identically well with detection off,
  unsupported, still downloading, or failing. It only *flavours* what spawns; it never gates
  the loop, and detection-driven spawns still go through `util/solvability.ts`.
- **Safety copy:** the home screen must always carry "Passenger use only. Do not use while driving."
  Nothing in the UI may imply driver use is safe.
- **Camera permission** is requested only from a direct user gesture, after Play — never on load.
- **No allocation in the update loop.** Pool obstacles and particles; never construct `Text`,
  `Graphics` or closures per frame. All motion is delta-time based and frame-rate independent.
- **Recoverable errors never crash the app**: denied camera, missing camera, insecure context,
  audio init failure, service-worker registration failure, `localStorage` throwing in private mode.
- The game must be fully playable in **no-camera fallback mode** (animated gradient background).

## Layout

```
src/main.ts               bootstrap
src/app/App.ts            app state machine, wires camera + game + UI
src/camera/CameraController.ts
src/game/{Game,GameLoop,config}.ts
src/game/entities/{Player,Obstacle}.ts
src/game/systems/{ObstacleSystem,ParticleSystem,InputSystem,AudioSystem}.ts
src/ui/UIController.ts    all screens, pure view + typed intent callbacks
src/storage/Preferences.ts
src/styles.css
```

## Agents

Specialists live in `.claude/agents/`. Route work to them rather than doing everything inline:
`pixi-game-engineer` · `camera-media-engineer` · `ui-screens-engineer` · `pwa-platform-engineer`
· `audio-engineer` · `build-verifier` · `fly-deploy-engineer`.

## Verified environment (2026-08-04)

- Git remote `origin` → `git@github.com:tncncm/glassy.git`, SSH auth as `tncncm`, push verified.
  Repo-local identity is `enricomariatenca@gmail.com` — commit with that, not the Roarington global.
- `flyctl` logged in as `enricomariatenca@gmail.com`, personal org, deploy rights confirmed.

Full brief, phase plan and verification checklist: [docs/HANDOVER.md](docs/HANDOVER.md).
