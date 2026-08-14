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
// (4) is the field lesson. `srcset` / `imagesrcset` are COMMA-SEPARATED
// CANDIDATE LISTS, and only the FIRST candidate is preceded by the quote that
// shapes (1)–(3) key on; every later one starts after ", ". Measured on
// objectandarchive.com: 68 srcsets × ~5 candidates, so ~270 responsive variants
// were invisible to pass 1 — while the ledger looked complete, because the
// first candidate of every set was present. Paired with a pathname-only url ->
// path mapping (lib/urlpath.mjs) this is undetectable downstream: the page
// renders from whichever variant did land.

/** HTML entities that appear inside URL attributes. */
export function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#38;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"');
}

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

  return function extractAssetUrls(text, baseUrl) {
    const urls = new Set();
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
    return urls;
  };
}
