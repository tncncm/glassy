/**
 * EXPERIMENTAL / RESEARCH — node runner for segmenter-video.html.
 *
 *   node tools/video-sim/experimental/segmenter-video.mjs <video> [--seconds 60] [--at 12.3,30]
 *
 * Real driving footage, the REAL shipped ObjectDetector/DetectionTracker,
 * and the EXPERIMENTAL MagicTouchSegmenter riding along — see the report for
 * what this measured. Requires the same three one-time setup steps as
 * segmenter-image.mjs (vision-assets, fetch-experimental-segmenter-assets,
 * build-experimental-segmenter-worker).
 */
import { spawn } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const tmpDir = join(here, '..', '.tmp');
const outDir = join(here, '..', 'out', 'experimental');

const args = process.argv.slice(2);
const videoArg = args.find((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const strFlag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? String(args[i + 1]) : fallback;
};
const maxSeconds = flag('seconds', 60);
const explicitShots = strFlag('at', '')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n))
  .sort((a, b) => a - b);

if (!videoArg) {
  console.error('Usage: node tools/video-sim/experimental/segmenter-video.mjs <video.mp4> [--seconds 60] [--at 12.3,30]');
  process.exit(1);
}
const videoPath = resolve(videoArg);

await mkdir(tmpDir, { recursive: true });
await mkdir(outDir, { recursive: true });
const ext = videoPath.split('.').pop()?.toLowerCase() ?? 'mp4';
const localName = `seg-input.${ext === 'mov' ? 'mp4' : ext}`;
await copyFile(videoPath, join(tmpDir, localName));
console.log(`Video: ${videoPath}`);

const PORT = 5184;
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
page.on('console', (m) => { if (m.type() === 'error') console.error('  console:', m.text().slice(0, 200)); });

await page.goto(`${base}/tools/video-sim/experimental/segmenter-video.html`, { waitUntil: 'load' });

const meta = await page.evaluate(([src]) => window.__simStart(src, 1), [`/tools/video-sim/.tmp/${localName}`]);
console.log(`Loaded ${meta.width}x${meta.height}, ${meta.duration.toFixed(1)}s\n`);

const wallLimit = Math.min(meta.duration, maxSeconds) * 1000 + 15000;
const started = Date.now();
const atQueue = explicitShots.slice();
let nextAt = 0;
let shotCounter = 0;
const periodicEvery = 8; // seconds between "just cruising" screenshots
let nextPeriodic = periodicEvery;

while (Date.now() - started < wallLimit) {
  const done = await page.evaluate(() => window.__simDone);
  const t = await page.evaluate(() => document.getElementById('v').currentTime);

  if (nextAt < atQueue.length && t >= atQueue[nextAt]) {
    const at = atQueue[nextAt];
    await page.evaluate((target) => window.__simFreezeAt(target), at);
    await page.locator('#wrap').screenshot({ path: join(outDir, `video-at-${at.toFixed(1)}.png`) });
    await page.evaluate(() => window.__simResume());
    nextAt++;
  } else if (t >= nextPeriodic) {
    await page.locator('#wrap').screenshot({ path: join(outDir, `video-cruise-${String(++shotCounter).padStart(2, '0')}.png`) });
    nextPeriodic += periodicEvery;
  }

  if (done || t >= maxSeconds) break;
  await new Promise((r) => setTimeout(r, 150));
}

const log = await page.evaluate(() => window.__simLog);
await browser.close();
try { vite.kill('SIGTERM'); } catch { /* gone */ }
await rm(tmpDir, { recursive: true, force: true });

await writeFile(join(outDir, 'segmenter-video-log.json'), JSON.stringify(log, null, 2));

/* ---------------------------- report ---------------------------- */

const seg = log.segmentEvents ?? [];
const ok = seg.filter((s) => s.ok);
const failed = seg.filter((s) => !s.ok);
const stabiliseEvents = seg.filter((s) => s.reason === 'stabilise');
const refreshEvents = seg.filter((s) => s.reason === 'refresh');

