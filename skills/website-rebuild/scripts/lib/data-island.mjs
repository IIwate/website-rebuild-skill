// Preserve serialized data regions during URL localization.
// The build and response layers share this helper so they protect the same
// inline Nuxt data and external payload files. Sharing prevents implementation
// drift; independent fixtures are still needed to detect shared mistakes.
//
// Protecting data in only one layer lets the other rewrite it, or makes the
// mirror and build disagree. See payload-gates.md section 1.4.
import { decodeUrlEscapes, looksLikeAsset } from "./extract-refs.mjs";

/**
 * Nuxt's inline __NUXT_DATA__ contains serialized application input
 * (payload-gates.md §6). On hubtown, its site name, environment and URL selected
 * the Theatre environment used by WebGL. Localizing that URL to "/" broke URL
 * construction and sheet lookups: addSheetObject read 'object' from undefined,
 * although all observed requests returned HTTP 200.
 *
 * The id attribute may be quoted or unquoted in the captured HTML.
 */
const INLINE_ISLAND = /(<script[^>]*\bid=["']?__NUXT_DATA__["']?[^>]*>)([\s\S]*?)(<\/script>)/g;

/**
 * Nuxt 3 also serves devalue payloads as /_payload.json?<buildId>
 * (payload-gates.md §5). These files need the same protection as inline data
 * because the server's text localization also processes JSON responses.
 */
const PAYLOAD_FILE = /(^|\/)_payload\.json($|\?)/;

/** Whether the entire response is a recognized external Nuxt payload. */
export const isDataIslandFile = (where) => PAYLOAD_FILE.test(String(where || ""));

// NUL delimiters distinguish placeholders from ordinary text. The reference
// extractor treats NUL-containing input as binary and does not scan its URLs.
const MARK = (i) => `\u0000NUXTDATA${i}\u0000`;
const MARK_RE = /\u0000NUXTDATA(\d+)\u0000/g;

const ABS_URL = /https?:\/\/[^\s"'\\<>]+/g;

/**
 * Decode escapes such as \u002F for URL inspection without changing the stored
 * payload. Using the reference extractor's decoder keeps both inspections
 * consistent for the supported escape forms.
 */
const urlsIn = (body) =>
  [...new Set(decodeUrlEscapes(String(body)).match(ABS_URL) || [])].map((url) => ({
    url,
    asset: looksLikeAsset(url),
  }));

/**
 * Apply URL localization outside recognized serialized-data regions.
 *
 * apply: (text) => text.
 * where: the response or file path; a recognized external payload is protected
 *        as a whole.
 * Returns { text, preserved: [{ url, asset }] } without logging or global state.
 *
 * Protected payloads can retain external asset URLs. The build caller rejects
 * such addresses; the reference server reports them while preserving its data.
 * One Nuxt capture contained 11 media URLs while a browser probe requested only
 * one, so runtime requests alone do not establish payload closure.
 *
 * Protection applies to localization, not to project-specific transforms.
 * The placeholder method assumes islands are not nested inside length-prefixed
 * Flight text rows. Such nesting would require joint length-aware processing.
 */
export function protectDataIslands(text, apply, { where = "" } = {}) {
  if (isDataIslandFile(where)) return { text, preserved: urlsIn(text) };

  const bodies = [];
  const carved = text.replace(INLINE_ISLAND, (_m, open, body, close) => {
    bodies.push(body);
    return open + MARK(bodies.length - 1) + close;
  });
  if (!bodies.length) return { text: apply(text), preserved: [] };
  // A callback preserves literal $& and $1 sequences in the payload; a string
  // replacement would interpret them as substitution patterns.
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
