#!/usr/bin/env node
// Compare captures from two running servers at the same viewport.
// Reports coarse 64x40 grid luma/color differences and writes captured frames,
// a labeled composite and metric.json. Grid averaging can hide localized pixel
// differences; a passing threshold applies only to the configured captures.
//
// node pixelcompare.mjs --a http://localhost:5173/ --b http://localhost:5175/
//     [--name home]                    view name (keys metric.json + filenames)
//     [--out docs/pixelcompare] [--width 1280] [--height 800]
//     [--settle 6000]                  ms to wait after load before shooting
//     [--ready "js expr"]              poll until truthy before settling
//     [--seed "js expr"]               injected before load on BOTH sides
//                                      (e.g. preseed localStorage to skip a tutorial)
//     [--label-a REBUILD] [--label-b MIRROR]
//     [--format png|jpeg] [--quality 92]   frame encoding (see the ceiling below)
//     [--max-mean 12]                  optional gate: exit 1 if meanAbsDiff exceeds
//     [--self] [--pump dt,frames] [--after-ready N] [--hold expr] [--hold-grace ms] [--hold-after N]
//     [--drive expr] [--chunk N] [--freeze-css] [--freeze-at -1s] [--cdp-port N]
//
// Use --ready, --seed and the drive options to reach comparable application
// states. --max-mean is an explicit threshold; this script does not infer a
// noise tolerance from repeated samples. --self records repeatability samples.
//
// Screenshot transport limits vary with runtime and image content. See
// lib/chrome.mjs for measured failures. JPEG reduces message size but is lossy;
// use PNG when comparing lossless pixels. Distinct-server identity and browser
// ownership are checked through lib/ports.mjs, with process-group cleanup in
// lib/chrome.mjs.
//
// Adapted from samsyninja's grid comparison. side-by-side.mjs provides image
// composites and a pixel difference view.


import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  assertDistinctSides,
  assertOwnBrowser,
  chromeSentinel,
  resolvePort,
} from './lib/ports.mjs';
import {
  findChrome,
  headlessArgs,
  launchChrome,
  preflightChrome,
  shotCeilingAdvice,
  shotLikelyTooBig,
} from './lib/chrome.mjs';
import { connectCdp } from './lib/cdp.mjs';
import { cli } from './lib/cli.mjs';

cli({
  known: ['a', 'b', 'name', 'out', 'width', 'height', 'format', 'quality', 'settle', 'ready', 'after-ready',
    'hold', 'hold-grace', 'hold-after', 'drive', 'pump', 'chunk', 'freeze-at', 'seed', 'label-a', 'label-b',
    'max-mean', 'cdp-port'],
  bools: ['self', 'freeze-css'],
  file: import.meta.url,
});

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};

