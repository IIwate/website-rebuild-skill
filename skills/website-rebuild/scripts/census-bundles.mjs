#!/usr/bin/env node
/**
 * census-bundles.mjs — chunk-level coordinate ledger for CONTAINER-LESS output.
 *
 * module-map.mjs reads the boundaries a packer wrote down; Vite/esbuild
 * scope-hoisted output has none to read, and per-chunk facts are the only
 * machine-extractable structure left: sha256 (the coordinate pin — every
 * "this logic lives in chunk X line N" claim in the reverse notes is anchored
 * against it), bytes/lines, and the CHUNK GRAPH from ESM import/export
 * statements — the counterpart of module-map's require edges, one level up.
 *
 * ⭐ Import clauses are naming evidence, not just edges: a minified export
 * name travels with its descriptive local alias (`import { ap as Vector2 }`),
 * which is exactly the tier-1 material name-modules/slice-esm feed on.
 *
 * Adapted from the hashgraphvc rebuild's project-local census (Codex runtime);
 * generalized: roots as flags, statement matching is line-anchored on the raw
 * bytes (a census is coordinates, not a gate — the reassembly gate is
 * verify-reassembly.mjs, and the mirror gate already proved the bytes).
 *
 *   node scripts/census-bundles.mjs --dir mirror/_nuxt --out docs/bundle-census.json
 */
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const DIR = path.resolve(flag("dir", "mirror/_nuxt"));
const OUT = path.resolve(flag("out", "docs/bundle-census.json"));
const KNOWN = new Set(["dir", "out"]);
for (const a of args) if (a.startsWith("--") && !KNOWN.has(a.slice(2))) {
  console.error(`FATAL — unknown flag ${a}. Known: ${[...KNOWN].map((f) => "--" + f).join(" ")}`);
  process.exit(2);
}

const names = (await readdir(DIR)).filter((n) => /\.m?js$/.test(n)).sort();
if (!names.length) { console.error(`FATAL — no .js chunks under ${DIR}.`); process.exit(2); }

const chunks = [];
for (const name of names) {
  const buf = await readFile(path.join(DIR, name));
  const src = buf.toString("utf8");
  // Line-anchored: an import/export STATEMENT starts a line in this output
  // shape. Occurrences inside strings would need the tokenizer — for a
  // coordinates ledger the trade is documented, not hidden.
  const imports = [];
  for (const m of src.matchAll(/(?:^|\n)import\s*(?:([^;]*?)\s*from\s*)?["']([^"']+)["'];?/g)) {
    imports.push({ clause: m[1] ? m[1].trim().slice(0, 400) : null, source: m[2] });
  }
  const exportNames = [];
  for (const m of src.matchAll(/(?:^|\n)export\s*\{([^}]*)\}/g)) {
    for (const piece of m[1].split(",")) {
      const asIdx = piece.indexOf(" as ");
      const exp = (asIdx >= 0 ? piece.slice(asIdx + 4) : piece).trim();
      if (exp) exportNames.push(exp);
    }
  }
  if (/(?:^|\n)export default /.test(src)) exportNames.push("default");
  chunks.push({
    file: name,
    sha256: createHash("sha256").update(buf).digest("hex"),
    bytes: buf.length,
    lines: src.split("\n").length,
    imports,
    exports: exportNames,
  });
}

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ generatedFrom: path.relative(process.cwd(), DIR), generatedAt: new Date().toISOString(), chunks }, null, 1));

console.log(`=== census-bundles  ${chunks.length} chunk(s) in ${path.relative(process.cwd(), DIR)} ===`);
const rows = [...chunks].sort((a, b) => b.lines - a.lines);
for (const c of rows.slice(0, 12)) {
  console.log(`  ${String(c.lines).padStart(8)} lines  imp:${String(c.imports.length).padStart(2)} exp:${String(c.exports.length).padStart(3)}  ${c.file}`);
}
if (rows.length > 12) console.log(`  … ${rows.length - 12} more`);
console.log(`  -> ${path.relative(process.cwd(), OUT)}`);
