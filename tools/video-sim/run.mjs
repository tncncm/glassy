/**
 * Glassy — video simulation runner (dev diagnostic, never shipped).
 *
 * Feeds a recorded driving video through the REAL SceneAnalyser and
 * ObjectDetector and reports what they actually see, so the open question
 * "does any of this work on real footage?" gets a measured answer instead of
 * a guess.
 *
 *   node tools/video-sim/run.mjs <video> [--rate 1] [--seconds 60]
 *
 * The video is copied into a gitignored temp dir so the dev server can read
 * it, analysed entirely on this machine, and never uploaded anywhere.
 * Outputs a JSON log, a summary, and annotated frame grabs you can look at.
 */
import { spawn } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const tmpDir = join(here, '.tmp');
const outDir = join(here, 'out');

const args = process.argv.slice(2);
const videoArg = args.find((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const playbackRate = flag('rate', 1);
const maxSeconds = flag('seconds', 60);
const shotCount = flag('shots', 8);
const mode = args.includes('--windscreen') ? 'windscreen' : 'window';

if (!videoArg) {
  console.error('Usage: node tools/video-sim/run.mjs <video.mp4> [--rate 2] [--seconds 60]');
  process.exit(1);
}
const videoPath = resolve(videoArg);

await rm(tmpDir, { recursive: true, force: true });
await mkdir(tmpDir, { recursive: true });
await mkdir(outDir, { recursive: true });

// Copy rather than symlink: vite refuses to serve outside its root.
const ext = videoPath.split('.').pop()?.toLowerCase() ?? 'mp4';
const localName = `input.${ext === 'mov' ? 'mp4' : ext}`;
await copyFile(videoPath, join(tmpDir, localName));
console.log(`Video: ${videoPath}`);

console.log('Starting dev server…');
const vite = spawn('npx', ['vite', '--port', '5178', '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
  detached: false,
});
const stopVite = () => { try { vite.kill('SIGTERM'); } catch { /* already gone */ } };
process.on('exit', stopVite);

// Wait for the server rather than sleeping a fixed amount.
const base = 'http://localhost:5178';
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(base);
    if (r.ok) break;
  } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 500));
}