//  The pump protocol REQUIRES the shim, and serve.mjs only injects it when the
// request carries ?__probe — so a URL without it is never what the caller meant.
// Measured: a bare URL produced "window.__pump never appeared within 30s" nine
// times in a row, and the truncated error (relayed through pixel-walk's 60-char
// slice) pointed at the serve config, which was fine all along. Append it here,
// once, instead of asking every caller to remember.
const withProbe = (u) => {
  if (!u) return u;
  try { const x = new URL(u); if (!x.searchParams.has('__probe')) { x.searchParams.set('__probe', ''); return x.href; } return u; }
  catch { return u; }
};
const URL_A = withProbe(flag('a', null));
const URL_B = withProbe(flag('b', null));
if (!URL_A || !URL_B) {
  console.error('usage: pixelcompare.mjs --a <urlA> --b <urlB> [--name home] [--out docs/pixelcompare] [--width 1280] [--height 800] [--settle 6000] [--ready expr] [--seed expr] [--label-a A] [--label-b B] [--format png|jpeg] [--quality 92] [--max-mean N] [--self] [--pump dt,frames]');
  process.exit(2);
}
const NAME = flag('name', 'home');
const OUT = flag('out', join(process.cwd(), 'docs', 'pixelcompare'));
const KIND = args.includes('--self') ? 'self-band' : 'cross-side';
//  Refuse to MIX KINDS in one metric.json, and refuse HERE — before the
// server wait and before a browser is launched. The tag used to be spread
// under the loaded object (`{kind, ...metrics}` with `metrics.kind` already
// set), so the file kept whichever kind its first run wrote: a band file and
// a cross-side pass could share one metric.json and the "tag travels with the
// numbers" promise at the write site was never enforced. A file with no tag is
// a pre-tag file and is simply tagged from here on.
{
  let prior = null;
  try { prior = JSON.parse(readFileSync(join(OUT, 'metric.json'), 'utf8')).kind ?? null; } catch {}
  if (prior && prior !== KIND) {
    console.error(`FATAL: ${join(OUT, 'metric.json')} is tagged kind=${prior}, but this run is ${KIND}.`);
    console.error(`       A band file and a cross-side file must not share one metric.json — use a different --out.`);
    process.exit(2);
  }
}
const W = Number(flag('width', 1280));
const H = Number(flag('height', 800));
// PNG by default: the saved frames are evidence and a byte-exact gate needs
// lossless bytes. jpeg is the documented escape hatch above ~1500x900, where
// PNG cannot cross the CDP WebSocket at all (see the header).
const FORMAT = String(flag('format', 'png')).toLowerCase();
const QUALITY = Number(flag('quality', 92));
if (!['png', 'jpeg', 'webp'].includes(FORMAT)) {
  console.error(`FATAL: --format must be png, jpeg or webp (got ${FORMAT})`);
  process.exit(2);
}
if (FORMAT !== 'png' && (!Number.isInteger(QUALITY) || QUALITY < 1 || QUALITY > 100)) {
  console.error(`FATAL: --quality must be an integer 1..100 (got ${flag('quality', 92)})`);
  process.exit(2);
}
const EXT = FORMAT === 'jpeg' ? 'jpg' : FORMAT;
const SETTLE = Number(flag('settle', 6000));
// A pumped readiness predicate can leave a diagnostic string in window.__why.
// It is printed if the frame budget is exhausted before readiness.
const READY = flag('ready', null);
// --after-ready N: align on STATE first (the frame where --ready turns true on each side), THEN pump N more frames.
// Waiting for an absolute pump count instead differs by one mount phase between the sides (darkroom /work: 1.8–2.5 at
// pumps 180/210, 0 at 60/90/120/240 — phase noise, not a porting gap). Same-frame means state-relative time.
const AFTER_READY = Number(flag('after-ready', '0')) || 0;
// --hold <expr> [--hold-grace ms]: the OTHER half of state alignment. --ready/--after-ready
// aligns on a state that is reached BY PUMPING (a mount phase in virtual time). But a
// state reached in REAL time — a GLB decoded on a worker, a texture arriving — must be
// waited for BEFORE the first pump, with the virtual clock still at 0: then both sides
// pump the same absolute frames from the same starting state. Aligning such a state
// with --after-ready instead makes the two sides' absolute pump counts differ by their
// arrival jitter, and every time-driven animation lands at a different phase (raycastkbd
// walk-025: exploded switch vs assembled switch, self-band a constant 1.7; with --hold
// and absolute pumping 0.00). --hold-grace is the real-time tail after the predicate
// (decode completion has no page-visible signal) — a stated deviation from "settle is a
// page state", register it.
const HOLD = flag('hold', null);
const HOLD_GRACE = Number(flag('hold-grace', '0')) || 0;
// --hold-after N: pump N frames FIRST, then hold. The arrival you wait for is usually
// requested from inside the pumped world (an IntersectionObserver record, a mount effect,
// the scroll drive reaching the section) — with the clock frozen at 0 the request is never
// issued and the hold times out (measured: 60s, 5/5 checkpoints). N frames of virtual time
// let the page ask; the hold then waits in real time; the remaining total−N frames pump the
// same absolute clock on both sides.
const HOLD_AFTER = Number(flag('hold-after', '0')) || 0;
//  A LOAD-TIME SEED CANNOT DRIVE A PAGE WHOSE TARGET DOES NOT EXIST YET.
// Measured: a site whose scroll container is created only after its preloader
// finishes. The seed ran at `load`, found `scrollHeight - clientHeight === 0`,
// and scrolled to 0 — at every checkpoint. Driving and readiness co-evolve, so
// the driver has to live in the same interleaved loop as the pump.
//
// --drive is an expression re-evaluated after EVERY pump chunk. Write it
// idempotently: it will run many times.
// Record window.__walkScroll = { tag, max, target, landed } so the comparison
// can check the actual scroll positions. Load-time patches belong in --seed.
const DRIVE = flag('drive', null);
// --pump "dt,frames" advances the shim's virtual clock through window.__pump.
const PUMP = flag('pump', null);
//  THE SHIM CANNOT FREEZE CSS. probe-shim.js takes over rAF, timers,
// performance.now, Date.now and Math.random — every clock that runs through
// JavaScript. A CSS `animation` does not: it runs on the browser's own
// animation timeline, and a marquee at `animation: marquee 30s infinite` keeps
// moving through a fully "frozen" page.
//
// Measured on a CSS-animated target: the same side compared with ITSELF drifted
// 0.31 meanAbsDiff with the same worst cell every run, while cross-side was
// 0.22 — the residual was larger within one side than between the two, and no
// amount of settling converged it, because the thing moving was never going to
// stop.
//
// --freeze-css pins every animation to the SAME PHASE on both sides: paused,
// with a fixed negative delay so each one is evaluated at the same offset into
// its own timeline.  It changes what is rendered (a marquee is captured
// mid-travel rather than wherever it drifted to), which is exactly the point —
// both sides are captured at the same mid-travel position.
const FREEZE_CSS = args.includes('--freeze-css');
const FREEZE_AT = flag('freeze-at', '-1s');
const SEED = flag('seed', null);
const LABEL_A = flag('label-a', 'REBUILD');
const LABEL_B = flag('label-b', 'MIRROR');
const MAX_MEAN = flag('max-mean', null);
// One browser drives both sides here, so the CDP lane carries no side digit.
const { port: CDP_PORT, label: CDP_LABEL } = resolvePort({
  lane: 'pixelcompare.cdp',
  cli: flag('cdp-port', null),
  env: process.env.CDP_PORT || null,
  envName: 'CDP_PORT',
});

