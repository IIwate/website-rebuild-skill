#!/usr/bin/env node
// verify-ssr.mjs — SSR byte-for-byte contract gate: every route's server-
// rendered <body> DOM, serialized data payload and runtime config must match
// the legacy mirror EXACTLY (build-specific values are masked first). Run the
// rebuild's SSR server, then:
//
//   PORT=3100 node verify-ssr.mjs
//
// Exits non-zero on any diff.
//
// The extractors below are written for Nuxt SSR output (NUXT_DATA JSON island
// + window.__NUXT__.config tail script). For another SSR framework, keep the
// gate's skeleton and swap the three extractors for the framework's own
// serialized islands (e.g. Next's __NEXT_DATA__ / RSC payload).
//
// Adapted from storytellingnoomo-rebuild/scripts/verify-ssr.mjs
// (its SSR-byte-gate-first discipline; masking only buildId).

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// CONFIG — edit per project.
// ---------------------------------------------------------------------------
const BASE = `http://127.0.0.1:${process.env.PORT || 3100}`;
const MIRROR_DIR = process.env.MIRROR_DIR || "legacy-mirror";

// Explicit [route, mirrorFile] pairs; null = auto-discover every index.html
// under MIRROR_DIR (dirs starting with "_" or "." and assets/ are skipped).
const PAGES = null;

// [regex, replacement] masks applied to BOTH sides before comparing the config
// blob — for values that legitimately differ per build (never mask real state).
const MASKS = [[/buildId:"[^"]+"/, 'buildId:"X"']];

// A route that must 404 like the origin (unknown slug probe).
const NOT_FOUND_ROUTE = "/__nonexistent-ssr-404-probe";
// ---------------------------------------------------------------------------

function discoverPages() {
  const pages = [];
  const walk = (dir, route) => {
    const idx = path.join(dir, "index.html");
    if (existsSync(idx) && statSync(idx).isFile()) pages.push([route || "/", idx]);
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith("_") || e.name.startsWith(".") || e.name === "assets" || e.name === "ext") continue;
      walk(path.join(dir, e.name), `${route}/${e.name}`);
    }
  };
  walk(path.resolve(MIRROR_DIR), "");
  return pages;
}

// --- extractors (Nuxt SSR; swap per framework) ------------------------------

const bodyDom = (h) => {
  const open = h.match(/<body[^>]*>/);
  if (!open) return "";
  const s = open.index + open[0].length;
  const island = h.indexOf('<script type="application/json" data-nuxt-data');
  const e = island > s ? island : h.indexOf("</body>");
  return h.slice(s, e);
};
const payload = (h) =>
  h.match(/data-nuxt-data[^>]*>(\[[\s\S]*?\])<\/script>/)?.[1] ?? "";
const config = (h) => {
  let c = h.match(/window\.__NUXT__\.config=([\s\S]*?)<\/script>/)?.[1] ?? "";
  for (const [re, sub] of MASKS) c = c.replace(re, sub);
  return c;
};
// Serialization ORDER is part of the contract too (noomo lesson: a transitive
// unhead bump reversed the data/config script order — same framework version,
// different output).
const tailOrder = (h) => {
  const i = h.indexOf("data-nuxt-data");
  const j = h.indexOf("window.__NUXT__.config");
  return i >= 0 && j >= 0 && i < j ? "data,config" : "unexpected";
};

// --- gate -------------------------------------------------------------------

let failures = 0;
const check = (route, name, ok) => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}`);
  }
};

const pages = PAGES ?? discoverPages();
if (pages.length === 0) {
  console.error(`no pages found under ${MIRROR_DIR} — set PAGES explicitly`);
  process.exit(1);
}

for (const [route, mirrorFile] of pages) {
  const a = await fetch(BASE + route).then((r) => r.text());
  const b = readFileSync(mirrorFile, "utf8");
  const results = [
    ["body-dom", bodyDom(a) === bodyDom(b)],
    ["payload", payload(a) === payload(b)],
    ["config", config(a) === config(b)],
    ["tail-order", tailOrder(a) === "data,config"],
  ];
  const allOk = results.every(([, ok]) => ok);
  console.log(`${allOk ? "PASS" : "FAIL"} ${route}`);
  for (const [name, ok] of results) check(route, name, ok);
}

// Unknown routes must 404 like the origin.
const notFound = await fetch(BASE + NOT_FOUND_ROUTE);
console.log(`${notFound.status === 404 ? "PASS" : "FAIL"} ${NOT_FOUND_ROUTE} -> ${notFound.status}`);
if (notFound.status !== 404) failures++;

console.log(failures === 0 ? "\nALL GATES GREEN" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
