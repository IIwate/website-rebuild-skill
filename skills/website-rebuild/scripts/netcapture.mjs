#!/usr/bin/env node
// netcapture.mjs — second mirror pass: drive the live site in a real headless
// Chrome, record every request it actually makes to the recorded hosts, then
// diff that against what the static crawler (mirror-site.mjs) pulled to disk.
//
// A regex crawl cannot see assets whose URLs are computed at runtime — scene
// textures built from an id, locale-suffixed sprites, media a component only
// requests once it mounts. This pass is how those get found.
//
// Zero npm dependencies: raw CDP over Node's built-in WebSocket (needs Node 22+).
//
// Usage:
//   node netcapture.mjs --origin https://example.com [--mirror legacy-mirror]
//     [--routes /,/about,/contact]      routes to visit (default "/")
//     [--viewports desktop,mobile]      which emulated viewports to run
//     [--steps 12] [--dwell 1500]       scroll-walk: wheel steps and per-step dwell (ms)
//     [--settle 9000]                   post-navigation settle before scrolling (ms)
//     [--hosts cdn.x.com,media.y.net]   extra hosts to record besides the origin
//     [--out <mirror>/netcapture.tsv]   HAVE/GAP ledger destination
//     [--fetch]                         also download anything the mirror is missing
//
// --hosts IS NOT OPTIONAL ON A CDN-BACKED SITE. Records are keyed by absolute
// URL over an allow-list of hosts, whose semantics match mirror-site.mjs's
// ASSET_HOSTS: pass this pass the same host list you passed the crawler. An
// earlier version filtered on startsWith(ORIGIN), so on a site serving its
// assets from a separate CDN host it recorded the HTML and nothing else and
// then reported a triumphant GAP=0 having observed ~2% of the traffic (field
// case: 208 of 246 URLs on cdn.shopify.com). Any host left off the list is
// counted and printed at the end, and running without --hosts while off-list
// traffic dominates prints a loud warning — a GAP=0 under that warning means
// nothing.
//
// The scroll walk dispatches WheelEvents AND window.scrollTo per step: covers
// both wheel-hijacking scene decks (advance one scene per wheel, then lock) and
// normal scroll pages. Dwell long enough for each newly mounted scene to start
// fetching, otherwise deep scenes' assets look like they do not exist.
//
// Adapted from careers-kimi-rebuild/legacy-mirror/_scripts/netcapture.mjs
// (samsyninja had the same real-browser capture idea; storytellingnoomo
// cross-checked with performance.getEntriesByType('resource'))
//   -> shopifydesign-rebuild (--hosts allow-list replacing the same-origin
//      filter, off-host census + under-observation warning, disk diff that
//      knows the assets/<host>/ layout).

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};

const ORIGIN_RAW = flag("origin", null);
if (!ORIGIN_RAW) {
  console.error("usage: netcapture.mjs --origin https://example.com [--mirror legacy-mirror] [--routes /,/a] [--viewports desktop,mobile] [--steps 12] [--dwell 1500] [--settle 9000] [--hosts cdn.x.com,media.y.net] [--out file.tsv] [--fetch] [--swiftshader]");
  process.exit(2);
}
const ORIGIN = ORIGIN_RAW.replace(/\/+$/, "");
const ROOT = path.resolve(flag("mirror", "legacy-mirror"));
const ROUTES = flag("routes", "/").split(",").filter(Boolean);
const STEPS = Number(flag("steps", 12));
const DWELL = Number(flag("dwell", 1500));
const SETTLE = Number(flag("settle", 9000));
const OUT_TSV = path.resolve(flag("out", path.join(ROOT, "netcapture.tsv")));
const ORIGIN_HOST = new URL(ORIGIN).hostname;
const HOSTS_FLAG = flag("hosts", "").split(",").map((s) => s.trim()).filter(Boolean);
// Same semantics as mirror-site.mjs's ASSET_HOSTS: origin + whatever you name.
const RECORD_HOSTS = new Set([ORIGIN_HOST, ...HOSTS_FLAG]);
const CDP_PORT = Number(process.env.CDP_PORT || 9333);
// Opt-in software GL — see the flag list below for why it is not the default.
const SWIFTSHADER = args.includes("--swiftshader");
const DO_FETCH = args.includes("--fetch");

// Emulated viewports; select with --viewports (comma list of these keys).
const VIEWPORT_DEFS = {
  desktop: { width: 1440, height: 900, mobile: false, deviceScaleFactor: 1 },
  mobile: { width: 390, height: 844, mobile: true, deviceScaleFactor: 2 },
};
const VIEWPORTS = Object.fromEntries(
  flag("viewports", "desktop,mobile")
    .split(",")
    .filter((v) => VIEWPORT_DEFS[v])
    .map((v) => [v, VIEWPORT_DEFS[v]]),
);

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