const CHROME = await findChrome();

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

// Cross-side runs reject repeated server identities. --self permits repeated
// endpoints for noise measurement and marks the output as a baseline sample,
// rather than a cross-side comparison result (verification-gates.md §1.3.2).
const SELF = args.includes('--self');
let idA = null, idB = null;
if (SELF) {
  console.log(
    `[pixel] --self: BAND SAMPLE, NOT A VERDICT.\n` +
      `        Both sides are the same root; this run measures that side's own\n` +
      `        session-to-session noise (§1.3.2). Collect >= 4 per side, per\n` +
      `        checkpoint, interleaved with the other side — a band built from\n` +
      `        one side only lets the reference side's luck set the tolerance.`,
  );
} else {
  ({ idA, idB } = await assertDistinctSides(URL_A, URL_B, {
    tool: 'pixelcompare.mjs',
    labelA: LABEL_A,
    labelB: LABEL_B,
  }));
}
// Labels drive the output filenames and the composite captions, so a label that
// contradicts the server's own declared side would mislabel the evidence.
for (const [label, id] of [[LABEL_A, idA], [LABEL_B, idB]]) {
  if (id && id.side !== 'unset' && !label.toLowerCase().includes(String(id.side).toLowerCase())) {
    console.error(`[pixel] WARNING: label "${label}" is attached to a server that declares side ${String(id.side).toUpperCase()}`);
  }
}

