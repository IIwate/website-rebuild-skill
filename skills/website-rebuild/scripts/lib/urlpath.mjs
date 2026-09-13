// Map URLs to local paths consistently across the crawler, server and checks.
//
// Query parameters can select different assets. In objectandarchive, one image
// at widths 320, 600 and 1200 returned 43,196, 163,064 and 328,321 bytes. A
// pathname-only mapping overwrote those variants while ordinary loading checks
// still passed.
//
//   /cdn/shop/x.jpg?v=1&width=600 -> cdn/shop/x@@v=1&width=600.jpg
//   /collections/foo?page=2     -> collections/foo@@page=2/index.html
//   https://cdn.other.com/a.js?b=1 -> assets/cdn.other.com/a@@b=1.js
//
// Query suffixes precede extensions so MIME detection still works. Parameters
// are sorted; verify that order is insignificant for the target service.
// Filesystem-hostile or long suffixes use a truncated SHA-1 digest. This avoids
// lossy character substitution but cannot guarantee collision-free naming;
// verify-mirror.mjs checks collisions among the observed URL records.
//
// All parameters are retained by default. Use --query-ignore or --query-only
// only for an established site-specific equivalence. urlpath-policy.json records
// that choice beside the mirror, and consumers load the same policy.


import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const POLICY_FILE = "urlpath-policy.json";

/**
 * The identity of a fetched resource. RFC 3986: the FRAGMENT is never sent to
 * the server, so `x.css?v=1` and `x.css?v=1#Shape-Arch` are ONE resource with
 * one set of bytes — not two URLs that collapsed onto one file.
 *
 * This helper exists because two different things were both true and only one
 * of them was right:
 *   - localRelPath() already ignores the fragment (it reads pathname + search),
 *     so the BYTES on disk were always correct;
 *   - but a crawler that enqueues the raw href records TWO ledger rows for that
 *     one resource, and verify-mirror's injectivity gate then reports a
 *     collapse that never happened ("whichever fetch finished last won" — when
 *     in fact both fetches asked the origin for the identical thing).
 * Measured on objectandarchive M2: exactly one such pair, from a `#Shape-Arch`
 * reference on a stylesheet URL. Canonicalise on the way INTO the queue and on
 * the way into the gate, or the two disagree about how many URLs exist.
 */
export function canonicalUrl(abs) {
  try {
    const u = new URL(abs);
    u.hash = "";
    return u.href;
  } catch {
    return String(abs);
  }
}

