#!/usr/bin/env node
/**
 * verify-mirror.mjs — THE MIRROR'S OWN GATE.
 *
 * WHY THIS SCRIPT EXISTS
 * ---------------------------------------------------------------------------
 * Every other gate in this toolchain asks a rendering question. probe.mjs asks
 * "any 404s, any console errors, any outbound request?". verify-offline.mjs
 * asks "does anything still name an external host?". pixelcompare.mjs asks
 * "do the two sides look the same?". verify-routes/verify-ssr ask "does the
 * rebuild restate the mirror?".
 *
 * NONE of them asks whether the mirror is the right bytes. So a mirror can be
 * wrong and every one of them goes green:
 *
 *   - a pathname-only url -> path mapping collapses `x.jpg?width=320|600|1200`
 *     into ONE file. The server answers every width with it, the srcset picks
 *     it, the page renders, zero 404s. (objectandarchive M0: 57 paths, 3-5
 *     variants each. See lib/urlpath.mjs.)
 *   - a quote-keyed srcset regex sees 1 of ~5 candidates per set. The ledger
 *     looks complete because the first candidate of every set is present.
 *   - a gap-filling run rewrites the manifest from scratch and drops the record
 *     of the 1,200 files already on disk; sha256 columns then describe files
 *     nobody can name.
 *
 * Downstream the symptom of all three is: nothing. That is what this gate is
 * for. It asks four questions of the mirror itself, and it fails loudly.
 *
 *   1  MAPPING INJECTIVITY — do two different URLs share one file?
 *      Checked twice: on the paths the ledger RECORDED (the collapse that
 *      actually happened on disk) and on the paths lib/urlpath.mjs computes
 *      TODAY (a mapping or a query policy that would collapse them now).
 *      A disagreement between the two is MAPPING DRIFT: the mirror was written
 *      under one policy and is being served/audited under another.
 *   2  LEDGER CONSISTENCY — does every manifest row's sha256/bytes match the
 *      bytes on disk, does inventory.tsv agree with the manifest, and does the
 *      set of ledger paths equal the set of files on disk (no orphans, no
 *      phantoms)?
 *   3  CLOSURE — reference set − disk set = ∅, using the SAME extractor the
 *      crawler used (lib/extract-refs.mjs), so the gate cannot inherit the
 *      crawler's blind spot. This is mirroring.md's "pass 4" as an executable
 *      gate. Deliberate non-files (base-URL literals) and accepted-degradation
 *      hosts get an allow-list: --allow-missing external.txt.
 *   4  RESAMPLE (optional, OFF by default) — re-request a few URLs from the
 *      live origin and compare sha256 against the ledger. Off by default so a
 *      routine gate run never touches the source site; when on it is
 *      deliberately slow (--resample-delay, default 1500 ms).
 *
 * Usage:
 *   node verify-mirror.mjs --mirror legacy-mirror
 *   node verify-mirror.mjs --mirror legacy-mirror --allow-missing legacy-mirror/external.txt
 *   node verify-mirror.mjs --mirror legacy-mirror --resample 8 --resample-delay 2000
 *
 *   [--origin https://example.com]  default: the manifest's own `origin`
 *   [--hosts a,b]                   extra hosts for the closure pass (default:
 *                                   every host that appears in the ledger)
 *   [--allow-missing FILE]          newline list; a line matching the start of a
 *                                   missing URL excuses it ("#" comments ok)
 *   [--skip mapping,ledger,closure,resample]
 *   [--resample N] [--resample-delay MS] [--resample-seed N] [--resample-html]
 *   [--max-report 25]
 *
 * Exit code 0 = all selected gates pass, 1 = at least one failed, 2 = usage.
 *
 * New in this toolchain (objectandarchive-rebuild M0 wrote the lessons; the
 * TODO list has carried a site-coupled careers-kimi ancestor since the start).
 */
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { localRelPath, loadPolicy, describePolicy, canonicalUrl } from "./lib/urlpath.mjs";
import { createRefExtractor } from "./lib/extract-refs.mjs";

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf("--" + n);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};

