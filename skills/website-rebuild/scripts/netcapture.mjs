#!/usr/bin/env node
// Capture browser requests and compare selected-host URLs with a local mirror.
// Each route uses a fresh CDP target. The viewport and scroll walk determine
// which requests can be observed; the report does not cover unvisited states.
//
// Usage:
//   node netcapture.mjs --origin https://example.com [--mirror mirror]
//     [--routes /,/about,/contact]      routes to visit (default "/")
//     [--viewports desktop,mobile]      which emulated viewports to run (default: both)
//     [--steps 12] [--dwell 1500]       scroll-walk: wheel steps and per-step dwell (ms)
//     [--settle 9000]                   post-navigation settle before scrolling (ms)
//     [--hosts cdn.x.com,media.y.net]   extra hosts to record besides the origin
//     [--out <mirror>/netcapture.tsv]   HAVE/GAP ledger destination
//     [--fetch]                         also download anything the mirror is missing,
//                                       into both ledgers (manifest + inventory)
//     [--swiftshader]                   opt-in software GL (see the Chrome flag list below)
//     [--cdp-port N]                    debug port; default allocated by lib/ports.mjs (CDP_PORT env also honoured)
//
// Use the crawler's asset-host list. Off-list hosts are counted and reported,
// but their requests do not enter the selected-host HAVE/GAP comparison.
// In shopifydesign, 208 of 246 observed URLs used cdn.shopify.com; filtering
// only the origin omitted most traffic while still reporting GAP=0.
//
// Wheel events and window.scrollTo cover different scrolling implementations.
// Allow enough dwell time for newly mounted scenes to request their assets.
// lib/ports.mjs verifies browser ownership; lib/chrome.mjs manages process groups.
// Uses Node's built-in WebSocket. Adapted from careers-kimi and shopifydesign,
// with related capture cases in samsyninja and storytellingnoomo.


import fs from "node:fs/promises";
import path from "node:path";
import { assertOwnBrowser, chromeSentinel, resolvePort } from "./lib/ports.mjs";
import { findChrome, launchChrome, preflightChrome } from "./lib/chrome.mjs";
// The one CDP client (bounded calls, close-error handling) — lib/cdp.mjs.
import { connectCdp, cdpUrlFor } from "./lib/cdp.mjs";
// Shared, query-aware url -> local path. This pass keys its records by url+search
// but used to resolve disk by pathname alone, so on a query-parameterised image
// CDN every responsive variant after the first reported HAVE against a file that
// is a DIFFERENT image — a false GAP=0 with no symptom. See lib/urlpath.mjs.
import { localRelPath, loadPolicy, describePolicy } from "./lib/urlpath.mjs";
import { fetchLadder } from "./lib/negotiate.mjs";
import { sha256 } from "./lib/hash.mjs";
// The mirror's ledgers, read and appended through lib/ledger.mjs — the same row
// format mirror-site.mjs writes and verify-mirror.mjs audits.
import { readManifest, writeManifest, appendInventory, MANIFEST_FILE as MANIFEST_NAME, INVENTORY_FILE } from "./lib/ledger.mjs";
import { cli } from "./lib/cli.mjs";

cli({
  known: ["origin", "mirror", "routes", "viewports", "steps", "dwell", "settle", "hosts", "out", "cdp-port"],
  bools: ["swiftshader", "fetch"],
  file: import.meta.url,
});

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};