const MAX_SUFFIX = 96;
// Filesystem, URL and shell metacharacters use the hash form. Keep this mapping
// stable across the crawler, server and ledger checks.
const HOSTILE = /[/\\?%*:|"'<>&=\x00-\x1f\x7f]/;

/**
 * Preserve all query parameters by default. Canonicalization and sorting still
 * map fragment-only and parameter-order differences to the same resource path.
 */
export const DEFAULT_POLICY = Object.freeze({ ignore: [], only: null });

/**
 * Cache-buster spellings seen in the wild. NOT ignored by default — this list
 * is a menu for `--query-ignore`, not a behaviour. Passing one of these without
 * checking is how a real transform param (`t` for "trim" on some CDNs, `v` for
 * "variant" on others) gets dropped and the collapse comes back.
 */
export const COMMON_CACHE_BUSTERS = Object.freeze([
  "v", "ver", "version", "rev", "_", "t", "ts", "cb", "cachebust", "nocache",
]);

/** Accept a loose object (or nothing) and return a canonical policy. */
export function normalizePolicy(p) {
  const list = (x) =>
    (Array.isArray(x) ? x : String(x ?? "").split(","))
      .map((s) => String(s).trim())
      .filter(Boolean)
      .sort();
  if (!p) return DEFAULT_POLICY;
  const only = p.only === null || p.only === undefined || p.only === "" ? null : list(p.only);
  return Object.freeze({ ignore: list(p.ignore), only: only && only.length ? only : null });
}

/** One-line, log-friendly description — printed by every script that loads one. */
export function describePolicy(policy) {
  const p = normalizePolicy(policy);
  if (p.only) return `query policy: ONLY [${p.only.join(", ")}] in path key`;
  if (p.ignore.length) return `query policy: all params except [${p.ignore.join(", ")}]`;
  return "query policy: every query param is part of the path key (default)";
}

/** Read `--query-ignore` / `--query-only` off an argv array. */
export function policyFromArgs(args) {
  const val = (name) => {
    const i = args.indexOf("--" + name);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : null;
  };
  const ignore = val("query-ignore");
  const only = val("query-only");
  if (ignore === null && only === null) return null; // "not specified", ≠ default
  return normalizePolicy({ ignore: ignore ?? [], only });
}

/**
 * Load the policy a mirror was written with. Absent file = the default, which
 * is also what a mirror produced before this module existed used implicitly.
 */
export async function loadPolicy(root) {
  try {
    return normalizePolicy(JSON.parse(await readFile(join(root, POLICY_FILE), "utf8")));
  } catch {
    return DEFAULT_POLICY;
  }
}

/** Record the policy next to the bytes it produced. */
export async function savePolicy(root, policy) {
  const p = normalizePolicy(policy);
  await writeFile(
    join(root, POLICY_FILE),
    JSON.stringify(
      {
        _comment:
          "url -> local path query policy for this mirror (scripts/lib/urlpath.mjs). " +
          "Serving or auditing the mirror under a different policy is a defect: " +
          "verify-mirror.mjs reports it as MAPPING DRIFT.",
        ignore: p.ignore,
        only: p.only,
      },
      null,
      2,
    ) + "\n",
  );
  return p;
}

/** The params that are part of the path key, sorted, per policy. */
function keyedParams(search, policy) {
  const p = normalizePolicy(policy);
  const out = [];
  for (const [k, v] of new URLSearchParams(search)) {
    if (p.only) {
      if (!p.only.includes(k)) continue;
    } else if (p.ignore.includes(k)) continue;
    out.push([k, v]);
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
}

/** Normalised, filesystem-safe encoding of a URL search string ("" if none). */
export function querySuffix(search, policy = DEFAULT_POLICY) {
  if (!search || search === "?") return "";
  const params = keyedParams(search, policy);
  if (!params.length) return "";
  const raw = params.map(([k, v]) => (v === "" ? k : `${k}=${v}`)).join("&");
  // HOSTILE is tested against each key and value SEPARATELY, never against the
  // joined string: `&` and `=` are the join characters, so they are legal in the
  // result but ambiguous inside a value (`?a=b&c` vs `?a=b%26c`) — both cases
  // use different suffix forms. The hashed form still requires collision
  // checks against the observed URL records.
  const hostile = params.some(([k, v]) => HOSTILE.test(k) || HOSTILE.test(v));
  if (hostile || raw.length > MAX_SUFFIX) {
    return "@@h" + createHash("sha1").update(raw).digest("hex").slice(0, 12);
  }
  return "@@" + raw;
}

/**
 * Does this path END in a file extension? The page-vs-asset test, in ONE place
 * so the writer (localRelPath) and the lookup (serveCandidates) cannot answer
 * it differently for the same name.
 *  {1,12}, not {1,8}: `.webmanifest` is ELEVEN characters and the shorter cap
 * classified it as a page, so the crawler wrote the file as a DIRECTORY with an
 * index.html inside while serve.mjs (which sees a real extension via
 * path.extname) looked for a file and 404'd. The cap still exists — it keeps a
 * path segment like `/v1.2.3` from reading as an extension — it was just set
 * before `.webmanifest`, `.geojson` and friends were common. lib/extract-refs.mjs
 * exports the same cap as EXT; the two must not drift.
 */
const hasExt = (p) => p.includes(".") && /\.[a-z0-9]{1,12}$/i.test(p);

/** Insert a query suffix into "dir/name.ext" -> "dir/name@@q.ext". */
export function withQuerySuffix(p, suffix) {
  if (!suffix) return p;
  const slash = p.lastIndexOf("/");
  const dot = p.lastIndexOf(".");
  if (dot > slash) return p.slice(0, dot) + suffix + p.slice(dot);
  return p + suffix;
}

// Extensions that make a NON-FINAL segment a file rather than a directory.
//  A known list, not "any dotted segment": a version directory like
// `/decoders/1.5.5/…` must NOT flatten, and a dot-anywhere rule would have
// silently remapped every existing mirror that has one.
const PATH_TAIL_EXT =
  /^(.*?\.(?:jpe?g|png|gif|webp|avif|svg|ico|mp4|webm|mov|mp3|wav|pdf|css|js|mjs|json|woff2?|ttf|otf|glb|gltf|ktx2|wasm|zip))(\/.+)$/i;

/**
 *  A URL PATH CAN CONTINUE PAST A FILE. Storyblok's image service appends
 * transforms UNDER the original's path: `…/team-hero.jpg` is the original and
 * `…/team-hero.jpg/m/110x110/filters:format(avif):quality(70)` is a variant.
 * A naive mapping needs `team-hero.jpg` to be a file and a directory at once,
 * and the crawl fails both ways — ENOTDIR creating the variant after the
 * original, EISDIR writing the original after a variant. Measured: every
 * storyblok asset with transforms, ~1,700 entries.
 *
 *  Flatten the tail into the filename: everything after an extension-bearing
 * non-final segment joins it with the reserved "@@" delimiter (the same
 * convention query strings use). Check observed mappings for collisions with
 * source paths that already contain this delimiter.
 *
 *  ONE FUNCTION, because the WRITER and the SERVER must not each carry their
 * own copy of this rule. localRelPath() writes the flattened name; a request
 * arrives in the SLASH spelling and serveCandidates() has to resolve it through
 * the identical rule or the server 404s on a file the crawler wrote. Two
 * regexes that start out identical are two regexes that drift (§2.1.1).
 *
 * Idempotent on already-flattened input: "@@" contains no "/", so a name that
 * has been through here once has no tail left to match.
 */
export function flattenPathTail(pathname) {
  return pathname.replace(PATH_TAIL_EXT, (m0, file, tail) => file + "@@" + tail.slice(1).replace(/\//g, "@@"));
}

/**
 * Mirror-relative path for an absolute URL. Origin pages land at
 * `<path>/index.html`, origin assets at `<path>`, every other host under
 * `assets/<host>/<path>` — plus the query suffix above.
 */
export function localRelPath(absUrl, originHost, policy = DEFAULT_POLICY) {
  const u = new URL(absUrl);
  const suffix = querySuffix(u.search, policy);
  //  COLLAPSE CONSECUTIVE SLASHES HERE, not somewhere downstream. Sites build
  // asset URLs by concatenating a base that ends in "/" with a path that starts
  // with one, so `…/textures//tunnels/x.png` is common and origins serve it
  // happily. The crawler used to write such a file through path.join(), which
  // silently normalises it, while this function kept the "//" — so the ledger
  // said one path, the mapping computed another, and serve.mjs (which resolves
  // through this function) would 404 on a file that is right there on disk.
  // Measured on a WebGL target: 2 texture files, caught by the mapping-drift
  // gate. Normalising in the ONE shared mapping is what keeps crawler, capture,
  // server and gate on the same answer (§2.1.1) — normalising downstream is how
  // they drifted in the first place.
  let clean = decodeURIComponent(u.pathname).replace(/\/{2,}/g, "/");
  // A path that continues PAST a file is flattened into the filename — see
  // flattenPathTail. The server resolves requests through the same function.
  const flattened = flattenPathTail(clean);
  //  A FLATTENED NAME IS A FILE, and the page/asset test below cannot see
  // that: the flattened tail rarely ENDS in an extension
  // (`…jpg@@m@@110x110@@filters:format(avif):quality(70)`), so the extension
  // test calls it a page and appends "/index.html" — while serveCandidates
  // offers the flattened name WITHOUT it. Writer and server would disagree on
  // every transformed asset, which is the exact drift flattening exists to
  // remove; the flatten only fires on a known asset extension, so having
  // fired IS the evidence that this names a file.
  const isFlattenedFile = flattened !== clean;
  clean = flattened;
  if (u.hostname !== originHost) {
    if (clean.endsWith("/")) clean += "index";
    return "assets/" + u.hostname + withQuerySuffix(clean, suffix);
  }
  if (clean === "/" || clean === "") return withQuerySuffix("index.html", suffix);
  let p = clean.replace(/^\/+/, "");
  if (p.endsWith("/")) p = p.slice(0, -1);
  if (isFlattenedFile) return withQuerySuffix(p, suffix);
  // Extension-less origin URLs are pages; extensioned ones are assets (hasExt).
  if (!hasExt(p)) return p + suffix + "/index.html";
  return withQuerySuffix(p, suffix);
}

/**
 * Disk candidates serve.mjs should try for an incoming (pathname, search),
 * most specific first. The bare-pathname fallback is deliberate: it keeps
 * mirrors taken before this module existed working, and it answers requests
 * whose only query is a cache buster the policy ignores.
 */
export function serveCandidates(pathname, search, policy = DEFAULT_POLICY) {
  const suffix = querySuffix(search, policy);
  const out = [];
  // The SAME flatten the writer used — one function, not a second copy of the
  // rule (flattenPathTail states why).
  const flat = flattenPathTail(pathname);
  if (flat !== pathname) {
    // A flattened path is the writer's filename. Apply the query suffix to that
    // filename before the bare fallback, otherwise a transformed asset with a
    // query can never resolve to the file localRelPath() wrote.
    if (suffix) out.push(withQuerySuffix(flat, suffix));
    out.push(flat);
  }
  if (suffix) {
    //  For a DIRECTORY-style path the crawler and the server used to disagree
    // about the ORDER of two operations — attach the query suffix, and append
    // `/index.html`. The crawler suffixes the last SEGMENT and then adds the
    // index (`…/defaultlinks@@locale=en_US&src=globalnav/index.html`); this
    // function suffixed the path INCLUDING its trailing slash
    // (`…/defaultlinks/@@locale=…`). Same library, same URL, two filenames, and
    // the mirror served a 404 for a file it had on disk.
    //
    // Emit the crawler's shape first, since that is the one that exists.
    if (pathname.endsWith("/")) out.push(pathname.slice(0, -1) + suffix + "/");
    out.push(withQuerySuffix(pathname, suffix));
  }
  out.push(pathname);
  return out;
}
