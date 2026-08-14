#!/usr/bin/env node
/**
 * mirror-site.mjs — BFS crawler: snapshot a live site into a byte-faithful
 * local mirror. Pages land at <out>/<path>/index.html, cross-host assets at
 * <out>/assets/<host>/<path>; every fetched text file is rescanned for asset
 * URLs until no new ones appear. Three ledgers are written next to the bytes:
 * <out>/mirror-manifest.json (url -> local path, size, sha256, type),
 * <out>/inventory.tsv (SHA256 BYTES PATH URL) and <out>/redirects.tsv
 * (CODE FROM TO — replayed by serve.mjs). A fourth file, <out>/urlpath-policy.json,
 * records the url -> path mapping policy these bytes were written under.
 *
 * Usage:
 *   node mirror-site.mjs --origin https://example.com [--out legacy-mirror]
 *     [--hosts cdn.example.com,media.example.net]  extra asset hosts to follow
 *     [--pages /pricing,/contact]                  extra seed pages
 *     [--probe-404 /no-such-page-mirror-probe]     fetch origin 404 template -> 404.html
 *     [--seeds urls.txt]                           newline-delimited extra asset URLs
 *     [--rounds 4] [--workers 8]
 *     [--query-ignore v,cb]                        params that do NOT change the bytes
 *     [--query-only width,height]                  the only params that do
 *
 * NOTE a static crawl always misses three classes of URL: worker-fetched WASM,
 * lazy-loaded assets, and runtime-concatenated paths. Follow up with
 * netcapture.mjs (real-browser CDP capture + disk diff) to find the gaps.
 * Then audit the mirror itself with verify-mirror.mjs — the render-level gates
 * downstream cannot tell a right mirror from a wrong one.
 *
 * Adapted from landonorris-rebuild/scripts/mirror-site.mjs.
 * Lineage: rogierdeboeve-rebuild (BFS regex crawler + manifest, ~250 lines)
 *   -> storytellingnoomo-rebuild ("Adapted from rogierdeboeve-rebuild": same-origin
 *      absolute paths, css url() refs, glTF buffer/image URIs)
 *   -> landonorris-rebuild (asset-host whitelist, same-origin Referer header for
 *      asset CDNs that require it, 404-template probe)
 *   -> shopifydesign-rebuild (redirect:"manual" + redirects.tsv instead of
 *      following — the script used to violate its own red line; per-file sha256
 *      in the manifest + inventory.tsv; --seeds so URLs solved out of bundles
 *      and payloads go through the same downloader and land in the same ledger)
 *   -> objectandarchive-rebuild (query-aware url -> path mapping shared through
 *      lib/urlpath.mjs; srcset candidate lists extracted per candidate).
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
// The url -> local-path mapping is QUERY-AWARE and lives in one module shared
// with netcapture.mjs, serve.mjs and verify-mirror.mjs. Read its header once:
// a pathname-only mapping collapses `x.jpg?width=320|600|1200` into one file on
// every query-parameterised image CDN, and nothing downstream can see it —
// the page renders from whichever variant landed last.
import {
  localRelPath,
  loadPolicy,
  policyFromArgs,
  savePolicy,
  describePolicy,
} from './lib/urlpath.mjs';
// The reference extractor is shared with verify-mirror.mjs's closure gate, so
// the gate cannot inherit a blind spot from the crawler it audits.
import { createRefExtractor } from './lib/extract-refs.mjs';

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
  console.error('usage: mirror-site.mjs --origin https://example.com [--out legacy-mirror] [--hosts a,b] [--pages /x,/y] [--probe-404 /slug] [--seeds urls.txt] [--rounds 4] [--workers 8] [--query-ignore v,cb | --query-only width,height]');
  process.exit(2);
}
const ORIGIN = ORIGIN_RAW.replace(/\/+$/, '');
const ORIGIN_HOST = new URL(ORIGIN).hostname;
const OUT = join(process.cwd(), flag('out', 'legacy-mirror'));
const ROUNDS = Number(flag('rounds', 4));
const WORKERS = Number(flag('workers', 8));
const PROBE_404 = flag('probe-404', null);
const SEEDS_FILE = flag('seeds', null);
// Query policy: CLI wins, else whatever this mirror was already written with,
// else the conservative default (every param is part of the path key). A
// gap-filling run therefore inherits the first run's policy automatically —
// re-fetching a handful of URLs under a different mapping would scatter them
// next to, instead of over, the files they are meant to replace.
await mkdir(OUT, { recursive: true });
const QUERY_POLICY = policyFromArgs(args) ?? (await loadPolicy(OUT));
await savePolicy(OUT, QUERY_POLICY);
console.log(`[urlpath] ${describePolicy(QUERY_POLICY)}`);

const ASSET_HOSTS = new Set([
  ...DEFAULT_ASSET_HOSTS,
  ...flag('hosts', '').split(',').filter(Boolean),
  ORIGIN_HOST, // same-origin assets (css/js/media referenced by absolute or root-relative URL)
]);

const TEXT_EXT = /\.(css|js|mjs|json|svg|html?)($|\?)/i;
const manifest = {};
const fetched = new Set();
// Redirects are SOURCE-SITE BEHAVIOR, not crawler bookkeeping: they get their
// own ledger and are never collapsed into the source path's file.
const redirects = []; // {from, status, to}

// Delegated to lib/urlpath.mjs so the crawler, the capture pass, the server and
// the mirror gate cannot drift apart on where a URL lives — and so the query
// string is part of the answer (lib/urlpath.mjs header for the measured case).
function localPathFor(url) {
  return join(OUT, localRelPath(url, ORIGIN_HOST, QUERY_POLICY));
}

async function save(url, buf, contentType) {
  const p = localPathFor(url);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, buf);
  manifest[url] = {
    path: relative(OUT, p),
    bytes: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
    type: contentType || '',
  };
}

async function get(url) {
  const res = await fetch(url, {
    // Some asset CDNs require a same-origin Referer and return 403 without one
    // (landonorris lesson); supply it so legitimate requests are served.
    headers: { 'user-agent': UA, accept: '*/*', referer: ORIGIN + '/' },
    // RED LINE (references/mirroring.md §2): never follow. A followed 301
    // writes the target's body at the source path and fabricates a file the
    // origin never served at that URL. Record it and re-queue the target so it
    // lands at its own place in URL space instead.
    redirect: 'manual',
  });
  if (res.status >= 300 && res.status < 400) {
    const to = res.headers.get('location') || '';
    redirects.push({ from: url, status: res.status, to });
    return { redirectTo: to ? new URL(to, url).href : null };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, type: res.headers.get('content-type') || '' };
}

