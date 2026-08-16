// extract-refs.mjs — THE asset-reference extractor: every URL shape a mirror
// has to be able to see in a text file. Shared by mirror-site.mjs (pass 1, the
// BFS crawl) and verify-mirror.mjs (pass 4, the static closure gate).
//
// It lives in lib/ for the same reason lib/urlpath.mjs does: when the crawler
// and the closure gate carry separate copies of these regexes, the gate cannot
// see the references the crawler cannot see, so the closure check reports
// "reference set − disk set = ∅" while both sides share one blind spot. A gate
// that inherits the bug it is auditing is worse than no gate.
//
// Shapes covered, and why each one is here:
//   1. absolute            https://host/path
//   2. protocol-relative   //host/path        (quoted or parenthesised)
//   3. root-relative       src=/path.ext      on the origin itself
//   4. srcset candidates   see below — the one that hides hundreds of files
//   5. relative url(...)   inside CSS, resolved against the stylesheet's URL
//
// …and every one of them is run TWICE: once over the file's bytes, once over a
// DECODED VIEW of them (see "THE ESCAPED-URL BLIND SPOT" below).
//
// (4) is the field lesson. `srcset` / `imagesrcset` are COMMA-SEPARATED
// CANDIDATE LISTS, and only the FIRST candidate is preceded by the quote that
// shapes (1)–(3) key on; every later one starts after ", ". Measured on
// objectandarchive.com: 68 srcsets × ~5 candidates, so ~270 responsive variants
// were invisible to pass 1 — while the ledger looked complete, because the
// first candidate of every set was present. Paired with a pathname-only url ->
// path mapping (lib/urlpath.mjs) this is undetectable downstream: the page
// renders from whichever variant did land.
//
// THE ESCAPED-URL BLIND SPOT — why the second pass exists【objectarchive D-T10】
// ---------------------------------------------------------------------------
// Shape (1)'s character class excludes backslash, on purpose: a URL match must
// stop at an escape boundary. The consequence nobody drew: a URL SPELLED with
// escapes never starts matching at all. `https:\/\/host\/path` — what a
// template engine's JSON filter emits inside an inline payload (Liquid
// `| json`, PHP `json_encode`, `JSON.stringify` piped through an HTML escaper)
// — dies at the first `\/`, and the whole class of references is invisible.
// Same for `\/\/host\/path`, for the double-escaped `https:\\/\\/…` that comes
// out of JSON-inside-JSON, for the `\u002f` spelling of the same escape, and
// for `&#x2F;` in an attribute value.
//
// The causal chain, and it is the reason this file exists at all:
//
//     a hole in the DISCOVERY regex
//       -> a reference set that is missing a whole CLASS of references
//         -> pass 4 computes "reference set − disk set" over that short set
//           -> the closure gate reports "= ∅" AND IS GREEN.
//
// The gate did not fail to run. It ran, correctly, on an input that was already
// wrong — the same family as "the mirror needs its own gate" (mirroring.md
// §5.1): every downstream gate can be green because THE THING THEY MEASURE is
// the broken artefact. A gate's input can be the bug.
//
// Measured on objectandarchive.com (M(n)): reference set 1,360 -> 1,420. The 60
// invisible references included two woff2 that were referenced on three routes
// and never mirrored. Nothing downstream could catch it either — the host form
// does not render on any produced document, and an unrendered element makes no
// request (verification-gates.md §1.6 class 2), so the runtime gates were blind
// FOR A LEGITIMATE REASON. It was found by the closing per-asset copyright
// audit counting fonts, not by any gate.
//
// The fix is not "add two more regexes". Escapes COMPOSE with every other
// shape: an escaped srcset list inside a JSON-embedded HTML blob needs shape
// (4) to see through `\"` as well as `\/`. So the whole shape set is re-run
// over a decoded view of the text, and the two result sets are unioned.
// Over-inclusion is the safe direction here: a phantom reference makes this
// gate RED and gets one line in external.txt, while a missed class makes it
// GREEN and takes a copyright audit to find.
//
// Measured, differentially, over that project's 197 mirrored text files:
// 1,587 -> 1,767 references, ZERO lost. 121 of those are invisible even to the
// two-extra-regexes version of this fix, and they are why the decoding is a
// NORMALISING PASS and not a second alphabet of shapes: one string can carry
// TWO escape flavours at once. That site's JSON-LD spells an image as
//
//     "image":"https:\/\/host\/....jpg?v=1784637278\u0026width=1920"
//
// A shape written for \/ matches the head of that and then STOPS at the
// \u0026, because its class excludes backslash. So the reference does not go
// missing — it comes out TRUNCATED, as ...jpg?v=1784637278, and under a
// query-aware mapping (lib/urlpath.mjs) that is a DIFFERENT asset, which IS on
// disk. A half-understood escape turns a missing reference into a satisfied
// one: the gate stays green, holding a real file up as evidence for a claim
// about a different one. Escape flavour and escape depth are unbounded; the
// shape list is not.

/**
 * HTML entities that appear inside URL attributes — including the ones that
 * hide the URL's own syntax (`&#x2F;` for "/", `&#58;` for ":"). Decimal and
 * hex spellings, with or without leading zeros; applied repeatedly-encoded
 * text decodes one layer per pass because `&amp;#x2F;` -> `&#x2F;` -> "/".
 */
