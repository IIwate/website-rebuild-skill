#!/usr/bin/env node
/**
 * Compare served static HTML with a fresh Next build, then restore .next.
 * Requires deterministic build inputs, including a stable generateBuildId.
 * Hashes existing route HTML, saves .next, builds, compares prerendered HTML,
 * and restores the saved output. Optimized images are outside this comparison.
 * Equal timestamps are not used as evidence of matching source and output.
 * Based on the darkroom build verification workflow.
 */
import { readdir, mkdtemp, rm, cp } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cli } from "../scripts/lib/cli.mjs";
import { sha256File } from "../scripts/lib/hash.mjs";
cli({ known: ["app", "site"], file: import.meta.url });
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const APP = flag("app", "rebuild"), SITE = flag("site", join(APP, "static-site"));
async function* walk(d, base = d) {
  for (const e of await readdir(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) yield* walk(p, base); else yield p.slice(base.length + 1);
  }
}
const before = new Map();
// Compare route HTML only; optimized image variants under _next/ are outside this check.
for await (const f of walk(SITE)) if (f.endsWith(".html") && !f.startsWith("_next/")) before.set(f, await sha256File(join(SITE, f)));
const chunksBefore = new Set((await readdir(join(APP, ".next/static/chunks"))).filter((f) => f.endsWith(".js")));
console.log(`static-site HTML files: ${before.size}; chunks: ${chunksBefore.size}`);
const tmp = await mkdtemp(join(tmpdir(), "fresh-next-"));
await cp(join(APP, ".next"), join(tmp, "next-before"), { recursive: true });
let buildErr = null;
try { execFileSync("npm", ["run", "build"], { cwd: APP, stdio: "pipe" }); } catch (e) { buildErr = e; }
let same = 0, diff = [];
if (!buildErr) {
  for (const [f, h] of before) {
    const built = f === "index.html" ? "index.html" : f.replace(/\/index\.html$/, ".html");
    const p = join(APP, ".next/server/app", built);
    try { if ((await sha256File(p)) === h) same++; else diff.push(f); } catch { diff.push(f + " (missing)"); }
  }
}
const chunksAfter = buildErr ? chunksBefore : new Set((await readdir(join(APP, ".next/static/chunks"))).filter((f) => f.endsWith(".js")));
const chunkDelta = [...chunksAfter].filter((c) => !chunksBefore.has(c)).length + [...chunksBefore].filter((c) => !chunksAfter.has(c)).length;
// Restore the saved .next output so the checked build does not replace served artifacts.
await rm(join(APP, ".next"), { recursive: true, force: true });
await cp(join(tmp, "next-before"), join(APP, ".next"), { recursive: true });
await rm(tmp, { recursive: true, force: true });
if (buildErr) { console.log(`FAIL — next build failed: ${String(buildErr.stderr || buildErr.message).split("\n")[0]}`); process.exit(1); }
console.log(`HTML byte-identical: ${same}/${before.size}; chunk-set delta: ${chunkDelta}`);
if (diff.length) { console.log("  stale:", diff.slice(0, 8).join(", ")); console.log("FAIL — static-site is not what src builds now; run assemble-static + harvest after every build"); process.exit(1); }
console.log("PASS — static-site == fresh build of src (HTML bytes), chunk set stable");
