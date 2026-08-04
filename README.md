# Glassy

A mobile-first PWA that turns your phone's rear camera into a live "car side window"
background, with a tiny endless-runner character rendered above it on a transparent
PixiJS canvas.

**Live:** https://glassy.fly.dev/

> **Passenger use only. Do not use while driving.**

There is deliberately **no computer vision**. The camera is only a moving backdrop;
gameplay is entirely independent of it, which is why the game stays fully playable in
no-camera fallback mode.

## Privacy

Camera frames are never read, recorded, uploaded or stored. The stream is attached to a
`<video>` element and nothing else — no `drawImage`, no pixel reads, no `MediaRecorder`.
`localStorage` holds exactly two values: `bestScore` and `muted`. There is no backend, no
login, no analytics.

## Running locally

```bash
npm install
npm run dev              # dev server on http://localhost:5173
npm run dev -- --host    # also expose on the LAN, for testing from a phone
npm run build            # typecheck + production build into dist/
npm run preview          # serve the production build
```

## Testing on an iPhone

`getUserMedia` only runs in a **secure context**. Over plain `http://` — including a LAN
address like `http://192.168.1.20:5173` — mobile Safari will not grant camera access at
all. `localhost` is exempt, but your phone is not your laptop's localhost.

So: **use the deployed URL**, https://glassy.fly.dev/, which is HTTPS and works as-is.
Add it to your home screen to test it as an installed PWA in landscape. An HTTPS tunnel
(`cloudflared tunnel --url http://localhost:5173` or ngrok) is the backup if you need to
test uncommitted local changes on-device.

Without HTTPS the app still runs — it detects the insecure context up front and drops
into the animated-gradient fallback rather than failing.

## Architecture

Three stacked layers, which is what makes the fallback trivial:

| Layer | What |
| --- | --- |
| 0 | `<video>` with the camera feed, or a `<canvas>` painting an animated gradient |
| 1 | Transparent PixiJS canvas (`backgroundAlpha: 0`) — the game |
| 2 | DOM screens — home, permission, rotate, HUD, pause, game over |

`src/app/App.ts` is the only state machine. Camera, game, audio, preferences and UI are
dumb collaborators that never reach into each other; every interaction is routed through
typed callbacks declared in `src/types.ts`, the single shared contract.

```
src/types.ts                     shared contract between all layers
src/main.ts                      bootstrap
src/app/App.ts                   state machine, wires everything
src/camera/CameraController.ts   getUserMedia, lifecycle, failure mapping
src/camera/FallbackBackground.ts animated no-camera gradient
src/game/{Game,GameLoop,config}.ts
src/game/entities/{Player,Obstacle}.ts
src/game/systems/{ObstacleSystem,ParticleSystem,InputSystem,AudioSystem}.ts
src/game/util/solvability.ts     derives jumpable obstacle spacing from the jump arc
src/ui/UIController.ts           all screens, pure view + typed intents
src/storage/Preferences.ts       the only code that touches localStorage
```

Notable properties: hand-rolled physics with coyote time and jump buffering; obstacles and
particles are pooled with zero allocation in the update loop; delta time is clamped to 50 ms
so a backgrounded tab can't tunnel the player through an obstacle; and obstacle spacing and
height are *derived* from the jump arc at the current world speed, so the difficulty ramp
cannot produce an impossible gap.

## Controls

Tap to jump. Drag vertically to move the running surface up and down — that's the point of
the thing, it lets you line the ground up with whatever is out the window. On desktop,
Space/↑ jumps and W/S move the platform.

## Stack

Vite · TypeScript (strict) · PixiJS v8 · vite-plugin-pwa. All visuals are Pixi primitives,
all audio is synthesised at runtime with Web Audio — zero external media assets.

## Deployment

Multi-stage Docker build (Node 22 → nginx-unprivileged, ~18 MB) on Fly.io in `fra`, with
`force_https = true` and machines scaling to zero. `index.html`, the manifest and the
service worker are served `no-cache`/`no-store` so installed PWAs never get stuck on a
stale shell; hashed assets are immutable.

```bash
flyctl deploy
```