export function decodeEntities(s) {
  return s
    .replace(/&(?:amp|#0*38|#[xX]0*26);/g, "&")
    .replace(/&(?:quot|#0*34|#[xX]0*22);/g, '"')
    .replace(/&(?:apos|#0*39|#[xX]0*27);/g, "'")
    .replace(/&(?:sol|#0*47|#[xX]0*2[fF]);/g, "/")
    .replace(/&(?:colon|#0*58|#[xX]0*3[aA]);/g, ":")
    .replace(/&(?:equals|#0*61|#[xX]0*3[dD]);/g, "=")
    .replace(/&(?:quest|#0*63|#[xX]0*3[fF]);/g, "?");
}

/**
 * Undo backslash escaping of the characters that carry URL syntax, so an
 * escaped reference reads like a plain one.
 *
 * Deliberately narrow: only `/ " '` and the `\u00XX` spellings of the same
 * handful of characters. A general JSON unescape would also rewrite `\n`,
 * `\t`, `\\` and the rest, which changes text that has nothing to do with
 * URLs and invents references that were never written. RUNS of backslashes
 * collapse (`\/`, `\\/`, `\\\\/` all mean "/") — that is the JSON-inside-JSON
 * case, where each nesting level doubles them.
 */
export function decodeUrlEscapes(s) {
  return s
    .replace(/\\+([/"'])/g, "$1")
    .replace(/\\+u00(2[267fF]|3[adfADF])/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** Cheap guard: is there anything in this text that a decoded pass could reveal? */
const MAYBE_ENCODED = /\\+[/"']|\\+u00[23]|&(?:#[0-9a-fA-F]|amp|quot|apos|sol|colon|equals|quest)/;

/**
 * Build an extractor bound to one site.
 *
 *   origin      "https://example.com" (no trailing slash) — base for root-relative refs
 *   originHost  hostname of the origin
 *   assetHosts  iterable of hostnames worth following (origin host included by
 *               the caller); anything else is ignored, exactly as the crawler's
 *               ASSET_HOSTS whitelist does
 *
 * Returns `(text, baseUrl) => Set<absolute url>`.
 */
export function createRefExtractor({ origin, originHost, assetHosts }) {
  const hosts = assetHosts instanceof Set ? assetHosts : new Set(assetHosts || []);
  const ORIGIN = String(origin || "").replace(/\/+$/, "");

  const addIfAsset = (rawUrl, urls) => {
    try {
      const u = new URL(rawUrl);
      if (!hosts.has(u.hostname)) return;
      // Same-origin URLs without an extension are pages, not assets.
      if (u.hostname === originHost && !/\.[a-z0-9]{2,5}($|\?)/i.test(u.pathname)) return;
      u.hash = "";
      urls.add(u.href);
    } catch {}
  };

  // The five shapes, over one view of the text. Called twice per file: raw,
  // then decoded (see header — escaped spellings compose with every shape, so
  // the shapes are re-run rather than duplicated).
  const scan = (text, baseUrl, urls) => {
    // 1. absolute URLs
    for (const m of text.matchAll(/https?:\/\/[a-z0-9.-]+\/[^\s"'`\\<>{}|^\][]+/gi)) {
      addIfAsset(decodeEntities(m[0]).replace(/[),.;:!]+$/, ""), urls);
    }
    // 2. protocol-relative (//host/path)
    for (const m of text.matchAll(/["'(]\/\/([a-z0-9.-]+\/[^\s"')<>]+)/gi)) {
      addIfAsset("https://" + decodeEntities(m[1]), urls);
    }
    // 3. root-relative refs on the origin itself (sites that serve their own
    // bundles/media reference them as /path/file.ext).
    // The (?!\/) guard is load-bearing: protocol-relative refs (//host/path)
    // also start with "/", and without it they get joined onto ORIGIN as
    // https://host//host/path — 77 phantom 404s on the first Shopify target
    // (racingshop-rebuild). Shape 2 already handled those.
    for (const m of text.matchAll(
      /(?:src|href|poster|content|data-src|data-poster|data-bg)=["'](\/(?!\/)[^"']+?\.[a-z0-9]{2,5}(?:\?[^"']*)?)["']/gi,
    )) {
      addIfAsset(ORIGIN + decodeEntities(m[1]), urls);
    }
    // 4. srcset / imagesrcset candidate lists — one entry per candidate, not
    // one per attribute (see header).
    for (const m of text.matchAll(/\b(?:image)?srcset=["']([^"']+)["']/gi)) {
      for (const cand of decodeEntities(m[1]).split(",")) {
        const ref = cand.trim().split(/\s+/)[0];
        if (!ref) continue;
        if (ref.startsWith("//")) addIfAsset("https:" + ref, urls);
        else if (/^https?:\/\//i.test(ref)) addIfAsset(ref, urls);
        else if (ref.startsWith("/")) addIfAsset(ORIGIN + ref, urls);
      }
    }
    // 5. relative url(...) inside CSS
    if (baseUrl && /\.css($|\?)/i.test(baseUrl)) {
      for (const m of text.matchAll(/url\(\s*['"]?(?!data:|https?:|\/\/)([^'")]+)['"]?\s*\)/gi)) {
        try {
          addIfAsset(new URL(m[1], baseUrl).href, urls);
        } catch {}
      }
    }
  };

  return function extractAssetUrls(text, baseUrl) {
    const urls = new Set();
    scan(text, baseUrl, urls);
    // Second pass over the decoded view. Guarded, so files with no escaping at
    // all pay one regex test; unioned, so the raw pass can never LOSE a
    // reference to the decoding (that would be the same bug pointing the other
    // way).
    if (MAYBE_ENCODED.test(text)) {
      const decoded = decodeUrlEscapes(decodeEntities(text));
      if (decoded !== text) scan(decoded, baseUrl, urls);
    }
    return urls;
  };
}
