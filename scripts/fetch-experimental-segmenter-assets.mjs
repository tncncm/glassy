/**
 * EXPERIMENTAL / RESEARCH ONLY — fetches the MediaPipe Interactive Segmenter
 * ("MagicTouch") model for the src/vision/experimental prototype that asks
 * "does a box-centre point prompt recover a real object silhouette instead
 * of a bounding box".
 *
 * NOT part of `npm run dev` / `npm run build` — this is deliberately a
 * separate, manually-run script so the experiment can never silently attach
 * itself to the shipped app's asset pipeline. Run it by hand:
 *
 *   node scripts/fetch-experimental-segmenter-assets.mjs
 *
 * The wasm runtime is NOT fetched here — it's the same generic MediaPipe
 * tasks-vision wasm every task in this project shares, already materialised
 * by `npm run vision-assets` (see scripts/fetch-vision-assets.mjs) at
 * public/vision/wasm/. Run that first if it hasn't been run yet.
 *
 * Output lives under public/vision/experimental/, inside the SAME gitignored
 * `public/vision/` tree as the shipped model (see .gitignore) — never
 * committed, never referenced by any shipped code path.
 */
import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'vision', 'experimental');

/**
 * Pinned to the only published version (v1 == "latest" as of this writing —
 * verified by probing both; see the report). This is the OLDER single-shot
 * "Interactive Segmenter" model/API (RegionOfInterest keypoint -> one
 * confidence mask per call), not the newer v2 encoder/decoder "MagicTouch"
 * `.task` bundle the library's own README example uses — that one is a
 * different, much larger (30MB) model with a different API
 * (InteractiveSegmenter + Stroke[]) built for interactive UIs where a user
 * drags a point around live. The brief's own published-latency figures
 * (130ms CPU / 67ms GPU, Pixel 6) match THIS model, so this is the one that
 * was actually asked for. Do not swap to /latest/ — that would make a run
 * silently non-reproducible if Google ever republishes this path.
 */
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite';
const MODEL_OUT = join(outDir, 'magic_touch_float32.tflite');
const MODEL_MIN_BYTES = 5_000_000;

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

async function main() {
  await mkdir(outDir, { recursive: true });

  if ((await sizeOf(MODEL_OUT)) >= MODEL_MIN_BYTES) {
    console.log('  experimental segmenter model already present, skipping');
    return;
  }

  console.log('Fetching experimental MagicTouch interactive-segmenter model…');
  const response = await fetch(MODEL_URL);
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${MODEL_URL}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength < MODEL_MIN_BYTES) {
    throw new Error(`suspiciously small (${bytes.byteLength} bytes) — refusing to write`);
  }
  await writeFile(MODEL_OUT, bytes);
  const sha = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  console.log(
    `  fetched ${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB, sha256:${sha}… -> ${MODEL_OUT.replace(root + '/', '')}`,
  );
}

await main();
