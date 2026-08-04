# Glassy

Mobile-first PWA: the phone's rear camera is a live "car side window" background, and a
transparent PixiJS canvas renders a tiny endless-runner character above it. The prototype
exists to validate whether the interaction *feels fun* — there is deliberately **no computer
vision**; the camera is only a moving backdrop and gameplay is fully independent of it.

Primary target: **iPhone Safari + installed iOS PWA, landscape**. Secondary: Chrome, Edge, Android Chrome.

## Stack — fixed, do not expand

Vite · TypeScript (strict) · PixiJS v8 · vite-plugin-pwa. No backend, no login, no cloud, no
analytics, no React, no game engine, no physics engine, no state library. Plain TypeScript and
DOM APIs. All visuals are Pixi primitives and all audio is synthesised — **zero external media assets**.

## Commands

```bash
npm run dev        # dev server
npm run dev -- --host   # expose on the LAN
npx tsc --noEmit   # strict typecheck
npm run build      # production build (must pass before any commit that claims completion)
npm run preview    # serve dist/
```

## Non-negotiable invariants

- **Privacy:** camera frames are never read, recorded, uploaded or stored. `localStorage` holds
  only `bestScore` and `muted`. Nothing else is persisted, ever.
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
