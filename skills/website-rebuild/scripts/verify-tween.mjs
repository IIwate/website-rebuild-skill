#!/usr/bin/env node
/**
 * verify-tween.mjs — a NUMERIC gate for the tween slice.
 *
 * Pixel comparison judges a finished page. It cannot judge this slice: it needs
 * the whole page built, it answers late, and a wrong easing curve arrives as a
 * few differing grid cells rather than as a number you can read.
 *
 * So the slice gets its own gate. Feed both sides the same keyframe spec, drive
 * the same positions, and compare the values the engines actually wrote. A wrong
 * curve, a wrong clamp or a wrong attribute route fails here with the input that
 * produced it, long before anything is rendered.
 *
 * ⛔ Runs several specs, not one. A single linear tween agrees under almost any
 * implementation — including a wrong one. The suite covers the curve (linear vs
 * eased), the clamp outside [start,end], a multi-value attribute, and the
 * declarative disable path, because those are where the implementations can
 * differ while a single sample still matches.
 *
 * ⚠ Both sides get identical `range` overrides. Expression-resolved start/end
 * need live layout the probe page does not have, and applying the SAME override
 * to both cannot mask a difference between them (REBUILD_PLAN §6 D6).
 *
 *   node scripts/verify-tween.mjs --a <urlA> --b <urlB> [--tol 1e-9]
 *   node scripts/verify-tween.mjs --a <urlA> --record docs/tween-baseline.json
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const A = flag("a", null), B = flag("b", null), RECORD = flag("record", null);
const TOL = Number(flag("tol", 1e-9));
const PROBE = flag("probe", "scripts/probe.mjs");
if (!A) { console.error("usage: verify-tween.mjs --a <urlA> [--b <urlB>] [--record <file>]"); process.exit(2); }

// The cases. Each one is a place two implementations of the same engine can
// disagree while a single linear sample still matches.
// ⛔ Field names and values are COPIED from the source's own parseOptions
// (_pretty/main.built.js L3149), not guessed. The first draft of this suite used
// `ease: "easeInOutCubic"` and every case still reported `linear` — because
// `ease` is a NUMERIC weight and the curve is named by `easeFunction`, whose
// vocabulary is a table the engine looks the name up in (linear, easeInQuad,
// easeOutQuad, easeInOutQuad, …) with bezier(…)/spring(…) parsed separately.
// A suite written from intuition would have passed while testing one curve five
// times.
const CASES = [
  { name: "linear opacity", spec: { start: 0, end: 100, opacity: [0, 1] } },
  { name: "easeInOutQuad opacity", spec: { start: 0, end: 100, opacity: [0, 1], easeFunction: "easeInOutQuad" } },
  { name: "easeOutQuad opacity", spec: { start: 0, end: 100, opacity: [0, 1], easeFunction: "easeOutQuad" } },
  { name: "reverse range", spec: { start: 0, end: 100, opacity: [1, 0] } },
  { name: "translate x", spec: { start: 0, end: 100, x: [0, 240] } },
  { name: "disabled when reduced-motion", spec: { start: 0, end: 100, opacity: [0, 1], disabledWhen: ["reduced-motion"] } },
];

const evalOn = (url, expr) =>
  new Promise((res) => {
    const p = spawn("node", [PROBE, url, "--eval", expr], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", () => {
      const m = out.match(/^EVAL: (.*)$/m);
      if (!m) return res({ error: "no EVAL line", raw: out.slice(-400) });
      try { res(JSON.parse(JSON.parse(m[1]))); } catch (e) { res({ error: String(e), raw: m[1].slice(0, 300) }); }
    });
  });

async function runSide(url) {
  const results = [];
  for (const c of CASES) {
    const expr = `JSON.stringify((()=>{try{return window.__tweenProbe(${JSON.stringify({ steps: 9, spec: c.spec })});}catch(e){return {error:String(e).slice(0,200)};}})())`;
    results.push({ case: c.name, ...(await evalOn(url, expr)) });
  }
  return results;
}

console.log(`=== verify-tween ===`);
const a = await runSide(A);
console.log(`  A ${A}`);
for (const r of a) console.log(`    ${r.error ? "ERR " : "ok  "} ${r.case.padEnd(30)} ${r.error ? r.error.slice(0, 70) : `${r.attr} / ${r.ease}`}`);

if (RECORD) {
  await mkdir(path.dirname(path.resolve(RECORD)), { recursive: true });
  await writeFile(path.resolve(RECORD), JSON.stringify({ url: A, cases: a }, null, 2) + "\n");
  console.log(`\n  -> ${RECORD}  (baseline recorded; this is NOT a pass)`);
  console.log(`  ⚠ A baseline is what the port does, not what the source does. It only`);
  console.log(`    becomes a gate once --b names the other side.`);
  process.exit(a.some((r) => r.error) ? 1 : 0);
}

if (!B) { console.log(`\n  ⚠ no --b: nothing was COMPARED. One side alone cannot pass this gate.`); process.exit(2); }

const b = await runSide(B);
console.log(`  B ${B}`);
let fail = 0;
for (let i = 0; i < CASES.length; i++) {
  const x = a[i], y = b[i];
  if (x.error || y.error) { fail++; console.log(`\n  FAIL ${CASES[i].name}: ${x.error || ""} ${y.error || ""}`.slice(0, 160)); continue; }
  const diffs = [];
  if (x.attr !== y.attr) diffs.push(`attr ${x.attr} vs ${y.attr}`);
  if (x.ease !== y.ease) diffs.push(`ease ${x.ease} vs ${y.ease}`);
  for (let k = 0; k < Math.max(x.out.length, y.out.length); k++) {
    const p = x.out[k], q = y.out[k];
    if (!p || !q) { diffs.push(`step ${k} missing on one side`); continue; }
    if (Math.abs(p.value - q.value) > TOL) diffs.push(`pos ${p.pos}: ${p.value} vs ${q.value}`);
    if (Math.abs(p.curved - q.curved) > TOL) diffs.push(`pos ${p.pos} curve: ${p.curved} vs ${q.curved}`);
  }
  if (diffs.length) { fail++; console.log(`\n  FAIL ${CASES[i].name}`); for (const d of diffs.slice(0, 6)) console.log(`         ${d}`); }
  else console.log(`  ok   ${CASES[i].name} — ${x.out.length} positions agree within ${TOL}`);
}
console.log(fail ? `\nFAIL — ${fail}/${CASES.length} case(s) differ.` : `\nPASS — ${CASES.length}/${CASES.length} cases agree within ${TOL}.`);
process.exit(fail ? 1 : 0);
