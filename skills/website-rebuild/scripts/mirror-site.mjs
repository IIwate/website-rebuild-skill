#!/usr/bin/env node
/**
 * mirror-site.mjs — BFS crawler: snapshot a live site into a byte-faithful
 * local mirror. Pages land at <out>/<path>/index.html, cross-host assets at
 * <out>/assets/<host>/<path>; every fetched text file is rescanned for asset
 * URLs until no new ones appear; writes <out>/mirror-manifest.json
 * (url -> local path, size, type).
 *
 * Usage:
 *   node mirror-site.mjs --origin https://example.com [--out legacy-mirror]
 *     [--hosts cdn.example.com,media.example.net]  extra asset hosts to follow
 *     [--pages /pricing,/contact]                  extra seed pages
 *     [--probe-404 /no-such-page-mirror-probe]     fetch origin 404 template -> 404.html
 *     [--rounds 4] [--workers 8]
 *
 * NOTE a static crawl always misses three classes of URL: worker-fetched WASM,
 * lazy-loaded assets, and runtime-concatenated paths. Follow up with
 * netcapture.mjs (real-browser CDP capture + disk diff) to find the gaps.
 *
 * Adapted from landonorris-rebuild/scripts/mirror-site.mjs.
 * Lineage: rogierdeboeve-rebuild (BFS regex crawler + manifest, ~250 lines)
 *   -> storytellingnoomo-rebuild ("Adapted from rogierdeboeve-rebuild": same-origin
 *      absolute paths, css url() refs, glTF buffer/image URIs)
 *   -> landonorris-rebuild (asset-host whitelist, same-origin Referer header for
 *      asset CDNs that require it, 404-template probe).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, extname } from 'node:path';

// ---------------------------------------------------------------------------
// CONFIG — per-project constants; site specifics come from the CLI instead.
// ---------------------------------------------------------------------------

// Generic third-party CDN hosts worth following by default (fonts and library
// CDNs show up in most sites). Site-specific CDNs go in via --hosts.
const DEFAULT_ASSET_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'unpkg.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
];

// Same-origin path prefixes that must NOT be crawled as pages, e.g. analytics
// reverse-proxy blobs (landonorris had Webflow GA proxies at /nvhc, /avljl).
const SKIP_PAGE_PREFIXES = [];

// Desktop UA for all requests; some origins vary or block on UA.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const ORIGIN_RAW = flag('origin', null);
if (!ORIGIN_RAW) {
  console.error('usage: mirror-site.mjs --origin https://example.com [--out legacy-mirror] [--hosts a,b] [--pages /x,/y] [--probe-404 /slug] [--rounds 4] [--workers 8]');
  process.exit(2);
}
const ORIGIN = ORIGIN_RAW.replace(/\/+$/, '');
const ORIGIN_HOST = new URL(ORIGIN).hostname;
const OUT = join(process.cwd(), flag('out', 'legacy-mirror'));
const ROUNDS = Number(flag('rounds', 4));
const WORKERS = Number(flag('workers', 8));
const PROBE_404 = flag('probe-404', null);

const ASSET_HOSTS = new Set([
  ...DEFAULT_ASSET_HOSTS,
  ...flag('hosts', '').split(',').filter(Boolean),
  ORIGIN_HOST, // same-origin assets (css/js/media referenced by absolute or root-relative URL)
]);

const TEXT_EXT = /\.(css|js|mjs|json|svg|html?)($|\?)/i;
const manifest = {};
const fetched = new Set();

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#38;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"');
}

function localPathFor(url) {
  const u = new URL(url);
  let path = decodeURIComponent(u.pathname);
  if (u.hostname === ORIGIN_HOST) {
    // Extension-less same-origin URLs are pages; extensioned ones are assets
    // served from the origin itself (e.g. /_nuxt/*.js, /assets/*.css).
    if (!extname(path)) {
      if (path === '/' || path === '') return join(OUT, 'index.html');
      return join(OUT, path, 'index.html');
    }
    return join(OUT, path);
  }
  if (path.endsWith('/')) path += 'index';
  return join(OUT, 'assets', u.hostname, path);
}

async function save(url, buf, contentType) {
  const p = localPathFor(url);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, buf);
  manifest[url] = {
    path: relative(OUT, p),
    bytes: buf.length,
    type: contentType || '',
  };
}

async function get(url) {
  const res = await fetch(url, {
    // Some asset CDNs require a same-origin Referer and return 403 without one
    // (landonorris lesson); supply it so legitimate requests are served.
    headers: { 'user-agent': UA, accept: '*/*', referer: ORIGIN + '/' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, type: res.headers.get('content-type') || '' };
}

function addIfAsset(rawUrl, urls) {
  try {
    const u = new URL(rawUrl);
    if (!ASSET_HOSTS.has(u.hostname)) return;
    // Same-origin URLs without an extension are pages, not assets.
    if (u.hostname === ORIGIN_HOST && !/\.[a-z0-9]{2,5}($|\?)/i.test(u.pathname)) return;
    urls.add(u.href);
  } catch {}
}

