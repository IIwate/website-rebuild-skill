#!/usr/bin/env node
// serve.mjs — zero-dependency static server for the pristine mirror (and the
// rebuild), so source and rebuild can be diffed side-by-side without network.
//
//   node serve.mjs --side mirror  --root legacy-mirror   # the source site
//   node serve.mjs --side rebuild --root dist            # the rebuild
//   node serve.mjs --side mirror --root legacy-mirror [--ext-hosts cdn.x.com,fonts.gstatic.com]
//                  [--stub-ext-hosts telemetry.example.com] [--port N]
//   PORT=3200 SERVE_ROOT=legacy-mirror node serve.mjs    # explicit port still wins
//
// PORTS AND IDENTITY (scripts/lib/ports.mjs — read its header once):
//   --side is what picks the port, and it is REQUIRED unless you pass an
//   explicit --port/PORT. The mirror and the rebuild therefore always land on
//   two different, self-describing ports (…1 = mirror, …2 = rebuild), and a
//   port that is already taken is a loud exit, never a silent slide to the next
//   free one. Every response also carries an x-wrs-identity token and this
//   server answers /__wrs/identity, which is how pixelcompare.mjs proves its
//   two sides are two processes instead of one server reached by two URLs.
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
//     with --ext-hosts, and name the deliberately-unmirrored telemetry ones
//     with --stub-ext-hosts so they answer with a JS stub instead of a 404
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
//   -> landonorris-rebuild (/ext/<host>/ mapping, 404 semantics, SRI strip)
//   -> racingshop-rebuild (HLS/DASH ladder MIME types)
//   -> shopifydesign-rebuild (.mov MIME, --stub-ext-hosts for hosts that are
//      rewritten into /ext/ but deliberately not mirrored).

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  IDENTITY_HEADER,
  IDENTITY_PATH,
  SIDES,
  SIDE_HEADER,
  describeOccupant,
  fatal,
  labelPort,
  resolvePort,
} from "./lib/ports.mjs";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};

const HOST = flag("host", process.env.HOST || "127.0.0.1");
const ROOT = path.resolve(flag("root", process.env.SERVE_ROOT || "legacy-mirror"));

// Which side of the comparison this instance is. It selects the port, it is
// stamped on every response, and it is the thing that makes a two-sided run
// legible at a glance ("…1 is the mirror, …2 is the rebuild").
const SIDE = flag("side", process.env.SERVE_SIDE || null);
if (SIDE !== null && !(SIDE in SIDES)) {
  fatal(`FATAL: --side must be one of ${Object.keys(SIDES).join(", ")}, got ${JSON.stringify(SIDE)}`, 2);
}
if (SIDE === null && !flagGiven("port") && !process.env.PORT) {
  fatal([
    "FATAL: serve.mjs needs to know which side it is serving.",
    "         node serve.mjs --side mirror  --root legacy-mirror",
    "         node serve.mjs --side rebuild --root dist",
    "       The side picks a distinct, self-describing port for each side of the",
    "       comparison; without it two instances can end up on one port and a",
    "       later A/B run compares one side with itself (lib/ports.mjs header).",
    "       Pass --port/PORT explicitly if you really want to choose the number.",
  ], 2);
}
const { port: PORT, label: PORT_LABEL } = resolvePort({
  lane: "serve",
  side: SIDE ?? "unset",
  cli: flagGiven("port") ? flag("port", null) : null,
  env: process.env.PORT || null,
});

// Per-process identity. Two serve.mjs instances never share it, so an A/B
// script can prove its two URLs are two servers and not one server twice.
const IDENTITY = {
  tool: "serve.mjs",
  side: SIDE ?? "unset",
  root: ROOT,
  port: PORT,
  pid: process.pid,
  token: randomBytes(8).toString("hex"),
  started: new Date().toISOString(),
};

function flagGiven(name) {
  return args.includes("--" + name);
}

// ---------------------------------------------------------------------------
// CONFIG — per-project constants.
// ---------------------------------------------------------------------------

// Same-origin path prefixes to answer with an empty JS stub instead of 404,
// e.g. analytics reverse-proxy blobs that were deliberately not mirrored
// (landonorris stubbed Webflow's GA proxies /nvhc, /avljl this way).
const STUB_PREFIXES = [];

// External hosts that get rewritten into /ext/<host>/ like any other ext host,
// but are then answered with an empty JS stub instead of a file, because they
// were deliberately NOT mirrored (pure telemetry: no behavior to reproduce, and
// letting them out would break the zero-outbound gate). List them here per
// project, or pass --stub-ext-hosts; register each one as a deviation.
// The rewrite is what makes this work even for runtime-built URLs: a loader
// that concatenates a "https://telemetry.example/tag/" literal with an id has
// the literal rewritten in the JS response, so the built URL is redirected too,
// and downstream hosts are never reached because their loaders never execute.
const STUB_EXT_HOSTS = [
  ...flag("stub-ext-hosts", "").split(",").map((s) => s.trim()).filter(Boolean),
];

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
  // .mov shows up in real mirrors; without this it goes out as
  // application/octet-stream and <video> refuses to play it.
  ".mov": "video/quicktime",
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
  // Stubbed hosts must be rewritten too, or the page calls them for real.
  ...STUB_EXT_HOSTS,
  ...flag("ext-hosts", "").split(",").filter(Boolean),
])];