async function findChrome() {
  for (const c of CHROME_CANDIDATES) {
    try {
      await fs.access(c);
      return c;
    } catch {}
  }
  throw new Error("Chrome not found. Set CHROME_PATH.");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(port) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      const { webSocketDebuggerUrl } = await res.json();
      const ws = new WebSocket(webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
      });
      return ws;
    } catch {
      await sleep(250);
    }
  }
  throw new Error("could not reach CDP");
}

function client(ws) {
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners) fn(msg);
    }
  };
  return {
    // Every call is bounded. A route whose scene never finishes booting leaves
    // Page.navigate / Runtime.evaluate pending forever, and an unbounded await
    // wedges the whole capture on one page.
    send(method, params = {}, sessionId, timeoutMs = 30000) {
      id += 1;
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
      const myId = id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(myId);
          reject(new Error(`CDP timeout after ${timeoutMs}ms: ${method}`));
        }, timeoutMs);
        pending.set(myId, {
          resolve: (v) => (clearTimeout(timer), resolve(v)),
          reject: (e) => (clearTimeout(timer), reject(e)),
        });
      });
    },
    on(fn) {
      listeners.push(fn);
    },
  };
}

// ---------------------------------------------------------------------------

const chromePath = await findChrome();
const profile = path.join(tmpdir(), `netcapture-${CDP_PORT}`);
await fs.rm(profile, { recursive: true, force: true });

const chrome = spawn(
  chromePath,
  [
    `--remote-debugging-port=${CDP_PORT}`,
    "--headless=new",
    // Software GL is OPT-IN (--swiftshader), not the default. The flag makes
    // the page render headlessly on GPU-less machines, but it is also a
    // capability-detection input: a site that tiers on the GPU name will read
    // "SwiftShader", drop to its low tier, and you are then capturing a
    // different program than the one you are rebuilding (determinism.md §2.9,
    // environment-traps.md "快门速度"). For capture specifically the risk is
    // narrow — a tier usually changes geometry/shader parameters, not which
    // files are fetched — but verify that on your target before relying on it,
    // because if the tier DOES switch asset variants your GAP=0 is measured
    // against the wrong asset set.
    ...(SWIFTSHADER ? ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] : []),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--mute-audio",
    `--user-data-dir=${profile}`,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
// headless Chrome must not outlive the script (careers-kimi lesson: SIGKILL it)
process.on("exit", () => {
  try { chrome.kill("SIGKILL"); } catch {}
});

const ws = await connect(CDP_PORT);
const cdp = client(ws);

// requestId -> record, so the response event can complete what the request started
const inflight = new Map();
const requests = new Map(); // absolute url -> {path, status, type, bytes}
const consoleErrors = [];
const offHost = new Map(); // host -> count, for hosts not on the allow-list

cdp.on((msg) => {
  const p = msg.params || {};
  if (msg.method === "Network.requestWillBeSent" && p.request?.url?.startsWith("http")) {
    const u = new URL(p.request.url);
    if (!RECORD_HOSTS.has(u.hostname)) {
      offHost.set(u.hostname, (offHost.get(u.hostname) || 0) + 1);
      return;
    }
    // Key by absolute URL: two hosts can serve the same pathname, and the disk
    // diff needs the host to find the file under assets/<host>/.
    inflight.set(p.requestId, u.origin + u.pathname + u.search);
  } else if (msg.method === "Network.responseReceived") {
    const sitePath = inflight.get(p.requestId);
    if (!sitePath) return;
    requests.set(sitePath, {
      path: sitePath,
      status: p.response.status,
      type: (p.response.headers?.["content-type"] || p.response.mimeType || "").split(";")[0],
      bytes: 0,
    });
  } else if (msg.method === "Network.loadingFinished") {
    const sitePath = inflight.get(p.requestId);
    const rec = sitePath && requests.get(sitePath);
    if (rec) rec.bytes = p.encodedDataLength || 0;
  } else if (msg.method === "Runtime.exceptionThrown") {
    consoleErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || "?");
  }
});

const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
const send = (m, p, timeoutMs) => cdp.send(m, p, sessionId, timeoutMs);

