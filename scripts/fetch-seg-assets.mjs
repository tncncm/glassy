/**
 * PROTOTYPE-ONLY asset fetcher for src/vision/experimental/ (the instance-
 * segmentation evaluation) — mirrors scripts/fetch-vision-assets.mjs but is
 * deliberately NOT wired into `npm run dev`/`npm run build`. Run it by hand:
 *
 *   node scripts/fetch-seg-assets.mjs
 *
 * Copies ONNX Runtime Web's WASM-only (no WebGPU/WebGL) runtime out of
 * node_modules/onnxruntime-web (already a devDependency added for this
 * evaluation — see the report) into tools/video-sim/ort/, self-hosted like
 * every other vision asset in this project. Never touches public/vision/,
 * never touches anything the shipped app fetches.
 *
 * The ONNX model itself is NOT fetched here — it was exported locally with
 * the Ultralytics CLI (Python, AGPL-3.0-licensed tooling and weights; see
 * the report for why this is a licensing flag, not a shipping decision) and
 * lives at tools/video-sim/models/*.onnx, gitignored, regenerate with the
 * export commands in the report if needed.
 */
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'node_modules', 'onnxruntime-web', 'dist');
const outDir = join(root, 'tools', 'video-sim', 'ort');

// The plain "wasm" backend build — WASM/CPU only, no WebGPU (jsep) or JSPI
// variant bundled in, keeping this self-hosted download to a single ~13.5MB
// pair instead of the ~27MB WebGPU-inclusive one. See InstanceSegmenter.ts
// and segmenter.worker.ts for why WASM-only is deliberate here, not a
// placeholder.
const FILES = ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'];

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

await mkdir(outDir, { recursive: true });
let total = 0;
for (const name of FILES) {
  const src = join(srcDir, name);
  const dest = join(outDir, name);
  const srcSize = await sizeOf(src);
  if (srcSize < 0) {
    throw new Error(`Missing ${src}. Run \`npm install\` first (onnxruntime-web is a dependency).`);
  }
  if ((await sizeOf(dest)) !== srcSize) {
    await copyFile(src, dest);
    console.log(`  copied ${name} (${(srcSize / 1024 / 1024).toFixed(1)} MB)`);
  } else {
    console.log(`  ${name} already present, skipping`);
  }
  total += srcSize;
}
console.log(`Done. ONNX Runtime Web wasm runtime: ~${(total / 1024 / 1024).toFixed(1)} MB uncompressed.`);