const ORIGIN_RAW = flag("origin", null);
if (!ORIGIN_RAW) {
  console.error("usage: netcapture.mjs --origin https://example.com [--mirror mirror] [--routes /,/a] [--viewports desktop,mobile] [--steps 12] [--dwell 1500] [--settle 9000] [--hosts cdn.x.com,media.y.net] [--out file.tsv] [--fetch] [--swiftshader]");
  process.exit(2);
}
const ORIGIN = ORIGIN_RAW.replace(/\/+$/, "");
const ROOT = path.resolve(flag("mirror", "mirror"));
// Declared up here, not next to the --fetch helpers at the bottom: the fetch
// loop is top-level code that runs BEFORE a `const` further down would exist.
// (The fetch UA is lib/negotiate.mjs's BROWSER_UA, inside fetchLadder.)
const MANIFEST_FILE = path.join(ROOT, MANIFEST_NAME);
const ROUTES = flag("routes", "/").split(",").filter(Boolean);
const STEPS = Number(flag("steps", 12));
const DWELL = Number(flag("dwell", 1500));
const SETTLE = Number(flag("settle", 9000));
const OUT_TSV = path.resolve(flag("out", path.join(ROOT, "netcapture.tsv")));
const ORIGIN_HOST = new URL(ORIGIN).hostname;
const HOSTS_FLAG = flag("hosts", "").split(",").map((s) => s.trim()).filter(Boolean);
// Same semantics as mirror-site.mjs's ASSET_HOSTS: origin + whatever you name.
const RECORD_HOSTS = new Set([ORIGIN_HOST, ...HOSTS_FLAG]);
// This pass drives the LIVE origin, which is its own side of the ledger.
const { port: CDP_PORT, label: CDP_LABEL } = resolvePort({
  lane: "netcapture.cdp",
  side: "live",
  cli: flag("cdp-port", null),
  env: process.env.CDP_PORT || null,
  envName: "CDP_PORT",
});
// Opt-in software GL — see the flag list below for why it is not the default.
const SWIFTSHADER = args.includes("--swiftshader");
const DO_FETCH = args.includes("--fetch");

// Emulated viewports; select with --viewports (comma list of these keys).
const VIEWPORT_DEFS = {
  desktop: { width: 1440, height: 900, mobile: false, deviceScaleFactor: 1 },
  mobile: { width: 390, height: 844, mobile: true, deviceScaleFactor: 2 },
};
//  AN UNRECOGNISED VIEWPORT USED TO BE DROPPED IN SILENCE. The selection was a
// filter with no floor under it, so `--viewports mobil` (typo), `Mobile` (this
// table is case-sensitive) or `desktop, mobile` (space after the comma) left an
// EMPTY set, the capture loop below ran zero times, and the run still printed
//
//     requests observed: 0
//     MIRROR GAPS:       0
//
// over a netcapture.tsv containing nothing but its header. That is this pass's
// worst possible output: GAP=0 is the number the caller came for, and here it
// was computed over an empty observation. Same family as the UNDER-OBSERVED
// warning at the end — A COUNT COMPUTED OVER NOTHING OBSERVED READS AS A PASS —
// except nothing printed at all. A partial typo is fatal too: `desktop,mobil`
// silently captured desktop only and reported it as the whole matrix.
const VIEWPORT_KEYS = flag("viewports", "desktop,mobile").split(",").map((s) => s.trim()).filter(Boolean);
const UNKNOWN_VIEWPORTS = VIEWPORT_KEYS.filter((v) => !Object.hasOwn(VIEWPORT_DEFS, v));
if (!VIEWPORT_KEYS.length || UNKNOWN_VIEWPORTS.length) {
  console.error(
    `FATAL: --viewports ${UNKNOWN_VIEWPORTS.length ? `names no such viewport: ${UNKNOWN_VIEWPORTS.join(", ")}` : "is empty"}.\n` +
      `       known viewports: ${Object.keys(VIEWPORT_DEFS).join(", ")} (case-sensitive)\n` +
      `       Refusing to run: an empty viewport set captures nothing and reports GAP=0.`,
  );
  process.exit(2);
}
const VIEWPORTS = Object.fromEntries(VIEWPORT_KEYS.map((v) => [v, VIEWPORT_DEFS[v]]));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------

console.log(`[netcapture] cdp port ${CDP_LABEL}`);
// Orphans from a previous run get reported and reaped BEFORE the port check —
// one of them is the most likely occupant of this port.
await preflightChrome({ role: "netcapture", port: CDP_PORT, tool: "netcapture.mjs" });

