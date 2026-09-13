#!/usr/bin/env node
/**
 * Compare Next Pages Router __NEXT_DATA__ and SSG JSON payloads.
 * A base can be an HTTP(S) URL or a local directory. Local routes resolve to
 * <route>/index.html or <route>.html; data resolves under _next/data/<buildId>/.
 * Checks pageProps within each side and compares records across two sides.
 * --normalize removes explicitly named fields; Sanity _key/_rev remain by default.
 * Use a route/status check as well: absent non-200 data responses are not compared
 * as payloads. Based on the 14islands Pages Router case.
 *
 *   node scripts/verify-nextdata.mjs --a <url-or-dir> [--b <url-or-dir>] [--routes /,/about] [--normalize <fields>]
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { cli } from "./lib/cli.mjs";

cli({ known: ["a", "b", "routes", "build", "dump", "normalize"], file: import.meta.url });

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const A = flag("a"), B = flag("b", null);
const ROUTES = (flag("routes", "") || "").split(",").filter(Boolean);
const DUMP = flag("dump", null);
const NORM = new Set((flag("normalize", "") || "").split(",").filter(Boolean));
if (!A || !ROUTES.length) {
  console.error("usage: verify-nextdata.mjs --a <base|dir> [--b <base|dir>] --routes /,/x [--build id] [--dump dir] [--normalize k,k]");
  process.exit(2);
}
const UA = "wrs-verify-nextdata";
const isHttp = (b) => /^https?:\/\//.test(b);

async function get(base, p) {
  if (isHttp(base)) {
    const r = await fetch(base + p, { headers: { "user-agent": UA } });
    return { status: r.status, text: await r.text() };
  }
  // Directory mode resolves page routes to index.html or .html; other paths are literal.
  const cands = p.endsWith(".json") ? [join(base, p)] : p === "/" ? [join(base, "index.html")] : [join(base, p, "index.html"), join(base, p + ".html")];
  for (const f of cands) {
    try { return { status: 200, text: await readFile(f, "utf8") }; } catch {}
  }
  return { status: 404, text: "" };
}
function extract(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  return m ? JSON.parse(m[1]) : null;
}
function strip(v) {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (!NORM.has(k)) o[k] = strip(x);
    return o;
  }
  return v;
}
function diff(a, b, p = "$", out = []) {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${p}: array length ${a.length} vs ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${p}[${i}]`, out);
    return out;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.join(" ") !== kb.join(" ")) out.push(`${p}: key set/order differs (${ka.length} vs ${kb.length}): -${ka.filter((k) => !kb.includes(k)).join(",")} +${kb.filter((k) => !ka.includes(k)).join(",")}`);
    for (const k of ka) if (k in b) diff(a[k], b[k], `${p}.${k}`, out);
    return out;
  }
  if (a !== b) out.push(`${p}: ${JSON.stringify(a)?.slice(0, 80)} vs ${JSON.stringify(b)?.slice(0, 80)}`);
  return out;
}

let build = flag("build", null), fails = 0, ok = 0;
if (DUMP) await mkdir(DUMP, { recursive: true });
for (const route of ROUTES) {
  const pa = await get(A, route);
  const da = pa.status === 200 ? extract(pa.text) : null;
  if (!da) { console.log(`FAIL ${route}: A side HTTP ${pa.status} / no __NEXT_DATA__`); fails++; continue; }
  build ||= da.buildId;
  const dataPath = route === "/" ? `/_next/data/${build}/index.json` : `/_next/data/${build}${route}.json`;
  const ja = await get(A, dataPath);
  const jda = ja.status === 200 ? JSON.parse(ja.text) : null;
  if (DUMP) {
    const stem = route.replace(/\//g, "_") || "_";
    await writeFile(join(DUMP, stem + ".nextdata.json"), JSON.stringify(da, null, 1));
    if (jda) await writeFile(join(DUMP, stem + ".data.json"), JSON.stringify(jda, null, 1));
  }
  if (!B) {
    const self = jda ? diff(strip(da.props.pageProps), strip(jda.pageProps)) : ["_next/data missing: HTTP " + ja.status];
    if (self.length) { console.log(`FAIL ${route}: page __NEXT_DATA__ vs _next/data ${self.length} diff(s)`); for (const d of self.slice(0, 5)) console.log("    " + d); fails++; }
    else { console.log(`ok   ${route}  _next/data ${ja.status}  pageProps keys ${Object.keys(da.props.pageProps || {}).join(",")}`); ok++; }
    continue;
  }
  const pb = await get(B, route);
  const db = pb.status === 200 ? extract(pb.text) : null;
  if (!db) { console.log(`FAIL ${route}: B side HTTP ${pb.status} / no __NEXT_DATA__`); fails++; continue; }
  const jb = await get(B, dataPath);
  const jdb = jb.status === 200 ? JSON.parse(jb.text) : null;
  const d1 = diff(strip(da), strip(db));
  const d2 = jda && jdb ? diff(strip(jda), strip(jdb)) : (!jda && !jdb && ja.status === jb.status) ? [] : [`_next/data: A ${ja.status} vs B ${jb.status}`];
  if (d1.length || d2.length) { console.log(`FAIL ${route}: __NEXT_DATA__ ${d1.length} diff(s), _next/data ${d2.length} diff(s)`); for (const d of [...d1, ...d2].slice(0, 8)) console.log("    " + d); fails++; }
  else { console.log(`ok   ${route}`); ok++; }
}
console.log(`\n${fails ? "FAIL" : "PASS"} — ${ok} ok, ${fails} fail (build ${build}${NORM.size ? `, normalized: ${[...NORM].join(",")}` : ""})`);
process.exit(fails ? 1 : 0);
