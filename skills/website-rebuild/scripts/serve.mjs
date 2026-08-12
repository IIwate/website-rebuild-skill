#!/usr/bin/env node
// serve.mjs — zero-dependency static server for the pristine mirror (and the
// rebuild), so source and rebuild can be diffed side-by-side without network.
//
//   PORT=5175 SERVE_ROOT=legacy-mirror node serve.mjs     # the source site
//   PORT=5173 SERVE_ROOT=dist          node serve.mjs     # the rebuild
//   node serve.mjs --port 5175 --root legacy-mirror [--ext-hosts cdn.x.com,fonts.gstatic.com]
//
// Discipline: the mirror on disk is SACRED — never rewritten. Every local-run
// adaptation happens in the response layer:
//   * full MIME map + Range requests, so <video>/<audio> can seek
//   * redirect replay from <root>/_scripts/redirects.tsv or <root>/redirects.tsv
//     (tab-separated "CODE FROM TO" lines, header row skipped): origin routing
//     behavior is replayed from the ledger, not re-invented   [careers-kimi]
//   * /ext/<host>/ mapping: text responses get absolute external-host URLs
//     rewritten to /ext/<host>/<path>, which resolves back into the mirror's
//     assets/<host>/<path>; SRI integrity attrs are dropped because rewritten
//     bytes can no longer match their hash        [samsyninja, landonorris]
//     ext hosts are auto-detected from <root>/assets/<host>/ dirs; add more
//     with --ext-hosts.
//   * ?__probe instrumentation: HTML responses get probe-shim.js injected so
//     both sides can be driven deterministically   [storytellingnoomo]
//   * 404.html template replay when the mirror captured one   [landonorris]
//
// Site-specific layers (e.g. careers-kimi's RSC flight payloads served from
// _rsc/ on an `RSC: 1` header) are intentionally left out — re-add per project.
//
// Adapted from storytellingnoomo-rebuild/scripts/serve.mjs and
// landonorris-rebuild/scripts/serve.mjs. Lineage:
//   samsyninja-rebuild (response-layer rewriting; mirror stays pristine)
//   -> careers-kimi-rebuild (redirect replay from ledger, RSC layer)
//   -> storytellingnoomo-rebuild ("Adapted from careers-kimi-rebuild/scripts/
//      serve.mjs"; Range support, probe-shim injection)
//   -> landonorris-rebuild (/ext/<host>/ mapping, 404 semantics, SRI strip).

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};

const PORT = Number(flag("port", process.env.PORT || 5175));
const HOST = flag("host", process.env.HOST || "127.0.0.1");
const ROOT = path.resolve(flag("root", process.env.SERVE_ROOT || "legacy-mirror"));

// ---------------------------------------------------------------------------
// CONFIG — per-project constants.
// ---------------------------------------------------------------------------

// Same-origin path prefixes to answer with an empty JS stub instead of 404,
// e.g. analytics reverse-proxy blobs that were deliberately not mirrored
// (landonorris stubbed Webflow's GA proxies /nvhc, /avljl this way).
const STUB_PREFIXES = [];

// File extensions whose responses are eligible for external-host rewriting.
const TEXT_REWRITE = new Set([".html", ".css", ".js", ".mjs", ".json", ".svg"]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".rsc": "text/x-component; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  // HLS ladder (see scripts/gapfill-video.mjs). Serving a mirrored .m3u8 with
  // the wrong type makes the player refuse the manifest, so the recovered
  // renditions never play. NOTE: in a mirror, ".ts" is an MPEG-TS segment,
  // never TypeScript — never serve it as text/*.
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".m4s": "video/iso.segment",
  ".mpd": "application/dash+xml",
  ".otf": "font/otf",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".hdr": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".ktx2": "image/ktx2",
  ".riv": "application/octet-stream",
};

// ---------------------------------------------------------------------------

// External hosts whose absolute URLs get rewritten to /ext/<host>/. Auto-
// detected from <root>/assets/<host>/ (mirror-site.mjs layout) + --ext-hosts.
const EXT_HOSTS = [...new Set([
  ...(await fsp.readdir(path.join(ROOT, "assets"), { withFileTypes: true }).catch(() => []))
    .filter((d) => d.isDirectory() && d.name.includes("."))
    .map((d) => d.name),
  ...flag("ext-hosts", "").split(",").filter(Boolean),
])];

// Redirect replay ledger (optional): "CODE\tFROM\tTO" per line, header skipped.
const REDIRECTS = new Map();
for (const ledger of ["_scripts/redirects.tsv", "redirects.tsv"]) {
  try {
    const tsv = await fsp.readFile(path.join(ROOT, ledger), "utf8");
    for (const line of tsv.trim().split("\n").slice(1)) {
      const [code, from, to] = line.split("\t");
      if (from) REDIRECTS.set(from, { code: Number(code), to });
    }
    break;
  } catch {}
}

// Probe shim (optional): injected into HTML when the request carries ?__probe.
let PROBE_SHIM = null;
try {
  PROBE_SHIM = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "probe-shim.js"),
    "utf8",
  );
} catch {}

