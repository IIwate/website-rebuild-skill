#!/usr/bin/env node
/**
 * Compare built HTML documents with the declared shell transformations.
 * Checks differing line ranges against the transform table without rewriting the
 * artifact under test. Unexplained differences fail and require investigation or
 * an explicitly recorded adaptation.
 *
 * The shell configuration is shared data. Importing the build entry itself once
 * executed a build before checking it: on two projects an injected byte vanished
 * and the check passed. Keeping the producer out of this process preserves the
 * on-disk input, though a shared transform definition can still have shared errors.
 *
 * node scripts/verify-shell.mjs --config scripts/shell-config.mjs
 *  node scripts/verify-shell.mjs [--config scripts/shell-config.mjs] [--mirror mirror] [--site site] [--max-report 8]
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { transformPage, noindexBlock } from "./lib/shell-build.mjs";
import { cli } from "./lib/cli.mjs";

cli({ known: ["config", "mirror", "site", "max-report"], file: import.meta.url });

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf("--" + n);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};
const CONFIG = flag("config", "scripts/shell-config.mjs");
const MIRROR = path.resolve(flag("mirror", "mirror"));
const SITE = path.resolve(flag("site", "site"));
const MAX_REPORT = Number(flag("max-report", 8));

const cfg = (await import(pathToFileURL(path.resolve(CONFIG)).href)).default;
const PAGES = cfg.pages || [];

let failures = 0;
const fail = (g, m) => (failures++, console.log(`  FAIL ${g} — ${m}`));
const ok = (g, m) => console.log(`  ok   ${g} — ${m}`);

// A minimal patience diff: anchors are lines occurring exactly once on both
// sides; between anchors we recurse, and a range with no unique anchor becomes
// one hunk. Zero dependencies, like every gate in this toolchain.
function uniqueAnchors(a, b, a0, a1, b0, b1) {
  const countIn = (arr, lo, hi) => {
    const m = new Map();
    for (let i = lo; i < hi; i++) m.set(arr[i], (m.get(arr[i]) || 0) + 1);
    return m;
  };
  const ca = countIn(a, a0, a1), cb = countIn(b, b0, b1);
  const posB = new Map();
  for (let j = b0; j < b1; j++) if (cb.get(b[j]) === 1) posB.set(b[j], j);
  const pairs = [];
  for (let i = a0; i < a1; i++) if (ca.get(a[i]) === 1 && posB.has(a[i])) pairs.push([i, posB.get(a[i])]);
  const tails = [], from = [], idx = [];
  for (let k = 0; k < pairs.length; k++) {
    const v = pairs[k][1];
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < v) lo = mid + 1; else hi = mid; }
    tails[lo] = v; idx[lo] = k; from[k] = lo > 0 ? idx[lo - 1] : -1;
  }
  const seq = [];
  let k = tails.length ? idx[tails.length - 1] : -1;
  while (k >= 0) { seq.push(pairs[k]); k = from[k]; }
  return seq.reverse();
}

function diffHunks(a, b) {
  const hunks = [];
  const rec = (a0, a1, b0, b1) => {
    while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) { a0++; b0++; }
    while (a1 > a0 && b1 > b0 && a[a1 - 1] === b[b1 - 1]) { a1--; b1--; }
    if (a0 === a1 && b0 === b1) return;
    const anchors = uniqueAnchors(a, b, a0, a1, b0, b1);
    if (!anchors.length) return void hunks.push({ a0, a1, b0, b1 });
    let pa = a0, pb = b0;
    for (const [ai, bi] of anchors) { rec(pa, ai, pb, bi); pa = ai + 1; pb = bi + 1; }
    rec(pa, a1, pb, b1);
  };
  rec(0, a.length, 0, b.length);
  return hunks;
}

console.log(`=== verify-shell  ${path.relative(process.cwd(), SITE)} vs ${path.relative(process.cwd(), MIRROR)} ===\n`);
console.log(`--- gate HUNKS (every difference must be a registered transform) ---`);

let hunkTotal = 0;
const unexplained = [];
const useCount = new Map();

for (const page of PAGES) {
  const A = (await readFile(path.join(MIRROR, page.rel), "utf8")).split("\n");
  const B = (await readFile(path.join(SITE, page.rel), "utf8")).split("\n");
  for (const h of diffHunks(A, B)) {
    hunkTotal++;
    const aText = A.slice(h.a0, h.a1).join("\n");
    const bText = B.slice(h.b0, h.b1).join("\n");
    let used = null;
    for (const head of [false, true]) {
      const r = transformPage(aText, cfg, { head });
      if (r.text === bText) { used = [...r.hits.keys()]; break; }
    }
    // Patience diff can anchor an insertion on different neighboring lines.
    // Observed noindex hunks used an empty reference side, the head tag or the line
    // after it. Remove the exact inserted prefix from the site hunk, then verify
    // the remainder against the configured transforms.
    if (!used && cfg.notice) {
      const block = noindexBlock(cfg);
      for (const b of [block, block.replace(/\n$/, "")]) {
        if (!bText.startsWith(b)) continue;
        const rest = bText.slice(b.length).replace(/^\n/, "");
        const r = transformPage(aText, cfg, { head: false });
        if (r.text === rest || aText === rest) { used = ["T-NOINDEX", ...r.hits.keys()]; break; }
      }
    }
    if (used) for (const u of used) useCount.set(u, (useCount.get(u) || 0) + 1);
    else unexplained.push({ page: page.rel, a: aText.slice(0, 200), b: bText.slice(0, 200) });
  }
}

if (unexplained.length) {
  fail("hunks", `${unexplained.length} of ${hunkTotal} differing hunk(s) are NOT reproducible by the transform table. Each is an unregistered deviation until it gets a §6 entry or is fixed:`);
  for (const u of unexplained.slice(0, MAX_REPORT)) {
    console.log(`         ${u.page}\n           mirror: ${JSON.stringify(u.a)}\n           site:   ${JSON.stringify(u.b)}`);
  }
} else {
  ok("hunks", `all ${hunkTotal} differing hunk(s) replay from the transform table`);
  console.log(`       used: ${[...useCount].sort().map(([k, n]) => `${k}=${n}`).join("  ")}`);
}

// Optional: the rebuild must run OUR build of the behaviour, not the source
// site's own file. Configure with `portSubstitution: {mustNotMatch, mustMatch}`.
const ps = cfg.portSubstitution;
if (ps) {
  console.log(`\n--- gate PORT-SUBSTITUTION (the rebuild must run OUR build of the behaviour) ---`);
  let leaks = 0, hitsN = 0;
  for (const page of PAGES) {
    const B = await readFile(path.join(SITE, page.rel), "utf8");
    if (ps.mustNotMatch && new RegExp(ps.mustNotMatch).test(B)) { leaks++; console.log(`         ${page.rel} still references the source site's own bundle`); }
    if (ps.mustMatch && new RegExp(ps.mustMatch).test(B)) hitsN++;
  }
  if (leaks) fail("port-substitution", `${leaks} shell(s) still load the source site's own bundle — every downstream gate would be comparing that file with itself`);
  else if (ps.mustMatch && hitsN !== PAGES.length) fail("port-substitution", `only ${hitsN}/${PAGES.length} shells load our build`);
  else ok("port-substitution", `${hitsN}/${PAGES.length} shells load our build, none load the source site's`);
}

console.log(
  failures
    ? `\nFAIL — ${failures} problem(s). The shell is the source program on a strategy-A target: an unexplained byte is an unregistered edit to it.`
    : `\nPASS — 0 problem(s).`,
);
process.exit(failures ? 1 : 0);