const ROOT = path.resolve(flag("mirror", "legacy-mirror"));
const SKIP = new Set(flag("skip", "").split(",").map((s) => s.trim()).filter(Boolean));
const MAX_REPORT = Number(flag("max-report", 25));
const RESAMPLE = Number(flag("resample", 0));
const RESAMPLE_DELAY = Number(flag("resample-delay", 1500));
const RESAMPLE_SEED = Number(flag("resample-seed", 1));
const RESAMPLE_HTML = args.includes("--resample-html");
const ALLOW_FILE = flag("allow-missing", null);
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Files that are the ledger, not the mirror; plus the two TOP-LEVEL toolchain
// output dirs and dotfiles. The prefixes are matched only at the root on
// purpose: plenty of origins serve real assets out of `_next/`, `_nuxt/`,
// `_astro/`, and excluding those would quietly shrink both the coverage check
// and the set of files the closure gate scans.
const LEDGER_FILES = new Set([
  "mirror-manifest.json",
  "inventory.tsv",
  "redirects.tsv",
  "netcapture.tsv",
  "external.txt",
  "urlpath-policy.json",
]);
const TOOL_DIRS = ["_pretty/", "_scripts/"];
const isBookkeeping = (rel) =>
  LEDGER_FILES.has(rel) ||
  TOOL_DIRS.some((d) => rel.startsWith(d)) ||
  rel.split("/").some((seg) => seg.startsWith("."));

const TEXT = /\.(html?|css|js|mjs|json|svg)$/i;

let failures = 0;
const fail = (gate, msg) => {
  failures++;
  console.log(`  FAIL ${gate} — ${msg}`);
};
const ok = (gate, msg) => console.log(`  ok   ${gate} — ${msg}`);
const list = (rows, render) => {
  for (const r of rows.slice(0, MAX_REPORT)) console.log(render(r));
  if (rows.length > MAX_REPORT) console.log(`         ... ${rows.length - MAX_REPORT} more`);
};

// --- load the ledgers -------------------------------------------------------

let manifest;
try {
  manifest = JSON.parse(await readFile(path.join(ROOT, "mirror-manifest.json"), "utf8"));
} catch (e) {
  console.error(`FATAL: cannot read ${path.join(ROOT, "mirror-manifest.json")}: ${e.message}`);
  console.error("       verify-mirror.mjs audits a mirror produced by mirror-site.mjs.");
  process.exit(2);
}
const ORIGIN = (flag("origin", manifest.origin || "") || "").replace(/\/+$/, "");
if (!ORIGIN) {
  console.error("FATAL: no origin — pass --origin https://example.com (the manifest has none).");
  process.exit(2);
}
const ORIGIN_HOST = new URL(ORIGIN).hostname;
const POLICY = await loadPolicy(ROOT);
const FILES = manifest.files || {};
const entries = Object.entries(FILES);
const saved = entries.filter(([, f]) => f && f.path);
const failedRows = entries.filter(([, f]) => f && !f.path);
// The 404 template is stored under a name that is NOT its URL's mapping (the
// crawler probes /no-such-page and files the body as 404.html on purpose), so
// it is exempt from the recomputed-mapping checks — not from the byte checks.
const isTemplate = ([, f]) => f.path === "404.html";

const norm = (p) => String(p).split(path.sep).join("/");

console.log(`=== verify-mirror  ${ROOT} ===`);
console.log(`  origin        ${ORIGIN}`);
console.log(`  ledger        ${saved.length} files recorded, ${failedRows.length} failed rows`);
console.log(`  ${describePolicy(POLICY)}`);

// --- gate 1: mapping injectivity -------------------------------------------