// Absolute / protocol-relative / root-relative / srcset-candidate / css-url()
// extraction now lives in lib/extract-refs.mjs, shared with verify-mirror.mjs's
// closure gate. Its header records why srcset needs per-candidate extraction:
// only the first candidate of a list is preceded by a quote, so a quote-keyed
// regex sees 1 of ~5 and the ledger still looks complete.
const extractAssetUrls = createRefExtractor({
  origin: ORIGIN,
  originHost: ORIGIN_HOST,
  assetHosts: ASSET_HOSTS,
});

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

// Extra seeds: URLs solved out of escaped payloads / bundle string literals,
// which the HTML-attribute regexes structurally cannot see. Feeding them here
// (rather than fetching them by hand) keeps one downloader and one ledger.
if (SEEDS_FILE) {
  const lines = (await readFile(SEEDS_FILE, 'utf8')).split('\n').map((s) => s.trim());
  let n = 0;
  for (const l of lines) {
    if (!l || l.startsWith('#')) continue;
    try { new URL(l); assetQueue.add(l); n += 1; } catch {}
  }
  console.log(`[seeds] ${n} urls from ${SEEDS_FILE}`);
}

// --- crawl pages ---
while (pageQueue.length) {
  const path = pageQueue.shift();
  if (pagesDone.has(path)) continue;
  pagesDone.add(path);
  const url = ORIGIN + (path === '/' ? '/' : path);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const to = res.headers.get('location') || '';
      redirects.push({ from: url, status: res.status, to });
      console.log(`[page REDIRECT ${res.status}] ${path} -> ${to}`);
      if (to && new URL(to, url).hostname === ORIGIN_HOST) {
        const p2 = new URL(to, url).pathname;
        if (!pagesDone.has(p2)) pageQueue.push(p2);
      }
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const html = buf.toString('utf8');
    const isNotFoundProbe = PROBE_404 !== null && path === PROBE_404;
    if (isNotFoundProbe) {
      // Save the origin's 404 template so serve.mjs can replay 404 semantics.
      await mkdir(OUT, { recursive: true });
      await writeFile(join(OUT, '404.html'), buf);
      manifest[url] = {
        path: '404.html',
        bytes: buf.length,
        sha256: createHash('sha256').update(buf).digest('hex'),
        type: 'text/html (404 template)',
      };
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
        const { buf, type, redirectTo } = await get(url);
        if (redirectTo !== undefined) {
          console.log(`[asset REDIRECT] ${url.slice(0, 90)} -> ${redirectTo}`);
          if (redirectTo && !fetched.has(redirectTo)) assetQueue.add(redirectTo);
          continue;
        }
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
await writeFile(
  join(OUT, 'redirects.tsv'),
  // Column order is CODE FROM TO because serve.mjs's replay reader destructures
  // in that order; a FROM-first ledger silently replays nothing.
  ['CODE', 'FROM', 'TO'].join('\t') + '\n' +
    redirects.map((r) => [r.status, r.from, r.to].join('\t')).join('\n') + (redirects.length ? '\n' : '')
);
await writeFile(
  join(OUT, 'inventory.tsv'),
  ['SHA256', 'BYTES', 'PATH', 'URL'].join('\t') + '\n' +
    Object.entries(manifest)
      .filter(([, f]) => f.path && f.sha256)
      .sort((a, b) => a[1].path.localeCompare(b[1].path))
      .map(([url, f]) => [f.sha256, f.bytes, f.path, url].join('\t'))
      .join('\n') + '\n'
);
const ok = Object.values(manifest).filter((f) => f.path).length;
const fail = Object.values(manifest).filter((f) => !f.path).length;
console.log(`\nDone: ${ok} files saved, ${fail} failed, ${redirects.length} redirects. Ledgers written.`);