// --- chrome ---
console.log(`[pixel] cdp port ${CDP_LABEL}`);
// Sweep this role's orphans from a previous run first (they are the most likely
// occupant of this port, and their load is what would widen the band), then
// refuse to move if the port is still taken.
await preflightChrome({ role: 'pixelcompare', port: CDP_PORT, tool: 'pixelcompare.mjs' });
const sentinel = chromeSentinel();
// Detached process group + reaping on every exit path lives in lib/chrome.mjs;
// --user-data-dir is a temp profile it creates and deletes.
const chrome = launchChrome({
  bin: CHROME,
  role: 'pixelcompare',
  port: CDP_PORT,
  tool: 'pixelcompare.mjs',
  // The shared headless set (anti-throttling, sentinel) plus autoplay, so both
  // sides' videos are at the same frame without a gesture.
  args: [
    ...headlessArgs({ port: CDP_PORT, width: W, height: H, sentinelUrl: sentinel.url }),
    '--autoplay-policy=no-user-gesture-required',
  ],
});
// Our own page or nothing: attaching to a browser this script did not start
// would shoot whatever that browser is showing and file it under these labels.
const target = await assertOwnBrowser({
  port: CDP_PORT, sentinel, tool: 'pixelcompare.mjs', pid: chrome.pid,
});

// THE error-reporting hook (an oversized screenshot kills the connection with
// close 1006 instead of returning an error) and the per-call timeout both live
// in lib/cdp.mjs; a silent hang is the worst failure shape there is.
const cdp = await connectCdp(target.webSocketDebuggerUrl, { defaultTimeoutMs: 120000 });
const evalJs = async (expression) => {
  const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'eval failed');
  return res.result.value;
};

await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
// HTTP cache reuse can change img.complete branches on the second capture.
// Disable it for both sides; cookies and application storage are separate inputs.
await cdp.send('Network.enable');
await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
// Expression hashes expose stale copies in wrapper scripts. They identify
// these inputs, not the entire browser environment or every capture option.
{
  const fp = (v) => v ? `${createHash('sha256').update(v).digest('hex').slice(0, 10)} (${v.length} chars)` : 'none';
  console.log(`[pixel] instrument — seed ${fp(SEED)} · ready ${fp(READY)} · drive ${fp(DRIVE)}${FREEZE_CSS ? ' · freeze-css' : ''} · cold-cache`);
}
if (SEED) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: SEED });
if (FREEZE_CSS) {
  // Injected on new document so it applies before first paint, and re-applied
  // after settle (below) for anything mounted later.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const css = \`*, *::before, *::after {
        animation-play-state: paused !important;
        animation-delay: ${FREEZE_AT} !important;
        transition: none !important;
      }\`;
      const put = () => {
        if (!document.documentElement || document.getElementById('__freeze_css')) return;
        const s = document.createElement('style');
        s.id = '__freeze_css';
        s.textContent = css;
        (document.head || document.documentElement).appendChild(s);
      };
      put();
      document.addEventListener('DOMContentLoaded', put);
      // New-document scripts can run before the root element exists.
      new MutationObserver(put).observe(document, { childList: true, subtree: true });
    })()`,
  });
}

/** Die with an actionable message instead of hanging or dumping a stack. */
function shotFatal(label, err) {
  console.error(`[pixel] FATAL: screenshot for ${label} failed: ${err.message}`);
  for (const l of shotCeilingAdvice({
    w: W, h: H,
    format: FORMAT,
    quality: FORMAT === 'png' ? null : QUALITY,
    closeCode: cdp.closed,
  })) console.error(`[pixel] ${l}`);
  chrome.reap();
  process.exit(4);
}

