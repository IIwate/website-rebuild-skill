#!/usr/bin/env node
/**
 * Fetch an HLS playlist hierarchy and referenced media into a local mirror.
 * Playlist references are resolved against each playlist URL. Recursion has
 * cycle and depth checks; URI-bearing media, map and key tags are included.
 * The mirror's query policy determines local paths. Successful files receive
 * SHA-256 records in both the manifest and inventory.tsv.
 *
 * Usage:
 *  node gapfill-video.mjs --master https://cdn.example.com/vp/<id>/<id>.m3u8
 *    [--out mirror]        mirror root (must match mirror-site.mjs)
 *    [--origin https://example.com]  same-origin path rule + Referer header;
 *                                    defaults to the first master's origin
 *    [--master a.m3u8 --master b.m3u8]  repeatable (or comma-separated)
 *    [--workers 4] [--delay 60]   politeness: pool size, ms between requests
 *    [--force]                    re-download files already on disk
 *    [--dry-run]                  enumerate the ladder, write nothing
 *    [--manifest <path>]          default <out>/mirror-manifest.json
 *    [--referer <url>]            Referer header sent with every request; default <origin>/
 *
 * The racingshop Daytona hero referenced three renditions and 12 MPEG-TS
 * segments through playlists. The static HTML/JS crawl had not discovered
 * them; browser request failures identified the missing playlist hierarchy.
 * serve.mjs includes HLS and MPEG-TS MIME types. Browser playback still depends
 * on the site's player, codecs and any access requirements of the stream.
 */
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { BROWSER_UA } from './lib/negotiate.mjs';
import { cli } from './lib/cli.mjs';
import { canonicalUrl, localRelPath, loadPolicy } from './lib/urlpath.mjs';
import { sha256, sha256File } from './lib/hash.mjs';
import { writeInventory } from './lib/ledger.mjs';

cli({
  known: ['master', 'out', 'origin', 'referer', 'manifest', 'workers', 'delay'],
  bools: ['force', 'dry-run'],
  file: import.meta.url,
});

// ---------------------------------------------------------------------------
// CONFIG — per-project constants; site specifics come from the CLI instead.
// ---------------------------------------------------------------------------

// Desktop UA for all requests (some media CDNs vary or block on UA): the one
// string in lib/negotiate.mjs, same as the crawler's.

// How deep to follow playlist -> playlist references. A normal ladder is 2
// levels (master -> variants); the guard only exists to stop pathological or
// self-referential manifests.
const MAX_PLAYLIST_DEPTH = 4;

// A referenced URI is treated as a nested playlist (recurse) rather than a
// media segment (download) when its path matches this.
const PLAYLIST_EXT = /\.(m3u8|m3u)$/i;

// Tags whose URI="..." attribute points at another playlist vs. at a plain
// file to download alongside the segments.
const PLAYLIST_URI_TAGS = new Set(['EXT-X-MEDIA', 'EXT-X-I-FRAME-STREAM-INF']);
const ASSET_URI_TAGS = new Set(['EXT-X-MAP', 'EXT-X-KEY', 'EXT-X-SESSION-KEY']);

// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const flagAll = (name) =>
  args.flatMap((a, i) => (a === '--' + name && args[i + 1] ? [args[i + 1]] : []));
const has = (name) => args.includes('--' + name);

const MASTERS = flagAll('master').flatMap((v) => v.split(',')).filter(Boolean).map(canonicalUrl);
if (!MASTERS.length) {
  console.error(
    'usage: gapfill-video.mjs --master https://cdn.example.com/vp/id/id.m3u8 [--out mirror]\n' +
      '       [--origin https://example.com] [--workers 4] [--delay 60] [--force] [--dry-run] [--manifest path]'
  );
  process.exit(2);
}