await send("Network.enable");
await send("Page.enable");
await send("Runtime.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });

for (const [name, vp] of Object.entries(VIEWPORTS)) {
  await send("Emulation.setDeviceMetricsOverride", { ...vp, screenWidth: vp.width, screenHeight: vp.height });
  for (const route of ROUTES) {
    process.stdout.write(`  ${name} ${route} ... `);
    const before = requests.size;
    await send("Page.navigate", { url: ORIGIN + route }).catch((e) => console.log(`[nav] ${e.message}`));
    await sleep(SETTLE);
    await send("Runtime.evaluate", {
      expression: `(async () => {
        const target = document.querySelector('main') || window;
        for (let i = 0; i < ${STEPS}; i++) {
          target.dispatchEvent(new WheelEvent('wheel', { deltaY: 400, bubbles: true, cancelable: true }));
          window.scrollTo(0, i * window.innerHeight);
          await new Promise(r => setTimeout(r, ${DWELL}));
        }
        window.scrollTo(0, 0);
      })()`,
      awaitPromise: true,
    }, STEPS * DWELL + 15000).catch((e) => console.log(`[scroll] ${e.message}`));
    await sleep(4000);
    console.log(`+${requests.size - before} new`);
  }
}

await cdp.send("Target.closeTarget", { targetId });
chrome.kill();

// --- Diff against what is on disk ------------------------------------------

// Mirrors mirror-site.mjs's localPathFor(): origin pages/assets land at the
// bare path, every other host under assets/<host>/<path>.
function localPathFor(absUrl) {
  const u = new URL(absUrl);
  const clean = decodeURIComponent(u.pathname);
  if (u.hostname !== ORIGIN_HOST) {
    return path.join("assets", u.hostname, clean.endsWith("/") ? clean + "index" : clean);
  }
  if (clean === "/") return "index.html";
  let p = clean.replace(/^\/+/, "");
  if (p.endsWith("/")) return p + "index.html";
  if (!path.extname(p)) return p + "/index.html";
  return p;
}

const rows = [...requests.values()].sort((a, b) => a.path.localeCompare(b.path));
const missing = [];
for (const r of rows) {
  if (r.status !== 200) continue;
  const rel = localPathFor(r.path);
  try {
    await fs.access(path.join(ROOT, rel));
  } catch {
    missing.push(r);
  }
}

await fs.mkdir(path.dirname(OUT_TSV), { recursive: true });
await fs.writeFile(
  OUT_TSV,
  // URL, not PATH: records are keyed by absolute URL now that more than one
  // host can be recorded, and two hosts can serve the same pathname.
  ["STATUS", "CODE", "BYTES", "URL", "TYPE"].join("\t") +
    "\n" +
    rows
      .map((r) => [missing.includes(r) ? "GAP" : "HAVE", r.status, r.bytes, r.path, r.type].join("\t"))
      .join("\n") +
    "\n",
);

const offHostTotal = [...offHost.values()].reduce((a, b) => a + b, 0);

console.log(`\nrequests observed: ${rows.length} (hosts: ${[...RECORD_HOSTS].join(", ")})`);
console.log(`already mirrored:  ${rows.filter((r) => r.status === 200).length - missing.length}`);
console.log(`MIRROR GAPS:       ${missing.length}`);
for (const m of missing) console.log(`  ${m.status} ${m.path}`);
if (offHost.size) {
  console.log(`\noff-list hosts seen (NOT recorded, decide each in the external table):`);
  for (const [h, n] of [...offHost].sort((a, b) => b[1] - a[1])) console.log(`  ${n}x ${h}`);
}
// A GAP=0 that was computed while most of the traffic went unobserved is worse
// than no answer, because it reads as a pass. Say so, loudly, before the caller
// records the number.
if (offHostTotal && (offHostTotal >= rows.length || offHostTotal >= 10) && !HOSTS_FLAG.length) {
  const pct = Math.round((offHostTotal / (offHostTotal + rows.length)) * 100);
  console.log(
    `\n!! UNDER-OBSERVED: ran without --hosts and ignored ${offHostTotal} requests (${pct}% of all\n` +
      `!! traffic) to ${offHost.size} other host(s), listed above. This capture only covered ${ORIGIN_HOST},\n` +
      `!! so the GAP count above is NOT a verdict on the mirror. Re-run with the asset hosts:\n` +
      `!!   --hosts ${[...offHost.keys()].slice(0, 4).join(",")}`,
  );
}
if (consoleErrors.length) console.log(`\npage exceptions: ${consoleErrors.length}`);

if (DO_FETCH && missing.length) {
  console.log("\nfetching gaps...");
  for (const m of missing) {
    // m.path is an absolute URL (records are keyed by host + path).
    const res = await fetch(m.path, {
      headers: { "user-agent": "Mozilla/5.0 local static mirror", accept: "*/*", referer: ORIGIN + "/" },
    });
    if (!res.ok) {
      console.log(`  FAIL ${res.status} ${m.path}`);
      continue;
    }
    const out = path.join(ROOT, localPathFor(m.path));
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, Buffer.from(await res.arrayBuffer()));
    console.log(`  OK ${m.path}`);
  }
}