let landA = null, landB = null;
async function capture(url, label) {
  await cdp.send('Network.clearBrowserCache');
  await cdp.send('Page.navigate', { url });
  //  --ready is NOT a pre-pump wait. Checking it before the pump can only ever
  // express "ready without any driving", and on a frozen page the states worth
  // waiting for are exactly the ones the pump has to produce: a preloader that
  // finishes, a WebGL canvas that gets sized. Waiting first simply hangs — 120 s
  // for a condition whose precondition has not run yet.
  //
  //  So --ready is the PUMP LOOP'S EXIT CONDITION (below): pump until the page
  // reaches the state, capped by the frame budget. Fast when the state arrives
  // early, and honest when it never does. Without --pump it keeps its old
  // meaning, because then there is nothing to drive.
  if (READY && !PUMP) await waitFor(() => evalJs(READY), 120000, label + ' ready');
  if (PUMP) {
    //  INTERLEAVED WITH REAL TIME, not one burst after the settle.
    //
    // A frozen page still boots against REAL async: XHR for assets, decode,
    // font loading. Those land on the wall clock while everything the page can
    // observe about time only moves when pumped. Pump once at the end and the
    // engine never gets a frame in which its assets have arrived — measured on a
    // WebGL target, canvases sat at the default 300x150 through a 240-frame
    // burst, and the comparison then reported a zero difference over two blank frames.
    // Pumping in chunks with real gaps, the same engine sized its canvas to
    // 1730x1082 within ~2.5 s of virtual time.
    //
    // So: the pump budget is spread across the settle window. Both sides get the
    // IDENTICAL dt sequence, which is what makes the frames comparable.
    const [dt, frames] = PUMP.split(',').map((n) => Number(n.trim()));
    //  WAIT for the shim, do not test for it once. `Page.navigate` resolves when
    // navigation STARTS, so a single check runs against the previous document or
    // before the injected script has executed — and then this gate blames the URL
    // for a shim that was there all along. Measured: the same URL that made this
    // FATAL answered `typeof window.__pump === "function"` from a plain probe.
    //  A wrong diagnosis is more expensive than no diagnosis: it sends you to
    // change something that was already correct.
    const ok = await waitFor(
      async () => {
        const r = await evalJs(`document.readyState !== "loading" && typeof window.__pump === "function"`);
        return r === true || r === 'true';
      },
      30000,
      label + ' determinism shim',
    ).catch(() => false);
    if (!ok) {
      console.error(`[pixel] FATAL: window.__pump never appeared on ${label} within 30s.\n` +
        `        serve.mjs injects the shim into HTML responses carrying ?__probe — check that the\n` +
        `        URL has it, that the response is HTML, and that the shim did not throw (probe the\n` +
        `        page directly and read the console).`);
      chrome.reap();
      process.exit(6);
    }
    // Real-time wait with the virtual clock frozen: nothing the page animates
    // advances between two __pump calls, so after the hold both sides resume the
    // same absolute clock from the same (arrived) state.
    let held = !HOLD;
    const holdNow = async (done) => {
      const ok2 = await waitFor(async () => { const r = await evalJs(HOLD); return r === true || r === 'true'; }, 60000, label + ' hold')
        .then(() => true).catch(() => false);
      if (!ok2) {
        console.error(`[pixel] FATAL: ${label} never satisfied --hold within 60s of real time (after ${done} pumped frame(s)) — do NOT compare this frame.`);
        console.error(`        If the arrival is only REQUESTED from inside the pumped world (IO record, mount effect, scroll drive), raise --hold-after.`);
        chrome.reap();
        process.exit(6);
      }
      if (HOLD_GRACE > 0) await new Promise((r) => setTimeout(r, HOLD_GRACE));
      console.log(`[pixel]   ${label}: --hold satisfied after ${done} pumped frame(s)${HOLD_GRACE ? ` (+${HOLD_GRACE}ms grace)` : ''}, resuming the absolute clock`);
      held = true;
    };
    if (HOLD && HOLD_AFTER === 0) await holdNow(0);
    const total = frames || 60;
    // --chunk N: pump granularity. State alignment (--ready) resolves to ONE chunk —
    // a marquee that starts 8–16 frames earlier on the single-bundle rebuild sits
    // entirely inside the default 6-frame chunk, and the two sides can only be
    // pinned to the same frame with a 1-frame chunk (darkroom /about 2.57 → 0.00).
    // Chunk size also controls how often the pump yields to network and media
    // work. A frame budget therefore depends on this setting and the real gaps.
    const chunk = Number(flag('chunk', '0')) > 0 ? Number(flag('chunk', '0')) : Math.max(1, Math.ceil(total / 40));
    const gap = Math.max(20, Math.floor(SETTLE / Math.ceil(total / chunk)));
    let readyAt = null;
    for (let done = 0; done < total; done += chunk) {
      if (!held && done >= HOLD_AFTER) await holdNow(done);
      await evalJs(`(window.__pump(${dt || 16.7}, ${Math.min(chunk, total - done)}), true)`);
      if (DRIVE) await evalJs(`(function(){ try { ${DRIVE} } catch (e) { return "ERR:" + e; } return true; })()`);
      if (READY && readyAt === null) {
        const r = await evalJs(READY);
        if (r === true || r === 'true') {
          readyAt = done + chunk;
          console.log(`[pixel]   ${label}: ready after ${readyAt} pumped frame(s) — ${AFTER_READY ? `then +${AFTER_READY} frame(s) state-relative` : 'stopping early'}`);
          break;
        }
      }
      await new Promise((r) => setTimeout(r, gap));
    }
    if (READY && readyAt !== null && AFTER_READY > 0) {
      for (let done = 0; done < AFTER_READY; done += chunk) {
        await evalJs(`(window.__pump(${dt || 16.7}, ${Math.min(chunk, AFTER_READY - done)}), true)`);
        if (DRIVE) await evalJs(`(function(){ try { ${DRIVE} } catch (e) { return "ERR:" + e; } return true; })()`);
        await new Promise((r) => setTimeout(r, gap));
      }
    }

    if (READY && readyAt === null) {
      //  Say it. A capture taken before the page reached its state is a capture
      // of the loading screen, and two of those agree perfectly.
      console.error(`[pixel] FATAL: ${label} never satisfied --ready within ${total} pumped frame(s).`);
      console.error(`        Raise --pump frames or --settle, or fix the predicate — do NOT compare this frame.`);
      const why = await evalJs(`String(window.__why ?? '')`).catch(() => '');
      if (why) console.error(`        window.__why: ${String(why).slice(0, 400)}`);
      else console.error(`        No window.__why diagnostic was provided by the predicate.`);
      chrome.reap();
      process.exit(6);
    }
  } else {
    await new Promise((resolve) => setTimeout(resolve, SETTLE)); // settle: transitions + fade-ins
  }
  // Where the scroll actually settled on this side, as recorded by the seed.
  {
    const raw = await evalJs(`JSON.stringify(window.__walkScroll || null)`).catch(() => null);
    try {
      const v = typeof raw === 'string' ? JSON.parse(raw) : null;
      if (v) { if (label === LABEL_A) landA = v; else landB = v; }
    } catch {}
  }
  let data;
  try {
    ({ data } = await cdp.send('Page.captureScreenshot', {
      format: FORMAT,
      ...(FORMAT === 'png' ? {} : { quality: QUALITY }),
    }));
  } catch (e) {
    shotFatal(label, e);
  }
  console.log(`[pixel]   ${label}: ${W}x${H} ${FORMAT}${FORMAT === 'png' ? '' : ' q' + QUALITY}, ${data.length.toLocaleString()} base64 chars`);
  return data;
}