const chromePath = await findChrome();
const sentinel = chromeSentinel();

// launchChrome owns --user-data-dir (fresh temp profile, deleted on teardown)
// and the reaping: detached process group, torn down on exit / SIGINT / SIGTERM
// / SIGHUP / uncaught exception. Nothing this script starts can outlive it.
const chrome = launchChrome({
  bin: chromePath,
  role: "netcapture",
  port: CDP_PORT,
  tool: "netcapture.mjs",
  stdio: "ignore",
  args: [
    `--remote-debugging-port=${CDP_PORT}`,
    "--headless=new",
    // Software GL is OPT-IN (--swiftshader), not the default. The flag makes
    // the page render headlessly on GPU-less machines, but it is also a
    // capability-detection input: a site that tiers on the GPU name will read
    // "SwiftShader", drop to its low tier, and you are then capturing a
    // different program than the one you are rebuilding (determinism.md §2.9,
    // environment-traps.md, capture timing). For capture specifically the risk is
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
    // One-shot landing page whose URL only this browser can be showing; the
    // ownership check below refuses to drive an endpoint that lacks it.
    sentinel.url,
  ],
});

// Ownership before protocol: connectCdp() would happily attach to whatever CDP
// endpoint answers on this port, and every request recorded through a foreign
// browser would be filed as this origin's traffic.
await assertOwnBrowser({ port: CDP_PORT, sentinel, tool: "netcapture.mjs", pid: chrome.pid });

// Every call is bounded (30s default). A route whose scene never finishes
// booting leaves Page.navigate / Runtime.evaluate pending forever, and an
// unbounded await wedges the whole capture on one page.
const cdp = await connectCdp(await cdpUrlFor(CDP_PORT, { attempts: 60 }), { defaultTimeoutMs: 30000, closeHint: null });

// requestId -> record, so the response event can complete what the request started
const inflight = new Map();
const requests = new Map(); // absolute url -> {path, status, type, bytes}
const consoleErrors = [];
const offHost = new Map(); // host -> count, for hosts not on the allow-list
// Unparseable request URLs. NOT swallowed silently: the page building a bad URL
// is a real finding about the source program and a candidate quirk-table entry.
const malformed = new Map();