// Redirect replay ledger (optional): "CODE\tFROM\tTO" per line, header skipped.
// FROM may be a bare path or the absolute URL the crawler asked for; requests
// arrive here as paths, so absolute FROMs are also keyed by their local
// equivalent (ext hosts under /ext/<host>/), otherwise the ledger loads and
// replays nothing at all.
const REDIRECTS = new Map();
const localizeUrl = (abs) => {
  const u = new URL(abs);
  return EXT_HOSTS.includes(u.hostname) ? `/ext/${u.hostname}${u.pathname}` : u.pathname;
};
const trimSlash = (p) => p.replace(/(.)\/$/, "$1");
for (const ledger of ["_scripts/redirects.tsv", "redirects.tsv"]) {
  try {
    const tsv = await fsp.readFile(path.join(ROOT, ledger), "utf8");
    for (const line of tsv.trim().split("\n").slice(1)) {
      const [code, from, to] = line.split("\t");
      if (!from || !to) continue;
      const rec = { code: Number(code), to };
      REDIRECTS.set(trimSlash(from), rec);
      if (/^https?:\/\//i.test(from)) {
        try { REDIRECTS.set(trimSlash(localizeUrl(from)), rec); } catch {}
      }
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

    // 0. instance identity. Stamped on EVERY response (so any client can tell
    // which side answered it) and served in full at /__wrs/identity. This is
    // what turns "two URLs" into "two provably different processes" for the
    // A/B scripts; the path is namespaced so it cannot shadow a mirrored one.
    res.setHeader(IDENTITY_HEADER, IDENTITY.token);
    res.setHeader(SIDE_HEADER, IDENTITY.side);
    if (url.pathname === IDENTITY_PATH) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify(IDENTITY));
    }

    // 1. redirect replay — origin behavior from the ledger, before anything else
    const redirect = REDIRECTS.get(trimSlash(url.pathname));
    if (redirect) {
      // Rewrite the origin host to this server so local navigation stays local
      // (an ext host goes to its /ext/<host>/ home instead); the status code and
      // the path are the origin's. A relative Location is already local.
      let to = redirect.to;
      if (/^https?:\/\//i.test(to)) {
        const u = new URL(to);
        to = EXT_HOSTS.includes(u.hostname)
          ? `/ext/${u.hostname}${u.pathname}${u.search}`
          : `http://${req.headers.host || "localhost"}${u.pathname}${u.search}${u.hash}`;
      }
      res.writeHead(redirect.code, { location: to, "cache-control": "no-cache" });
      return res.end();
    }

    // 2. stub prefixes (unmirrored analytics proxies): keep the console quiet
    if (STUB_PREFIXES.some((p) => url.pathname.startsWith(p))) {
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end("/* stub */");
    }

    // 2b. telemetry hosts rewritten into /ext/ but never mirrored -> JS stub.
    if (STUB_EXT_HOSTS.some((h) => url.pathname.startsWith(`/ext/${h}/`))) {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      return res.end("/* unmirrored telemetry host: stubbed */");
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

// A taken port is a hard stop, not a nudge to the next free one: the whole
// point of the allocation is that the other scripts can find this server where
// they expect it, and a server that moved leaves them talking to whatever else
// answers there.
server.on("error", async (e) => {
  if (e.code !== "EADDRINUSE") throw e;
  fatal([
    `FATAL: serve.mjs cannot bind port ${PORT_LABEL} — it is already taken.`,
    `       occupant: ${await describeOccupant(PORT)}`,
    `       (if that is a stale serve.mjs of yours, stop it; if it is another`,
    `        workspace, give this one its own slot: WRS_PORT_SLOT=<0..8>)`,
  ]);
});

server.listen(PORT, HOST, () => {
  console.log(`serving ${ROOT}  [side ${IDENTITY.side.toUpperCase()}]`);
  console.log(`  http://${HOST}:${PORT}/`);
  console.log(`  port ${labelPort(PORT)}`);
  console.log(`  identity ${IDENTITY.token}  (GET ${IDENTITY_PATH})`);
  if (EXT_HOSTS.length) console.log(`  ext hosts: ${EXT_HOSTS.join(", ")}`);
  if (REDIRECTS.size) console.log(`  replaying ${REDIRECTS.size} redirects from ledger`);
});
