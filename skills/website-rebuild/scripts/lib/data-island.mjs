// data-island.mjs — the regions a URL localiser must NOT touch, and what
// holding them back cost. Imported by BOTH localisers, so the two cannot
// disagree about where those regions are.
//
// verification-gates.md §4.9.4: url localisation exists twice in this
// toolchain — lib/shell-build.mjs bakes it into the port's bytes at BUILD
// time, serve.mjs rewrites the mirror on its way out at RESPONSE time — and
// the discipline that keeps them from drifting is that whatever they must
// agree on lives in lib/ and is imported by both, the way lib/flight.mjs owns
// the length-aware path.
//
// ⛔ THE GUARD ARRIVED ON ONE SIDE ONLY, AND BOTH OUTCOMES OF THAT ARE WRONG.
// v0.1.71 carved the island out inside transformPage() and nowhere else, so
// depending on how the rebuild is served:
//   * through serve.mjs with --origin-hosts (the configuration determinism.md
//     records for a two-sided run), the response layer re-localises exactly
//     what the builder preserved — the guard has no effect at all;
//   * as built bytes against a serve.mjs-fronted mirror, the two sides now
//     disagree about that one field, and verify-payload's classifier reads
//     `https://host` against `/` as a CONTENT difference — the payload gate
//     goes red on the very target class the guard was written for.
// The lesson is right. It just cannot live on one side of a two-sided fact.
import { decodeUrlEscapes, looksLikeAsset } from "./extract-refs.mjs";

/**
 * ⛔ A DEVALUE DATA ISLAND IS PROGRAM INPUT, NOT ADDRESSES
 * (verification-gates.md §4.18). Nuxt inlines
 * `<script type="application/json" id="__NUXT_DATA__">` whose entries the app
 * PARSES at runtime. Measured on hubtown: the island carries the deploy's site
 * record (name, env, url), the WebGL boot derives its Theatre environment from
 * it, and localising that url to "/" made `new URL(...)` paths and sheet
 * lookups fail three layers away — `addSheetObject` reading 'object' of
 * undefined — while every request stayed 200. §4.10's rule one ring further
 * in: display text was content, and so is parsed data.
 *
 * ⚠ The quotes are optional in the pattern because what is being matched is
 * the ATTRIBUTE, not one generator's spelling of it.
 */
const INLINE_ISLAND = /(<script[^>]*\bid=["']?__NUXT_DATA__["']?[^>]*>)([\s\S]*?)(<\/script>)/g;

/**
 * ⭐ THE SAME ISLAND ALSO ARRIVES AS A FILE. Nuxt 3 can EXTERNALIZE the payload
 * to `/_payload.json?<buildId>` (§4.19) — the same devalue-encoded program
 * input with the `<script>` wrapper removed. §4.18 and §4.19 landed in the
 * same upstream commit and were never connected, and `.json` sits in
 * serve.mjs's TEXT_REWRITE set, so the response layer localises the
 * externalized payload exactly the way it localised the inline island.
 */
const PAYLOAD_FILE = /(^|\/)_payload\.json($|\?)/;

/** Is this response path an externalized devalue payload — an island entire? */
export const isDataIslandFile = (where) => PAYLOAD_FILE.test(String(where || ""));

// NUL-delimited, so no document this toolchain serves can spell it: a NUL byte
// is already what lib/extract-refs.mjs reads as proof that bytes are binary.
const MARK = (i) => `\u0000NUXTDATA${i}\u0000`;
const MARK_RE = /\u0000NUXTDATA(\d+)\u0000/g;

const ABS_URL = /https?:\/\/[^\s"'\\<>]+/g;

/**
 * The absolute URLs a carve-out preserved, in the one spelling they can be
 * judged in. A devalue island escapes "/" as \u002F so the blob can never
 * contain "</script>", so the text is normalised through the SHARED decoder
 * before scanning — a private unescape here would be the second implementation
 * this whole file exists to prevent.
 */
const urlsIn = (body) =>
  [...new Set(decodeUrlEscapes(String(body)).match(ABS_URL) || [])].map((url) => ({
    url,
    asset: looksLikeAsset(url),
  }));

/**
 * Run `apply` over `text` with every data island held out of its reach.
 *
 * Pure: nothing is logged, nothing is module state. The caller decides what a
 * preserved URL is worth, because the two callers differ — a build produces
 * the deliverable and can refuse to ship it, a reference server has to keep
 * answering.
 *
 *   apply    (text) => text, the localisation this island must not see
 *   where    the response path or file being transformed; an externalized
 *            payload file is an island in its ENTIRETY and `apply` never runs
 *   returns  { text, preserved: [{ url, asset }] }
 *
 * ⛔ THE CARVE-OUT IS TOTAL, AND THAT IS NOT FREE. A serialised SSG payload is
 * precisely where this toolchain has measured latent outbound before: 11
 * media-host URLs survived every other localisation shape inside
 * `window.__NUXT__` and the runtime probe caught exactly ONE of them, because
 * a URL in a payload is not requested until the page happens to want it. So
 * holding the island back re-opens that class for the sake of the data fields,
 * and the trade has to be VISIBLE — `preserved` is the whole reason this
 * returns a second value, and `asset: true` marks the entries that are
 * addresses BY SHAPE and therefore the ones a build gate should refuse to
 * ship. "Zero-outbound is unaffected" was measured on one site's island; it is
 * not a property of islands.
 *
 * ⚠ Scope, stated because it is a choice and not an oversight: this holds the
 * island back from LOCALISATION only. A project's own registered transforms
 * still see it, on the same reasoning §4.9 gives for putting them on the
 * length-aware path — they are deliberate, floored and purpose-checked, while
 * localisation is blanket. ⚠ It also assumes an island is never nested inside
 * a length-prefixed flight row: the marker is shorter than the body it
 * replaces, so a row's `T<hex>` would be re-declared over the marker and then
 * restored to a different length. Nuxt islands and Next flight rows do not
 * co-occur on a document; if that ever changes, this is where it breaks.
 */
export function protectDataIslands(text, apply, { where = "" } = {}) {
  if (isDataIslandFile(where)) return { text, preserved: urlsIn(text) };

  const bodies = [];
  const carved = text.replace(INLINE_ISLAND, (_m, open, body, close) => {
    bodies.push(body);
    return open + MARK(bodies.length - 1) + close;
  });
  if (!bodies.length) return { text: apply(text), preserved: [] };
  // ⚠ A FUNCTION replacement, not a string one: `$&` and `$1` are ordinary
  // data inside a payload, and a string replacement would expand them.
  const out = apply(carved).replace(MARK_RE, (_m, i) => bodies[Number(i)]);
  return { text: out, preserved: bodies.flatMap(urlsIn) };
}

/**
 * One line describing what a carve-out kept, for callers that report rather
 * than fail. Returns null when there is nothing to say, so a caller can stay
 * silent without testing the shape of the list itself.
 */
export function describePreserved(preserved) {
  if (!preserved || !preserved.length) return null;
  const assets = preserved.filter((p) => p.asset);
  const head = `${preserved.length} absolute URL(s) preserved inside a data island`;
  if (!assets.length) return `${head}, none asset-shaped`;
  return `${head}, ${assets.length} of them asset-shaped — e.g. ${assets[0].url.slice(0, 90)}`;
}
