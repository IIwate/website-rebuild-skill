#!/usr/bin/env node
// pixelcompare.mjs — A/B pixel comparison of two ALREADY-RUNNING servers
// (rebuild vs mirror): screenshot both at the same viewport in the same
// headless Chrome, quantify the difference on a coarse 64x40 grid-cell
// luma/color metric (suited to live scenes — noise, videos, particles — where
// an exact diff is meaningless), write both PNGs, a labeled side-by-side
// composite JPG, and merge the numbers into <out>/metric.json.
//
//   node pixelcompare.mjs --a http://localhost:5173/ --b http://localhost:5175/
//     [--name home]                    view name (keys metric.json + filenames)
//     [--out docs/pixelcompare] [--width 1280] [--height 800]
//     [--settle 6000]                  ms to wait after load before shooting
//     [--ready "js expr"]              poll until truthy before settling
//     [--seed "js expr"]               injected before load on BOTH sides
//                                      (e.g. preseed localStorage to skip a tutorial)
//     [--label-a REBUILD] [--label-b MIRROR]
//     [--max-mean 12]                  optional gate: exit 1 if meanAbsDiff exceeds
//
// Drive different app states by running this once per state with a --ready /
// --seed combination (the samsyninja original walked its menu states inline;
// that drive logic is site-specific and belongs in the caller).
//
// Zero npm dependencies: raw CDP over Node's built-in WebSocket (Node 22+).
// Adapted from samsyninja-rebuild/scripts/pixelcompare.mjs (64x40 grid +
// metric.json). For per-pixel byte gates + diff heatmaps see side-by-side.mjs.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};

const URL_A = flag('a', null);
const URL_B = flag('b', null);
if (!URL_A || !URL_B) {
  console.error('usage: pixelcompare.mjs --a <urlA> --b <urlB> [--name home] [--out docs/pixelcompare] [--width 1280] [--height 800] [--settle 6000] [--ready expr] [--seed expr] [--label-a A] [--label-b B] [--max-mean N]');
  process.exit(2);
}
const NAME = flag('name', 'home');
const OUT = flag('out', join(process.cwd(), 'docs', 'pixelcompare'));
const W = Number(flag('width', 1280));
const H = Number(flag('height', 800));
const SETTLE = Number(flag('settle', 6000));
const READY = flag('ready', null);
const SEED = flag('seed', null);
const LABEL_A = flag('label-a', 'REBUILD');
const LABEL_B = flag('label-b', 'MIRROR');
const MAX_MEAN = flag('max-mean', null);
const CDP_PORT = Number(process.env.CDP_PORT || 9333);

const CHROME =
  process.env.CHROME_BIN ||
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const children = [];
process.on('exit', () => children.forEach((c) => { try { c.kill('SIGKILL'); } catch {} }));
process.on('SIGINT', () => process.exit(2));

const waitFor = (fn, ms, label) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = async () => {
    try { const v = await fn(); if (v) return resolve(v); } catch {}
    if (Date.now() - t0 > ms) return reject(new Error('timeout ' + label));
    setTimeout(tick, 300);
  };
  tick();
});

// --- servers must already be running ---
await waitFor(async () => (await fetch(URL_A)).ok, 10000, 'server A ' + URL_A);
await waitFor(async () => (await fetch(URL_B)).ok, 10000, 'server B ' + URL_B);
console.log('[pixel] servers up');

// --- chrome ---
const profile = mkdtempSync(join(tmpdir(), 'pixelcompare-'));
children.push(spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--mute-audio', `--window-size=${W},${H}`, '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: 'ignore' }));
const target = await waitFor(async () => {
  const list = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
  return list.find((t) => t.type === 'page');
}, 15000, 'cdp');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let msgId = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  }
};
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expression) => {
  const res = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'eval failed');
  return res.result.value;
};

