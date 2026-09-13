#!/usr/bin/env node
/**
 * Compare JavaScript token types and values using Acorn 8.14.0.
 * Whitespace and source positions are excluded. This detects changed literals,
 * including regular expressions, but does not prove equivalent ASI or behavior.
 * The 14islands formatter changed a nested template while sampled visual and
 * loading checks passed. This check reports the first token difference.
 * Offline use requires the pinned Acorn package in the npm cache.
 *
 *   node scripts/verify-tokens.mjs <original.js> <emitted.js>
 *   node scripts/verify-tokens.mjs --pairs pairs.tsv
 *
 * TSV columns: ORIGINAL, EMITTED, optional TAG. Preserve this command's exit code.
 */

import { readFileSync } from "node:fs";
import { tokenStream, firstDivergence, showToken, ACORN_VERSION } from "./lib/tokens.mjs";
import { cli } from "./lib/cli.mjs";

cli({ known: ["pairs"], file: import.meta.url, positional: "<original.js> <emitted.js>" });

const args = process.argv.slice(2);
const pi = args.indexOf("--pairs");
let pairs = [];
if (pi >= 0) {
  for (const line of readFileSync(args[pi + 1], "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || /^ORIGINAL\t/i.test(t)) continue;
    const [orig, emitted, tag] = t.split("\t");
    if (orig && emitted) pairs.push({ orig, emitted, tag: tag || emitted });
  }
} else if (args.length === 2) {
  pairs = [{ orig: args[0], emitted: args[1], tag: args[1] }];
}
if (!pairs.length) {
  console.error("usage: verify-tokens.mjs <original.js> <emitted.js> | --pairs pairs.tsv (ORIGINAL<tab>EMITTED[<tab>TAG])");
  process.exit(2);
}
let ok = 0, fail = 0;
for (const { orig, emitted, tag } of pairs) {
  let ta, tb;
  try { ta = tokenStream(orig); tb = tokenStream(emitted); }
  catch (e) { console.log(`FAIL ${tag}: ${e.message}`); fail++; continue; }
  const k = firstDivergence(ta, tb);
  if (k < 0) { console.log(`ok   ${tag}  ${ta.length} tokens`); ok++; }
  else { console.log(`FAIL ${tag}: ${ta.length} vs ${tb.length} tokens; first divergence at #${k}: ${showToken(ta[k])} vs ${showToken(tb[k])}`); fail++; }
}
console.log(`\n${fail ? "FAIL" : "PASS"} — ${ok} pair(s) token-identical, ${fail} differ (acorn@${ACORN_VERSION})`);
process.exit(fail ? 1 : 0);