if (!SKIP.has("mapping")) {
  console.log(`\n--- gate MAPPING INJECTIVITY ---`);

  // (a) the collapse as it actually happened: two URLs, one recorded path.
  // URLs are canonicalised first (fragment stripped). RFC 3986: the fragment
  // never reaches the server, so two spellings that differ only there are ONE
  // resource and one set of bytes — reporting them as a collapse is a false
  // red, and a loud false red on the mirror gate is expensive: it teaches you
  // to skim this gate's output. Everything else is compared verbatim.
  const byRecorded = new Map();
  for (const [url, f] of saved) {
    const key = norm(f.path);
    if (!byRecorded.has(key)) byRecorded.set(key, new Set());
    byRecorded.get(key).add(canonicalUrl(url));
  }
  const collided = [...byRecorded].map(([p, s]) => [p, [...s]]).filter(([, urls]) => urls.length > 1);
  if (collided.length) {
    fail(
      "recorded",
      `${collided.length} disk file(s) are claimed by more than one URL — the mirror is ` +
        `NOT a restatement of the origin's URL space; whichever fetch finished last won:`,
    );
    list(collided, ([p, urls]) => `         ${p}\n${urls.map((u) => `           <- ${u}`).join("\n")}`);
  } else {
    ok("recorded", `${saved.length} ledger rows -> ${byRecorded.size} distinct files, injective on canonical URLs`);
  }

  // (b) the mapping as it stands today, under the mirror's stored policy.
  const byComputed = new Map();
  const drift = [];
  for (const [url, f] of saved) {
    if (isTemplate([url, f])) continue;
    let rel;
    try {
      rel = localRelPath(url, ORIGIN_HOST, POLICY);
    } catch {
      continue;
    }
    if (!byComputed.has(rel)) byComputed.set(rel, new Set());
    byComputed.get(rel).add(canonicalUrl(url));
    if (rel !== norm(f.path)) drift.push({ url, recorded: norm(f.path), computed: rel });
  }
  const wouldCollide = [...byComputed].map(([p, s]) => [p, [...s]]).filter(([, urls]) => urls.length > 1);
  if (wouldCollide.length) {
    fail(
      "computed",
      `${wouldCollide.length} path(s) would be shared by several URLs under the CURRENT policy ` +
        `— re-mirroring now would collapse them (${describePolicy(POLICY)}):`,
    );
    list(wouldCollide, ([p, urls]) => `         ${p}\n${urls.map((u) => `           <- ${u}`).join("\n")}`);
  } else {
    ok("computed", `lib/urlpath.mjs maps those URLs to ${byComputed.size} distinct paths`);
  }

  if (drift.length) {
    fail(
      "drift",
      `${drift.length} file(s) sit at a path the current mapping would NOT choose. The mirror ` +
        `was written under a different mapping or query policy than the one in force now; ` +
        `serving it this way answers requests with the wrong file or a 404:`,
    );
    list(drift, (d) => `         ${d.url}\n           on disk: ${d.recorded}\n           mapping: ${d.computed}`);
  } else {
    ok("drift", "recorded paths agree with the mapping in force");
  }
}

// --- gate 2: ledger consistency --------------------------------------------

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(p);
    s.on("error", reject);
    s.on("data", (c) => h.update(c));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

async function* walk(dir) {
  let ents;
  try {
    ents = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of ents) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) yield* walk(p);
    else if (d.isFile()) yield p;
  }
}

const diskFiles = new Set();
for await (const f of walk(ROOT)) {
  const rel = norm(path.relative(ROOT, f));
  if (!isBookkeeping(rel)) diskFiles.add(rel);
}

if (!SKIP.has("ledger")) {
  console.log(`\n--- gate LEDGER CONSISTENCY ---`);

  const badHash = [];
  const badSize = [];
  const absent = [];
  for (const [url, f] of saved) {
    const rel = norm(f.path);
    const abs = path.join(ROOT, f.path);
    let st;
    try {
      st = await stat(abs);
    } catch {
      absent.push({ url, rel });
      continue;
    }
    if (typeof f.bytes === "number" && st.size !== f.bytes) {
      badSize.push({ url, rel, ledger: f.bytes, disk: st.size });
    }
    if (f.sha256) {
      const disk = await sha256File(abs);
      if (disk !== f.sha256) badHash.push({ url, rel, ledger: f.sha256, disk });
    }
  }

  if (absent.length) {
    fail("on-disk", `${absent.length} ledger row(s) name a file that does not exist:`);
    list(absent, (a) => `         ${a.rel}  <- ${a.url}`);
  } else {
    ok("on-disk", `all ${saved.length} ledger rows resolve to a file`);
  }

  if (badSize.length || badHash.length) {
    fail(
      "bytes",
      `${badHash.length} sha256 mismatch(es), ${badSize.length} size mismatch(es) — the ledger ` +
        `describes bytes that are not the bytes on disk:`,
    );
    list(badHash, (b) => `         ${b.rel}\n           ledger ${b.ledger}\n           disk   ${b.disk}`);
    list(badSize, (b) => `         ${b.rel}  ledger ${b.ledger} B, disk ${b.disk} B`);
  } else {
    ok("bytes", `sha256 + size verified against disk for ${saved.filter(([, f]) => f.sha256).length} files`);
  }

  const ledgerPaths = new Set(saved.map(([, f]) => norm(f.path)));
  const orphans = [...diskFiles].filter((p) => !ledgerPaths.has(p)).sort();
  if (orphans.length) {
    fail(
      "coverage",
      `${diskFiles.size} files on disk vs ${ledgerPaths.size} in the ledger — ${orphans.length} ` +
        `file(s) nobody can name a URL for (fetched off the books, or a ledger overwritten by a ` +
        `later partial run):`,
    );
    list(orphans, (p) => `         ${p}`);
  } else {
    ok("coverage", `${diskFiles.size} files on disk, all named by the ledger`);
  }

  // inventory.tsv is the human-readable half of the same ledger; if the two
  // disagree, every later citation of "the inventory" is citing a fiction.
  try {
    const tsv = await readFile(path.join(ROOT, "inventory.tsv"), "utf8");
    const rows = tsv.trim().split("\n").slice(1).filter(Boolean);
    const invBad = [];
    const seenUrls = new Set();
    for (const line of rows) {
      const [sha, bytes, p, url] = line.split("\t");
      seenUrls.add(url);
      const f = FILES[url];
      if (!f || !f.path) invBad.push({ url, why: "not in mirror-manifest.json" });
      else if (norm(f.path) !== norm(p)) invBad.push({ url, why: `path ${p} != manifest ${f.path}` });
      else if (f.sha256 && f.sha256 !== sha) invBad.push({ url, why: "sha256 differs from manifest" });
      else if (String(f.bytes) !== String(bytes)) invBad.push({ url, why: "bytes differ from manifest" });
    }
    const missingRows = saved.filter(([url]) => !seenUrls.has(url));
    if (invBad.length || missingRows.length) {
      fail(
        "inventory",
        `inventory.tsv disagrees with mirror-manifest.json: ${invBad.length} bad row(s), ` +
          `${missingRows.length} manifest file(s) absent from the inventory:`,
      );
      list(invBad, (b) => `         ${b.url}\n           ${b.why}`);
      list(missingRows, ([url]) => `         (missing row) ${url}`);
    } else {
      ok("inventory", `inventory.tsv agrees with the manifest on ${rows.length} rows`);
    }
  } catch {
    fail("inventory", "no inventory.tsv next to the bytes (mirror-site.mjs writes one)");
  }

  if (failedRows.length) {
    console.log(
      `  info ${failedRows.length} ledger row(s) record a FAILED fetch — each must be a registered ` +
        `deviation or be re-fetched (--seeds), not a silent hole:`,
    );
    list(failedRows, ([url, f]) => `         ${url}  (${f.error || "no error recorded"})`);
  }
}

