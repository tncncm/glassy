# Glassy

Mobile-first PWA played by a car **passenger**, phone in landscape held up to the
**windscreen**. The rear camera is the live backdrop; a transparent PixiJS canvas draws the game
over it. Real vehicles ahead are detected and become **platforms**: the player hops from a fixed
block on the left to one on the right, across the traffic. Falling is the only way to lose.

The original side-window endless runner is **deleted** — it validated the feel, then was replaced.

There IS computer vision now, and it is central rather than incidental:
`@mediapipe/tasks-vision` object detection in a worker, cross-frame tracking, a per-column
silhouette scan for the landing surface, a carriageway filter, an optical-flow scene reader
(focus of expansion + ego-motion), and device-motion for comfort cues and shake damping.

**The game must remain fully playable when every one of those fails.** Detection is opt-in and
off by default; synthetic "ghost" platforms guarantee a crossing is always possible; an empty
road and a busy road must play and score identically.

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
  detection is ever written to storage. `localStorage` holds only `bestScore`, `muted`,
  `visionEnabled` and `motionCues`. Nothing else is persisted, ever.
  **If this boundary moves again, the user-facing privacy copy must change first.**
- **Detection is strictly additive.** The game must play identically well with detection off,
  unsupported, still downloading, or failing. Ghost platforms are first class, not a consolation.
- **Nothing may reward more traffic.** The player is a passenger and the driver is right there:
  no score, HUD or copy may make a busy road better than an empty one, or frame "no cars" as a
  degraded state. A no-ghost bonus existed once and was deleted for exactly this reason.
- **Safety copy:** the home screen must always carry "Passenger use only. Do not use while driving."
  Nothing in the UI may imply driver use is safe.
- **Camera permission** is requested only from a direct user gesture, after Play — never on load.
- **No allocation in the update loop.** Pool obstacles and particles; never construct `Text`,
  `Graphics` or closures per frame. All motion is delta-time based and frame-rate independent.
- **Recoverable errors never crash the app**: denied camera, missing camera, insecure context,
  audio init failure, service-worker registration failure, `localStorage` throwing in private mode.
- The game must be fully playable in **no-camera fallback mode** (animated gradient background).
- **Solvability is derived, never guessed.** Ghost-platform spacing comes from the actual jump
  envelope at current settings, so a crossing is always physically possible — including on a
  completely empty road.

## Layout

```
src/types.ts              THE shared contract — every layer implements it, nothing bypasses it
src/main.ts               bootstrap
src/app/App.ts            the one state machine; wires every layer, owns no logic of its own
src/camera/{CameraController,FallbackBackground}.ts
src/video/VideoBackdrop.ts        demo clip + dev ?video= override
src/motion/MotionSensor.ts        DeviceMotion, iOS-gated, for comfort cues and shake damping
src/vision/SceneAnalyser.ts       horizon estimate
src/vision/ObjectDetector.ts      proxy to the worker
src/vision/detector.worker.ts     MediaPipe, CPU delegate, off the main thread
src/vision/DetectionTracker.ts    cross-frame association and smoothing
src/vision/SurfaceProfileFinder.ts  per-column silhouette -> the landing surface
src/vision/CarriagewayFilter.ts   keep only vehicles on our own side
src/vision/OpticalFlow.ts         focus of expansion + ego-motion (not wired in yet)
src/game/{Game,GameLoop,config}.ts
src/game/entities/{Player,Platform}.ts
src/game/systems/{CrossingSystem,ParticleSystem,InputSystem,MotionCueSystem,AudioSystem}.ts
src/game/util/{solvability,math}.ts
src/ui/UIController.ts    all screens, pure view + typed intent callbacks
src/storage/Preferences.ts
src/styles.css
tools/video-sim/          dev-only: replay the real vision stack against recorded footage
```

## Measure, don't guess

Every vision claim in this project has been settled by running the real code against real
dashcam footage, never by reasoning about it. `tools/video-sim/run.mjs <clip> --windscreen`
replays the whole stack and writes annotated frames. Several confident-sounding designs died
there — a quantised model that emitted pure noise, an "obviously correct" horizon estimator that
locked onto the crash barrier, an optical-flow detector that found embankments. Use it before
claiming anything works.

## Agents

Specialists live in `.claude/agents/`. Route work to them rather than doing everything inline:
`vision-engineer` (owns `src/vision/**`) · `pixi-game-engineer` · `camera-media-engineer`
(strictly `src/camera/**` — getUserMedia and lifecycle, NOT computer vision) · `ui-screens-engineer`
· `pwa-platform-engineer` · `audio-engineer` · `build-verifier` · `fly-deploy-engineer`.

Respect the boundaries: `src/vision/**` is CV work and belongs to `vision-engineer`, not to
`camera-media-engineer`, whose remit stops at the media stream.

## Verified environment (2026-08-04)

- Git remote `origin` → `git@github.com:tncncm/glassy.git`, SSH auth as `tncncm`, push verified.
  Repo-local identity is `enricomariatenca@gmail.com` — commit with that, not the Roarington global.
- `flyctl` logged in as `enricomariatenca@gmail.com`, personal org, deploy rights confirmed.

Full brief, phase plan and verification checklist: [docs/HANDOVER.md](docs/HANDOVER.md).
