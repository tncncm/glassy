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
const strFlag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? String(args[i + 1]) : fallback;
};
const playbackRate = flag('rate', 1);
const maxSeconds = flag('seconds', 60);
const shotCount = flag('shots', 8);
const mode = args.includes('--windscreen') ? 'windscreen' : 'window';
/** `--model lite2int8` swaps in an alternate detector model for this run —
 * see MODEL_OVERRIDES in index.html and `modelPath` in ObjectDetector.ts's
 * diagnostic-only debug options. Never affects what App.ts ships. */
const modelOverride = strFlag('model', '');
/**
 * `--tag before` prefixes every written PNG so an A/B pair survives two runs
 * instead of the second overwriting the first. `--at 12.3,20` additionally
 * grabs the annotated frame at those exact playback times — the only way to
 * revisit one specific vehicle, which is what a before/after on a named
 * failure case needs.
 */
const tag = strFlag('tag', '');
const prefix = tag ? `${tag}-` : '';
const explicitShots = strFlag('at', '')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n))
  .sort((a, b) => a - b);

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

const maskQuery = (args.includes('--mask') ? '&mask=1' : '') + (args.includes('--nomask') ? '&nomask=1' : '');
const modelQuery = modelOverride ? `&model=${modelOverride}` : '';
await page.goto(`${base}/tools/video-sim/index.html?mode=${mode}${maskQuery}${modelQuery}`, { waitUntil: 'load' });

const meta = await page.evaluate(
  ([src, rate]) => window.__simStart(src, rate),
  [`/tools/video-sim/.tmp/${localName}`, playbackRate],
);
console.log(`Loaded ${meta.width}x${meta.height}, ${meta.duration.toFixed(1)}s (playing at ${playbackRate}x)\n`);

const wallLimit = Math.min(meta.duration / playbackRate, maxSeconds / playbackRate) * 1000 + 8000;
const started = Date.now();
const shotAt = Array.from({ length: shotCount }, (_, i) => ((i + 0.5) / shotCount) * Math.min(meta.duration, maxSeconds));
let nextShot = 0;
const atQueue = explicitShots.slice();
let nextAt = 0;

while (Date.now() - started < wallLimit) {
  const done = await page.evaluate(() => window.__simDone);
  const t = await page.evaluate(() => document.getElementById('v').currentTime);
  if (nextAt < atQueue.length && t >= atQueue[nextAt]) {
    // Freeze the overlay, park the video on the exact requested time, shoot,
    // resume. Two runs then differ only in what the annotation says, not in
    // which frame it is drawn over.
    const at = atQueue[nextAt];
    const landed = await page.evaluate((target) => window.__simFreezeAt(target), at);
    await page.locator('#wrap').screenshot({ path: join(outDir, `${prefix}at-${at.toFixed(1)}.png`) });
    await page.evaluate(() => window.__simResume());
    if (landed === undefined) console.warn('  freeze failed at', at);
    nextAt++;
  }
  if (nextShot < shotAt.length && t >= shotAt[nextShot]) {
    await page.locator('#wrap').screenshot({ path: join(outDir, `${prefix}frame-${String(nextShot + 1).padStart(2, '0')}.png`) });
    nextShot++;
  }
  if (done || t >= maxSeconds) break;
  await new Promise((r) => setTimeout(r, 120));
}

const log = await page.evaluate(() => window.__simLog);
await browser.close();
stopVite();

await writeFile(join(outDir, `${prefix}log.json`), JSON.stringify(log, null, 2));

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

// Per-inference wall-clock cost — what decides whether a model fits the
// sample budget, measured, not taken from a vendor spec sheet.
const infCost = (log.inferenceCost ?? []).slice().sort((a, b) => a - b);
if (infCost.length) {
  const infAt = (q) => infCost[Math.min(infCost.length - 1, Math.floor(q * infCost.length))];
  console.log(`  inference cost (ms) : median ${infAt(0.5).toFixed(1)}  p90 ${infAt(0.9).toFixed(1)}  max ${infCost[infCost.length - 1].toFixed(1)}  (n=${infCost.length})`);
}

