# Dev-only: YOLO instance segmentation behind `?seg=yolo`

Status: **prototype, dev-only, never shipped**. This note exists so a future
session (or you, later) can reproduce the on-device iPhone measurement
without re-deriving any of this.

## What this is

`src/vision/experimental/` holds an evaluation of whether a YOLOv8n-seg
instance-segmentation model, run through ONNX Runtime Web, produces a
better landing surface than the shipped `SurfaceProfileFinder` (which
approximates a vehicle's roofline from a box with a gradient scan). It
measured well on desktop. This wiring makes it reachable in `npm run dev`
so the real open question — **what does it cost on an iPhone** — can
finally be answered.

It is gated behind `?seg=yolo` in a dev build (`import.meta.env.DEV`) and
is **structurally incapable of reaching a production bundle** — see
"Why this can never ship" below.

## Why this can never ship

YOLOv8n-seg's published weights are **AGPL-3.0**. Serving them from
`glassy.fly.dev` to a visitor's browser is distribution and would trigger
AGPL obligations regardless of money changing hands. Local `npm run dev`
and testing on your own phone over your own LAN is not distribution to
anyone else — that's the boundary this whole setup is built around.

Three independent things keep it out of `dist/`:

1. **The model file itself is never fetched by any script.**
   `scripts/fetch-seg-assets.mjs` (unlike `scripts/fetch-vision-assets.mjs`,
   which `npm run dev`/`npm run build` run automatically) is **not** wired
   into `npm run dev` or `npm run build` — it must be run by hand, and it
   only copies the ONNX Runtime Web *wasm runtime* out of `node_modules`.
   The `.onnx` model itself is fetched by nothing in this repo (see
   "Getting the model" below) and lives under `tools/video-sim/models/`,
   which is gitignored and, critically, **outside `public/`** — Vite only
   copies `public/` into `dist/`, so a file here is never a candidate for
   shipping no matter how the build is invoked.

2. **The loader code is dynamically imported behind a literal
   `if (import.meta.env.DEV)`.** `src/app/App.ts`'s
   `initSegBridgeIfRequested()` reads:
   ```ts
   if (import.meta.env.DEV) {
     const mode = devSegMode();
     if (mode === 'yolo') {
       const { createSegGameBridge } = await import('../vision/experimental/SegGameBridge.ts');
       ...
     }
   }
   ```
   Vite replaces `import.meta.env.DEV` with the literal `false` in a
   production build, and Rollup's dead-code elimination removes the whole
   branch — including the dynamic `import()` — before it ever resolves
   `SegGameBridge.ts`, which is the only thing in the shipped app that
   imports `InstanceSegmenter.ts`, which is the only thing that imports
   `onnxruntime-web` or constructs the `segmenter.worker.ts` worker. None of
   it is reachable from the module graph a production build actually walks.
   This is the exact pattern already proven for `src/video/VideoBackdrop.ts`'s
   `?video=` override — see that file's own comment for the history of why
   the guard has to be literal and outer, not hidden inside a runtime helper.

3. **Verified against the actual `dist/` output, every time this is
   touched** — see "How this was verified" below. Don't take (1) and (2) on
   faith; grep the artifact.

## Getting the model

**Do not run a Python export or download a `.pt` checkpoint without being
asked to.** `torch.load` deserializes pickle and can execute arbitrary
code — a previous session did this unprompted and it was correctly flagged
as a security concern. If you need a fresh export, ask first.

If you already have Ultralytics installed in a Python environment you
trust, the export that matches what `segmenter.worker.ts` expects
(`output0` = `[1, 4+80+32, N]` box/class/mask-coefficient tensor,
`output1` = `[1, 32, protoH, protoW]` proto tensor, standard YOLOv8-seg
shape) is:

```bash
pip install ultralytics  # only if not already present
yolo export model=yolov8n-seg.pt format=onnx imgsz=320 simplify=True opset=12
```

This downloads the pretrained `yolov8n-seg.pt` checkpoint from Ultralytics
on first run — that download itself is the AGPL-licensed artifact this
whole prototype is built around never shipping. `imgsz=320` matches
`InstanceSegmenter.ts`'s `DEFAULT_INPUT_SIZE`; export a `640` variant too
(`imgsz=640`) if you want the quality-vs-cost comparison the file headers
describe.

Rename the output and place it at:

```
tools/video-sim/models/yolov8n-seg-320.onnx
```

(and, if exported, `tools/video-sim/models/yolov8n-seg-640.onnx`). Both
paths are gitignored — see `.gitignore`'s `tools/video-sim/models/` entry.

Then fetch the ONNX Runtime Web wasm runtime (safe to run any time, no
network calls beyond copying out of an already-installed `node_modules`
package):

```bash
node scripts/fetch-seg-assets.mjs
```

## Running it

```bash
npm run dev
```

Open `http://localhost:5173/?seg=yolo&debug`, tap **Play**, then **Try the
demo drive** (not "Continue" — the demo path plays a bundled clip and never
calls `getUserMedia`, so it works over plain HTTP with no camera involved,
which matters for the LAN step below).

You should see, in devtools:

```
[glassy] dev-only YOLO instance-segmentation prototype active (?seg=yolo) — never present in a production build.
```

and, once the model loads, masks driving the platforms instead of boxes.
If the model file is missing, you'll see a clear, specific error instead of
a crash or silent nothing:

```
[InstanceSegmenter] failed to start: Error: model not found at /tools/video-sim/models/yolov8n-seg-320.onnx (the dev server returned its HTML shell instead — see docs/dev-instance-segmentation.md for where to place the .onnx file)
```

(That specific wording exists because Vite's dev server SPA-falls-back an
unmatched path to `index.html` with `200 OK` rather than `404` — a missing
model file would otherwise fail deep inside ONNX Runtime with an opaque
"protobuf parsing failed" error that gives no hint what actually went
wrong. `InstanceSegmenter.ts`'s `fetchModel()` checks the response
`Content-Type` for this specific case.)

Either way, the game stays fully playable — a missing/failed model just
means zero tracked objects ever arrive, so the ghost-platform solvability
fallback in `CrossingSystem` takes over exactly as it does for a genuinely
empty scene. This is by design: a broken vision path must never leave the
level unsolvable.

### Reading the numbers

With `?debug` also set, the existing DOM debug overlay (top-left, otherwise
unused today — `UIController.setDebugText`) shows:

```
seg=yolo  status=ready  hz=2.0  instances=3
pre=4ms  inf=181ms  post=9ms  total=194ms
ticks=42  errors=0
```

`status` reflects load/runtime state (`loading` / `ready` / `error`) even
before a single successful pass, so a phone tester without a cable attached
can tell at a glance whether the model loaded at all. `inf` is the number
that matters most — `session.run()` wall-clock time inside the worker.

### Cadence — the one lever that matters

YOLO-seg reports every instance in one pass; there's no per-object caching
to tune, only how often the whole pipeline runs. Default is 2Hz
(`SegGameBridge.ts`'s `DEFAULT_HZ`), chosen as a conservative starting point
given the 63ms steady-state single-threaded desktop (M4 Max) measurement
and this project's own note that iPhone JSC can run scalar wasm 2-4x
slower. Override per-run without touching code:

```
?seg=yolo&debug&segHz=4
```

Try several values on the actual phone and read `inf`/`total` off the
on-screen overlay to find where it stops being free.

## LAN / phone testing

```bash
npm run dev -- --host
```

Vite prints a `Network:` URL (something like `http://192.168.1.42:5173`).
Open that on the phone, appending `?seg=yolo&debug`, then **Play → Try the
demo drive** — same reasoning as above: the demo clip needs no camera, so
plain HTTP over the LAN is fine. (A **live camera** feed would need HTTPS —
`getUserMedia` refuses insecure contexts — which is a separate, unrelated
constraint this flag doesn't need to solve.)

## What this integration does and doesn't do

**Converts masks into the exact `TrackedObject` contract the game already
consumes** (`src/vision/experimental/SegGameBridge.ts`): for each YOLO-seg
instance, the mask's own top contour, per column, becomes
`surfaceProfile`; the mask's occupied columns become `surfaceLeft`/
`surfaceRight` (already tight to the vehicle, not the padded box); the
median of the profile becomes `surfaceY`. No search band, no motion mask,
no gradient-scan heuristics — the mask already is the vehicle. Cross-frame
identity, box smoothing and `stable` gating reuse the shipped
`DetectionTracker` as-is.

**Deliberately does not reimplement** `CarriagewayFilter` (own-side-of-the-
road reasoning) or `OpticalFlow`'s ego-motion gate — those exist to answer
"is this actually a vehicle worth trusting on OUR road," a question
orthogonal to "does a mask make a better surface than a box," which is what
this prototype exists to measure. A real merge would need them back.

## How this was verified

- `npx tsc --noEmit` and `npm run build` clean.
- `dist/` grepped for `onnxruntime`, `InstanceSegmenter`, `SegGameBridge`,
  `segmenter.worker`, `yolov8n`, `ort-wasm`, `wasmPaths`, `video-sim` — zero
  matches on all of them. Main JS bundle byte size compared against a build
  with the App.ts change stashed out: 420.21 kB → 420.24 kB, a 30-byte
  difference from the small always-present guard/formatting code, not from
  anything segmentation-related (which is entirely absent).
- Flag off: the DOM debug overlay never receives text, the
  `[glassy] dev-only YOLO...` console line never appears, and
  `syncDetector()` runs its normal branch — confirmed via a live
  `npm run dev` + Playwright run against the real UI (Play → demo drive),
  not just by reading the code.
- Flag on, model missing (this environment has no `.onnx` file and per the
  brief was not permitted to generate one): confirmed the graceful-failure
  path end to end — one clear console error, `status=error` visible on the
  on-screen overlay even though zero ticks ever ran, and the game staying
  fully playable via ghost platforms. This exercise caught two real bugs,
  both fixed: `InstanceSegmenter.start()` never rejects on failure (it
  reports `onStateChange('error')` and resolves anyway), which had made the
  bridge declare `status: 'ready'` on a failed load; and a missing model
  file 200's as Vite's HTML shell rather than 404ing, which had produced an
  opaque "protobuf parsing failed" error instead of a clear one.
- The mask→surface math (`surfaceFromMask` in `SegGameBridge.ts`) was
  checked against a synthetic bonnet/windscreen/roof mask outside the
  browser: correct left/right extent, correct monotonic profile shape, an
  empty mask correctly returns "no data" rather than inventing a value, and
  a single-pixel spike (simulating an aerial/mirror) does not pull
  `surfaceY` away from the dominant flat-roof value (median, not min).
- **Not verified**: real mask quality/visual fidelity end-to-end (screenshot
  of actual vehicle-shaped platforms), and the actual iPhone inference cost.
  Both need a real `.onnx` file this environment does not have and was
  explicitly told not to generate. Once one is placed at the path above,
  `node tools/video-sim/run-seg.mjs video <clip> --model
  /tools/video-sim/models/yolov8n-seg-320.onnx` (the existing harness, see
  its own header) gives the mask-quality numbers on desktop, and the
  `?seg=yolo&debug` overlay on a real phone gives the number this whole
  exercise exists to produce.
