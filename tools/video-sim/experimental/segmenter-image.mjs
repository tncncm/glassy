/**
 * EXPERIMENTAL / RESEARCH — node runner for segmenter-image.html.
 *
 *   node tools/video-sim/experimental/segmenter-image.mjs
 *
 * Feeds four stock photos (none shipped, none real user footage — see the
 * report for exactly what's real vs synthetic) through the real
 * MagicTouchSegmenter prototype with hand-picked point prompts standing in
 * for "the centre of a tracked detection box", screenshots the mask overlay
 * for each, and prints cost numbers. Requires:
 *   1. node scripts/fetch-vision-assets.mjs (wasm runtime, shared)
 *   2. node scripts/fetch-experimental-segmenter-assets.mjs (the model)
 *   3. node scripts/build-experimental-segmenter-worker.mjs (the worker)
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const outDir = join(here, '..', 'out', 'experimental');
await mkdir(outDir, { recursive: true });

const PORT = 5181;

console.log('Starting dev server…');
const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'ignore' });
process.on('exit', () => { try { vite.kill('SIGTERM'); } catch { /* gone */ } });

const base = `http://localhost:${PORT}`;
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(base)).ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 500));
}

const { chromium } = await import(join(root, 'tools', 'video-sim', 'node_modules', 'playwright', 'index.mjs')).catch(
  () => import('playwright'),
);
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1000, height: 800 } })).newPage();
page.on('pageerror', (e) => console.error('  page error:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('  console:', m.text().slice(0, 300)); });

await page.goto(`${base}/tools/video-sim/experimental/segmenter-image.html`, { waitUntil: 'load' });

/**
 * Point prompts are hand-picked by eye against each 960px-wide stock photo
 * (see the report for what each image shows) — standing in for "the centre
 * of a tracked detection box" without needing EfficientDet to actually fire
 * on classes this project's shipped allowlist excludes (laptop, chair, …).
 */
const CASES = [
  {
    tag: 'beach-parasols',
    image: '/tools/video-sim/.tmp/experimental/beach_parasols.jpg',
    concurrent: false,
    points: [
      { name: 'parasol-1', x: 0.109, y: 0.407 },
      { name: 'parasol-2', x: 0.281, y: 0.446 },
      { name: 'parasol-3', x: 0.448, y: 0.430 },
      { name: 'parasol-4', x: 0.625, y: 0.407 },
      { name: 'parasol-5', x: 0.802, y: 0.391 },
      { name: 'parasol-front-1', x: 0.161, y: 0.532 },
      { name: 'parasol-front-2', x: 0.521, y: 0.548 },
      { name: 'lounger-stack', x: 0.542, y: 0.814 },
    ],
  },
  {
    tag: 'office-desk-laptop',
    image: '/tools/video-sim/.tmp/experimental/office_desk_laptop.jpg',
    concurrent: false,
    points: [
      { name: 'laptop', x: 0.365, y: 0.234 },
      { name: 'pen', x: 0.125, y: 0.391 },
      { name: 'sticky-notes', x: 0.833, y: 0.344 },
      { name: 'notebook', x: 0.729, y: 0.625 },
      { name: 'phone', x: 0.865, y: 0.906 },
    ],
  },
  {
    tag: 'person-desk',
    image: '/tools/video-sim/.tmp/experimental/person_desk.jpg',
    concurrent: false,
    points: [
      { name: 'person', x: 0.604, y: 0.548 },
      { name: 'laptop', x: 0.344, y: 0.868 },
      { name: 'vase', x: 0.099, y: 0.751 },
      { name: 'clock', x: 0.844, y: 0.094 },
      { name: 'fridge', x: 0.365, y: 0.407 },
    ],
  },
  {
    tag: 'cluttered-desk',
    image: '/tools/video-sim/.tmp/experimental/cluttered_desk.jpg',
    concurrent: false,
    points: [
      { name: 'laptop', x: 0.448, y: 0.547 },
      { name: 'chair', x: 0.104, y: 0.469 },
    ],
  },
];

const allLogs = [];

for (const c of CASES) {
  console.log(`\n=== ${c.tag} (CPU, sequential) ===`);
  const log = await page.evaluate(
    ([src, points, opts]) => window.__runImage(src, points, opts),
    [c.image, c.points, { delegate: 'CPU', resizeWidth: 512, concurrent: false }],
  );
  await page.locator('#wrap').screenshot({ path: join(outDir, `${c.tag}-cpu-seq.png`) });
  console.log(JSON.stringify(log, null, 1));
  allLogs.push({ tag: `${c.tag}-cpu-seq`, ...log });
}

// Worst case: several new objects at once, fired without waiting between
// them — the beach's 8 parasols, all requested in the same tick.
console.log(`\n=== beach-parasols (CPU, CONCURRENT — many-new-objects worst case) ===`);
const concurrentCase = CASES[0];
const concLog = await page.evaluate(
  ([src, points, opts]) => window.__runImage(src, points, opts),
  [concurrentCase.image, concurrentCase.points, { delegate: 'CPU', resizeWidth: 512, concurrent: true }],
);
await page.locator('#wrap').screenshot({ path: join(outDir, `beach-parasols-cpu-concurrent.png`) });
console.log(JSON.stringify(concLog, null, 1));
allLogs.push({ tag: 'beach-parasols-cpu-concurrent', ...concLog });

// GPU comparison, one case only — enough to say whether CPU-vs-GPU tells the
// same story here as it did for the shipped EfficientDet detector, without
// tripling total runtime.
console.log(`\n=== office-desk-laptop (GPU, sequential) ===`);
const gpuCase = CASES[1];
const gpuLog = await page.evaluate(
  ([src, points, opts]) => window.__runImage(src, points, opts),
  [gpuCase.image, gpuCase.points, { delegate: 'GPU', resizeWidth: 512, concurrent: false }],
);
await page.locator('#wrap').screenshot({ path: join(outDir, `office-desk-laptop-gpu-seq.png`) });
console.log(JSON.stringify(gpuLog, null, 1));
allLogs.push({ tag: 'office-desk-laptop-gpu-seq', ...gpuLog });

await browser.close();
try { vite.kill('SIGTERM'); } catch { /* gone */ }

await writeFile(join(outDir, 'segmenter-image-log.json'), JSON.stringify(allLogs, null, 2));

console.log('\n\n══════════ SUMMARY ══════════');
for (const l of allLogs) {
  const oks = l.points.filter((p) => p.ok);
  const costs = oks.map((p) => p.inferenceMs).sort((a, b) => a - b);
  const med = costs.length ? costs[Math.floor(costs.length / 2)] : NaN;
  console.log(
    `${l.tag.padEnd(32)} ok=${oks.length}/${l.points.length}  medianInferenceMs=${med?.toFixed?.(0)}  wallMs=${l.wallMs.toFixed(0)}  loadMs=${l.loadMs.toFixed(0)}`,
  );
}
console.log(`\nScreenshots: ${outDir}/*.png`);
console.log(`Raw log:     ${outDir}/segmenter-image-log.json`);