// Raw COCO label breakdown — what actually fired, before collapsing to kind.
const labels = log.labels ?? [];
if (labels.length) {
  const byLabel = {};
  for (const l of labels) {
    byLabel[l.label] ??= { count: 0, scoreSum: 0 };
    byLabel[l.label].count++;
    byLabel[l.label].scoreSum += l.score;
  }
  console.log('\n  by COCO label:');
  for (const [label, v] of Object.entries(byLabel).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`   ${label.padEnd(16)} ${String(v.count).padStart(4)}  mean score ${(v.scoreSum / v.count).toFixed(2)}`);
  }
}

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
// Carriageway filter report
const cw = log.carriageway ?? [];
const cwVehicleSamples = cw.length;
const cwKept = cw.filter((c) => c.kept).length;
const cwRejected = cw.filter((c) => !c.kept).length;
const cwById = new Map();
for (const c of cw) {
  const e = cwById.get(c.id) ?? { everKept: false, everRejected: false, reasons: new Set() };
  if (c.kept) e.everKept = true; else { e.everRejected = true; e.reasons.add(c.reason); }
  cwById.set(c.id, e);
}
const reasonCounts = {};
for (const c of cw) if (!c.kept) reasonCounts[c.reason] = (reasonCounts[c.reason] ?? 0) + 1;
console.log('\n══════════ CARRIAGEWAY FILTER ══════════');
console.log(`  vehicle samples      : ${cwVehicleSamples}  (kept ${cwKept}, rejected ${cwRejected}${cwVehicleSamples ? ', ' + ((100*cwRejected/cwVehicleSamples).toFixed(1)) + '% rejected' : ''})`);
if (Object.keys(reasonCounts).length) {
  console.log('  rejected by reason   :');
  for (const [reason, n] of Object.entries(reasonCounts).sort((a,b)=>b[1]-a[1])) {
    console.log(`    ${reason.padEnd(14)} ${n}`);
  }
}
const cwTracksKeptOnly = [...cwById.values()].filter((e) => e.everKept && !e.everRejected).length;
const cwTracksRejectedOnly = [...cwById.values()].filter((e) => e.everRejected && !e.everKept).length;
const cwTracksBoth = [...cwById.values()].filter((e) => e.everKept && e.everRejected).length;
console.log(`  distinct vehicle tracks: ${cwById.size}  (kept-only ${cwTracksKeptOnly}, rejected-only ${cwTracksRejectedOnly}, flipped ${cwTracksBoth})`);

// Ego-motion gate report — is CarriagewayFilter actually engaging (or
// staying off) when it should?
const ego = log.ego ?? [];
console.log('\n══════════ EGO-MOTION GATE ══════════');
if (!ego.length) {
  console.log('  no ego-motion samples');
} else {
  const mags = ego.map((e) => e.magnitude).sort((a, b) => a - b);
  const magAt = (q) => mags[Math.min(mags.length - 1, Math.floor(q * mags.length))];
  const movingSamples = ego.filter((e) => e.moving).length;
  const meanConf = ego.reduce((a, b) => a + b.confidence, 0) / ego.length;
  console.log(`  samples              : ${ego.length}`);
  console.log(`  magnitude (frame-diagonals/s): p10 ${magAt(0.1).toFixed(4)}  p50 ${magAt(0.5).toFixed(4)}  p90 ${magAt(0.9).toFixed(4)}  max ${mags[mags.length - 1].toFixed(4)}`);
  console.log(`  mean confidence      : ${meanConf.toFixed(2)}`);
  console.log(`  gate ON (moving)     : ${movingSamples} / ${ego.length}  (${((100 * movingSamples) / ego.length).toFixed(1)}%)`);
  // Flip count — how often the gate changed state, a rough chatter check.
  let flips = 0;
  for (let i = 1; i < ego.length; i++) if (ego[i].moving !== ego[i - 1].moving) flips++;
  console.log(`  gate transitions     : ${flips}  ${flips > ego.length * 0.05 ? '← chattering' : '← steady'}`);
  const costs = ego.map((e) => e.costMs ?? 0).sort((a, b) => a - b);
  const costAt2 = (q) => costs[Math.min(costs.length - 1, Math.floor(q * costs.length))];
  console.log(`  OpticalFlow cost/sample: median ${costAt2(0.5).toFixed(2)}ms  p90 ${costAt2(0.9).toFixed(2)}ms  max ${costs[costs.length - 1].toFixed(2)}ms`);
}

