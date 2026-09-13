#!/usr/bin/env node
// Compare selected Nuxt SSR output with captured mirror documents.
// Compares the extracted body content, data island and runtime config as strings,
// checks data/config script order, and expects a configured unknown route to 404.
// The config comparison masks buildId. These extractors describe the supported
// Nuxt serialization shape, not arbitrary SSR frameworks or hydrated behavior.
//
//   node verify-ssr.mjs            # allocated default port
//   PORT=3100 node verify-ssr.mjs  # explicit target port
//
// Configure PAGES, MASKS and NOT_FOUND_ROUTE for the project. MIRROR_DIR selects
// the captured documents. Port allocation is a convention and can collide; this
// script reports its target but does not authenticate the server's identity.
//
// Adapted from storytellingnoomo. Its unhead dependency changed data/config script
// order while the main framework version stayed unchanged.


import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { resolvePort } from "./lib/ports.mjs";
import { cli } from "./lib/cli.mjs";

// No flags: everything this gate asserts lives in CONFIG below (PORT / MIRROR_DIR
// come from the environment). cli() still runs so --help works and a stray
// --flag fails explicitly instead of being ignored.
cli({ known: [], file: import.meta.url });

// ---------------------------------------------------------------------------
// CONFIG — edit per project.
// ---------------------------------------------------------------------------
const { port: PORT, label: PORT_LABEL } = resolvePort({
  lane: "verify-ssr.server",
  side: "rebuild",
  env: process.env.PORT || null,
});
const BASE = `http://127.0.0.1:${PORT}`;
console.log(`[verify-ssr] server under test ${BASE}  (${PORT_LABEL})`);
const MIRROR_DIR = process.env.MIRROR_DIR || "mirror";

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

// Say which server is missing before the first fetch throws a bare ECONNREFUSED.
try {
  await fetch(BASE, { redirect: "manual" });
} catch {
  console.error(`no SSR server at ${BASE}  (${PORT_LABEL})`);
  console.error(`  start the rebuild's SSR server on this port, or set PORT for both.`);
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

console.log(failures === 0 ? "\nPASS - configured SSR comparisons passed" : `\nFAIL - ${failures} comparison(s) failed`);
process.exit(failures === 0 ? 0 : 1);