// The ceiling is a property of the transport and is knowable before the shot,
// so warn while the advice can still be acted on cheaply.
if (shotLikelyTooBig({ w: W, h: H, format: FORMAT })) {
  for (const l of shotCeilingAdvice({ w: W, h: H, format: FORMAT })) console.error(`[pixel] ${l}`);
}

console.log(`[pixel] capturing A (${LABEL_A})…`);
const shotA = await capture(URL_A, LABEL_A);
console.log(`[pixel] capturing B (${LABEL_B})…`);
const shotB = await capture(URL_B, LABEL_B);

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, `${LABEL_A.toLowerCase()}-${NAME}.${EXT}`), Buffer.from(shotA, 'base64'));
writeFileSync(join(OUT, `${LABEL_B.toLowerCase()}-${NAME}.${EXT}`), Buffer.from(shotB, 'base64'));

// The two steps below send BOTH frames back INTO the browser inlined in a
// Runtime.evaluate expression, so that message is ~2x one frame. The outbound
// direction has more headroom than the inbound one (4.37 M chars measured OK
// here), but it is the same ceiling and it is the reason a run can survive both
// screenshots and then die on the metric. When it does, say which step and why
// instead of printing a bare 120 s timeout.
const INLINE_B64 = shotA.length + shotB.length;
const MIME = `data:image/${FORMAT};base64,`;
const inlineFatal = (step, err) => {
  console.error(`[pixel] FATAL: the ${step} step failed: ${err.message}`);
  console.error(`[pixel]   it inlines BOTH frames into one CDP message (${INLINE_B64.toLocaleString()} base64 chars) and reads the result back.`);
  for (const l of shotCeilingAdvice({
    w: W, h: H, format: FORMAT, quality: FORMAT === 'png' ? null : QUALITY,
    sizeB64: INLINE_B64, closeCode: cdp.closed,
  })) console.error(`[pixel] ${l}`);
  chrome.reap();
  process.exit(4);
};

