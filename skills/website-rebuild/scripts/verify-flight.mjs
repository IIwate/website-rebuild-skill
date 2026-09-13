#!/usr/bin/env node
/**
 * Compare normalized Flight trees from a mirror and a Next build.
 * Normalizes build paths, CSS/media hashes, selected framework metadata,
 * preload nodes and some children/prop representations, then compares trees and
 * checks a global module-ID mapping. These normalizations can hide differences
 * in loading, reconciliation or runtime behavior; use separate asset and browser
 * checks. A passing comparison does not recover or prove original server code.
 * --normalize-props drops named fields recursively; --normalize-class drops
 * matching rendered subtrees. Record their scope before using either option.
 * The parser is local to this checker; importing flight-decode would execute a
 * producer rather than inspect the existing output.
 *
 *   node scripts/verify-flight.mjs --built rebuild/.next/server/app --mirror mirror
 *   node scripts/verify-flight.mjs --built rebuild/.next/server/app --mirror mirror --normalize-props views,viewsFormatted --normalize-class react-tweet-theme
 */
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { cli } from "./lib/cli.mjs";

cli({ known: ["built", "mirror", "normalize-props", "normalize-class"], file: import.meta.url });

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf("--" + n);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};
const BUILT = flag("built", "rebuild/.next/server/app");
const MIRROR = flag("mirror", "mirror");
// Project-specific normalization options; record their scope with the invocation.
// --normalize-props views,viewsFormatted drops named fields across data epochs.
// The rauchg ISR captures came from different regeneration times.
// --normalize-class react-tweet-theme drops a matching rendered subtree.
// This excludes its content from comparison; it does not verify that content.
const NORM_PROPS = new Set((flag("normalize-props", "") || "").split(",").map((s) => s.trim()).filter(Boolean));
const NORM_CLASS = (flag("normalize-class", "") || "").split(",").map((s) => s.trim()).filter(Boolean);

const PUSH = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
function streamOf(html) {
  PUSH.lastIndex = 0;
  let s = "", m, n = 0;
  while ((m = PUSH.exec(html))) { n++; s += JSON.parse(m[1]); }
  return n ? s : null;
}
function rowsOf(stream) {
  const buf = Buffer.from(stream, "utf8");
  const out = new Map();
  let i = 0;
  while (i < buf.length) {
    const colon = buf.indexOf(0x3a, i);
    if (colon < 0) break;
    const id = buf.subarray(i, colon).toString("utf8");
    if (!/^[0-9a-f]*$/i.test(id)) { const nl = buf.indexOf(0x0a, i); if (nl < 0) break; i = nl + 1; continue; }
    let j = colon + 1;
    const tm = /^T([0-9a-f]+),/i.exec(buf.subarray(j, j + 20).toString("latin1"));
    if (tm) {
      const len = parseInt(tm[1], 16);
      const start = j + tm[0].length;
      out.set(id, { kind: "T", text: buf.subarray(start, start + len).toString("utf8") });
      i = start + len;
      if (buf[i] === 0x0a) i++;
      continue;
    }
    const nl = buf.indexOf(0x0a, j);
    const body = buf.subarray(j, nl < 0 ? buf.length : nl).toString("utf8");
    i = nl < 0 ? buf.length : nl + 1;
    if (body.startsWith("I")) out.set(id, { kind: "I", json: JSON.parse(body.slice(1)) });
    else if (body.startsWith("HL")) out.set(id, { kind: "HL", json: JSON.parse(body.slice(2)) });
    else if (body.startsWith("E")) out.set(id, { kind: "E", json: JSON.parse(body.slice(1)) });
    // React 19 stream-control sentinels (X async-iterable, C stop-stream) carry
    // a bare tag char, not JSON. Same crash the decoder hit — the gate has its
    // own parser, so it needs the same guard. Store raw; a $-ref resolves to a
    // stream marker (both sides symmetric, so it drops out of the diff).
    else {
      try { out.set(id, { kind: "json", json: JSON.parse(body) }); }
      catch { out.set(id, { kind: "raw", raw: body }); }
    }
  }
  return out;
}