// Surface profile report: how much shape is actually being found (spread
// between the highest and lowest column per sample, i.e. does the polyline
// show a bonnet-to-roof step or sit dead flat), how often individual columns
// fall back to the flat surfaceY, and how steady the shape is tick to tick.
const vehicleTracked = tracked.filter((t) => t.kind === 'vehicle' && Array.isArray(t.profile));
const FLAT_EPS = 0.0015; // fraction-of-frame-height tolerance for "this column is just surfaceY"
let flatColumns = 0;
let totalColumns = 0;
const spreads = [];
for (const t of vehicleTracked) {
  const p = t.profile;
  let lo = Infinity, hi = -Infinity, flatHere = 0;
  for (const v of p) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    if (Math.abs(v - t.surfaceY) < FLAT_EPS) flatHere++;
  }
  flatColumns += flatHere;
  totalColumns += p.length;
  spreads.push(hi - lo);
}
spreads.sort((a, b) => a - b);
const spreadAt = (q) => (spreads.length ? spreads[Math.min(spreads.length - 1, Math.floor(q * spreads.length))] : NaN);

// Temporal stability per column per track id — the same "median frame-to-
// frame jump" measure used for the horizon above, generalised across all 24
// columns of every stable track.
const byTrackId = new Map();
for (const t of vehicleTracked) {
  if (!t.stable) continue;
  const list = byTrackId.get(t.id) ?? [];
  list.push(t);
  byTrackId.set(t.id, list);
}
const colSteps = [];
for (const list of byTrackId.values()) {
  list.sort((a, b) => a.t - b.t);
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1].profile, cur = list[i].profile;
    if (!prev || !cur || prev.length !== cur.length) continue;
    for (let c = 0; c < cur.length; c++) colSteps.push(Math.abs(cur[c] - prev[c]));
  }
}
colSteps.sort((a, b) => a - b);
const colMedStep = colSteps.length ? colSteps[Math.floor(colSteps.length / 2)] : NaN;
const colP90Step = colSteps.length ? colSteps[Math.floor(colSteps.length * 0.9)] : NaN;

console.log('\n══════════ SURFACE PROFILE ══════════');
console.log(`  vehicle samples w/ profile : ${vehicleTracked.length}`);
console.log(`  column fallback-to-flat    : ${totalColumns ? ((100 * flatColumns) / totalColumns).toFixed(1) : 'n/a'}% of columns (within ${FLAT_EPS} of surfaceY)`);
if (spreads.length) {
  console.log(`  shape spread (hi-lo, frac of frame height): p50 ${spreadAt(0.5).toFixed(4)}  p90 ${spreadAt(0.9).toFixed(4)}  max ${spreads[spreads.length - 1].toFixed(4)}`);
}
if (colSteps.length) {
  console.log(`  per-column frame-to-frame jump (stable tracks): median ${colMedStep.toFixed(4)}  p90 ${colP90Step.toFixed(4)}  ${colMedStep > 0.02 ? '← jittery' : '← steady'}`);
}

// Motion-mask report: how often flow had an answer inside a detection box,
// how often that answer meaningfully tightened the box, and what it cost.
const flow = log.flow;
const flowCost = (log.flowCost ?? []).slice().sort((a, b) => a - b);
const costAt = (q) => (flowCost.length ? flowCost[Math.min(flowCost.length - 1, Math.floor(q * flowCost.length))] : NaN);
console.log('\n══════════ MOTION MASK (flow inside the box) ══════════');
if (!flow) {
  console.log('  no mask samples');
} else {
  console.log(`  boxes examined       : ${flow.boxesSeen}`);
  console.log(`  flow had an answer   : ${flow.boxesDecided} (${((100 * flow.boxesDecided) / (flow.boxesSeen || 1)).toFixed(1)}%)`);
  console.log(`  too weak → fell back : ${flow.boxesSeen - flow.boxesDecided} (${((100 * (flow.boxesSeen - flow.boxesDecided)) / (flow.boxesSeen || 1)).toFixed(1)}%)`);
  console.log(`  meaningfully tightened: ${flow.boxesTightened} (${((100 * flow.boxesTightened) / (flow.boxesSeen || 1)).toFixed(1)}% of boxes, ${((100 * flow.boxesTightened) / (flow.boxesDecided || 1)).toFixed(1)}% of decided)`);
  console.log(`  cost per detector tick: median ${costAt(0.5).toFixed(2)}ms  p90 ${costAt(0.9).toFixed(2)}ms  max ${flowCost.length ? flowCost[flowCost.length - 1].toFixed(2) : 'n/a'}ms  (${flow.ticks} ticks)`);
}

console.log(`\nAnnotated frames: ${outDir}/frame-*.png`);
console.log(`Raw log:          ${outDir}/log.json`);