// --- gate 3: closure --------------------------------------------------------

if (!SKIP.has("closure")) {
  console.log(`\n--- gate CLOSURE (reference set − disk set = ∅) ---`);

  const allow = [];
  if (ALLOW_FILE) {
    try {
      for (const line of (await readFile(ALLOW_FILE, "utf8")).split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        // external.txt has no single fixed column order in the wild. This
        // toolchain's own template writes "<DECISION> | <target> | why", the
        // older shape was "<url or host> <decision> …". Splitting on BOTH the
        // pipe and whitespace and taking the first URL-or-host-looking token
        // reads either. Measured: with the old first-token-only rule, a whole
        // external.txt parsed to ZERO prefixes and the gate silently ran with
        // an empty allow-list, so its CLOSURE failures could never be excused
        // no matter what the file said.
        //
        // A MIRROR decision is deliberately NOT an excuse: that decision says
        // "this host's files are on disk", so a missing one is a real hole.
        // Only the not-a-file / degraded / stubbed / content decisions excuse.
        const cells = t.split(/[|\s]+/).filter(Boolean);
        const decision = /^(MIRROR|STUB|DEGRADE|CONTENT|LATENT|NOTFILE)$/i.exec(cells[0] || "");
        if (decision && /^MIRROR$/i.test(decision[0])) continue;
        const tok = cells.find((c) => /^https?:\/\//i.test(c) || /^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(c));
        if (tok) allow.push(tok);
      }
      console.log(`  info ${allow.length} allow-list prefix(es) from ${ALLOW_FILE}`);
    } catch (e) {
      console.log(`  info could not read --allow-missing ${ALLOW_FILE}: ${e.message}`);
    }
  }
  const allowed = (url) =>
    allow.some((a) => url.startsWith(a) || url.startsWith("https://" + a) || url.startsWith("http://" + a));

  // Hosts worth resolving: every host the ledger already contains, plus --hosts.
  const hosts = new Set([ORIGIN_HOST, ...flag("hosts", "").split(",").map((s) => s.trim()).filter(Boolean)]);
  for (const [url] of saved) {
    try {
      hosts.add(new URL(url).hostname);
    } catch {}
  }
  const extract = createRefExtractor({ origin: ORIGIN, originHost: ORIGIN_HOST, assetHosts: hosts });

  // A mirrored file's own URL is its base, so relative refs (CSS url()) resolve
  // the way the browser resolved them.
  const pathToUrl = new Map();
  for (const [url, f] of saved) pathToUrl.set(norm(f.path), url);

  const refs = new Map(); // url -> Set(referrer)
  let scanned = 0;
  for (const rel of diskFiles) {
    if (!TEXT.test(rel)) continue;
    const abs = path.join(ROOT, rel);
    const st = await stat(abs);
    if (st.size > 16 * 1024 * 1024) continue;
    scanned++;
    const base = pathToUrl.get(rel) || ORIGIN + "/" + rel;
    for (const u of extract(await readFile(abs, "utf8"), base)) {
      if (!refs.has(u)) refs.set(u, new Set());
      refs.get(u).add(rel);
    }
  }

  const missing = [];
  for (const [url, from] of refs) {
    if (allowed(url)) continue;
    let rel;
    try {
      rel = localRelPath(url, ORIGIN_HOST, POLICY);
    } catch {
      continue;
    }
    if (!diskFiles.has(rel)) missing.push({ url, rel, from: [...from].slice(0, 2) });
  }

  console.log(`  info scanned ${scanned} text files, ${refs.size} distinct references`);
  if (missing.length) {
    const byHost = new Map();
    for (const m of missing) {
      const h = new URL(m.url).hostname;
      if (!byHost.has(h)) byHost.set(h, []);
      byHost.get(h).push(m);
    }
    fail("closure", `${missing.length} reference(s) resolve to nothing on disk:`);
    for (const [h, rows] of [...byHost].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`         ${h}  (${rows.length})`);
      list(rows, (m) => `           ${m.url}\n             <- ${m.from.join(", ")}`);
    }
    console.log(
      `         Each must be fetched (mirror-site.mjs --seeds) or get a line in the mirror's\n` +
        `         external.txt and be excused here with --allow-missing.`,
    );
  } else {
    ok("closure", "reference set − disk set = ∅");
  }
}

