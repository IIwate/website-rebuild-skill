#!/usr/bin/env node
/**
 * closure.mjs — transitive dependency closure of a set of seed modules.
 *
 * ⛔ An unknown seed id is FATAL, not skipped. Silently filtering ids the map
 * does not know turns a typo into a smaller-but-plausible slice: the closure
 * still prints a sensible module count, the slicer still succeeds, and the
 * failure surfaces much later as `Cannot read properties of undefined` at run
 * time. Measured — an id transcribed from a TRUNCATED diagnostic line
 * (`048cb669e0` for `048cb669e0708ebf9629`) was dropped without a word.
 *
 * ⚠ Which is also why the tools print full ids now. A diagnostic that truncates
 * an identifier invites it to be copied back in truncated.
 *
 *   node scripts/closure.mjs --seed <id>[,<id>...] [--map docs/module-map.json] [--out docs/slice-closure.json]
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const MAP = path.resolve(flag("map", "docs/module-map.json"));
const OUT = path.resolve(flag("out", "docs/slice-closure.json"));
const seed = (flag("seed", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
if (!seed.length) { console.error("usage: closure.mjs --seed <id>[,<id>...]"); process.exit(2); }

const map = JSON.parse(await readFile(MAP, "utf8"));
// ⚠ Ids are not always strings: an array-style webpack container gives numeric
// indices, and the object-style one gives hashes. Normalise before comparing,
// or `id.startsWith` throws on the first numeric id it meets.
const idOf = (m) => String(m.id);
const byId = new Map(map.modules.map((m) => [idOf(m), m]));

const unknownSeeds = seed.filter((id) => !byId.has(id));
if (unknownSeeds.length) {
  console.error(`FATAL: ${unknownSeeds.length} seed id(s) are not in the map:`);
  for (const id of unknownSeeds) {
    const near = map.modules.filter((m) => idOf(m).startsWith(id.slice(0, 8))).map((m) => idOf(m));
    console.error(`         ${id}${near.length ? `   did you mean: ${near.join(", ")}` : ""}`);
  }
  console.error(`       A skipped seed produces a smaller-but-plausible closure and fails at run time instead.`);
  process.exit(5);
}

const seen = new Set(), q = [...seed], unresolved = new Set();
while (q.length) {
  const id = q.shift();
  if (seen.has(id)) continue;
  seen.add(id);
  const m = byId.get(id);
  if (!m) { unresolved.add(id); continue; }
  for (const r of m.requires) { const rid = String(r); if (!seen.has(rid)) q.push(rid); }
}
const missing = [...seen].filter((id) => !byId.has(id));
const mods = [...seen].filter((id) => byId.has(id));
const lines = mods.reduce((t, id) => t + byId.get(id).lines, 0);
const total = map.modules.reduce((t, m) => t + m.lines, 0);

console.log(`=== closure ===`);
console.log(`  seeds: ${seed.join(", ")}`);
console.log(`  ${mods.length} module(s) / ${lines} lines  (${(lines / total * 100).toFixed(1)}% of the bundle's ${total})`);
if (missing.length) {
  console.log(`\n  FAIL ${missing.length} required id(s) are not in the map — the closure is NOT closed:`);
  for (const id of missing.slice(0, 10)) console.log(`         ${id}`);
  console.log(`       Either module-map missed a require shape, or the map is stale.`);
  process.exit(1);
}
console.log(`  ok   closed — every require resolves inside the set`);

// ⭐ CLOSED IS NOT THE SAME AS COMPLETE. `requires` is closed over this map by
// construction (module-map.mjs files an id it cannot resolve under
// `crossChunkRequires` instead), so the assertion above can only ever speak
// about edges that stay inside the file. The edges that LEAVE it are the ones a
// port trips over — the runtime throws "module N … the module factory is not
// available" at evaluation time, from a slice that checked byte-identical.
// ⚠ Not a failure: a chunk depending on another chunk is normal, and the mirror
// serves the other chunk verbatim. It is only a failure once someone ports this
// slice standalone, which is why it prints here rather than deciding the exit
// code.
{
  const outbound = new Map();
  for (const id of mods) {
    for (const t of byId.get(id).crossChunkRequires || []) {
      if (!outbound.has(t)) outbound.set(t, []);
      outbound.get(t).push(id);
    }
  }
  if (outbound.size) {
    console.log(`\n  ⚠    ${outbound.size} require target(s) in this closure live in ANOTHER chunk:`);
    for (const [t, from] of [...outbound].slice(0, 12)) {
      console.log(`         ${t}   <- ${from.slice(0, 4).join(", ")}${from.length > 4 ? ` … +${from.length - 4}` : ""}`);
    }
    if (outbound.size > 12) console.log(`         … ${outbound.size - 12} more`);
    console.log(`       Either map that chunk too and re-run, or confirm the runtime resolves it from`);
    console.log(`       a chunk the deliverable ships verbatim. A slice missing one of these is`);
    console.log(`       byte-identical and still throws at evaluation time.`);
  }
}

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ seed, modules: mods }, null, 2) + "\n");
console.log(`  -> ${path.relative(process.cwd(), OUT)}`);
