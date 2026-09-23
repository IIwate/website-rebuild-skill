#!/usr/bin/env node
/**
 * Replace calls of a string-decryption function with the decrypted literal.
 * Obfuscators route every string through `decrypt(<index>)`; once the runtime
 * table has been dumped to JSON, the readable track can carry the literals.
 * Babel locates the calls, edits are applied from the last offset backwards so
 * comments, formatting and untouched code keep their bytes, and the result is
 * re-parsed before it is written.
 *
 *   node tools/inline-strings.mjs --dict <strings.json> --fn <callee> --file <path> [--file <path>…] [--dry-run]
 *   node tools/inline-strings.mjs --dict <strings.json> --fn <callee> --files "<glob>" [--dry-run]
 *
 * Only `callee(<number|string literal>)` is rewritten. A call whose argument
 * has no dictionary entry is reported and the run exits 1 after the other
 * replacements are applied, so a partial dump does not pass as complete.
 *
 * Exit codes: 0 every call resolved, 1 unresolved calls, unreadable input or a
 * result that no longer parses, 2 usage.
 */
import { globSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";
import { cli } from "../scripts/lib/cli.mjs";

const traverse = traverseModule.default?.default ?? traverseModule.default ?? traverseModule;

const { argv, flag, has } = cli({
  known: ["dict", "fn", "file", "files"],
  bools: ["dry-run"],
  file: import.meta.url,
});

const DICT_PATH = flag("dict", null);
const FN_NAME = flag("fn", null);
const FILES = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--file" && argv[i + 1] !== undefined) FILES.push(argv[i + 1]);
  else if (argv[i].startsWith("--file=")) FILES.push(argv[i].slice("--file=".length));
}
const FILES_GLOB = flag("files", null);
const DRY_RUN = has("dry-run");

if (!DICT_PATH || !FN_NAME || (FILES.length === 0 && !FILES_GLOB)) {
  console.error("usage: inline-strings.mjs --dict <path> --fn <callee> (--file <path> | --files <glob>) [--dry-run]");
  process.exit(2);
}

let dict;
try {
  dict = JSON.parse(readFileSync(path.resolve(DICT_PATH), "utf8"));
} catch (e) {
  console.error(`FATAL: cannot read dictionary JSON at ${DICT_PATH}: ${e.message}`);
  process.exit(1);
}
if (dict === null || typeof dict !== "object" || Array.isArray(dict)) {
  console.error(`FATAL: ${DICT_PATH}: expected a JSON object mapping call arguments to strings`);
  process.exit(1);
}

const targets = [...new Set([...FILES, ...(FILES_GLOB ? globSync(FILES_GLOB) : [])].map((f) => path.resolve(f)))];
if (targets.length === 0) {
  console.error("FATAL: no target files matched");
  process.exit(1);
}

const parserOptions = { sourceType: "module", plugins: ["jsx"], allowUndeclaredExports: true };
const isLiteralArg = (node) => node?.type === "NumericLiteral" || node?.type === "StringLiteral";

let totalReplacements = 0;
let failures = 0;
for (const target of targets) {
  const rel = path.relative(process.cwd(), target);
  let source;
  try {
    source = readFileSync(target, "utf8");
  } catch (e) {
    console.error(`FAIL ${rel}: cannot read: ${e.message}`);
    failures += 1;
    continue;
  }
  let ast;
  try {
    ast = parse(source, parserOptions);
  } catch (e) {
    console.error(`FAIL ${rel}: does not parse: ${e.message}`);
    failures += 1;
    continue;
  }

  const edits = [];
  const unresolved = [];
  traverse(ast, {
    CallExpression({ node }) {
      if (node.callee?.type !== "Identifier" || node.callee.name !== FN_NAME) return;
      if (node.arguments.length !== 1 || !isLiteralArg(node.arguments[0])) return;
      const key = String(node.arguments[0].value);
      if (!Object.hasOwn(dict, key)) { unresolved.push(`${key} @${node.loc.start.line}:${node.loc.start.column + 1}`); return; }
      edits.push({ start: node.start, end: node.end, replacement: JSON.stringify(String(dict[key])) });
    },
  });

  // Descending offsets keep every earlier edit's coordinates valid.
  edits.sort((a, b) => b.start - a.start);
  let transformed = source;
  for (const edit of edits) transformed = transformed.slice(0, edit.start) + edit.replacement + transformed.slice(edit.end);

  if (edits.length > 0) {
    try {
      parse(transformed, parserOptions);
    } catch (e) {
      console.error(`FAIL ${rel}: inlined result does not parse, file left untouched: ${e.message}`);
      failures += 1;
      continue;
    }
    if (!DRY_RUN) writeFileSync(target, transformed, "utf8");
  }
  totalReplacements += edits.length;
  console.log(`${rel}: ${edits.length} replacement(s)${unresolved.length ? `, ${unresolved.length} unresolved` : ""}${DRY_RUN ? " (dry-run)" : ""}`);
  for (const u of unresolved) console.log(`  unresolved ${FN_NAME}(${u})`);
  if (unresolved.length) failures += 1;
}

if (failures > 0) {
  console.error(`FAIL — ${totalReplacements} call(s) inlined, ${failures} file(s) with unresolved calls or errors.`);
  process.exit(1);
}
console.log(`PASS — ${totalReplacements} call(s) inlined across ${targets.length} file(s).`);
