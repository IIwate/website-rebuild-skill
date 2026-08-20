#!/usr/bin/env node
/**
 * webpack-map.mjs — enumerate a webpack bundle's modules as the porting units.
 *
 * reverse-engineering.md's layer map scans TOP-LEVEL DECLARATIONS, because the
 * four projects before this one were flat concatenations: hundreds of
 * declarations sharing one scope, and the whole problem was deciding where one
 * ended. A packed bundle has ZERO top-level declarations — it is
 * `!function(modules){runtime}([…])` — and the boundaries the previous tool had
 * to reconstruct are simply present.
 *
 * ⭐ ZERO-DEPENDENCY, and that is not incidental. Everything before the source
 * stage runs with nothing installed; a rebuild project acquires devDependencies
 * only at M(n+1). The first version of this file imported @babel/* and sat in
 * scripts/ for eight releases — three lines below the paragraph forbidding it.
 *
 * It gets a real tokenizer anyway, via the same pinned-npx pattern
 * beautify-bundle.mjs uses: spawn `acorn --tokenize`, read the token stream,
 * never import anything. ⛔ Do NOT hand-roll the lexer instead. That was tried
 * elsewhere in this skill and a regex literal containing a quote desynced it by
 * 16,177 lines (F27). Brace matching over a real token stream is exact; brace
 * matching over text is a guess about strings, regexes and comments.
 *
 *   node scripts/webpack-map.mjs [--in mirror/_pretty/main.built.js] [--out docs/webpack-map.json]
 */
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const ACORN_VERSION = "8.14.0"; // PINNED — a version bump can change token shapes.

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const IN = path.resolve(flag("in", "mirror/_pretty/main.built.js"));
const OUT = path.resolve(flag("out", "docs/webpack-map.json"));

const code = await readFile(IN, "utf8");

const r = spawnSync("npx", ["-y", `acorn@${ACORN_VERSION}`, "--ecma2022", "--locations", "--tokenize", IN], {
  encoding: "utf8",
  maxBuffer: 1024 * 1024 * 1024,
});
if (r.status !== 0) {
  console.error(`FATAL — acorn@${ACORN_VERSION} could not tokenize ${IN}.`);
  console.error((r.stderr || "").split("\n").slice(0, 8).join("\n"));
  process.exit(5);
}
let T;
try { T = JSON.parse(r.stdout); } catch (e) {
  console.error(`FATAL — acorn produced output this tool could not read: ${e.message}`);
  process.exit(5);
}
const lab = (i) => T[i]?.type?.label;
const val = (i) => T[i]?.value;
// ⛔ A property name can be a reserved word — `.default` is the common one in
// transpiled ESM interop — and acorn emits it as a KEYWORD token, not a `name`.
// Requiring `name` here dropped `default` from one module's export list, which
// is exactly the export that matters for interop.
const isProp = (i) => lab(i) === "name" || !!T[i]?.type?.keyword;
const propName = (i) => T[i]?.type?.keyword ?? val(i);

// --- find the module container --------------------------------------------
// A module property is `<key>: function(…)` where key is a string, a bare
// identifier, or a number. ⛔ All three occur: a minifier quotes a key only
// when it must, so `"02b5c2be…":` and `a738138e…:` and `14:` are the same
// thing. Accepting only the quoted form found 376 of 597 modules and the miss
// was invisible — every id it dropped simply never appeared downstream.
const KEY = new Set(["string", "name", "num"]);
const props = [];
for (let i = 0; i + 2 < T.length; i++) {
  if (!KEY.has(lab(i)) || lab(i + 1) !== ":") continue;
  if (lab(i + 2) !== "function") continue;
  props.push(i);
}

// Group by enclosing brace depth so a stray `{ x: function(){} }` elsewhere in
// the file cannot be mistaken for the container. The container is the depth
// with by far the most module-shaped properties.
// ⛔ `${` opens a brace context that closes with a plain `}`. Counting only `{`
// as an opener makes depth drift negative once per template interpolation — 466
// of them here, and `}` outnumbered `{` by exactly 466, which is how the bug
// announced itself. A depth counter that can go negative is not a depth counter.
const OPEN = new Set(["{", "[", "(", "${"]);
const CLOSE = new Set(["}", "]", ")"]);
const depthAt = new Int32Array(T.length);
{
  let d = 0;
  for (let i = 0; i < T.length; i++) {
    const l = lab(i);
    if (OPEN.has(l)) d++;
    depthAt[i] = d;
    if (CLOSE.has(l)) d--;
  }
  if (d !== 0) {
    console.error(`FATAL — token depth ended at ${d}, not 0. The bracket accounting is wrong, and every`);
    console.error(`        module boundary derived from it would be wrong with it.`);
    process.exit(5);
  }
}
const ownerAt = new Int32Array(T.length).fill(-1);
{
  const stack = [];
  let owner = -1;
  const owners = [];
  for (let i = 0; i < T.length; i++) {
    const l = lab(i);
    if (OPEN.has(l)) { stack.push(l); if (l === "{" || l === "${") { owners.push(owner); owner = i; } else owners.push(null); }
    ownerAt[i] = owner;
    if (CLOSE.has(l)) { const o = stack.pop(); const prev = owners.pop(); if (prev !== null && prev !== undefined) owner = prev; }
  }
}
const byOwner = new Map();
for (const i of props) byOwner.set(ownerAt[i], (byOwner.get(ownerAt[i]) || []).concat(i));
const [, members] = [...byOwner].sort((a, b) => b[1].length - a[1].length)[0] || [];