// Check for near-blank frames before computing differences
// (gate-failure-modes.md §1.8). Matching blank frames can have zero differences.
// On one frozen WebGL target, three routes produced frames with 201 colors
// and 99.5% black pixels, compared with 28,282 colors when unfrozen; both
// cross-side and self comparisons reported zero difference. Color count and
// background dominance are heuristics and still require scene-specific review.
const census = await evalJs(`(async () => {
  const load = (b64) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = ${JSON.stringify(MIME)} + b64; });
  const stat = async (b64) => {
    const img = await load(b64);
    const c = document.createElement('canvas');
    c.width = Math.min(img.width, 480); c.height = Math.min(img.height, 300);
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0, c.width, c.height);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    const h = new Map(); let top = 0;
    for (let i = 0; i < d.length; i += 4) {
      const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      const n = (h.get(k) || 0) + 1; h.set(k, n); if (n > top) top = n;
    }
    return { colours: h.size, dominantPct: +(100 * top / (c.width * c.height)).toFixed(1) };
  };
  return JSON.stringify({ a: await stat(${JSON.stringify(shotA)}), b: await stat(${JSON.stringify(shotB)}) });
})()`);
{
  const { a, b } = JSON.parse(census);
  //  SAY WHERE THIS WAS MEASURED. A gate that reports a number without saying
  // what state produced it invites the reader to assume the intended state. And an
  // assertion whose inputs are missing is silently inert — printing them is how
  // you find out it never ran, rather than believing it passed.
  if (DRIVE || landA || landB) {
    const fmt = (l) => (l ? `${l.tag} ${l.landed}/${l.max} (target ${l.target})` : "NOT RECORDED");
    console.log(`[pixel] measured at — A: ${fmt(landA)}   B: ${fmt(landB)}`);
    if (DRIVE && (!landA || !landB)) {
      console.error(`[pixel] FATAL: --drive was given but at least one side recorded no landing.`);
    console.error(`        --drive must set window.__walkScroll = { tag, max, target, landed }.`);
    console.error(`        Check that the scroll target exists and the driver records its landing.`);
    console.error(`        Use --seed for load-time patches that do not drive scrolling.`);
      chrome.reap();
      process.exit(6);
    }
  }

  //  Both sides must have landed at the SAME scroll position. The seed records
  // where the scroll actually settled; a smooth-scroll library can drag it
  // elsewhere, and then this gate compares two different parts of the page and
  // reports the difference as a porting defect.
  if (landA && landB && Math.abs(landA.landed - landB.landed) > 4) {
    console.error(`[pixel] FATAL: the two sides settled at different scroll positions —`);
    console.error(`        A landed ${landA.landed} of ${landA.max}, B landed ${landB.landed} of ${landB.max} (target ${landA.target}).`);
    console.error(`        Comparing them measures the page, not the port. Drive through whatever owns`);
    console.error(`        scrolling on this site and assert the landing before capturing.`);
    chrome.reap();
    process.exit(6);
  }
  console.log(`[pixel] frame census — ${LABEL_A}: ${a.colours} colours, dominant ${a.dominantPct}%  |  ${LABEL_B}: ${b.colours} colours, dominant ${b.dominantPct}%`);
  const blank = (x) => x.colours < 64 || x.dominantPct > 97;
  if (blank(a) || blank(b)) {
    console.error(
      `[pixel] FATAL: a captured frame is effectively BLANK, so any agreement below would be agreement about nothing.\n` +
        `        Likely causes: the page never reached first paint, a determinism freeze parked it before init,\n` +
        `        or --settle / --ready returned too early. Compare against an unfrozen capture before trusting a 0.`,
    );
    chrome.reap();
    process.exit(5);
  }
}

