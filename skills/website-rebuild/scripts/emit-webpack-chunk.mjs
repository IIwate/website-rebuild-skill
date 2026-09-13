#!/usr/bin/env node
/**
 * Reassemble a webpack chunk from verbatim module and container slices.
 * Retains the original runtime callback and cross-chunk resolution. The 14islands
 * _app chunk had 24 cross-chunk requires, so an isolated IIFE was insufficient.
 * --map accepts module-map output or a compatible boundary table; --in is the
 * corresponding formatted source. Verify its tokens against the original first.
 * --raw replaces selected modules with original minified spans from --raw-bounds;
 * 14islands module 99150 required this after nested-template formatting changed.
 * --check compares existing parts and output without regenerating them.
 *
 *   node scripts/emit-webpack-chunk.mjs --in <chunk.js> --map <map.json> --out <output.js> --parts <dir>
 *   node scripts/emit-webpack-chunk.mjs --in <chunk.js> --map <map.json> --out <output.js> --parts <dir> --check
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cli } from "./lib/cli.mjs";
import { sha256Short } from "./lib/hash.mjs";

cli({ known: ["in", "map", "out", "parts", "raw", "raw-bounds"], bools: ["check"], file: import.meta.url });

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const IN = flag("in"), MAP = flag("map"), OUT = flag("out"), PARTS = flag("parts");
// --raw selects modules from the original minified file using explicit bounds.
// The bounds JSON is supplied through --raw-bounds by the project analysis.
// 14islands module 99150 needed this after formatting changed a nested template.
// Each raw part must be an exact substring of the original minified file.
const RAW_FILE = flag("raw", null), RAW_BOUNDS = flag("raw-bounds", null);
const RAW = RAW_FILE && RAW_BOUNDS ? JSON.parse(readFileSync(RAW_BOUNDS, "utf8")) : {};
const RAW_SRC = RAW_FILE ? readFileSync(RAW_FILE, "utf8") : "";
if (!IN || !MAP || !OUT || !PARTS) { console.error("usage: emit-webpack-chunk.mjs --in <pretty.js> --map <lines.json> --out <gen.js> --parts <dir> [--check]"); process.exit(2); }
const src = readFileSync(IN, "utf8");
const lines = src.split("\n");
const map = JSON.parse(readFileSync(MAP, "utf8"));
// Accept startLine/endLine or the project map fields start/end.
const mods = map.modules
  .map((m) => ({ ...m, start: m.start ?? m.startLine, end: m.end ?? m.endLine, exports: m.exports ?? m.exportNames ?? [] }))
  .sort((a, b) => a.start - b.start);

// Split the prefix, module ranges and suffix without leaving uncovered bytes.
// Inter-module gap lines belong to the following part.
const parts = [];
let cursor = 1;
const head = lines.slice(0, mods[0].start - 1);
parts.push({ name: "000-head", text: head.join("\n") + "\n" }); cursor = mods[0].start;
mods.forEach((m, i) => {
  const gapBefore = lines.slice(cursor - 1, m.start - 1);
  const body = lines.slice(m.start - 1, m.end);
  const text = (gapBefore.length ? gapBefore.join("\n") + "\n" : "") + body.join("\n") + "\n";
  if (RAW[m.id]) {
    const raw = RAW_SRC.slice(RAW[m.id].start, RAW[m.id].end);
    parts.push({ name: `${String(i + 1).padStart(3, "0")}-${m.id}.raw`, id: m.id, text: (gapBefore.length ? gapBefore.join("\n") + "\n" : "") + "        " + raw + ",\n", exports: m.exports, lines: m.lines, raw: true, prettyText: text });
  } else
  parts.push({ name: `${String(i + 1).padStart(3, "0")}-${m.id}`, id: m.id, text, exports: m.exports, lines: m.lines });
  cursor = m.end + 1;
});
const tail = lines.slice(cursor - 1);
parts.push({ name: "999-tail", text: tail.join("\n") });

const joined = parts.map((p) => p.text).join("");
// Reassemble formatted spans for comparison, and separately verify raw spans.
const joinedPretty = parts.map((p) => (p.raw ? p.prettyText : p.text)).join("");
const rawOk = parts.filter((p) => p.raw).every((p) => RAW_SRC.includes(p.text.trim().replace(/,$/, "")));
const identical = joinedPretty === src && rawOk;
const CHECK = args.includes("--check");
if (!identical) {
  // Report the first difference without writing output.
  let k = 0; while (k < Math.min(joinedPretty.length, src.length) && joinedPretty[k] === src[k]) k++;
  if (!rawOk) console.log("  raw part(s) are not exact substrings of the minified source");
  console.log(`FATAL — reassembly differs from ${IN} at byte ${k} (joined ${joined.length} vs src ${src.length})`);
  console.log(`  src:    ${JSON.stringify(src.slice(Math.max(0, k - 40), k + 40))}`);
  console.log(`  joined: ${JSON.stringify(joinedPretty.slice(Math.max(0, k - 40), k + 40))}`);
  process.exit(1);
}
if (!CHECK) {
  rmSync(PARTS, { recursive: true, force: true }); mkdirSync(PARTS, { recursive: true });
  for (const p of parts) writeFileSync(join(PARTS, p.name + ".js"), p.text);
  writeFileSync(OUT, joined);
  writeFileSync(join(PARTS, "MANIFEST.tsv"), "PART\tMODULE\tLINES\tEXPORTS\tSHA12\n" + parts.map((p) => [p.name, p.id || "-", p.lines || p.text.split("\n").length, (p.exports || []).join(",") || "-", sha256Short(p.text, 12)].join("\t")).join("\n") + "\n");
} else {
  // In check mode, existing parts must reproduce both the source and emitted file.
  const onDisk = readdirSync(PARTS).filter((f) => f.endsWith(".js")).sort().map((f) => readFileSync(join(PARTS, f), "utf8")).join("");
  const outNow = readFileSync(OUT, "utf8");
  if (onDisk !== joined || outNow !== joined) { console.log("FATAL — on-disk parts or gen file drifted from the emitted assembly"); process.exit(1); }
}
const nraw = parts.filter((p) => p.raw).length;
console.log(`${CHECK ? "check " : ""}ok — ${mods.length} module part(s) + head + tail; reassembly === ${IN} (${src.length} bytes, sha12 ${sha256Short(src, 12)})${nraw ? `; ${nraw} raw part(s) = exact minified substrings` : ""}`);
