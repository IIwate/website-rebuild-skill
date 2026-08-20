#!/usr/bin/env node
/**
 * modules-to-src.mjs — turn one generated bundle-port into a readable tree.
 *
 * For a packed bundle the split is free: the packer already decided the
 * boundaries. What this does is make each boundary a FILE, give it the name the
 * evidence supports (docs/*-names.json), and put a provenance header on it.
 *
 * ⛔ IT DOES NOT CONVERT REQUIRES INTO STATIC IMPORTS, and that is a decision,
 * not laziness. `require(id)` is LAZY and MEMOISED: the module runs the first
 * time someone asks for it. ESM imports are hoisted and evaluated before the
 * importing module's body. Converting the one to the other reorders every
 * module's top-level side effects — and this port's engine publishes globals
 * from module top level, so the reordering is observable. readable-source.md
 * §3.1 names evaluation order as one of the three hard constraints on how far a
 * split may go; here the packer's own runtime is what respects it.
 *
 * So each module becomes:
 *
 *     export default function (module, exports, require) { …verbatim… }
 *
 * ⭐ Renaming the wrapper's three parameters is free readability with zero risk:
 * their meaning is fixed by the packer's contract, not inferred. `function(e, t, i)`
 * becomes `function (module, exports, require)` and every `i("…")` in the body
 * reads as `require("…")`.
 *
 * ⛔ The bodies stay verbatim otherwise. Renaming locals is a separate step with
 * a separate gate (verify-symbols.mjs); doing both at once means a failure
 * cannot be attributed.
 *
 *   node tools/modules-to-src.mjs --closure docs/app-closure.json \
 *        --names docs/app-names.json --entry 14 --out src
 */
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
const traverse = _traverse.default ?? _traverse;

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const MAP = JSON.parse(await readFile(path.resolve(flag("map", "docs/webpack-map.json")), "utf8"));
const CLO = JSON.parse(await readFile(path.resolve(flag("closure", "docs/app-closure.json")), "utf8"));
const NAMES = JSON.parse(await readFile(path.resolve(flag("names", "docs/app-names.json")), "utf8"));
const ENTRY = String(flag("entry", ""));
const OUT = path.resolve(flag("out", "src"));
const SRC = (await readFile(path.resolve(MAP.source), "utf8")).split("\n");

if (!ENTRY) { console.error("FATAL — --entry <module-id> is required: a tree with no entry does not run."); process.exit(2); }

const byId = new Map(MAP.modules.map((m) => [String(m.id), m]));
const nameOf = new Map(NAMES.modules.filter((m) => m.name).map((m) => [String(m.id), m]));
const ids = CLO.modules.map(String);
if (!ids.includes(ENTRY)) { console.error(`FATAL — entry ${ENTRY} is not in the closure.`); process.exit(5); }

const fileFor = (id) => (nameOf.has(id) ? `${nameOf.get(id).name}.js` : `${id}.js`);

await rm(path.join(OUT, "modules"), { recursive: true, force: true });
await mkdir(path.join(OUT, "modules"), { recursive: true });