cdp.on("*", (msg) => {
  const p = msg.params || {};
  if (msg.method === "Network.requestWillBeSent" && p.request?.url?.startsWith("http")) {
    // startsWith("http") is NOT a parseability test. The browser faithfully
    // reports a request the PAGE built badly, and one such URL used to take the
    // whole capture down with an uncaught TypeError — losing every route, not
    // just the bad request. A capture tool must survive its subject.
    // Field case: a tag manager built https://senses%20trackingscript.<host>/…
    // — a percent-encoded SPACE inside the hostname, 8x per session.
    let u;
    try {
      u = new URL(p.request.url);
    } catch {
      malformed.set(p.request.url, (malformed.get(p.request.url) || 0) + 1);
      return;
    }
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

for (const [name, vp] of Object.entries(VIEWPORTS)) {
  for (const route of ROUTES) {
    process.stdout.write(`  ${name} ${route} ... `);
    const before = requests.size;
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const send = (m, p, timeoutMs) => cdp.send(m, p, { sessionId, timeoutMs });

    await send("Network.enable");
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Network.setCacheDisabled", { cacheDisabled: true });
    await send("Emulation.setDeviceMetricsOverride", { ...vp, screenWidth: vp.width, screenHeight: vp.height });

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
    }, STEPS * DWELL + 45000).catch((e) => console.log(`[scroll] ${e.message}`));
    await sleep(4000);
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    console.log(`+${requests.size - before} new`);
  }
}
// Reap the whole process group (not just the browser process) and delete the
// temp profile — the disk diff below can take a while and there is no reason to
// hold 8 renderers open through it.
chrome.reap();

// --- Diff against what is on disk ------------------------------------------

// The same mapping the crawler wrote with and the server reads with — one
// module, loaded with the policy this mirror was written under, so the three
// cannot drift (scripts/lib/urlpath.mjs).
const QUERY_POLICY = await loadPolicy(ROOT);
console.log(`[urlpath] ${describePolicy(QUERY_POLICY)}`);
function localPathFor(absUrl) {
  return localRelPath(absUrl, ORIGIN_HOST, QUERY_POLICY);
}

const rows = [...requests.values()].sort((a, b) => a.path.localeCompare(b.path));
const missing = [];
for (const r of rows) {
  // 206 is a HIT, not a miss: <video>/<audio> arrive through Range requests,
  // and a URL the browser only ever fetched as 206 was dropped here — so media
  // served by Range never entered the GAP diff at all, whether or not the
  // crawler had it.
  if (r.status !== 200 && r.status !== 206) continue;
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
console.log(`already mirrored:  ${rows.filter((r) => r.status === 200 || r.status === 206).length - missing.length}`);
console.log(`MIRROR GAPS:       ${missing.length}`);
for (const m of missing) console.log(`  ${m.status} ${m.path}`);
if (offHost.size) {
  console.log(`\noff-list hosts seen (NOT recorded, decide each in the external table):`);
  for (const [h, n] of [...offHost].sort((a, b) => b[1] - a[1])) console.log(`  ${n}x ${h}`);
}
// A GAP=0 that was computed while most of the traffic went unobserved is worse
// than no answer, because it reads as a pass. Say so, explicitly, before the caller
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

if (malformed.size) {
  console.log(`\nmalformed request URL(s) the page issued — ${malformed.size} distinct:`);
  for (const [u, n] of malformed) console.log(`  x${n}  ${JSON.stringify(u).slice(0, 300)}`);
}

const fetched = [];
if (DO_FETCH && missing.length) {
  //  ONE MIRROR, ONE LEDGER. This used to write bytes and no ledger row, with
  // a note recommending mirror-site.mjs --seeds instead. The note was correct
  // and it did not help: a run of --fetch left files that verify-mirror reports
  // forever as "nobody can name a URL for", and a second ledger that records
  // URLs without the PATHS they were written to cannot be reconciled against
  // disk at all. Measured on eightdesign: 324 files, every one of them fetched
  // deliberately, none of which passes the file/ledger checks.
  //
  //  A tool that can leave the artefact in a state no gate accepts is a
  // footgun with a comment on it. Appending the row is fifteen lines.
  //  The ledger must be READABLE before the first byte lands. Bytes that hit
  // disk with no row are off the books from that moment: the next capture sees
  // HAVE for every one of them and nothing ever ledgers them. So a --fetch into
  // a mirror whose manifest cannot be read is refused up front, explicitly, with
  // nothing written.
  await ledgerOrExit();
  // Use the browser image Accept header on the standard profile. In basement D5,
  // a generic Accept header selected fallback formats on an auto=format CDN.
  // fetchLadder shares the crawler's profiles and records the selected profile
  // and Vary metadata. The minimal retry profile retains Accept: */* for servers
  // that reject the browser header set.
  console.log("\nfetching gaps... (bytes AND ledger rows)");
  for (const m of missing) {
    // m.path is an absolute URL (records are keyed by host + path).
    //  PER-URL TOLERANCE + PERIODIC LEDGERING. The first version had neither:
    // one thrown fetch (DNS, TLS, reset) aborted the WHOLE loop before
    // appendLedger ever ran, stranding every file already written as
    // off-the-books state — the exact condition appendLedger's own comment
    // promises to prevent, one failure mode over. Measured on rauchg: 725
    // /_next/image variants on disk, zero in the manifest.
    // This loop has always FOLLOWED redirects (a gap the browser resolved is
    // fetched to its final bytes); fetchLadder's default is manual, so say so.
    const { res, profile: usedProfile, error: lastErr } = await fetchLadder(m.path, { origin: ORIGIN, typeHint: m.type, redirect: "follow" });
    if (!res || !res.ok) {
      console.log(`  FAIL ${lastErr} ${m.path}`);
      continue;
    }
    const rel = localPathFor(m.path);
    const out = path.join(ROOT, rel);
    const body = Buffer.from(await res.arrayBuffer());
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, body);
    //  Carry the DECLARED TYPE into the ledger. serve.mjs answers extensionless
    // paths (Nuxt server routes) with the manifest's recorded type; a row
    // without one gets extension-guessed into text/html, and ofetch — which
    // parses by content-type — hands the app a string where it awaited JSON.
    fetched.push({ path: rel, url: m.path, bytes: body.length, sha256: sha256(body),
      type: res.headers.get("content-type") || "",
      profile: usedProfile, vary: res.headers.get("vary") || "" });
    console.log(`  OK ${m.path}`);
    if (fetched.length % 100 === 0) await appendLedger(fetched.splice(0, fetched.length));
  }
  await appendLedger(fetched);
}

/**
 * Record fetched files in both mirror-manifest.json and inventory.tsv. The
 * manifest maps URLs to path, bytes, SHA-256 and response type; the inventory
 * stores SHA256, BYTES, PATH and URL columns. Existing entries are retained.
 *
 * An inventory-only update leaves files absent from the verifier's manifest
 * and loses those inventory rows when a later crawl rewrites both records.
 * Updating both formats keeps supplementary capture consistent with the crawl.
 */
async function appendLedger(rows) {
  if (!rows.length) return;
  // BOTH ledgers. The first version appended inventory.tsv only;
  // mirror-manifest.json is the authority verify-mirror audits, so every
  // --fetch left files the manifest could not name - the same off-the-books
  // state this function was added to prevent, one ledger over. Worse: any later
  // mirror-site run rewrites both ledgers from the manifest, so rows that only
  // ever reached inventory.tsv are silently dropped again.
  //
  //  MANIFEST FIRST, INVENTORY SECOND, and a manifest that cannot be read is
  // FATAL before inventory.tsv is touched — so the two ledgers can never
  // disagree about one batch (both carry its rows, or neither does). This was a
  // bare `catch {}`: a missing or corrupt manifest silently skipped the write
  // and produced exactly the off-the-books state described above.
  const mf = await ledgerOrExit();
  let n = 0;
  for (const r of rows) {
    if (mf.files[r.url]) continue;
    // Same row shape mirror-site.mjs's save() writes: profile + Vary on record,
    // or a negotiated response is indistinguishable from a plain one.
    mf.files[r.url] = { path: r.path, bytes: r.bytes, sha256: r.sha256, ...(r.type ? { type: r.type } : {}),
      ...(r.profile ? { profile: r.profile } : {}), ...(r.vary ? { vary: r.vary } : {}) };
    n++;
  }
  if (n) await writeManifest(ROOT, mf);
  // appendInventory skips paths already recorded and creates the header if the
  // file is absent (lib/ledger.mjs — the crawler's row format, not a second one).
  const add = await appendInventory(ROOT, rows);
  if (!add.length) return void console.log(`  ledger — all ${rows.length} path(s) already recorded`);
  console.log(`  ledger — ${add.length} row(s) appended to ${path.relative(process.cwd(), path.join(ROOT, INVENTORY_FILE))}`);
}

/** The mirror's ledger, or an explicit error exit — never a silent skip (see appendLedger). */
async function ledgerOrExit() {
  let mf = null, why = "";
  // lib/ledger.mjs: null when the file is absent, throws when it exists but is
  // not a manifest — both are fatal here, for the reason appendLedger gives.
  try { mf = await readManifest(ROOT); } catch (e) { why = e.message; }
  if (mf) return mf;
  console.error(`FATAL: cannot read ${MANIFEST_FILE}: ${why || "no such file"}`);
  console.error(`       --fetch appends to the mirror's ONE ledger; without it every fetched file is off the books`);
  console.error(`       (files landed since the last ledger write, if any, are on disk unrecorded — verify-mirror lists them as orphans).`);
  process.exit(1);
}
