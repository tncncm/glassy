/**
 * Pre-bundles src/vision/detector.worker.ts into a plain, classic-worker
 * script at public/vision/detector-worker.js — generated, never committed
 * (see public/vision/ in .gitignore), served exactly like the wasm runtime
 * and the model it sits next to.
 *
 * WHY THIS EXISTS, not just `new Worker(new URL('./detector.worker.ts',
 * import.meta.url), { type: 'module' })` (Vite's normal worker pattern):
 *
 * MediaPipe's own wasm loader only knows two ways to load its glue script:
 * a `<script>` tag (main thread) or `importScripts()` (a CLASSIC worker).
 * Calling `importScripts` from a `type: 'module'` worker throws per spec, and
 * Vite's DEV SERVER always serves `new Worker(...)` scripts as ES modules —
 * there is no dev-server option to get a true classic worker, because dev
 * mode serves unbundled ESM source on the fly rather than a real bundled
 * script. That combination breaks MediaPipe inside any Vite-dev-served
 * worker, in a way that has no supported fix on MediaPipe's side other than
 * a `self.import` escape hatch that evals the glue script — and this
 * project's CSP has no `unsafe-eval` (see src/main.ts), deliberately, so
 * that is not an acceptable fix here.
 *
 * Bundling with esbuild directly, ourselves, sidesteps the whole dev/build
 * distinction: the output is a single, already-bundled, classic (non-ESM)
 * script — identical in `npm run dev` and `npm run build` — so
 * ObjectDetector.ts can construct a plain classic `new Worker(url)` in both,
 * and MediaPipe gets the synchronous `importScripts` load path it actually
 * expects, every time.
 */
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'src', 'vision', 'detector.worker.ts');
const outDir = join(root, 'public', 'vision');
const outfile = join(outDir, 'detector-worker.js');

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

console.log(`Built vision worker -> ${outfile.replace(root + '/', '')}`);
