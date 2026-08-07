/**
 * EXPERIMENTAL / RESEARCH ONLY — pre-bundles
 * src/vision/experimental/magicTouchSegmenter.worker.ts into a plain classic
 * worker script, exactly the way scripts/build-vision-worker.mjs does for
 * the shipped detector worker (see that file for the full "why a classic
 * worker, why esbuild, why not Vite's own worker plugin" reasoning — it
 * applies identically here since this worker imports the same
 * @mediapipe/tasks-vision package).
 *
 * NOT part of `npm run dev` / `npm run build` — run by hand:
 *
 *   node scripts/build-experimental-segmenter-worker.mjs
 *
 * Output: public/vision/experimental/magic-touch-worker.js — inside the
 * gitignored public/vision/ tree, never committed, never referenced by any
 * shipped code path.
 */
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'src', 'vision', 'experimental', 'magicTouchSegmenter.worker.ts');
const outDir = join(root, 'public', 'vision', 'experimental');
const outfile = join(outDir, 'magic-touch-worker.js');

await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});

console.log(`Built experimental segmenter worker -> ${outfile.replace(root + '/', '')}`);