function extractAssetUrls(text, baseUrl) {
  const urls = new Set();
  // absolute URLs
  for (const m of text.matchAll(/https?:\/\/[a-z0-9.-]+\/[^\s"'`\\<>{}|^\][]+/gi)) {
    addIfAsset(decodeEntities(m[0]).replace(/[),.;:!]+$/, ''), urls);
  }
  // protocol-relative (//host/path)
  for (const m of text.matchAll(/["'(]\/\/([a-z0-9.-]+\/[^\s"')<>]+)/gi)) {
    addIfAsset('https://' + decodeEntities(m[1]), urls);
  }
  // root-relative refs on the origin itself (noomo-generation behavior: sites
  // that serve their own bundles/media reference them as /path/file.ext).
  // The (?!\/) guard is load-bearing: protocol-relative refs (//host/path) also
  // start with "/", and without it they get joined onto ORIGIN as
  // https://host//host/path — 77 phantom 404s on the first Shopify target
  // (racingshop-rebuild). Those refs are already handled by the branch above.
  for (const m of text.matchAll(/(?:src|href)=["'](\/(?!\/)[^"']+?\.[a-z0-9]{2,5}(?:\?[^"']*)?)["']/gi)) {
    addIfAsset(ORIGIN + decodeEntities(m[1]), urls);
  }
  // relative url(...) inside CSS
  if (baseUrl && /\.css($|\?)/i.test(baseUrl)) {
    for (const m of text.matchAll(/url\(\s*['"]?(?!data:|https?:|\/\/)([^'")]+)['"]?\s*\)/gi)) {
      try {
        addIfAsset(new URL(m[1], baseUrl).href, urls);
      } catch {}
    }
  }
  return urls;
}

function extractPageLinks(html) {
  const pages = new Set();
  for (const m of html.matchAll(/href="(\/[^"#?]*)"/g)) {
    const p = m[1];
    if (/\.(css|js|png|jpg|webp|svg|ico|xml|txt|woff2?)$/i.test(p)) continue;
    if (SKIP_PAGE_PREFIXES.some((pre) => p.startsWith(pre))) continue;
    pages.add(p.replace(/\/$/, '') || '/');
  }
  return pages;
}

const pageQueue = ['/', ...flag('pages', '').split(',').filter(Boolean)];
if (PROBE_404) pageQueue.push(PROBE_404);
const pagesDone = new Set();
let assetQueue = new Set();

// --- crawl pages ---
while (pageQueue.length) {
  const path = pageQueue.shift();
  if (pagesDone.has(path)) continue;
  pagesDone.add(path);
  const url = ORIGIN + (path === '/' ? '/' : path);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA } });
    const buf = Buffer.from(await res.arrayBuffer());
    const html = buf.toString('utf8');
    const isNotFoundProbe = PROBE_404 !== null && path === PROBE_404;
    if (isNotFoundProbe) {
      // Save the origin's 404 template so serve.mjs can replay 404 semantics.
      await mkdir(OUT, { recursive: true });
      await writeFile(join(OUT, '404.html'), buf);
      manifest[url] = { path: '404.html', bytes: buf.length, type: 'text/html (404 template)' };
    } else {
      await save(url, buf, res.headers.get('content-type'));
    }
    console.log(`[page] ${path} (${buf.length}b${res.ok ? '' : `, HTTP ${res.status}`})`);
    for (const u of extractAssetUrls(html, url)) assetQueue.add(u);
    if (!isNotFoundProbe) {
      for (const p of extractPageLinks(html)) if (!pagesDone.has(p)) pageQueue.push(p);
    }
  } catch (e) {
    console.error(`[page FAIL] ${path}: ${e.message}`);
  }
}

// --- download assets, rescanning text assets until fixpoint ---
for (let round = 1; round <= ROUNDS && assetQueue.size; round++) {
  const batch = [...assetQueue].filter((u) => !fetched.has(u));
  assetQueue = new Set();
  console.log(`--- asset round ${round}: ${batch.length} urls ---`);
  let i = 0;
  const workers = Array.from({ length: WORKERS }, async () => {
    while (i < batch.length) {
      const url = batch[i++];
      if (fetched.has(url)) continue;
      fetched.add(url);
      try {
        const { buf, type } = await get(url);
        await save(url, buf, type);
        console.log(`[asset] ${url.slice(0, 110)} (${buf.length}b)`);
        if (TEXT_EXT.test(url) || /text|javascript|json|css/.test(type)) {
          for (const u of extractAssetUrls(buf.toString('utf8'), url))
            if (!fetched.has(u)) assetQueue.add(u);
        }
      } catch (e) {
        console.error(`[asset FAIL] ${url}: ${e.message}`);
        manifest[url] = { path: null, error: e.message };
      }
    }
  });
  await Promise.all(workers);
}

await writeFile(
  join(OUT, 'mirror-manifest.json'),
  JSON.stringify({ origin: ORIGIN, mirroredAt: new Date().toISOString(), files: manifest }, null, 2)
);
const ok = Object.values(manifest).filter((f) => f.path).length;
const fail = Object.values(manifest).filter((f) => !f.path).length;
console.log(`\nDone: ${ok} files saved, ${fail} failed. Manifest written.`);