// --- gate 4: sampled re-fetch (opt-in) --------------------------------------

if (!SKIP.has("resample") && RESAMPLE > 0) {
  console.log(`\n--- gate RESAMPLE (${RESAMPLE} URLs, ${RESAMPLE_DELAY} ms apart) ---`);
  // Deterministic sample so a failing run can be repeated exactly; change the
  // set with --resample-seed.
  let s = RESAMPLE_SEED >>> 0 || 1;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pool = saved
    .filter(([, f]) => f.sha256)
    .filter(([, f]) => RESAMPLE_HTML || !/\.html?$/i.test(f.path))
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const picked = [];
  const used = new Set();
  while (picked.length < Math.min(RESAMPLE, pool.length)) {
    const i = Math.floor(rnd() * pool.length);
    if (used.has(i)) continue;
    used.add(i);
    picked.push(pool[i]);
  }
  if (!RESAMPLE_HTML) {
    console.log(`  info HTML excluded (nonces/session tokens make it differ every request); --resample-html to include`);
  }

  const differ = [];
  const errored = [];
  for (const [url, f] of picked) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": UA, accept: "*/*", referer: ORIGIN + "/" },
        redirect: "manual",
      });
      if (res.status >= 300) {
        errored.push({ url, why: `HTTP ${res.status}` });
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        const sha = createHash("sha256").update(buf).digest("hex");
        if (sha !== f.sha256) differ.push({ url, ledger: f.sha256, live: sha, bytes: [f.bytes, buf.length] });
      }
    } catch (e) {
      errored.push({ url, why: e.message });
    }
    await new Promise((r) => setTimeout(r, RESAMPLE_DELAY));
  }

  if (differ.length) {
    fail("resample", `${differ.length}/${picked.length} sampled URL(s) no longer match the ledger:`);
    list(
      differ,
      (d) =>
        `         ${d.url}\n           ledger ${d.ledger} (${d.bytes[0]} B)\n           live   ${d.live} (${d.bytes[1]} B)`,
    );
    console.log(
      `         A transform CDN may legitimately re-encode over time — but a DIFFER on a\n` +
        `         content-hashed or versioned URL means the mirror and the origin have parted.`,
    );
  } else {
    ok("resample", `${picked.length}/${picked.length} sampled URLs still byte-identical to the ledger`);
  }
  if (errored.length) {
    console.log(`  info ${errored.length} sample(s) could not be compared:`);
    list(errored, (e) => `         ${e.url}  (${e.why})`);
  }
} else if (!SKIP.has("resample")) {
  console.log(`\n--- gate RESAMPLE — skipped (--resample N to re-check N URLs against the live origin) ---`);
}

// ---------------------------------------------------------------------------

console.log(
  `\n${failures ? "FAIL" : "PASS"} — ${failures} mirror-level problem(s). ` +
    `A green run here is what makes the downstream render-level gates mean something.`,
);
process.exit(failures ? 1 : 0);