const { chromium } = await import(
  join(root, 'tools', 'video-sim', 'node_modules', 'playwright', 'index.mjs')
).catch(() => import('playwright'));

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
page.on('pageerror', (e) => console.error('  page error:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('  console:', m.text().slice(0, 200)); });

await page.goto(`${base}/tools/video-sim/index.html?mode=${mode}`, { waitUntil: 'load' });

const meta = await page.evaluate(
  ([src, rate]) => window.__simStart(src, rate),
  [`/tools/video-sim/.tmp/${localName}`, playbackRate],
);
console.log(`Loaded ${meta.width}x${meta.height}, ${meta.duration.toFixed(1)}s (playing at ${playbackRate}x)\n`);

const wallLimit = Math.min(meta.duration / playbackRate, maxSeconds / playbackRate) * 1000 + 8000;
const started = Date.now();
const shotAt = Array.from({ length: shotCount }, (_, i) => ((i + 0.5) / shotCount) * Math.min(meta.duration, maxSeconds));
let nextShot = 0;

while (Date.now() - started < wallLimit) {
  const done = await page.evaluate(() => window.__simDone);
  const t = await page.evaluate(() => document.getElementById('v').currentTime);
  if (nextShot < shotAt.length && t >= shotAt[nextShot]) {
    await page.locator('#wrap').screenshot({ path: join(outDir, `frame-${String(nextShot + 1).padStart(2, '0')}.png`) });
    nextShot++;
  }
  if (done || t >= maxSeconds) break;
  await new Promise((r) => setTimeout(r, 200));
}

const log = await page.evaluate(() => window.__simLog);
await browser.close();
stopVite();

await writeFile(join(outDir, 'log.json'), JSON.stringify(log, null, 2));

/* ---------------------------- report ---------------------------- */

const horizon = log.horizon ?? [];
const withEstimate = horizon.filter((h) => h.y !== null);
const ys = withEstimate.map((h) => h.y);
const mean = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : NaN;
const sd = ys.length ? Math.sqrt(ys.reduce((a, b) => a + (b - mean) ** 2, 0) / ys.length) : NaN;
// Median absolute step between consecutive samples = how jittery it is.
const steps = [];
for (let i = 1; i < withEstimate.length; i++) steps.push(Math.abs(withEstimate[i].y - withEstimate[i - 1].y));
steps.sort((a, b) => a - b);
const medStep = steps.length ? steps[Math.floor(steps.length / 2)] : NaN;

const byKind = {};
for (const d of log.detections ?? []) {
  byKind[d.kind] ??= { count: 0, scoreSum: 0 };
  byKind[d.kind].count++;
  byKind[d.kind].scoreSum += d.score;
}
const seconds = Math.min(meta.duration, maxSeconds);

console.log('══════════ HORIZON ══════════');
console.log(`  samples              : ${horizon.length}`);
console.log(`  usable (y !== null)  : ${withEstimate.length} (${((withEstimate.length / (horizon.length || 1)) * 100).toFixed(0)}%)`);
if (ys.length) {
  console.log(`  mean y               : ${mean.toFixed(3)}  (0 = top of frame, 1 = bottom)`);
  console.log(`  std dev              : ${sd.toFixed(3)}  ${sd > 0.12 ? '← very unstable' : sd > 0.06 ? '← wobbly' : '← stable'}`);
  console.log(`  median frame-to-frame jump: ${medStep.toFixed(4)}  ${medStep > 0.02 ? '← jittery, would shake the ground line' : '← smooth'}`);
  console.log(`  mean confidence      : ${(withEstimate.reduce((a, b) => a + b.confidence, 0) / withEstimate.length).toFixed(2)}`);
}

console.log('\n══════════ OBJECT DETECTION ══════════');
console.log(`  detector states      : ${(log.detectorStates ?? []).map((s) => s.status).join(' → ') || '(none)'}`);
console.log(`  total detections     : ${(log.detections ?? []).length} over ${seconds.toFixed(0)}s of footage`);
console.log(`  rate                 : ${((log.detections ?? []).length / seconds).toFixed(2)} per second`);
if (Object.keys(byKind).length === 0) {
  console.log('  NOTHING DETECTED — the model saw nothing it recognised.');
} else {
  for (const [kind, v] of Object.entries(byKind)) {
    console.log(`   ${kind.padEnd(8)} ${String(v.count).padStart(4)}  mean score ${(v.scoreSum / v.count).toFixed(2)}`);
  }
}
if (log.errors?.length) console.log(`\n  page errors: ${log.errors.slice(0, 5).join(' | ')}`);

// Tracking report
const tracked = log.tracked ?? [];
const ids = new Map();
for (const t of tracked) {
  const e = ids.get(t.id) ?? { n: 0, stable: 0, kind: t.kind, first: t.t, last: t.t };
  e.n++; if (t.stable) e.stable++; e.last = t.t; ids.set(t.id, e);
}
console.log('\n══════════ TRACKING (' + mode + ') ══════════');
console.log(`  oggetti distinti     : ${ids.size}`);
const stableIds = [...ids.entries()].filter(([, e]) => e.stable > 0);
console.log(`  di cui STABILI       : ${stableIds.length}  (usabili come piattaforma)`);
const durations = stableIds.map(([, e]) => e.last - e.first).sort((a, b) => b - a);
if (durations.length) {
  console.log(`  durata traccia stabile: max ${durations[0].toFixed(1)}s  mediana ${durations[Math.floor(durations.length/2)].toFixed(1)}s`);
  console.log(`  tracce >2s            : ${durations.filter((d) => d > 2).length}`);
}
console.log(`\nAnnotated frames: ${outDir}/frame-*.png`);
console.log(`Raw log:          ${outDir}/log.json`);