// --- array-form container: `[function(…), function(…)]` ---------------------
let entries = [];
let containerKind = "ObjectExpression";
if (!members || members.length < 2) {
  // Fall back to the array form before giving up.
  const arr = [];
  for (let i = 0; i + 1 < T.length; i++) {
    if (lab(i) !== "function") continue;
    if (lab(i - 1) === "[" || lab(i - 1) === ",") arr.push(i);
  }
  if (arr.length < 2) {
    console.error("FATAL: no webpack module container found — this bundle is not `!function(m){…}([…])`.");
    console.error("       Do NOT fall back to the flat layer map: a wrong unit boundary is a silent 65% error.");
    process.exit(5);
  }
  containerKind = "ArrayExpression";
  entries = arr.map((fi, idx) => ({ id: String(idx), fi }));
} else {
  entries = members.map((i) => ({ id: String(val(i)), fi: i + 2 }));
}

// --- walk each module -------------------------------------------------------
// Every id the container defines. Needed before the walk, because a require
// argument may be a conditional and the only sound way to read the literals
// inside it is to check them against the real id set.
const KNOWN = new Set(entries.map((e) => String(e.id)));

const mods = [];
for (const { id, fi } of entries) {
  // fi points at `function`. Params run from the next `(` to its match.
  let p = fi + 1;
  while (p < T.length && lab(p) !== "(") p++;
  const params = [];
  let depth = 0, q = p;
  for (; q < T.length; q++) {
    const l = lab(q);
    if (l === "(") { depth++; continue; }
    if (l === ")") { depth--; if (depth === 0) break; continue; }
    if (depth === 1 && l === "name") params.push(val(q));
  }
  // Body: the `{` after the params, brace-matched.
  let b = q + 1;
  while (b < T.length && lab(b) !== "{") b++;
  let bd = 0, end = b;
  for (let k = b; k < T.length; k++) {
    const l = lab(k);
    if (l === "{" || l === "${") bd++;
    else if (l === "}") { bd--; if (bd === 0) { end = k; break; } }
  }
  const startLine = T[fi].loc.start.line, endLine = T[end].loc.end.line;

  // webpack's module signature is (module, exports, __webpack_require__).
  const modName = params[0] ?? null, reqName = params[2] ?? null;
  const requires = new Set();
  const exportNames = new Set();
  let exportsAssigned = 0;
  for (let k = b; k < end; k++) {
    // reqName(<anything>) — collect every literal inside the call that is a real
    // module id, at any depth.
    //
    // ⛔ Matching only `reqName("id")` misses a CONDITIONAL require, and this
    // bundle has one: `i(t ? "c0e8c815…" : "2f021872…")` picks a video-player
    // implementation by browser and options. Both targets then had no inbound
    // edge, the closure classified them as dead code, and the port shipped
    // without them — while a nine-checkpoint pixel walk stayed at 0.00, because
    // the branch is not taken on the paths that were driven. This is exactly the
    // hole a list reconciliation exists to find and a functional test cannot.
    if (reqName && lab(k) === "name" && val(k) === reqName && lab(k + 1) === "(") {
      let d = 0;
      for (let j = k + 1; j < end; j++) {
        const l = lab(j);
        if (l === "(" || l === "[" || l === "{" || l === "${") d++;
        else if (l === ")" || l === "]" || l === "}") { d--; if (d === 0) { k = j; break; } }
        else if (d >= 1 && (l === "string" || l === "num")) {
          const v = String(val(j));
          if (KNOWN.has(v)) requires.add(v);
        }
      }
      continue;
    }
    // modName.exports =
    if (modName && lab(k) === "name" && val(k) === modName && lab(k + 1) === "." &&
        isProp(k + 2) && propName(k + 2) === "exports") {
      if (lab(k + 3) === "=") exportsAssigned++;
      // <anything>.exports.NAME =
      else if (lab(k + 3) === "." && isProp(k + 4) && lab(k + 5) === "=") exportNames.add(propName(k + 4));
    }
  }
  mods.push({ id, startLine, endLine, lines: endLine - startLine + 1, requires: [...requires], exportsAssigned, exportNames: [...exportNames].slice(0, 12) });
}

