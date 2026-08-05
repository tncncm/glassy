import { spawn } from 'node:child_process';
import { chromium } from './node_modules/playwright/index.mjs';
const vite = spawn('npx', ['vite','--port','5180','--strictPort'], { cwd: process.cwd(), stdio:'ignore' });
process.on('exit', () => { try { vite.kill(); } catch {} });
for (let i=0;i<60;i++){ try { if ((await fetch('http://localhost:5180')).ok) break; } catch {} await new Promise(r=>setTimeout(r,500)); }
const b = await chromium.launch();
const p = await (await b.newContext()).newPage();
p.on('pageerror', e=>console.error('ERR',e.message));
p.on('console', m=>{ if(m.type()==='error') console.error('CONSOLE', m.text().slice(0,160)); });
await p.goto('http://localhost:5180/tools/video-sim/still.html', { waitUntil:'load' });
const res = await p.evaluate(([paths, models]) => window.__run(paths, models), [[
  '/tools/video-sim/.tmp/frame_2.0.jpg','/tools/video-sim/.tmp/frame_3.0.jpg','/tools/video-sim/.tmp/frame_35.0.jpg',
],[
  '/vision/efficientdet_lite0_float16.tflite',
]]);
for (const [model, frames] of Object.entries(res)) {
  console.log(`\n########## ${model.split('/').pop()} ##########`);
  if (frames.error) { console.log('  ERRORE:', frames.error); continue; }
  for (const [f, dets] of Object.entries(frames)) {
    console.log(` ${f}:`, dets.length ? '' : ' nulla');
    for (const d of dets) console.log(`    ${String(d.n).padEnd(16)} ${d.s}`);
  }
}
await b.close(); try { vite.kill(); } catch {}