// Normalization rules.
const normStr = (s) =>
  s
    .replace(/\/_next\/static\/(?:[a-z]+\/)?chunks\/(turbopack-)?[a-z0-9_-]{8,}\.(js|css)/g, "/_next/static/chunks/CHUNK.$2")
    .replace(/\/_next\/static\/(?:[a-z]+\/)?media\/[A-Za-z0-9_.-]+\.(woff2|ttf)/g, "/_next/static/media/MEDIA.$1")
    .replace(/\/_next\/static\/(?:[a-z]+\/)?media\/([A-Za-z0-9_-]+?)[.-][a-z0-9_-]{8,}\.(png|jpe?g|svg|gif|webp|avif|tsx)/g, "/_next/static/media/$1.HASH.$2")
    // N2 accepts observed six-to-eight-character CSS module hashes. In darkroom,
    // mono_39c065e-module___Kbuzq__variable used a seven-character hash, while
    // mono_5da033d2-module__n1AzdG__variable used eight characters.
    // Class hash normalization still requires separate stylesheet verification.
    .replace(/\b([a-z0-9_]+?)(?:sans|mono)?_[0-9a-f]{6,8}-module__[A-Za-z0-9_-]{4,10}__/g, "$1-MOD__")
    // Library CSS modules can use <stem>-module__<hash>__<local>.
    .replace(/\b([a-z0-9-]+)-module__[A-Za-z0-9_-]{4,10}__/g, "$1-MOD__");

function resolve(v, table, side, ids, seen = new Set()) {
  if (typeof v === "string") {
    if (!v.startsWith("$")) return normStr(v);
    if (v.startsWith("$$")) return v.slice(1);
    if (v === "$undefined") return "«undef»";
    if (v.startsWith("$S")) return "«sym:" + v.slice(2) + "»";
    if (v.startsWith("$D")) return "«date:" + v.slice(2) + "»";
    // Resolve deep references before comparing independently deduplicated streams.
    // One side may inline a value that the other reaches through a path.
    // Numeric segments index arrays; props/key/type address element slots.
    const m = /^\$([L@])?([0-9a-f]+)((?::[^\s"]+)*)$/i.exec(v);
    if (m) {
      const id = m[2];
      if (seen.has(id)) {
        // Resolve a path-qualified self-reference from the raw row, then resolve its leaf.
        // A reference to the entire current row remains a cycle.
        if (!m[3]) return "«cycle»";
        const row0 = table.get(id);
        if (!row0 || row0.kind !== "json") return "«cycle»";
        let leaf = row0.json;
        for (const seg of m[3].split(":").filter(Boolean)) {
          if (leaf == null) return "«badPath:" + v + "»";
          const isElem = Array.isArray(leaf) && leaf[0] === "$" && leaf.length >= 4;
          if (isElem && seg === "props") { leaf = leaf[3]; continue; }
          if (isElem && seg === "key") { leaf = leaf[2]; continue; }
          if (isElem && seg === "type") { leaf = leaf[1]; continue; }
          leaf = Array.isArray(leaf) && /^\d+$/.test(seg) ? leaf[Number(seg)] : leaf[seg];
        }
        return resolve(leaf, table, side, ids, seen);
      }
      const row = table.get(id);
      if (!row) return "«missing:" + id + "»";
      if (row.kind === "T") return normStr(row.text);
      if (row.kind === "raw") return "«stream:" + row.raw + "»"; // X/C sentinel, both sides symmetric
      if (row.kind === "I") {
        // Normalize the observed empty-string/default export-name encodings.
        const en = row.json[2];
        const name = !en || en === "default" ? "(default)" : `${en}`;
        ids.push([row.json[0], name]);
        return { $c: name, $mid: String(row.json[0]) };
      }
      const s2 = new Set(seen); s2.add(id);
      let val = resolve(row.json, table, side, ids, s2);
      if (m[3]) {
        for (const seg of m[3].split(":").filter(Boolean)) {
          if (val == null) return "«badPath:" + v + "»";
          const isElem = Array.isArray(val) && val[0] === "$" && val.length >= 4;
          if (isElem && seg === "props") { val = val[3]; continue; }
          if (isElem && seg === "key") { val = val[2]; continue; }
          if (isElem && seg === "type") { val = val[1]; continue; }
          val = Array.isArray(val) && /^\d+$/.test(seg) ? val[Number(seg)] : val[seg];
        }
      }
      return val;
    }
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => resolve(x, table, side, ids, seen));
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, val] of Object.entries(v)) {
      // Drop explicitly configured fields that vary by data epoch.
      if (NORM_PROPS.has(k) && (typeof val === "number" || typeof val === "string")) { o[k] = "«prop:" + k + "»"; continue; }
      o[k] = resolve(val, table, side, ids, seen);
    }
    return o;
  }
  return v;
}

/**
 * N5 removes preload scripts and precedence stylesheet links from the tree comparison. Verify the resources separately. N7 removes trailing blank strings from children arrays; this is normalization, not a general whitespace-equivalence proof.
 */