// --- grid-cell diff + composite, computed inside the same chrome ---
let metric;
try {
  metric = await evalJs(`(async () => {
  const load = (b64) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.src = ${JSON.stringify(MIME)} + b64;
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
} catch (e) {
  inlineFatal('metric', e);
}
console.log(`[pixel] ${NAME}:`, JSON.stringify(metric));

let composite;
try {
  composite = await evalJs(`(async () => {
  const load = (b64) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.src = ${JSON.stringify(MIME)} + b64;
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
} catch (e) {
  inlineFatal('composite', e);
}
writeFileSync(join(OUT, `side-by-side-${NAME}.jpg`), Buffer.from(composite, 'base64'));

// merge into metric.json so repeated runs (one per view/state) accumulate
let metrics = {};
try { metrics = JSON.parse(readFileSync(join(OUT, 'metric.json'), 'utf8')); } catch {}
// Strip the loaded tag so this run's KIND wins the spread (the kind check
// above already guaranteed the two agree, or exited before any pixel was taken).
delete metrics.kind;
metrics[NAME] = metric;
// The tag travels with the numbers: a band file must never be readable later as
// a cross-side pass. Anything consuming these files should refuse to mix kinds.
writeFileSync(join(OUT, 'metric.json'), JSON.stringify({ kind: KIND, ...metrics }, null, 2));
console.log('[pixel] wrote', OUT);

cdp.close();
// Reap the whole process group and only then delete the profile — a live Chrome
// keeps writing into that directory, so removing it first throws ENOTEMPTY and a
// passing comparison exits non-zero on a failure that says nothing about the
// pixels (observed under concurrent runs). Both halves live in lib/chrome.mjs,
// which also swallows cleanup errors so they can never decide the exit code.
chrome.reap();

//  --max-mean is a GATE, and a band sample is not a gate result. Applying a
// threshold to a self-comparison would let the reference side's own noise
// "pass" or "fail" something, which is a category error: the band is an INPUT
// to classification, never a verdict.
if (SELF && MAX_MEAN !== null) {
  console.error(`[pixel] --max-mean is ignored under --self: a band sample is an input to classification, not a gate result.`);
} else if (MAX_MEAN !== null && metric.meanAbsDiff > Number(MAX_MEAN)) {
  console.error(`[pixel] GATE FAIL: meanAbsDiff ${metric.meanAbsDiff} > ${MAX_MEAN}`);
  process.exit(1);
}
process.exit(0);