await cdp('Runtime.enable');
await cdp('Page.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
if (SEED) await cdp('Page.addScriptToEvaluateOnNewDocument', { source: SEED });

async function capture(url, label) {
  await cdp('Page.navigate', { url });
  if (READY) await waitFor(() => evalJs(READY), 120000, label + ' ready');
  await new Promise((resolve) => setTimeout(resolve, SETTLE)); // settle: transitions + fade-ins
  return (await cdp('Page.captureScreenshot', { format: 'png' })).data;
}

console.log(`[pixel] capturing A (${LABEL_A})…`);
const shotA = await capture(URL_A, LABEL_A);
console.log(`[pixel] capturing B (${LABEL_B})…`);
const shotB = await capture(URL_B, LABEL_B);

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, `${LABEL_A.toLowerCase()}-${NAME}.png`), Buffer.from(shotA, 'base64'));
writeFileSync(join(OUT, `${LABEL_B.toLowerCase()}-${NAME}.png`), Buffer.from(shotB, 'base64'));

// --- grid-cell diff + composite, computed inside the same chrome ---
const metric = await evalJs(`(async () => {
  const load = (b64) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.src = 'data:image/png;base64,' + b64;
  });
  const a = await load(${JSON.stringify(shotA)});
  const b = await load(${JSON.stringify(shotB)});
  const GW = 64, GH = 40;
  const cellData = (img) => {
    const canvas = document.createElement('canvas');
    canvas.width = GW; canvas.height = GH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, GW, GH);
    return ctx.getImageData(0, 0, GW, GH).data;
  };
  const da = cellData(a), db = cellData(b);
  let sum = 0, worst = 0, worstCell = null;
  for (let i = 0; i < da.length; i += 4) {
    const d = (Math.abs(da[i]-db[i]) + Math.abs(da[i+1]-db[i+1]) + Math.abs(da[i+2]-db[i+2])) / 3;
    sum += d;
    if (d > worst) { worst = d; worstCell = [(i/4) % GW, Math.floor((i/4) / GW)]; }
  }
  const mean = sum / (GW * GH);
  return { meanAbsDiff: +mean.toFixed(2), worstCellDiff: +worst.toFixed(1), worstCell, similarityPct: +(100 - mean / 2.55).toFixed(1) };
})()`);
console.log(`[pixel] ${NAME}:`, JSON.stringify(metric));

const composite = await evalJs(`(async () => {
  const load = (b64) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.src = 'data:image/png;base64,' + b64;
  });
  const a = await load(${JSON.stringify(shotA)});
  const b = await load(${JSON.stringify(shotB)});
  const canvas = document.createElement('canvas');
  canvas.width = a.width; canvas.height = a.height + b.height + 40;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#f22'; ctx.font = '16px monospace';
  ctx.fillText(${JSON.stringify(`${LABEL_A} — ${NAME.toUpperCase()}`)}, 10, 16);
  ctx.drawImage(a, 0, 20);
  ctx.fillText(${JSON.stringify(`${LABEL_B} — ${NAME.toUpperCase()}`)}, 10, a.height + 36);
  ctx.drawImage(b, 0, a.height + 40);
  return canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
})()`);
writeFileSync(join(OUT, `side-by-side-${NAME}.jpg`), Buffer.from(composite, 'base64'));

// merge into metric.json so repeated runs (one per view/state) accumulate
let metrics = {};
try { metrics = JSON.parse(readFileSync(join(OUT, 'metric.json'), 'utf8')); } catch {}
metrics[NAME] = metric;
writeFileSync(join(OUT, 'metric.json'), JSON.stringify(metrics, null, 2));
console.log('[pixel] wrote', OUT);

ws.close();
rmSync(profile, { recursive: true, force: true });

if (MAX_MEAN !== null && metric.meanAbsDiff > Number(MAX_MEAN)) {
  console.error(`[pixel] GATE FAIL: meanAbsDiff ${metric.meanAbsDiff} > ${MAX_MEAN}`);
  process.exit(1);
}
process.exit(0);
