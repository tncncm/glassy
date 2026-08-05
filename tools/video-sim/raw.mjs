import { spawn } from 'node:child_process';
import { chromium } from './node_modules/playwright/index.mjs';
const vite = spawn('npx', ['vite','--port','5179','--strictPort'], { cwd: process.cwd(), stdio:'ignore' });
process.on('exit', () => { try { vite.kill(); } catch {} });
for (let i=0;i<60;i++){ try { if ((await fetch('http://localhost:5179')).ok) break; } catch {} await new Promise(r=>setTimeout(r,500)); }
const b = await chromium.launch();
const p = await (await b.newContext({viewport:{width:1000,height:800}})).newPage();
p.on('pageerror', e => console.error('PAGEERR', e.message));
p.on('console', m => { if (m.type()==='error') console.error('CONSOLE', m.text().slice(0,200)); });
await p.goto('http://localhost:5179/tools/video-sim/raw.html', { waitUntil:'load' });
await p.evaluate((s) => window.__run(s), '/tools/video-sim/.tmp/input.mp4');
const t0 = Date.now();
while (Date.now()-t0 < 70000) { if (await p.evaluate(()=>window.__done)) break; await new Promise(r=>setTimeout(r,500)); }
const raw = await p.evaluate(()=>window.__raw);
await b.close(); try { vite.kill(); } catch {}
const by = {};
for (const r of raw) { by[r.name] ??= {n:0,max:0}; by[r.name].n++; by[r.name].max = Math.max(by[r.name].max, r.score); }
console.log('\n=== RILEVAMENTI GREZZI (soglia 0.05, nessun filtro) ===');
console.log('totale:', raw.length);
const rows = Object.entries(by).sort((a,b)=>b[1].n-a[1].n);
if (!rows.length) console.log('  NULLA. Il modello non produce alcuna categoria su questo video.');
for (const [name,v] of rows.slice(0,20)) console.log(`  ${name.padEnd(18)} n=${String(v.n).padStart(4)}  score max ${v.max.toFixed(2)}`);
