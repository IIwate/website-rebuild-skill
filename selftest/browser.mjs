#!/usr/bin/env node
// Browser regression suite: npm run test:browser.
// Runs Chrome against loopback fixtures to check pixel comparisons, error reports,
// instance identity, request capture and SPA navigation. Valid and defective inputs
// exercise success, failure and unmet-precondition results.
//
// Pixel fixtures use 128 solid cells at integer bounds without fonts or animation,
// so a changed cell produces a measurable difference. Navigation fixtures check
// trusted input, storage isolation and route/text stability.
//
// Requires a local Chrome/Chromium installation; absence exits 5.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { SKILL, scratch, ok, bad, eq, truthy, finish, run, green, red, W, serveOn } from "./harness.mjs";

const TMP = scratch(".tmp-browser");
const { findChrome } = await import(path.join(SKILL, "scripts/lib/chrome.mjs"));
const chrome = await findChrome();
if (!chrome) {
  console.error("FATAL — no Chrome/Chromium found (lib/chrome.mjs CHROME_CANDIDATES). This lane needs a browser; the offline lane is `npm test`.");
  process.exit(5);
}
console.log(`browser lane — ${chrome}\n`);

// ---------------------------------------------------------------- fixtures
const cell = (i, hue, offset = 0) => `<div style="position:absolute;left:${(i % 16) * 80}px;top:${Math.floor(i / 16) * 100 + offset}px;width:80px;height:100px;background:hsl(${hue},70%,50%)"></div>`;
const grid = (recolour = {}) => {
  let cells = "";
  for (let i = 0; i < 128; i++) cells += cell(i, recolour[i] ?? (i * 137) % 360);
  return `<!doctype html><html><head><meta charset="utf-8"><title>fx</title></head><body style="margin:0;width:1280px;height:800px;overflow:hidden;background:#000">${cells}</body></html>`;
};
const blank = `<!doctype html><html><body style="margin:0;background:#3355aa"><div style="position:absolute;left:10px;top:10px;width:100px;height:100px;background:#fff"></div></body></html>`;
const tall = grid().replace("height:800px;overflow:hidden", "height:2400px").replace("</body>",
  Array.from({ length: 96 }, (_, i) => cell(i, (i * 131) % 360, 1600)).join("") +
  `<script>window.__restorationAtInit=history.scrollRestoration;</script></body>`);
const PA = 29980, PB = 29981;
const A = W(path.join(TMP, "a"), {
  "index.html": grid(), "tall.html": tall,
  "diff.html": grid(),
  "blank.html": blank,
  "404.html": grid() + `<img src="/missing.png">`,
  "error.html": grid() + `<script>console.error("boom from the page")</script>`,
  "outbound.html": grid() + `<script>fetch("http://127.0.0.1:${PB}/ping.txt", { mode: "no-cors" }).catch(() => {})</script>`,
  "capture-one.html": `<html><script>window.name = "previous-route"</script></html>`,
  "capture-two.html": `<html><script>fetch(window.name ? "/capture-leaked.json" : "/capture-fresh.json")</script></html>`,
  "capture-fresh.json": JSON.stringify({ state: "fresh" }),
  "capture-leaked.json": JSON.stringify({ state: "leaked" }),
  "favicon.ico": "\x00\x00\x01\x00", // Chrome asks for it unprompted; a root without one is a 404 the probe rightly counts
});
const Bdir = W(path.join(TMP, "b"), { "index.html": grid(), "diff.html": grid({ 0: 200 }), "blank.html": blank, "ping.txt": "ok", "favicon.ico": "\x00\x00\x01\x00" });