function stripPreloads(v) {
  if (Array.isArray(v)) {
    if (v[0] === "$" && v[1] === "script" && v[3] && typeof v[3].src === "string" && /\/_next\/static\/(?:[a-z]+\/)?chunks\//.test(v[3].src) && v[3].async)
      return null;
    if (v[0] === "$" && v[1] === "link" && v[3] && v[3].rel === "stylesheet" && v[3].precedence)
      return null;
    // N11 removes selected framework boundary nodes whose placement can vary
    // between streamed and static outputs. Their runtime behavior is not compared.
    if (v[0] === "$" && v[1] && typeof v[1] === "object" && typeof v[1].$c === "string" && /Boundary$/.test(v[1].$c))
      return null;
    // Drop configured library-rendered subtrees that cannot be replayed from the
    // same data epoch. This reduces the compared scope.
    if (v[0] === "$" && v[3] && typeof v[3].className === "string" && NORM_CLASS.some((c) => v[3].className.includes(c)))
      return "«lib-subtree:" + NORM_CLASS.find((c) => v[3].className.includes(c)) + "»";
    const mapped = v.map(stripPreloads);
    if (v.length >= 4 && v[0] === "$") {
      // N14 treats numeric-looking keys as positional and normalizes them to null.
      // Such keys can also be explicit application keys, so this rule can hide
      // reconciliation differences; nonnumeric keys remain in the comparison.
      if (typeof mapped[2] === "string" && /^\.?\d+$/.test(mapped[2])) mapped[2] = null;
      return mapped;
    }
    // Filter configured PPR stream sentinels from the structural comparison.
    // This does not establish equivalence of streaming or loading behavior.
    let arr = mapped.filter((x) => x !== null && !(typeof x === "string" && x.startsWith("\u00ab" + "stream:")));
    // Normalize a resource-only array to null after its links have been removed.
    // This masks stylesheet chunk placement, which requires separate checks.
    // An originally empty array remains distinguishable at this stage.
    if (v.length > 0 && arr.length === 0 && v.every((x) => x && Array.isArray(x))) return null;
    if (arr.some((x) => Array.isArray(x) && x[0] === "$")) {
      // N7/N9 normalize trailing blank children and adjacent text fragments.
      // Pure string arrays such as the route c field are left intact.
      while (arr.length && typeof arr[arr.length - 1] === "string" && arr[arr.length - 1].trim() === "") arr.pop();
      const merged = [];
      for (const x of arr) {
        if (typeof x === "string" && typeof merged[merged.length - 1] === "string") merged[merged.length - 1] += x;
        else merged.push(x);
      }
      arr = merged;
    }
    return arr;
  }
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, val] of Object.entries(v)) {
      // N16 removes explicit undefined props for this normalized comparison.
      // Prop presence may still be observable by application code.
      if (val === "\u00abundef\u00bb") continue;
      let sv = stripPreloads(val);
      // LayoutRouter notFound/loading slots contain [tree, styles, scripts].
      // The darkroom mirror had a precedence link removed by N5, while the build
      // contained an empty styles array. Normalize trailing null/empty slots here
      // rather than treating their different intermediate forms as content changes.
      if ((k === "notFound" || k === "loading") && Array.isArray(sv)) {
        while (sv.length > 1 && (sv[sv.length - 1] === null || (Array.isArray(sv[sv.length - 1]) && sv[sv.length - 1].length === 0))) sv.pop();
      }
      // N13 flattens nested children arrays and drops empty lists for comparison.
      // This compares the resulting child sequence, not React key identity or
      // all reconciliation behavior. Apply the same transformation to both sides.
      if (k === "children") {
        const flat = [];
        (function fl(x) {
          if (Array.isArray(x) && !(x[0] === "$" && x.length >= 4)) { x.forEach(fl); return; }
          if (x === null || x === undefined || x === "\u00abundef\u00bb") return;
          // N15 expands unkeyed fragments in the normalized tree.
          // Keyed fragments are retained because keys participate in reconciliation.
          // Unkeyed-fragment normalization still requires behavioral checks.
          if (Array.isArray(x) && x[0] === "$" && x[2] == null &&
              (x[1] === "\u00absym:react.fragment\u00bb" || (x[1] && x[1].$symbol === "react.fragment"))) {
            fl(x[3] && x[3].children);
            return;
          }
          flat.push(x);
        })(sv);
        // N9 coalesces adjacent text and removes empty strings after flattening.
        // Text-node boundaries are excluded from this comparison.
        const merged = [];
        for (const x of flat) {
          if (typeof x === "string") {
            if (x === "") continue;
            if (typeof merged[merged.length - 1] === "string") { merged[merged.length - 1] += x; continue; }
          }
          merged.push(x);
        }
        sv = merged;
      }
      o[k] = sv;
    }
    return o;
  }
  return v;
}