// ⛔ A container can define the same id more than once, and this one does: 597
// properties, 569 distinct ids. JS object-literal semantics decide which one is
// real — THE LAST DEFINITION WINS — so the map keeps the last and reports what
// it shadowed.
//
// ⚠ Four of the shadowed copies here are NOT byte-identical to their winner:
// `503cddff7fa7d3d89971` is defined four times, once as a plain rAF scheduler
// and again as a phase-aware one. A bundle can carry several versions of the
// same library and let the packer's last write decide. So this is not corrupt
// input to reject — it is input to read correctly.
//
// ⛔ Before this existed the tool reported "597 modules" and every document
// repeated the number; the real count of distinct modules is 569. Worse, tools
// that build an id→module map got whichever copy the iteration order landed on.
// The port did take the winning copy of the one duplicate inside its slice —
// by luck, not by decision.
//
// ⚠ "Last" means last IN THE FILE. Computing it after the display sort keeps
// the SMALLEST copy of each id and then reports divergence that is an artefact
// of the sort — a bug that reads exactly like a finding.
const inSourceOrder = [...mods].sort((a, b) => a.startLine - b.startLine);
const lastOf = new Map();
for (const m of inSourceOrder) lastOf.set(m.id, m);
const shadowed = inSourceOrder.filter((m) => lastOf.get(m.id) !== m);
let divergent = [];
if (shadowed.length) {
  const lines = code.split("\n");
  const body = (m) => lines.slice(m.startLine - 1, m.endLine).join("\n");
  divergent = shadowed.filter((m) => body(m) !== body(lastOf.get(m.id)));
  console.log(`\n  ⚠    ${mods.length} properties define ${lastOf.size} distinct modules — ${shadowed.length} shadowed`);
  console.log(`       definition(s) dropped; a repeated key means the LAST one wins at runtime.`);
  if (divergent.length) {
    console.log(`  ⚠⚠   ${divergent.length} shadowed definition(s) DIFFER from their winner — the bundle carries`);
    console.log(`       more than one version of the same module. Port the WINNER; the others never ran:`);
    for (const m of divergent.slice(0, 8)) {
      console.log(`         ${m.id}  shadowed L${m.startLine}-${m.endLine}   winner L${lastOf.get(m.id).startLine}-${lastOf.get(m.id).endLine}`);
    }
  } else {
    console.log(`       all shadowed copies are byte-identical to their winner.`);
  }
  mods.length = 0;
  mods.push(...lastOf.values());
}

mods.sort((a, b) => b.lines - a.lines);
const total = mods.reduce((t, m) => t + m.lines, 0);
console.log(`=== webpack-map  ${path.relative(process.cwd(), IN)} ===`);
console.log(`  container: ${containerKind === "ArrayExpression" ? "array" : "object"}   ${mods.length} module(s)   ${total} lines inside modules / ${code.split("\n").length} total`);
console.log(`  tokenized by acorn@${ACORN_VERSION} (pinned, spawned — not imported)\n`);
console.log(`  largest modules:`);
for (const m of mods.slice(0, 12)) {
  console.log(`    ${String(m.lines).padStart(5)} lines  id=${String(m.id).padEnd(4)} L${String(m.startLine).padStart(5)}-${String(m.endLine).padEnd(5)}  requires ${m.requires.length}  ${m.exportNames.slice(0, 4).join(", ")}`);
}
const leaf = mods.filter((m) => m.requires.length === 0).length;
console.log(`\n  ${leaf} module(s) require nothing (leaves);  ${mods.length - leaf} have dependencies`);

// ⛔ Every id must be a string. The @babel version read a numeric key straight
// through, so one module's id was the NUMBER 14 while closure.mjs and
// slice-modules.mjs compare strings — it could never be selected, and nothing
// would have said so. Same family as the truncated id that was silently
// filtered out of a slice.
const bad = mods.filter((m) => typeof m.id !== "string" || !m.id);
if (bad.length) { console.error(`\nFATAL — ${bad.length} module(s) have a non-string id.`); process.exit(5); }
console.log(`  ⭐ module boundaries are GIVEN here — no SCC/eval-order partition is needed,`);
console.log(`     which is the whole problem readable-source.md §3.1 exists to solve.`);

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({
  source: path.relative(process.cwd(), IN),
  container: containerKind,
  properties: entries.length,
  shadowedDivergent: [...new Set(divergent.map((m) => m.id))],
  modules: mods,
}, null, 2) + "\n");
console.log(`\n  -> ${path.relative(process.cwd(), OUT)}`);
