#!/usr/bin/env node
/**
 * webpack-map.mjs — enumerate a webpack bundle's modules as the porting units.
 *
 * reverse-engineering.md's layer map scans TOP-LEVEL DECLARATIONS, because the
 * four projects before this one were flat concatenations: hundreds of
 * declarations sharing one scope, and the whole problem was deciding where one
 * ended. This bundle has ZERO top-level declarations — it is
 * `!function(modules){runtime}([...])`, and the module boundaries the previous
 * tool had to reconstruct are simply present.
 *
 * So the unit here is the module, not the line range. This tool reads the array
 * (or object) of module functions out of the AST and reports, per module: its
 * id, line span, size, what it requires, and what it exports.
 *
 *   node tools/webpack-map.mjs [--in mirror/_pretty/main.built.js] [--out docs/webpack-map.json]
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
const traverse = _traverse.default ?? _traverse;

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const IN = path.resolve(flag("in", "mirror/_pretty/main.built.js"));
const OUT = path.resolve(flag("out", "docs/webpack-map.json"));

const code = await readFile(IN, "utf8");
const ast = parse(code, { sourceType: "script", errorRecovery: true });

// The runtime is an IIFE whose single argument is the module container.
let container = null;
traverse(ast, {
  CallExpression(p) {
    if (container) return;
    const callee = p.node.callee;
    const isIife = callee.type === "FunctionExpression" ||
      (callee.type === "UnaryExpression" && callee.argument?.type === "FunctionExpression");
    if (!isIife || p.node.arguments.length !== 1) return;
    const arg = p.node.arguments[0];
    if (arg.type === "ArrayExpression" || arg.type === "ObjectExpression") { container = { node: arg, kind: arg.type }; p.stop(); }
  },
});

if (!container) {
  console.error("FATAL: no webpack module container found — this bundle is not `!function(m){…}([…])`.");
  console.error("       Do NOT fall back to the flat layer map: a wrong unit boundary is a silent 65% error.");
  process.exit(5);
}

const entries = container.kind === "ArrayExpression"
  ? container.node.elements.map((el, i) => ({ id: String(i), fn: el }))
  : container.node.properties.map((pr) => ({ id: pr.key?.value ?? pr.key?.name ?? "?", fn: pr.value }));

const mods = [];
for (const { id, fn } of entries) {
  if (!fn || (fn.type !== "FunctionExpression" && fn.type !== "ArrowFunctionExpression")) continue;
  const startLine = fn.loc.start.line, endLine = fn.loc.end.line;
  // webpack's module signature is (module, exports, __webpack_require__).
  const reqName = fn.params[2]?.type === "Identifier" ? fn.params[2].name : null;
  const modName = fn.params[0]?.type === "Identifier" ? fn.params[0].name : null;
  const requires = new Set();
  let exportsAssigned = 0, exportNames = new Set();
  traverse(fn.body, {
    noScope: true,
    CallExpression(p) {
      if (!reqName || p.node.callee?.type !== "Identifier" || p.node.callee.name !== reqName) return;
      const a = p.node.arguments[0];
      if (a && (a.type === "NumericLiteral" || a.type === "StringLiteral")) requires.add(String(a.value));
    },
    AssignmentExpression(p) {
      const l = p.node.left;
      if (l.type !== "MemberExpression" || l.property?.type !== "Identifier") return;
      if (modName && l.object?.type === "Identifier" && l.object.name === modName && l.property.name === "exports") exportsAssigned++;
      if (l.object?.type === "MemberExpression" && l.object.property?.name === "exports") exportNames.add(l.property.name);
    },
  });
  mods.push({ id, startLine, endLine, lines: endLine - startLine + 1, requires: [...requires], exportsAssigned, exportNames: [...exportNames].slice(0, 12) });
}

mods.sort((a, b) => b.lines - a.lines);
const total = mods.reduce((t, m) => t + m.lines, 0);
console.log(`=== webpack-map  ${path.relative(process.cwd(), IN)} ===`);
console.log(`  container: ${container.kind === "ArrayExpression" ? "array" : "object"}   ${mods.length} module(s)   ${total} lines inside modules / ${code.split("\n").length} total\n`);
console.log(`  largest modules:`);
for (const m of mods.slice(0, 12)) {
  console.log(`    ${String(m.lines).padStart(5)} lines  id=${String(m.id).padEnd(4)} L${String(m.startLine).padStart(5)}-${String(m.endLine).padEnd(5)}  requires ${m.requires.length}  ${m.exportNames.slice(0, 4).join(", ")}`);
}
const leaf = mods.filter((m) => m.requires.length === 0).length;
console.log(`\n  ${leaf} module(s) require nothing (leaves);  ${mods.length - leaf} have dependencies`);
console.log(`  ⭐ module boundaries are GIVEN here — no SCC/eval-order partition is needed,`);
console.log(`     which is the whole problem readable-source.md §3.1 exists to solve.`);

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ source: path.relative(process.cwd(), IN), container: container.kind, modules: mods }, null, 2) + "\n");
console.log(`\n  -> ${path.relative(process.cwd(), OUT)}`);