W(A, { "navigation.html": `<!doctype html><html><head><link rel="icon" href="data:,"></head><body>
<a data-link="reader's" href="/about">About</a><main>Home</main><script>
const clean = !window.name && !localStorage.getItem('case') && !document.cookie.includes('case=1');
window.name = 'previous-case'; localStorage.setItem('case', '1'); document.cookie = 'case=1';
window.requestAnimationFrame = () => { console.error('Unexpected injected animation loop'); return 0; };
document.querySelector('a').addEventListener('click', (event) => {
  event.preventDefault();
  if (!event.isTrusted) { console.error('Click was not trusted'); return; }
  const mode = new URLSearchParams(location.search).get('mode');
  history.pushState({}, '', mode === 'prefix' ? '/about-extra' : '/about');
  document.querySelector('main').textContent = 'About Trusted ' + (clean ? 'Clean' : 'Leaked');
  if (mode === 'redirect') setTimeout(() => history.pushState({}, '', '/elsewhere'), 250);
});
</script></body></html>` });

// a = the rebuild, b = the mirror: pixelcompare's default labels, and the sides the servers declare
const SA = await serveOn(PA, A, ["--side", "rebuild"]);
const SB = await serveOn(PB, Bdir, ["--side", "mirror"]);
const metric = (out, name) => { const f = path.join(out, "metric.json"); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8"))?.[name] : null; };
const px = (name, extra) => run("scripts/pixelcompare.mjs", ["--name", name, "--out", path.join(TMP, "px-" + name), "--settle", "300", ...extra]);
const probe = (url, extra = []) => run("scripts/probe.mjs", [url, "--wait", "500", ...extra]);

try {
  // ---------------------------------------------------------------- pixelcompare
  const same = px("same", ["--a", `${SA.base}/`, "--b", `${SB.base}/`]);
  green("pixelcompare — the same page from two processes measures 0.00 (v0.3.22)", same, /./);
  truthy("pixelcompare — …and the run names its instrument: seed/ready/drive fingerprints + cold-cache (v0.3.23)", /\[pixel\] instrument — seed none · ready none · drive none · cold-cache/.test(same.out), same.out.slice(0, 300));
  eq("pixelcompare — …and metric.json records meanAbsDiff 0 (v0.3.22)", metric(path.join(TMP, "px-same"), "same")?.meanAbsDiff, 0);

  const diff = px("diff", ["--a", `${SA.base}/diff.html`, "--b", `${SB.base}/diff.html`, "--max-mean", "0"]);
  red("pixelcompare — one recoloured cell under --max-mean 0 goes red and prints the number (v0.3.22)", diff, /GATE FAIL: meanAbsDiff [\d.]+ > 0/);
  truthy("pixelcompare — …and the measured difference is above zero (v0.3.22)", (metric(path.join(TMP, "px-diff"), "diff")?.meanAbsDiff ?? 0) > 0, JSON.stringify(metric(path.join(TMP, "px-diff"), "diff")));

  red("pixelcompare - rejects the same URL on both sides with exit 3",
    px("twice", ["--a", `${SA.base}/`, "--b", `${SA.base}/`]), /same|identity|origin|token/i, 3);

  red("pixelcompare — two blank frames refuse to compare, exit 5: a perfect 0 over nothing is not a result (v0.3.22)",
    px("blank", ["--a", `${SA.base}/blank.html`, "--b", `${SB.base}/blank.html`]), /blank|empty|colou?rs|dominant/i, 5);

  // the same URL twice was refused above; declared as a band sample it is the run §1.3.2 mandates
  const band = px("band", ["--a", `${SA.base}/`, "--b", `${SA.base}/`, "--self", "--max-mean", "0"]);
  green("pixelcompare — the same URL twice under --self is allowed: a BAND SAMPLE, tagged as such (v0.3.22)", band, /BAND SAMPLE, NOT A VERDICT/);
  truthy("pixelcompare — …--max-mean is ignored under --self: a band sample is not a gate result (v0.3.22)", /ignored under --self/.test(band.out), band.out.slice(-200));
  eq("pixelcompare — …the band file is kind self-band (v0.3.22)", JSON.parse(readFileSync(path.join(TMP, "px-band/metric.json"), "utf8")).kind, "self-band");

  // A cacheable resource must reach the fixture server once per capture.
  {
    const { createServer } = await import("node:http");
    const { execFile } = await import("node:child_process");
    let assetRequests = 0;
    const cacheServer = createServer((req, res) => {
      if (req.url === "/cached.js") {
        assetRequests++;
        res.writeHead(200, { "content-type": "text/javascript", "cache-control": "public, max-age=3600" });
        return res.end("window.__cacheReady=true;");
      }
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(grid().replace("</head>", '<script src="/cached.js"></script></head>'));
    });
    await new Promise((resolve) => cacheServer.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${cacheServer.address().port}/`;
    try {
      const result = await new Promise((resolve) => execFile(process.execPath, [path.join(SKILL, "scripts/pixelcompare.mjs"), "--a", url, "--b", url,
        "--self", "--settle", "300", "--ready", "window.__cacheReady===true", "--name", "cache", "--out", path.join(TMP, "px-cache")],
        { timeout: 40000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: String(stdout) + String(stderr) })));
      truthy("pixelcompare - both same-origin captures fetch cacheable assets independently", result.code === 0 && assetRequests === 2,
        `requests=${assetRequests}, exit=${result.code}: ${result.out.slice(-400)}`);
    } finally { await new Promise((resolve) => cacheServer.close(resolve)); }
  }

  // Both checkpoints contain nonblank, distinct content. The requested second
  // scroll fits inside the pump budget even when readiness is reached early.
  const walk = (name, extra) => run("scripts/pixel-walk.mjs", ["--steps", "2", "--pump", "16.7,30", "--rescroll-ms", "0", "--settle", "100", "--format", "png", "--out", path.join(TMP, "walk-" + name), "--self", ...extra]);
  const seeded = walk("seeded", ["--a", `${SA.base}/tall.html`, "--b", `${SA.base}/tall.html`, "--seed", "window.__s=1 // trailing comment",
    "--ready", "window.__s===1 && window.__restorationAtInit==='manual' && getComputedStyle(document.body).animationPlayState==='paused'", "--freeze-css", "--after-ready", "3", "--chunk", "1"]);
  green("pixel-walk - forwards seed and capture options while disabling scroll restoration before initialization", seeded, /ready after 1 pumped frame\(s\).*then \+3 frame\(s\)/);
  red("pixel-walk — …and without the seed the same --ready never fires: the pass above came from the forwarded seed (v0.3.23)",
    walk("unseeded", ["--a", `${SA.base}/tall.html`, "--b", `${SA.base}/tall.html`, "--ready", "window.__s===1"]), /never satisfied --ready|FAIL/, 5);
  red("pixelcompare — a --drive that records no landing exits 6 and names the contract: window.__walkScroll (v0.3.23)",
    px("nodrive", ["--a", `${SA.base}/`, "--b", `${SB.base}/`, "--pump", "16.7,5", "--drive", "1"]), /window\.__walkScroll/, 6);

  red("pixelcompare — a --ready that never fires exits 6 and prints the reason the predicate left in window.__why (v0.3.23)",
    px("why", ["--a", `${SA.base}/`, "--b", `${SB.base}/`, "--pump", "16.7,5", "--ready", "(window.__why='waiting on hero.jpg', false)"]), /window\.__why: waiting on hero\.jpg/, 6);

  const sweepReport = path.join(TMP, "reports/nested/routes.tsv");
  const sweep = run("scripts/sweep-routes.mjs", ["--base", SA.base, "--routes", "/", "--wait", "150", "--out", sweepReport]);
  truthy("sweep-routes - creates the output directory and writes route results", sweep.code === 0 && existsSync(sweepReport) &&
    /^ROUTE\tVERDICT/.test(readFileSync(sweepReport, "utf8")) && readFileSync(sweepReport, "utf8").includes("\n/\t"), sweep.out.slice(-300));

  // ---------------------------------------------------------------- probe
  green("probe — a clean page is CLEAN, exit 0 (v0.3.22)", probe(`${SA.base}/`), /CLEAN/);
  red("probe — one 404 image goes red and is named (v0.3.22)", probe(`${SA.base}/404.html`), /404[\s\S]*missing\.png/);
  red("probe — a console.error goes red and the message is echoed (v0.3.22)", probe(`${SA.base}/error.html`), /boom from the page/);
  green("probe — a request that leaves the origin and succeeds is CLEAN without --no-external (v0.3.22)", probe(`${SA.base}/outbound.html`), /CLEAN/);
  red("probe — the same request under --no-external goes red: zero outbound is asserted, not assumed (v0.3.22)", probe(`${SA.base}/outbound.html`, ["--no-external"]), /external|outbound|ping\.txt/i);
  red("probe — --expect-side mirror against the rebuild server is FATAL 3 and says which side answered (v0.3.22)", probe(`${SA.base}/`, ["--expect-side", "mirror"]), /answers as side REBUILD/, 3);
  green("probe — --expect-side rebuild against the rebuild server passes (v0.3.22)", probe(`${SA.base}/`, ["--expect-side", "rebuild"]), /CLEAN/);
  const seededProbe = probe(`${SA.base}/`, ["--settle", "500", "--seed", "window.__seeded = 7", "--eval", "window.__seeded"]);
  green("probe — --seed runs before the document and --settle equal to --wait is accepted", seededProbe, /EVAL: 7[\s\S]*CLEAN/);

  const captured = W(path.join(TMP, "captured"), {
    "mirror-manifest.json": JSON.stringify({ origin: SA.base, files: {} }),
  });
  const capture = run("scripts/netcapture.mjs", ["--origin", SA.base, "--mirror", captured,
    "--routes", "/capture-one.html,/capture-two.html", "--viewports", "desktop",
    "--steps", "0", "--settle", "100", "--fetch"], { timeout: 45000 });
  green("netcapture — per-route sessions work through the shared CDP client", capture, /requests observed:/);
  const files = JSON.parse(readFileSync(path.join(captured, "mirror-manifest.json"), "utf8")).files;
  truthy("netcapture — window state from a previous route cannot change the next route's assets",
    !!files[`${SA.base}/capture-fresh.json`] && !files[`${SA.base}/capture-leaked.json`]);
  eq("netcapture — fetched ledger rows retain the declared content-type parameters",
    files[`${SA.base}/capture-fresh.json`]?.type, "application/json; charset=utf-8");

  const navigationCase = { name: "trusted navigation", startPath: "/navigation.html", linkSelector: 'a[data-link="reader\'s"]', expectedPath: "/about", expectedSelector: "main", expectedTexts: ["About   Trusted", "Clean"], stabilityMs: 450, timeoutMs: 1800 };
  const navigation = (name, cases) => {
    const config = path.join(TMP, `${name}.mjs`);
    W(TMP, { [`${name}.mjs`]: `export default ${JSON.stringify({ base: SA.base, cases })};\n` });
    return run("assets/templates/verify-spa-navigation.mjs", ["--config", config], { timeout: 30000 });
  };
  green("SPA navigation - trusted input, quoted selectors and per-case storage isolation",
    navigation("navigation", [navigationCase, { ...navigationCase, name: "isolated second case" }]));
  red("SPA navigation - a path prefix is not the expected route",
    navigation("navigation-prefix", [{ ...navigationCase, startPath: "/navigation.html?mode=prefix" }]), /Target state not reached/);
  red("SPA navigation - every expected text snippet is required",
    navigation("navigation-text", [{ ...navigationCase, expectedTexts: ["About", "Missing text"] }]), /Target state not reached/);
  red("SPA navigation - route changes during the stability window fail",
    navigation("navigation-redirect", [{ ...navigationCase, startPath: "/navigation.html?mode=redirect" }]), /Target state changed during stability window/);
} catch (e) { bad("browser lane", String(e.stack || e.message).split("\n").slice(0, 3).join(" | ")); }
finally { await SA.stop(); await SB.stop(); }

finish(TMP);
