#!/usr/bin/env node
/**
 * Scan JavaScript files for literal module dependencies.
 * Reports bare specifiers in imports, re-exports and require() calls, and paths
 * pointing into the configured tools directory. node: specifiers, relative paths
 * and absolute paths are otherwise accepted.
 *
 * Parses source with the same pinned Acorn tool used by token checks. Offline
 * execution requires that tool in the npm cache. Computed specifiers, binding
 * resolution and subprocess tools are outside its coverage; a require() call
 * is recognized by its name, without resolving aliases or shadowed bindings.
 * Passing does not mean the scripts need no installed tools or downloads.
 *
 * The module-map script once imported Babel contrary to the scripts directory's
 * dependency convention; that mismatch persisted for eight releases.
 *
 *   node scripts/verify-zerodep.mjs [--dir scripts] [--tools tools]
 */
import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { cli } from "./lib/cli.mjs";
import { ACORN_VERSION } from "./lib/tokens.mjs";

cli({ known: ["dir", "tools"], bools: [], file: import.meta.url });

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const DIR = path.resolve(flag("dir", "scripts"));
const TOOLS = flag("tools", "tools");

const walk = async (d, out = []) => {
  for (const e of await readdir(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (/\.(mjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
};

const files = await walk(DIR);
if (files.length === 0) {
  console.log(`FATAL — no scripts found under ${DIR}; no dependencies were examined.`);
  process.exit(5);
}

let fail = 0;
const deps = [], producers = [];

for (const f of files) {
  const rel = path.relative(process.cwd(), f);
  const parsed = spawnSync("npx", ["-y", `acorn@${ACORN_VERSION}`, "--ecma2024", "--module", "--compact", f], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  let nodes;
  try {
    if (parsed.status !== 0) throw new Error(parsed.error?.message || parsed.stderr.trim());
    nodes = [JSON.parse(parsed.stdout)];
  } catch (e) {
    console.error(`FATAL — could not parse ${rel}: ${e.message}`);
    process.exit(5);
  }
  while (nodes.length) {
    const node = nodes.pop();
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) nodes.push(...value.filter((v) => v && typeof v.type === "string"));
      else if (value && typeof value.type === "string") nodes.push(value);
    }
    let source;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(node.type)) source = node.source;
    else if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "require") source = node.arguments[0];
    if (source?.type !== "Literal" || typeof source.value !== "string") continue;
    const spec = source.value;
    if (spec.startsWith("node:") || spec.startsWith(".") || spec.startsWith("/")) {
      // Imports from tools/ are checked separately from bare package specifiers.
      if (spec.includes(`/${TOOLS}/`) || spec.startsWith(`../${TOOLS}/`)) producers.push({ rel, spec });
      continue;
    }
    deps.push({ rel, spec });
  }
}

console.log(`=== verify-zerodep ===`);
console.log(`  ${files.length} file(s) under ${path.relative(process.cwd(), DIR) || DIR}\n`);

if (deps.length) {
  fail++;
  console.log(`  FAIL ${deps.length} bare dependency specifier(s):`);
  for (const d of deps) console.log(`         ${d.rel}  ->  ${d.spec}`);
  console.log(`\n       Review these imports against the scripts directory's dependency requirements.`);
} else console.log(`  ok   no bare dependency specifiers found (node: / relative / absolute paths accepted)`);

if (producers.length) {
  fail++;
  console.log(`\n  FAIL ${producers.length} import(s) reference producer tools in ${TOOLS}/:`);
  for (const p of producers) console.log(`         ${p.rel}  ->  ${p.spec}`);
} else console.log(`  ok   no literal imports into ${TOOLS}/ found`);

console.log(fail ? `\nFAIL — ${fail} dependency check(s) failed.` : `\nPASS — scanned literal imports satisfy the dependency and tools-directory checks.`);
process.exit(fail ? 1 : 0);
