#!/usr/bin/env node
/**
 * Evaluate configured cases on both sites and compare their outputs.
 * Use an accessible source function, class or module and provide the same
 * inputs and prerequisites on each side. Samples establish behavior only for
 * the selected cases.
 *
 * Probes run sequentially, and fingerprints reject indistinguishable instances.
 * The initial cases exposed an accidental same-browser comparison, a missing
 * resize prerequisite (0 versus 1080), and page-coordinate differences between
 * documents of heights 29,556 and 1,080 pixels.
 *
 * judged cases are compared; info cases are recorded without equality grading.
 * Both lists must resolve on both sides. Align viewport, scroll, clock and
 * random inputs where relevant; ratios are appropriate only when they preserve
 * the behavior being tested.
 *
 * node scripts/verify-crossside.mjs --a <mirror-url> --b <port-url> \
 *       --config scripts/crossside.config.mjs [--probe scripts/probe.mjs]
 *
 * The config module supplies what is target-specific:
 *
 *  export const name   = "expression parser";
 *  export const judged = ["100vh", "(a0b - a0t) * 0.5"];
 *  export const info   = ["a0t", "a0b"];
 *  export function build(cases) { return `...JS returning {out:{case:value}}...`; }
 *
 * See crossside.config.example.mjs.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cli } from "./lib/cli.mjs";

cli({ known: ["a", "b", "config", "probe"], bools: [], file: import.meta.url });

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const A = flag("a", null), B = flag("b", null);
const CONFIG = flag("config", "scripts/crossside.config.mjs");
const PROBE = flag("probe", "scripts/probe.mjs");

if (!A || !B) {
  console.error("usage: verify-crossside.mjs --a <mirror-url> --b <port-url> [--config <file>]");
  process.exit(2);
}

let cfg;
try {
  cfg = await import(pathToFileURL(path.resolve(CONFIG)).href);
} catch (e) {
  console.error(`FATAL — cannot load config ${CONFIG}: ${e.message}`);
  process.exit(5);
}
const JUDGED = cfg.judged ?? [];
const INFO = cfg.info ?? [];
const CASES = [...JUDGED, ...INFO];

if (JUDGED.length === 0) {
  //  A gate with nothing to judge passes unconditionally. That is worse than
  // no gate, because it appears in the record as evidence.
  console.error(`FATAL — config exports no \`judged\` cases. A gate that grades nothing agrees with everything.`);
  process.exit(5);
}
if (typeof cfg.build !== "function") {
  console.error(`FATAL — config exports no \`build(cases)\` function.`);
  process.exit(5);
}

// Record each page URL and basic layout metadata alongside the numeric cases.
// This helps diagnose endpoint or viewport mismatches without authenticating
// the page or establishing that its content is correct.
const WRAP = (cases) => `JSON.stringify((()=>{
  const __id = {
    href: String(location.href),
    title: String(document.title || ""),
    docH: document.documentElement.scrollHeight,
    innerH: innerHeight, innerW: innerWidth,
  };
  try {
    const r = (function(){ return (${cfg.build(cases)}); })();
    return { __id, ...(r && typeof r === "object" ? r : { error: "build() returned " + typeof r }) };
  } catch (e) { return { __id, error: String(e).slice(0, 200) }; }
})())`;

const evalOn = (url, expr) =>
  new Promise((res) => {
    const p = spawn("node", [PROBE, url, "--eval", expr], { stdio: ["ignore", "pipe", "pipe"] });
    let o = "";
    p.stdout.on("data", (d) => (o += d));
    p.stderr.on("data", (d) => (o += d));
    p.on("close", () => {
      const m = o.match(/^EVAL: (.*)$/m);
      if (!m) return res({ error: "no EVAL line (probe produced no result)", raw: o.slice(-400) });
      try { res(JSON.parse(JSON.parse(m[1]))); } catch (e) { res({ error: String(e), raw: m[1].slice(0, 240) }); }
    });
  });

console.log(`=== verify-crossside — ${cfg.name || "unnamed seam"} ===`);
console.log(`  A ${A}\n  B ${B}\n`);

//  SERIAL, never Promise.all. Both calls drive CDP; concurrently, the second
// attaches to the browser the first started and the gate measures one side
// twice — reporting equal measured values. See the header, failure mode 1.
const a = await evalOn(A, WRAP(CASES));
const b = await evalOn(B, WRAP(CASES));

if (a.error || b.error) {
  console.log(`  FATAL A: ${a.error || "-"}`);
  if (a.raw) console.log(`         ${String(a.raw).replace(/\n/g, "\n         ").slice(0, 400)}`);
  console.log(`  FATAL B: ${b.error || "-"}`);
  if (b.raw) console.log(`         ${String(b.raw).replace(/\n/g, "\n         ").slice(0, 400)}`);
  process.exit(5);
}

// Report page metadata and check the configured comparison endpoints.
const ia = a.__id || {}, ib = b.__id || {};
console.log(`  A  ${ia.href}`);
console.log(`     ${ia.innerW}x${ia.innerH} viewport, ${ia.docH}px document`);
console.log(`  B  ${ib.href}`);
console.log(`     ${ib.innerW}x${ib.innerH} viewport, ${ib.docH}px document\n`);
if (ia.href && ia.href === ib.href) {
  console.log(`FATAL — both sides report the same URL. This gate measured ONE page twice;`);
  console.log(`        any agreement below is an artefact. Run the two probes serially and`);
  console.log(`        check that no other CDP session is attached.`);
  process.exit(5);
}
if (ia.docH !== ib.docH || ia.innerH !== ib.innerH) {
  console.log(`      the two pages differ in size. Condition-dependent quantities WILL differ;`);
  console.log(`       that is why they belong in \`info\`, not \`judged\`.\n`);
}

let fail = 0, same = 0;
const bothErr = [];
const isErr = (v) => String(v).startsWith("ERR:") || v === undefined;
const w = Math.max(24, ...CASES.map((c) => c.length));

console.log(`  ${"case".padEnd(w)} A                 B`);
for (const c of JUDGED) {
  const x = a.out?.[c], y = b.out?.[c];
  if (isErr(x) && isErr(y)) bothErr.push(c);
  const agree = String(x) === String(y);
  if (agree) same++; else fail++;
  console.log(`  ${agree ? "ok  " : "FAIL"} ${c.padEnd(w)} ${String(x).slice(0, 16).padEnd(18)}${String(y).slice(0, 16)}`);
}

if (INFO.length) {
  console.log(`\n  info — condition-dependent, NOT graded on value (both sides must still resolve):`);
  for (const c of INFO) {
    const x = a.out?.[c], y = b.out?.[c];
    const resolved = !isErr(x) && !isErr(y);
    if (!resolved) fail++;
    console.log(`  ${resolved ? "    " : "FAIL"} ${c.padEnd(w)} ${String(x).slice(0, 16).padEnd(18)}${String(y).slice(0, 16)}${resolved ? "" : "   <- one side failed to resolve"}`);
  }
}

//  Every case erroring on both sides is agreement about failure, not about a
// value. Left ungraded it prints as a clean pass.
if (bothErr.length === JUDGED.length) {
  console.log(`\nFATAL — every judged case errored on BOTH sides. Agreement about failure is not agreement.`);
  process.exit(5);
}
if (bothErr.length) console.log(`\n      ${bothErr.length} judged case(s) errored on both sides — counted as agreement, but they prove nothing.`);

console.log(fail
  ? `\nFAIL — ${fail} problem(s).  Before calling it a porting defect, rule out §0.25 (a`
    + `\n       prerequisite action one side performs and the other does not) and §0.26`
    + `\n       (a quantity whose domain differs between the two pages).`
  : `\nPASS — ${same}/${JUDGED.length} judged case(s) agree${INFO.length ? `; ${INFO.length} condition-dependent case(s) resolved on both sides` : ""}.`);
process.exit(fail ? 1 : 0);