let named = 0, wrapperRenamed = 0;
for (const id of ids) {
  const m = byId.get(id);
  if (!m) { console.error(`FATAL — ${id} is in the closure but not in the map.`); process.exit(5); }
  const raw = SRC.slice(m.startLine - 1, m.endLine).join("\n");

  // Strip `"<id>": ` / `<id>: ` so the file starts at `function (…)`.
  const fnText = raw.replace(/^\s*(?:"[^"]+"|[A-Za-z_$][\w$]*|\d+)\s*:\s*/, "").replace(/,\s*$/, "");

  // ⛔ Rename ONLY the wrapper's own three parameters, and do it with SCOPE, not
  // with text. A text-level shadow test is far too coarse for one-letter names:
  // the first version refused 381 of 565 modules because some inner function
  // somewhere also had a parameter called `e`. Shadowing is precisely what a
  // scope analyser is for.
  //
  // ⭐ But AST for IDENTIFICATION, text splice for EDITING. Regenerating from the
  // AST would reformat the body, and the body is the port — it has to stay
  // byte-for-byte. So collect the binding's positions and rewrite those spans.
  //
  // ⛔ referencePaths does NOT include writes. A parameter that is assigned to
  // (`e = e || {}`, common in minified code) has that occurrence in
  // constantViolations instead, and missing it renames half the binding —
  // which produces code that parses and is wrong (readable-source.md §3.2).
  let body = fnText;
  let renamedThis = false;
  try {
    const ast = parse(`(${fnText})`, { sourceType: "script", errorRecovery: true });
    let fnPath = null;
    traverse(ast, { FunctionExpression(p) { if (!fnPath) { fnPath = p; p.stop(); } } });
    if (fnPath && fnPath.node.params.length === 3 && fnPath.node.params.every((p) => p.type === "Identifier")) {
      const wanted = ["module", "exports", "require"];
      const spans = [];
      let clash = false;
      fnPath.node.params.forEach((param, i) => {
        const b = fnPath.scope.getBinding(param.name);
        if (!b) { clash = true; return; }
        // ⚠ If the target name is already used for something else in here,
        // renaming would merge two different bindings into one.
        if (fnPath.scope.getBinding(wanted[i]) || fnPath.scope.hasGlobal?.(wanted[i])) { clash = true; return; }
        const nodes = [b.identifier, ...b.referencePaths.map((r) => r.node), ...b.constantViolations.map((v) => (v.node.left && v.node.left.type === "Identifier" ? v.node.left : v.node.id ?? v.node))];
        for (const n of nodes) {
          if (!n || n.type !== "Identifier" || n.start == null) continue;
          spans.push({ start: n.start, end: n.end, to: wanted[i] });
        }
      });
      if (!clash && spans.length) {
        // The parse was of `(${fnText})`, so offsets are shifted by one.
        spans.sort((a, b) => b.start - a.start);
        let t = fnText;
        for (const sp of spans) t = t.slice(0, sp.start - 1) + sp.to + t.slice(sp.end - 1);
        body = t;
        renamedThis = true;
        wrapperRenamed++;
      }
    }
  } catch { /* a module that will not parse keeps its original text */ }

  const meta = nameOf.get(id);
  if (meta) named++;
  const header = [
    `// ${meta ? meta.name : id}`,
    `//`,
    `// Verbatim webpack module \`${id}\` from ${MAP.source} L${m.startLine}-L${m.endLine}`,
    `// (${m.lines} lines). ⛔ The body below is transcribed, not rewritten: source-site`,
    `// bugs, dead code and odd spellings are the port.`,
    meta ? `//` : null,
    meta ? `// Name evidence (tier ${meta.tier}): ${meta.why}` : `// No evidence supported a name, so this file keeps the packer's id. That is`,
    meta ? null : `// deliberate — a wrong name is worse than a hash, because a hash makes you look.`,
    `//`,
    `// Requires: ${m.requires.length ? m.requires.map((r) => fileFor(String(r))).join(", ") : "(none)"}`,
    ``,
  ].filter((l) => l !== null).join("\n");

  await writeFile(path.join(OUT, "modules", fileFor(id)), header + "export default " + body + "\n");
}

// --- registry + runtime -----------------------------------------------------
// ⭐ STATIC imports of the factories, not dynamic ones. Importing a factory only
// defines a function; it does not run the module. So the tree loads eagerly and
// synchronously (no async entry, no loading-semantics change) while the module
// BODIES still run lazily, the first time require() asks — which is the
// evaluation order the packer's runtime guarantees.
const imports = ids.map((id, i) => `import __m${i} from "./modules/${fileFor(id)}";`).join("\n");
const reg = ids.map((id, i) => `  ${JSON.stringify(id)}: __m${i},`).join("\n");
await writeFile(path.join(OUT, "registry.js"),
`${imports}

// registry.js — id -> module factory, one entry per file in modules/.
//
// ⛔ Generated. The mapping is the packer's, not ours: module ids are content
// hashes and the file names beside them are only as good as the evidence in
// docs/*-names.json. Regenerate with tools/modules-to-src.mjs.
export const modules = {
${reg}
};
`);

await writeFile(path.join(OUT, "runtime.js"),
`// runtime.js — the packer's module contract, re-implemented.
//
// ⚠ REGISTERED DEVIATION: the original runtime is one closure wrapping the whole
// container; carrying it verbatim would carry every module. This is the smallest
// re-implementation that preserves what the modules were compiled against —
// require by id, memoised exports, and a { exports } object per module.
//
// ⛔ Requires stay LAZY. A module runs the first time someone asks for it, and
// its top-level side effects happen then — not at import time. Replacing this
// with static ESM imports would hoist every module body above the code that
// asks for it and reorder those side effects.
// ⛔ THE HELPERS ARE PART OF THE CONTRACT, not decoration. Modules compiled from
// ESM call require.r / require.d / require.n / require.o to mark and wire up
// interop, and a runtime without them throws \`require.r is not a function\` the
// first time such a module runs.
//
// ⚠ How that was nearly missed: on a 46-module vertical slice these helpers were
// called ZERO times, and "unreachable" was written down. Across all 565 they are
// used. "Not reached by the part I looked at" is not "not reached" — the same
// generalisation the cold audit exists to prevent, made one layer down.
const cache = {};

export function makeRequire(modules) {
  function require(id) {
    if (cache[id]) return cache[id].exports;
    const factory = modules[id];
    if (!factory) throw new Error(\`module \${id} is not in the registry\`);
    const module = (cache[id] = { id, exports: {} });
    factory(module, module.exports, require);
    return module.exports;
  }

  // define a getter on exports (webpack's __webpack_require__.d)
  require.d = (exports, name, getter) => {
    if (!require.o(exports, name)) Object.defineProperty(exports, name, { enumerable: true, get: getter });
  };
  // mark exports as an ES module (.r)
  require.r = (exports) => {
    if (typeof Symbol !== "undefined" && Symbol.toStringTag) Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    Object.defineProperty(exports, "__esModule", { value: true });
  };
  // getDefaultExport wrapper (.n)
  require.n = (mod) => {
    const getter = mod && mod.__esModule ? () => mod.default : () => mod;
    require.d(getter, "a", getter);
    return getter;
  };
  // hasOwnProperty (.o)
  require.o = (obj, prop) => Object.prototype.hasOwnProperty.call(obj, prop);
  // createFakeNamespaceObject (.t) — used by \`import()\`-shaped code paths
  require.t = (value, mode) => {
    if (mode & 1) value = require(value);
    if (mode & 8) return value;
    if (mode & 4 && typeof value === "object" && value && value.__esModule) return value;
    const ns = Object.create(null);
    require.r(ns);
    Object.defineProperty(ns, "default", { enumerable: true, value });
    if (mode & 2 && typeof value !== "string") for (const key in value) require.d(ns, key, ((k) => value[k]).bind(null, key));
    return ns;
  };
  // publicPath (.p) — the packer emitted "/" for this bundle
  require.p = "/";
  require.m = modules;
  require.c = cache;

  return require;
}
`);

await writeFile(path.join(OUT, "index.js"),
`// index.js — the entry the packer's runtime called: \`__webpack_require__(${JSON.stringify(ENTRY)})\`.
import { modules } from "./registry.js";
import { makeRequire } from "./runtime.js";

const require = makeRequire(modules);
require(${JSON.stringify(ENTRY)});

// ⚠ Verification hook only. The source publishes no such global; nothing in the
// port may reach for it.
if (typeof window !== "undefined") window.__req = require;
`);

console.log(`=== modules-to-src ===`);
console.log(`  ${ids.length} module(s) -> ${path.relative(process.cwd(), OUT)}/modules/`);
console.log(`  ${named} named from evidence, ${ids.length - named} keep their id`);
console.log(`  ${wrapperRenamed} wrapper signature(s) renamed to (module, exports, require);`);
console.log(`  ${ids.length - wrapperRenamed} left alone (not the 3-parameter shape, or the target name is taken)`);
console.log(`\n  ⚠ Bodies are still verbatim. Local renaming is the next step and has its own gate.`);
