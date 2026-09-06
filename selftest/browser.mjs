#!/usr/bin/env node
// selftest/browser.mjs — the BROWSER lane: `npm run test:browser`.
//
// The offline lane (run.mjs) proves the gates' pure logic and, since v0.3.20,
// that every offline gate goes RED on bad input. It cannot say that about the
// gates the skill's headline claim rests on — pixelcompare's 0.00, probe's
// CLEAN — because they exist only with a real browser behind them. v0.3.18
// rewrote the CDP floor under all of them (lib/cdp.mjs) with no verdict test
// in reach. This lane launches a real headless Chrome against loopback
// fixtures served by serve.mjs and drives those gates to their verdicts:
// green as shipped, red on one deliberate defect, and the identity refusals
// (same process twice, wrong side) that guard against the invisible 假绿.
//
// Fixtures are flat colour grids: 128 solid cells at integer pixel bounds, no
// text, no fonts, no animation — so two renders of the same HTML in the same
// Chrome are byte-identical (the determinism the pixel gate itself relies on),
// and a recoloured cell is a measurable, reproducible difference.
//
// Needs Chrome/Chromium on the machine (lib/chrome.mjs findChrome); without one
// it is FATAL 5, never a silent pass. Runs in its own CI job. ~30–60 s.
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
const cell = (i, hue) => `<div style="position:absolute;left:${(i % 16) * 80}px;top:${Math.floor(i / 16) * 100}px;width:80px;height:100px;background:hsl(${hue},70%,50%)"></div>`;
const grid = (recolour = {}) => {
  let cells = "";
  for (let i = 0; i < 128; i++) cells += cell(i, recolour[i] ?? (i * 137) % 360);
  return `<!doctype html><html><head><meta charset="utf-8"><title>fx</title></head><body style="margin:0;width:1280px;height:800px;overflow:hidden;background:#000">${cells}</body></html>`;
};
const blank = `<!doctype html><html><body style="margin:0;background:#3355aa"><div style="position:absolute;left:10px;top:10px;width:100px;height:100px;background:#fff"></div></body></html>`;
const PA = 29980, PB = 29981;
const A = W(path.join(TMP, "a"), {
  "index.html": grid(),
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
  eq("pixelcompare — …and metric.json records meanAbsDiff 0 (v0.3.22)", metric(path.join(TMP, "px-same"), "same")?.meanAbsDiff, 0);

  const diff = px("diff", ["--a", `${SA.base}/diff.html`, "--b", `${SB.base}/diff.html`, "--max-mean", "0"]);
  red("pixelcompare — one recoloured cell under --max-mean 0 goes red and prints the number (v0.3.22)", diff, /GATE FAIL: meanAbsDiff [\d.]+ > 0/);
  truthy("pixelcompare — …and the measured difference is above zero (v0.3.22)", (metric(path.join(TMP, "px-diff"), "diff")?.meanAbsDiff ?? 0) > 0, JSON.stringify(metric(path.join(TMP, "px-diff"), "diff")));

  red("pixelcompare — the same URL on both sides is refused, exit 3: one process measured twice is the invisible 假绿 (v0.3.22)",
    px("twice", ["--a", `${SA.base}/`, "--b", `${SA.base}/`]), /same|identity|origin|token/i, 3);

  red("pixelcompare — two blank frames refuse to compare, exit 5: a perfect 0 over nothing is not a result (v0.3.22)",
    px("blank", ["--a", `${SA.base}/blank.html`, "--b", `${SB.base}/blank.html`]), /blank|empty|colou?rs|dominant|空/i, 5);

  // the same URL twice was refused above; declared as a band sample it is the run §1.3.2 mandates
  const band = px("band", ["--a", `${SA.base}/`, "--b", `${SA.base}/`, "--self", "--max-mean", "0"]);
  green("pixelcompare — the same URL twice under --self is allowed: a BAND SAMPLE, tagged as such (v0.3.22)", band, /BAND SAMPLE, NOT A VERDICT/);
  truthy("pixelcompare — …--max-mean is ignored under --self: a band sample is not a gate result (v0.3.22)", /ignored under --self/.test(band.out), band.out.slice(-200));
  eq("pixelcompare — …the band file is kind self-band (v0.3.22)", JSON.parse(readFileSync(path.join(TMP, "px-band/metric.json"), "utf8")).kind, "self-band");

  // ---------------------------------------------------------------- probe
  green("probe — a clean page is CLEAN, exit 0 (v0.3.22)", probe(`${SA.base}/`), /CLEAN/);
  red("probe — one 404 image goes red and is named (v0.3.22)", probe(`${SA.base}/404.html`), /404[\s\S]*missing\.png/);
  red("probe — a console.error goes red and the message is echoed (v0.3.22)", probe(`${SA.base}/error.html`), /boom from the page/);
  green("probe — a request that leaves the origin and succeeds is CLEAN without --no-external (v0.3.22)", probe(`${SA.base}/outbound.html`), /CLEAN/);
  red("probe — the same request under --no-external goes red: zero outbound is asserted, not assumed (v0.3.22)", probe(`${SA.base}/outbound.html`, ["--no-external"]), /external|outbound|ping\.txt/i);
  red("probe — --expect-side mirror against the rebuild server is FATAL 3 and says which side answered (v0.3.22)", probe(`${SA.base}/`, ["--expect-side", "mirror"]), /answers as side REBUILD/, 3);
  green("probe — --expect-side rebuild against the rebuild server passes (v0.3.22)", probe(`${SA.base}/`, ["--expect-side", "rebuild"]), /CLEAN/);

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
} catch (e) { bad("browser lane", String(e.stack || e.message).split("\n").slice(0, 3).join(" | ")); }
finally { await SA.stop(); await SB.stop(); }

finish(TMP);