console.log('══════════ MAGICTOUCH SEGMENT EVENTS (real driving footage) ══════════');
console.log(`  distinct objects stabilised : ${log.stabiliseCount}`);
console.log(`  segment() calls total       : ${seg.length}  (stabilise ${stabiliseEvents.length}, refresh ${refreshEvents.length})`);
console.log(`  ok / failed                 : ${ok.length} / ${failed.length}`);
if (ok.length) {
  const costs = ok.map((s) => s.ms).sort((a, b) => a - b);
  const costAt = (q) => costs[Math.min(costs.length - 1, Math.floor(q * costs.length))];
  console.log(`  inference cost (ms)         : median ${costAt(0.5).toFixed(1)}  p90 ${costAt(0.9).toFixed(1)}  max ${costs[costs.length - 1].toFixed(1)}`);
  const rt = ok.map((s) => s.roundTripMs).sort((a, b) => a - b);
  const rtAt = (q) => rt[Math.min(rt.length - 1, Math.floor(q * rt.length))];
  console.log(`  round-trip cost (ms)        : median ${rtAt(0.5).toFixed(1)}  p90 ${rtAt(0.9).toFixed(1)}  max ${rt[rt.length - 1].toFixed(1)}`);
  const cov = ok.map((s) => s.maskCoverage).sort((a, b) => a - b);
  const covAt = (q) => cov[Math.min(cov.length - 1, Math.floor(q * cov.length))];
  console.log(`  mask coverage (frac of bitmap >=0.5): median ${covAt(0.5).toFixed(3)}  p90 ${covAt(0.9).toFixed(3)}  max ${cov[cov.length - 1].toFixed(3)}`);
  console.log(`    (near 1.0 repeatedly would mean the mask is swallowing the whole frame — the beach-scene failure mode)`);
}
if (failed.length) {
  console.log('  failures:');
  for (const f of failed.slice(0, 10)) console.log(`    t=${f.t} id=${f.id} ${f.error ?? '(no mask returned)'}`);
}

const rate = seg.length / Math.min(meta.duration, maxSeconds);
console.log(`\n  call rate                   : ${rate.toFixed(2)} segment() calls/sec of footage`);

console.log('\n══════════ EFFICIENTDET CONTENTION (does MagicTouch slow the real detector down?) ══════════');
const det = log.detectorInferenceCost ?? [];
const detWithMT = det.filter((d) => d.magicTouchInFlight);
const detWithoutMT = det.filter((d) => !d.magicTouchInFlight);
function stats(arr) {
  if (!arr.length) return null;
  const s = arr.map((d) => d.ms).sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { n: s.length, median: at(0.5), p90: at(0.9), max: s[s.length - 1] };
}
const withStats = stats(detWithMT);
const withoutStats = stats(detWithoutMT);
console.log(`  EfficientDet samples while MagicTouch idle   : ${withoutStats ? `n=${withoutStats.n} median=${withoutStats.median.toFixed(1)}ms p90=${withoutStats.p90.toFixed(1)}ms max=${withoutStats.max.toFixed(1)}ms` : 'none'}`);
console.log(`  EfficientDet samples while MagicTouch in flight: ${withStats ? `n=${withStats.n} median=${withStats.median.toFixed(1)}ms p90=${withStats.p90.toFixed(1)}ms max=${withStats.max.toFixed(1)}ms` : 'none'}`);
if (withStats && withoutStats) {
  const delta = withStats.median - withoutStats.median;
  console.log(`  delta (median)                                : ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}ms  ${Math.abs(delta) > withoutStats.median * 0.3 ? '← MEASURABLE CONTENTION' : '← no meaningful contention'}`);
}

console.log(`\nScreenshots: ${outDir}/video-*.png`);
console.log(`Raw log:     ${outDir}/segmenter-video-log.json`);
