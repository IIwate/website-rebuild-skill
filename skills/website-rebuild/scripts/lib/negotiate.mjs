/**
 * Image Accept profiles and Sanity reference evidence.
 * IMG_ACCEPT is a recorded Chrome image-request profile; confirm it matches the
 * capture environment when format negotiation matters. CDP type hints take
 * precedence over filename heuristics, including extensionless image proxies.
 * In basement, 391 auto=format variants used fallback formats under * /*;
 * a 1.13 MB PNG URL returned 61 KB WebP to the browser, and all six sampled
 * responses differed from the crawler. Vary: Accept identifies this dependency.
 * sanityEvidence collects markers and encoded references, not a site category.
 */
export const IMG_ACCEPT =
  "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";

/**
 * Choose an image Accept profile from a URL and optional CDP/MIME type hint.
 */
export function imageAcceptFor(url, typeHint = "") {
  // Accept both CDP resource names (Image) and MIME values (image/png).
  // The 14islands TSV used MIME values rather than CDP resource names.
  if (/^image(\/|$)/i.test(String(typeHint).trim())) return IMG_ACCEPT;
  try {
    const u = new URL(url);
    if (/\.(avif|webp|png|jpe?g|gif|svg|ico)$/i.test(u.pathname)) return IMG_ACCEPT;
    // An extensionless Next image proxy carries the source URL in its query.
    if (/\/_next\/image$/.test(u.pathname)) return IMG_ACCEPT;
    const inner = u.searchParams.get("url");
    if (inner && /\.(avif|webp|png|jpe?g|gif|svg)(\?|$)/i.test(inner)) return IMG_ACCEPT;
  } catch {
    /**
 * Invalid URLs use the generic profile; the fetch caller reports the URL error.
 */
  }
  return "*/*";
}

/**
 * Check whether Vary names Accept as a response-selection input.
 */
export function isNegotiated(varyHeader) {
  return /(^|,)\s*accept\s*(,|$)/i.test(String(varyHeader || ""));
}

/**
 * Extract Sanity project, API-host and format markers from HTML or payload text. Counts are occurrences.
 */
export function sanityEvidence(text) {
  // Decode slash and colon spellings without decoding arbitrary percent sequences.
  // Whole-text decodeURIComponent would reject unrelated incomplete escapes.
  const norm = String(text)
    .replace(/\\\//g, "/")
    .replace(/%2F/gi, "/")
    .replace(/%3A/gi, ":");
  const projects = new Map();
  for (const m of norm.matchAll(
    /cdn\.sanity\.io\/(?:images|files)\/([a-z0-9]+)\/([A-Za-z0-9_-]+)\//g,
  )) {
    const k = `${m[1]}/${m[2]}`;
    projects.set(k, (projects.get(k) || 0) + 1);
  }
  const apiHosts = new Map();
  for (const m of norm.matchAll(/([a-z0-9]+\.api(?:cdn)?\.sanity\.io)/g)) {
    apiHosts.set(m[1], (apiHosts.get(m[1]) || 0) + 1);
  }
  return {
    projects: [...projects].map(([k, n]) => {
      const [projectId, dataset] = k.split("/");
      return { projectId, dataset, n };
    }),
    apiHosts: [...apiHosts].map(([host, n]) => ({ host, n })),
    // Count host-only references as well as project asset paths. Flight preconnect
    // hints can contain https://cdn.sanity.io without /images/<projectId>/.
    // The darkroom home page had such a hint, while project IDs appeared only
    // on deeper routes. A host reference without a project identifies a lead,
    // not a complete asset inventory.
    cdnRefs: (norm.match(/cdn\.sanity\.io/g) || []).length,
    autoFormat: (norm.match(/auto=format/g) || []).length,
    keyFields: (norm.match(/"_key"/g) || []).length,
  };
}

// ---- the one UA, the one header ladder ---------------------------------------------
// Five scripts carried their own copy of the browser UA — two Chrome versions among
// them (126 vs 128) — and four carried their own std→bare retry ladder. The ladder
// is source behaviour (the same 403 has two OPPOSITE cures: one CDN wants a same-
// origin Referer, another 403s browser-shaped headers and serves curl), so every
// fetcher must climb the same rungs in the same order or their ledgers disagree
// about what a URL "returns".
export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
export const BARE_UA = "curl/8.6.0";

/**
 * The std→bare ladder for one URL. `std` sends the browser UA, the browser's own
 * image Accept when the URL/typeHint says image (auto=format CDNs negotiate on it;
 * `*\/*` lands the fallback bytes), and a same-origin Referer. `bare` is the header-
 * allergy rung and stays minimal on purpose.
 */
export function fetchProfiles(url, { origin, typeHint = "" } = {}) {
  return [
    { name: "std", headers: { "user-agent": BROWSER_UA, accept: imageAcceptFor(url, typeHint), ...(origin ? { referer: origin.replace(/\/+$/, "") + "/" } : {}) } },
    { name: "bare", headers: { "user-agent": BARE_UA, accept: "*/*" } },
  ];
}

/**
 * Try the browser header profile, then the minimal profile on 401/403 or a
 * transport error. Return other HTTP responses immediately, including 3xx;
 * redirect handling defaults to manual so callers can record source redirects.
 * Returns { res, profile, error }; res is null when both profiles fail through
 * the retry path.
 */
export async function fetchLadder(url, { origin, typeHint = "", redirect = "manual", init = {} } = {}) {
  let lastErr = "";
  for (const p of fetchProfiles(url, { origin, typeHint })) {
    try {
      const res = await fetch(url, { ...init, headers: { ...p.headers, ...(init.headers || {}) }, redirect });
      if (res.ok || (res.status >= 300 && res.status < 400)) return { res, profile: p.name, error: "" };
      lastErr = `HTTP ${res.status} (${p.name})`;
      if (res.status !== 401 && res.status !== 403) return { res, profile: p.name, error: lastErr };
    } catch (e) {
      lastErr = `${e.message} (${p.name})`;
    }
  }
  return { res: null, profile: "", error: lastErr };
}
