/**
 * PROTOTYPE-ONLY runner for the instance-segmentation evaluation
 * (src/vision/experimental/). Mirrors run.mjs's dev-server + Playwright
 * pattern but drives tools/video-sim/seg.html instead of the shipped
 * detector's index.html.
 *
 * Video mode:
 *   node tools/video-sim/run-seg.mjs video <clip.mp4> [--seconds 20] [--every 0.5]
 *     [--model /tools/video-sim/models/yolov8n-seg-320.onnx] [--inputSize 320]
 *
 * Image mode (desk/beach stills — NOT real Glassy footage):
 *   node tools/video-sim/run-seg.mjs image <photo.jpg> [--reps 5] [--model ...] [--inputSize 320]
 *
 * The video/image is copied into a gitignored temp dir so the dev server can
 * read it, analysed entirely on this machine, and never uploaded anywhere —
 * same discipline as run.mjs.
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
const runMode = args[0]; // 'video' | 'image'
const srcArg = args[1];
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const strFlag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? String(args[i + 1]) : fallback;
};

if ((runMode !== 'video' && runMode !== 'image') || !srcArg) {
  console.error('Usage: node tools/video-sim/run-seg.mjs <video|image> <file> [--seconds 20] [--every 0.5] [--reps 5] [--model path] [--inputSize 320] [--tag name]');
  process.exit(1);
}

const srcPath = resolve(srcArg);
const seconds = flag('seconds', 20);
const every = flag('every', 0.5);
const reps = flag('reps', 5);
const model = strFlag('model', '/tools/video-sim/models/yolov8n-seg-320.onnx');
const inputSize = flag('inputSize', 320);
const scoreThreshold = flag('score', 0.25);
const tag = strFlag('tag', '');
const prefix = tag ? `${tag}-` : '';

await mkdir(tmpDir, { recursive: true });
await mkdir(outDir, { recursive: true });

const ext = srcPath.split('.').pop()?.toLowerCase() ?? 'mp4';
const localName = `seg-input.${ext === 'mov' ? 'mp4' : ext}`;
await copyFile(srcPath, join(tmpDir, localName));
console.log(`Input: ${srcPath}`);
console.log(`Model: ${model}  inputSize=${inputSize}  scoreThreshold=${scoreThreshold}`);

console.log('Starting dev server…');
const vite = spawn('npx', ['vite', '--port', '5179', '--strictPort'], { cwd: root, stdio: 'ignore', detached: false });
const stopVite = () => { try { vite.kill('SIGTERM'); } catch { /* already gone */ } };
process.on('exit', stopVite);

const base = 'http://localhost:5179';
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(base);
    if (r.ok) break;
  } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 500));
}

const { chromium } = await import(join(root, 'tools', 'video-sim', 'node_modules', 'playwright', 'index.mjs')).catch(() => import('playwright'));
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
page.on('pageerror', (e) => console.error('  page error:', e.message));
page.on('console', (m) => console.error(`  console[${m.type()}]:`, m.text().slice(0, 300)));
page.on('framenavigated', (f) => console.error('  NAV ->', f.url()));
page.on('requestfailed', (r) => console.error('  request failed:', r.url(), r.failure()?.errorText));

const query = `?mode=${runMode}&model=${encodeURIComponent(model)}&inputSize=${inputSize}&score=${scoreThreshold}`;
await page.goto(`${base}/tools/video-sim/seg.html${query}`, { waitUntil: 'load' });

const loadStart = Date.now();
await page.evaluate(() => window.__segStart());
const loadMs = Date.now() - loadStart;
console.log(`Session ready in ${loadMs}ms (model fetch + ONNX Runtime Web init).`);

if (runMode === 'video') {
  const meta = await page.evaluate(([src]) => window.__segLoadVideo(src, 1), [`/tools/video-sim/.tmp/${localName}`]);
  console.log(`Loaded video ${meta.width}x${meta.height}, ${meta.duration.toFixed(1)}s\n`);

  const nTicks = Math.floor(Math.min(seconds, meta.duration) / every);
  for (let i = 0; i < nTicks; i++) {
    const targetT = i * every;
    await page.evaluate((t) => new Promise((res) => {
      const v = document.getElementById('v');
      const done = () => { v.removeEventListener('seeked', done); res(); };
      v.addEventListener('seeked', done);
      v.currentTime = t;
    }), targetT);
    await page.waitForTimeout(20); // let the freshly-seeked frame actually paint
    const r = await page.evaluate(() => window.__segDetectOnce());
    if (i === 0 || i === Math.floor(nTicks / 2) || i === nTicks - 1) {
      await page.locator('#wrap').screenshot({ path: join(outDir, `${prefix}seg-video-t${targetT.toFixed(1)}.png`) });
    }
    console.log(`  t=${targetT.toFixed(1)}s  instances=${r?.n ?? 'ERR'}  inf=${r?.inf?.toFixed(1) ?? '-'}ms`);
  }
} else {
  await page.evaluate(([src]) => window.__segLoadImage(src), [`/tools/video-sim/.tmp/${localName}`]);
  for (let i = 0; i < reps; i++) {
    const r = await page.evaluate(() => window.__segDetectOnce());
    console.log(`  rep ${i + 1}/${reps}  instances=${r?.n ?? 'ERR'}  inf=${r?.inf?.toFixed(1) ?? '-'}ms`);
  }
  await page.locator('#wrap').screenshot({ path: join(outDir, `${prefix}seg-image-${localName.replace(/\.[a-z]+$/, '')}.png`) });
}

const log = await page.evaluate(() => window.__segLog);
await browser.close();
stopVite();
await writeFile(join(outDir, `${prefix}seg-log.json`), JSON.stringify(log, null, 2));

/* ---------------------------- report ---------------------------- */
const costs = log.costs;
console.log(`\n══════════ COST (n=${costs.length}) ══════════`);
if (costs.length) {
  console.log(`  first call        : pre=${costs[0].pre.toFixed(1)}ms inf=${costs[0].inf.toFixed(1)}ms post=${costs[0].post.toFixed(1)}ms wall=${costs[0].wall.toFixed(1)}ms`);
  const steady = costs.slice(1);
  if (steady.length) {
    const median = (arr) => { const s = arr.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
    console.log(`  steady-state (n=${steady.length}) median: pre=${median(steady.map((c) => c.pre)).toFixed(1)}ms inf=${median(steady.map((c) => c.inf)).toFixed(1)}ms post=${median(steady.map((c) => c.post)).toFixed(1)}ms wall=${median(steady.map((c) => c.wall)).toFixed(1)}ms`);
    const maxInf = Math.max(...steady.map((c) => c.inf));
    console.log(`  steady-state max inference: ${maxInf.toFixed(1)}ms`);
  }
}
console.log('\n══════════ INSTANCES BY LABEL ══════════');
const byLabel = log.instancesByLabel;
if (Object.keys(byLabel).length === 0) {
  console.log('  NOTHING DETECTED.');
} else {
  for (const [label, n] of Object.entries(byLabel).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${label.padEnd(16)} ${n}`);
  }
}
if (log.errors.length) console.log(`\n  page errors: ${log.errors.slice(0, 5).join(' | ')}`);
console.log(`\nScreenshots: ${outDir}/${prefix}seg-*.png`);
console.log(`Raw log:     ${outDir}/${prefix}seg-log.json`);