function rewrite(text, ext) {
  // Rewritten bytes can no longer match SRI hashes; drop integrity attrs (HTML only).
  if (ext === ".html") text = text.replace(/ integrity="[^"]*"/g, "");
  for (const h of EXT_HOSTS) {
    text = text.replaceAll(`https://${h}/`, `/ext/${h}/`).replaceAll(`http://${h}/`, `/ext/${h}/`);
    // Protocol-relative form only in markup/styles: inside JS it is often
    // concatenated with a "https:" prefix and rewriting would corrupt it.
    if (ext === ".html" || ext === ".css") text = text.replaceAll(`//${h}/`, `/ext/${h}/`);
  }
  return text;
}

async function statFile(p) {
  try {
    const st = await fsp.stat(p);
    if (st.isFile()) return { file: p, size: st.size };
  } catch {}
  return null;
}

async function resolveFile(pathname) {
  // Reject traversal before touching the filesystem.
  const clean = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  if (clean.includes("..")) return null;

  if (clean.startsWith("/ext/")) {
    // mirror layout keeps external assets under assets/<host>/
    return (
      (await statFile(path.join(ROOT, "assets", clean.slice("/ext/".length)))) ||
      (await statFile(path.join(ROOT, clean)))
    );
  }

  const direct = path.join(ROOT, clean);
  // Extension-less paths are routes -> <route>/index.html.
  const candidates = path.extname(clean)
    ? [direct]
    : [path.join(direct, "index.html"), direct + ".html", direct];
  for (const c of candidates) {
    if (!c.startsWith(ROOT)) continue;
    const hit = await statFile(c);
    if (hit) return hit;
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    // 1. redirect replay — origin behavior from the ledger, before anything else
    const redirect = REDIRECTS.get(url.pathname.replace(/(.)\/$/, "$1"));
    if (redirect) {
      // Rewrite the origin host to this server so local navigation stays local;
      // the status code and the path are the origin's.
      const to = redirect.to.replace(/^https?:\/\/[^/]+/, `http://${req.headers.host || "localhost"}`);
      res.writeHead(redirect.code, { location: to, "cache-control": "no-cache" });
      return res.end();
    }

    // 2. stub prefixes (unmirrored analytics proxies): keep the console quiet
    if (STUB_PREFIXES.some((p) => url.pathname.startsWith(p))) {
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end("/* stub */");
    }

    // 3. file resolution (incl. /ext/<host>/ mapping)
    const hit = await resolveFile(url.pathname);
    if (!hit) {
      // Replay the origin's 404 template if the mirror captured one.
      const tpl = await statFile(path.join(ROOT, "404.html"));
      if (tpl && !url.pathname.startsWith("/ext/")) {
        const html = rewrite(await fsp.readFile(tpl.file, "utf8"), ".html");
        res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
        return res.end(html);
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end("404 not found: " + url.pathname);
    }

    const ext = path.extname(hit.file).toLowerCase();
    const headers = {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": "no-cache",
      "access-control-allow-origin": "*",
    };

    // 4. response-layer text transforms (ext-host rewrite + probe injection)
    const wantsProbe = ext === ".html" && url.searchParams.has("__probe") && PROBE_SHIM;
    if ((TEXT_REWRITE.has(ext) && EXT_HOSTS.length) || wantsProbe) {
      let text = await fsp.readFile(hit.file, "utf8");
      if (EXT_HOSTS.length) text = rewrite(text, ext);
      if (wantsProbe) text = text.replace(/<head([^>]*)>/i, `<head$1><script>${PROBE_SHIM}</script>`);
      const body = Buffer.from(text, "utf8");
      res.writeHead(200, { ...headers, "content-length": body.length });
      return res.end(body);
    }

    // 5. Range support, so <video>/<audio> can seek.
    const range = req.headers.range;
    if (range && /^bytes=\d*-\d*$/.test(range)) {
      const [s, e] = range.replace("bytes=", "").split("-");
      const start = s ? Number(s) : 0;
      const end = e ? Number(e) : hit.size - 1;
      if (start >= hit.size || end >= hit.size || start > end) {
        res.writeHead(416, { "content-range": `bytes */${hit.size}` });
        return res.end();
      }
      res.writeHead(206, {
        ...headers,
        "content-range": `bytes ${start}-${end}/${hit.size}`,
        "accept-ranges": "bytes",
        "content-length": end - start + 1,
      });
      return fs.createReadStream(hit.file, { start, end }).pipe(res);
    }

    res.writeHead(200, { ...headers, "content-length": hit.size, "accept-ranges": "bytes" });
    fs.createReadStream(hit.file).pipe(res);
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(e));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`serving ${ROOT}`);
  console.log(`  http://${HOST}:${PORT}/`);
  if (EXT_HOSTS.length) console.log(`  ext hosts: ${EXT_HOSTS.join(", ")}`);
  if (REDIRECTS.size) console.log(`  replaying ${REDIRECTS.size} redirects from ledger`);
});