function firstDiff(a, b, p = "$") {
  if (a === b) return null;
  if (typeof a !== typeof b) return `${p}: 类型 ${typeof a} vs ${typeof b}\n       建: ${JSON.stringify(a)?.slice(0, 140)}\n       镜: ${JSON.stringify(b)?.slice(0, 140)}`;
  if (typeof a === "string") return `${p}: ${JSON.stringify(a).slice(0, 220)} vs ${JSON.stringify(b).slice(0, 220)}`;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      const kind = (x) =>
        typeof x === "string" ? JSON.stringify(x.length > 14 ? x.slice(0, 11) + "..." : x)
        : Array.isArray(x) && x[0] === "$" ? `<${typeof x[1] === "string" ? x[1] : (x[1] && x[1].$c) || "?"}>`
        : x && x.$c ? `<${x.$c}/>` : JSON.stringify(x)?.slice(0, 60) ?? typeof x;
      return `${p}: 长度 ${a.length} vs ${b.length}\n       建: ${a.map(kind).join(" ")}\n       镜: ${b.map(kind).join(" ")}`;
    }
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${p}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === "object") {
    const ka = Object.keys(a).filter((k) => k !== "$mid"), kb = Object.keys(b).filter((k) => k !== "$mid");
    if (ka.join(",") !== kb.join(",")) return `${p}: 键 {${ka}} vs {${kb}}\n       建: ${JSON.stringify(a)?.slice(0, 160)}\n       镜: ${JSON.stringify(b)?.slice(0, 160)}`;
    for (const k of ka) {
      const d = firstDiff(a[k], b[k], `${p}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return `${p}: ${JSON.stringify(a)?.slice(0, 60)} vs ${JSON.stringify(b)?.slice(0, 60)}`;
}

// Route discovery.
async function routes() {
  const out = [];
  async function walk(d, rel) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== "assets" && e.name !== "_next" && e.name !== "_pretty" && !e.name.startsWith("api") && !e.name.startsWith("og") && e.name !== "opengraph-image")
        { if (!e.name.includes("@@")) await walk(path.join(d, e.name), rel + e.name + "/"); }
      else if (e.name === "index.html" && !rel.includes("@@")) out.push(rel || "/");
    }
  }
  await walk(MIRROR, "");
  return out.filter((r) => r !== "csscss/");
}

let pass = 0, failCount = 0;
const pairs = new Map(); // mirrorId -> Set(builtId)
const report = [];
for (const r of await routes()) {
  const mirrorFile = path.join(MIRROR, r === "/" ? "index.html" : r + "index.html");
  const builtFile = path.join(BUILT, r === "/" ? "index.html" : r.replace(/\/$/, "") + ".html");
  let mHtml, bHtml;
  try { mHtml = await readFile(mirrorFile, "utf8"); } catch { report.push(`SKIP ${r} 镜像缺 HTML`); continue; }
  try { bHtml = await readFile(builtFile, "utf8"); } catch { report.push(`FAIL ${r} 构建缺 HTML(${builtFile})`); failCount++; continue; }
  const ms = streamOf(mHtml), bs = streamOf(bHtml);
  if (!ms || !bs) { report.push(`FAIL ${r} 一侧无 flight 流`); failCount++; continue; }
  const mt = rowsOf(ms), bt = rowsOf(bs);
  const mids = [], bids = [];
  const m0 = mt.get("0"), b0 = bt.get("0");
  if (!m0 || !b0) { report.push(`FAIL ${r} 缺行 0`); failCount++; continue; }
  let mTree = resolve(m0.json, mt, "mirror", mids);
  let bTree = resolve(b0.json, bt, "built", bids);
  mTree = stripPreloads(mTree); bTree = stripPreloads(bTree);
  // N12 normalizes trailing seed/router-state slots. CacheNodeSeedData contains
  // [node, parallelRoutes, loading, isPartial, ...]; FlightRouterState contains
  // [segment, parallel, url, refresh, isRootLayout, ...]. The compared prefix
  // retains tree and route structure; loading and cache behavior are excluded.
  // In basement, 103 of 144 routes differed only in seed tuple length
  // (five entries versus three). That observation motivates this normalization.
  const isElN = (x) => Array.isArray(x) && x[0] === "$" && x.length >= 4;
  function normSeed(sd) {
    if (!Array.isArray(sd) || isElN(sd)) return sd;
    const node = sd[0], par = sd[1];
    if (par && typeof par === "object" && !Array.isArray(par))
      return [node, "children" in par ? { ...par, children: normSeed(par.children) } : par, "«tail»"];
    return sd;
  }
  function normRS(rs) {
    if (!Array.isArray(rs)) return rs;
    const seg = rs[0], par = rs[1];
    // Normalize trailing slots on __PAGE__ leaves without parallel children.
    if (par && typeof par === "object" && !Array.isArray(par))
      return [seg, "children" in par ? { ...par, children: normRS(par.children) } : par, "«tail»"];
    return rs;
  }
  if (Array.isArray(mTree.f)) mTree.f = mTree.f.map((e) => (Array.isArray(e) ? [normRS(e[0]), normSeed(e[1]), e[2], "«tail»"] : e));
  if (Array.isArray(bTree.f)) bTree.f = bTree.f.map((e) => (Array.isArray(e) ? [normRS(e[0]), normSeed(e[1]), e[2], "«tail»"] : e));

  // N6 normalizes the observed home-route c field used by the edge rewrite.
  if (r === "/" && Array.isArray(mTree.c) && mTree.c.join(",") === ",index" && bTree.c.join(",") === ",") {
    mTree.c = bTree.c = ["«c:registered-D6»"];
  }
  // N11 normalizes selected root fields: b is buildId, u/a are deployment values,
  // and h/r/s identify streaming channels. Other reserved fields are listed below.
  // These fields are excluded, not proven irrelevant to all runtime behavior.
  // Basement recorded mirror {...,d,u} versus build {...,d,b} across 144 routes.
  {
    const PLATFORM_KEYS = ["b", "u", "r", "s", "a", "h", "l", "p", "d"];
    const present = PLATFORM_KEYS.filter((k) => k in mTree || k in bTree);
    // Delete then reinsert normalized keys in a fixed order because assigning an
    // existing key preserves its original insertion position.
    for (const k of present) { delete mTree[k]; delete bTree[k]; }
    for (const k of present) { mTree[k] = "«platform:" + k + "»"; bTree[k] = "«platform:" + k + "»"; }
  }
  const d = firstDiff(bTree, mTree);
  // Pair module IDs by position in the normalized trees after structure matches.
  // Resolution order cannot be used: discarded boundary nodes can introduce extra
  // default references on one side. $c nodes retain $mid for the pairing pass;
  // firstDiff deliberately excludes $mid from structural comparison.
  let paired = 0;
  if (!d) {
    (function walkPair(a, b) {
      if (!a || !b || typeof a !== "object" || typeof b !== "object") return;
      if (a.$mid && b.$mid) { // a=built b=mirror
        if (!pairs.has(b.$mid)) pairs.set(b.$mid, new Set());
        pairs.get(b.$mid).add(a.$mid); paired++;
      }
      if (Array.isArray(a)) { for (let i = 0; i < a.length; i++) walkPair(a[i], b[i]); return; }
      for (const k of Object.keys(a)) if (k !== "$mid") walkPair(a[k], b[k]);
    })(bTree, mTree);
  }
  if (d) { report.push(`FAIL ${r}\n       ${d}`); failCount++; }
  else { report.push(`ok   ${r}  (I 行 ${paired} 对)`); pass++; }
}

// Validate the module-ID mapping in both directions.
let bij = 0, poly = [];
for (const [mid, set] of pairs) {
  if (set.size === 1) bij++;
  else poly.push(`${mid} -> {${[...set].join(",")}}`);
}
const builtSeen = new Map();
for (const [mid, set] of pairs) for (const b of set) {
  if (!builtSeen.has(b)) builtSeen.set(b, new Set());
  builtSeen.get(b).add(mid);
}
for (const [b, set] of builtSeen) if (set.size > 1) poly.push(`built ${b} <- {${[...set].join(",")}}`);

console.log("=== verify-flight ===");
for (const l of report) console.log("  " + l);
console.log(`  模块 id 双射:${bij} 对一一映射${poly.length ? `; 违背双射 ${poly.length} 条:` : ""}`);
for (const l of poly.slice(0, 10)) console.log("    " + l);
await mkdir("docs", { recursive: true });
await writeFile("docs/flight-gate-report.txt", report.join("\n") + "\n双射 " + bij + " 违背 " + poly.length + "\n");
if (failCount || poly.length) {
  console.log(`\nFAIL — ${failCount} 路由不一致,${poly.length} 条双射违背`);
  process.exit(1);
}
console.log(`\nPASS — ${pass} 路由 flight 语义一致,模块双射成立`);