const OUT = resolve(flag('out', 'mirror'));
const ORIGIN = (flag('origin', null) || new URL(MASTERS[0]).origin).replace(/\/+$/, '');
const ORIGIN_HOST = new URL(ORIGIN).hostname;
const REFERER = flag('referer', ORIGIN + '/');
const MANIFEST_PATH = flag('manifest', join(OUT, 'mirror-manifest.json'));
const WORKERS = Number(flag('workers', 4));
const DELAY_MS = Number(flag('delay', 60));
const FORCE = has('force');
const DRY_RUN = has('dry-run');
if (!Number.isSafeInteger(WORKERS) || WORKERS < 1 || !Number.isFinite(DELAY_MS) || DELAY_MS < 0) {
  console.error('usage: --workers must be a positive integer and --delay a nonnegative number');
  process.exit(2);
}
const QUERY_POLICY = await loadPolicy(OUT);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function localPathFor(url) {
  const p = resolve(OUT, localRelPath(url, ORIGIN_HOST, QUERY_POLICY));
  const rel = relative(OUT, p);
  if (!rel || rel === '..' || rel.startsWith('../')) throw new Error(`URL maps outside the mirror: ${url}`);
  return p;
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

async function get(url) {
  const res = await fetch(url, {
    // Media CDNs commonly 403 without a same-origin Referer.
    headers: { 'user-agent': BROWSER_UA, accept: '*/*', referer: REFERER },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') || '' };
}

// --- manifest ledger --------------------------------------------------------

function detectIndent(raw) {
  const m = raw.match(/^\{\r?\n(\s*)"/);
  return m ? m[1].length : 2;
}

let manifestIndent = 2;
let manifestData = { origin: ORIGIN, mirroredAt: new Date().toISOString(), files: {} };
let manifestExisted = false;
try {
  const raw = await readFile(MANIFEST_PATH, 'utf8');
  manifestData = JSON.parse(raw);
  manifestIndent = detectIndent(raw);
  manifestExisted = true;
  if (!manifestData || typeof manifestData.files !== 'object' || manifestData.files === null || Array.isArray(manifestData.files)) {
    throw new Error(`${MANIFEST_PATH}: no files map in the document`);
  }
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
  console.warn(`[warn] no manifest at ${relative(process.cwd(), MANIFEST_PATH)} — one will be created`);
}

let ledgerAdds = 0;
function record(url, p, bytes, type, hash) {
  manifestData.files[url] = {
    ...manifestData.files[url],
    path: relative(OUT, p),
    bytes,
    type: type || '',
    sha256: hash,
    source: 'gapfill-video',
  };
  ledgerAdds++;
}

async function save(url, buf, type) {
  const p = localPathFor(url);
  if (!DRY_RUN) {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, buf);
  }
  record(url, p, buf.length, type, sha256(buf));
  return p;
}

// --- playlist parsing -------------------------------------------------------

// Split an m3u8 into the two things worth chasing: nested playlists (recurse)
// and byte payloads (download). Every URI is resolved against the playlist's
// own URL, so subdirectory ladders and ../ references work, not just the flat
// sibling layout racingshop happened to have.
function parsePlaylist(text, baseUrl) {
  if (text.trimStart().split(/\r?\n/, 1)[0] !== '#EXTM3U') throw new Error('Missing HLS #EXTM3U header');
  const playlists = new Set();
  const assets = new Set();
  let expectVariantUri = false;

  const resolve = (ref) => {
    try {
      return canonicalUrl(new URL(ref.trim(), baseUrl).href);
    } catch {
      return null;
    }
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#')) {
      const tag = line.slice(1).split(':', 1)[0];
      if (tag === 'EXT-X-STREAM-INF') {
        // The next non-comment line is a variant playlist.
        expectVariantUri = true;
        continue;
      }
      const m = line.match(/URI="([^"]*)"/);
      if (!m || !m[1]) continue;
      const abs = resolve(m[1]);
      if (!abs) continue;
      if (PLAYLIST_URI_TAGS.has(tag)) playlists.add(abs);
      else if (ASSET_URI_TAGS.has(tag)) assets.add(abs);
      continue;
    }

    const abs = resolve(line);
    if (!abs) continue;
    // A bare URI is a variant when EXT-X-STREAM-INF announced it, or whenever
    // it simply looks like a playlist (defensive: some masters omit the tag).
    if (expectVariantUri || PLAYLIST_EXT.test(new URL(abs).pathname)) playlists.add(abs);
    else assets.add(abs);
    expectVariantUri = false;
  }
  return { playlists, assets };
}

// --- descend the ladder -----------------------------------------------------

const seenPlaylists = new Set();
const pending = new Set(); // asset URLs to download
let playlistsFetched = 0;
let playlistsFromDisk = 0;
const failures = [];

async function walkPlaylist(url, depth) {
  if (seenPlaylists.has(url)) return;
  seenPlaylists.add(url);
  if (depth > MAX_PLAYLIST_DEPTH) {
    failures.push([url, `playlist depth ${depth} exceeds ${MAX_PLAYLIST_DEPTH}`]);
    return;
  }

  try {
    const p = localPathFor(url);
    const cached = !FORCE && await exists(p);
    const { buf, type } = cached
      ? { buf: await readFile(p), type: manifestData.files[url]?.type || 'application/vnd.apple.mpegurl' }
      : await get(url);
    const { playlists, assets } = parsePlaylist(buf.toString('utf8'), url);
    if (cached) {
      record(url, p, buf.length, type, sha256(buf));
      playlistsFromDisk++;
    } else {
      await save(url, buf, type);
      playlistsFetched++;
    }
    console.log(`[playlist] ${'  '.repeat(depth)}${url.slice(0, 110)} (${cached ? 'on disk, ' : ''}${buf.length}b)`);
    for (const a of assets) pending.add(a);
    console.log(`             ${'  '.repeat(depth)}-> ${playlists.size} nested playlist(s), ${assets.size} segment(s)`);
    for (const child of playlists) await walkPlaylist(child, depth + 1);
  } catch (e) {
    failures.push([url, e.message]);
    console.error(`[playlist FAIL] ${url}: ${e.message}`);
  }
}

for (const master of MASTERS) await walkPlaylist(master, 0);

// --- download the segments --------------------------------------------------

const queue = [...pending];
let downloaded = 0;
let skipped = 0;

let cursor = 0;
await Promise.all(
  Array.from({ length: WORKERS }, async () => {
    while (cursor < queue.length) {
      const url = queue[cursor++];
      try {
        const p = localPathFor(url);
        if (!FORCE && await exists(p)) {
          record(url, p, (await stat(p)).size, manifestData.files[url]?.type || '', await sha256File(p));
          skipped++;
          continue;
        }
        if (DRY_RUN) {
          downloaded++;
          console.log(`[would fetch] ${url.slice(0, 120)}`);
          continue;
        }
        const { buf, type } = await get(url);
        await save(url, buf, type);
        downloaded++;
        if (downloaded % 10 === 0) console.log(`  ... ${downloaded}/${queue.length} segments`);
      } catch (e) {
        failures.push([url, e.message]);
        console.error(`[segment FAIL] ${url.slice(0, 100)}: ${e.message}`);
      }
      if (DELAY_MS) await sleep(DELAY_MS);
    }
  })
);

// --- write the ledger back --------------------------------------------------

if (!DRY_RUN && ledgerAdds) {
  if (!manifestExisted) await mkdir(dirname(MANIFEST_PATH), { recursive: true });
  await writeFile(MANIFEST_PATH, JSON.stringify(manifestData, null, manifestIndent) + '\n');
  await writeInventory(OUT, manifestData.files);
}

console.log(
  `\nvideo gapfill${DRY_RUN ? ' (dry run)' : ''}: ` +
    `${playlistsFetched} playlist(s) fetched, ${playlistsFromDisk} already mirrored, ` +
    `${downloaded} segment(s) ${DRY_RUN ? 'pending' : 'downloaded'}, ${skipped} already present, ` +
    `${failures.length} failed. ` +
    (DRY_RUN ? 'Manifest untouched.' : `${ledgerAdds} file records written to the manifest and inventory.`)
);
if (failures.length) {
  for (const [u, m] of failures) console.error(`  FAIL ${m} ${u}`);
  process.exit(1);
}
