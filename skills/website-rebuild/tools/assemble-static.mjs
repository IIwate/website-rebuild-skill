#!/usr/bin/env node
/**
 * Assemble Next prerendered HTML into a tree served by serve.mjs.
 * Links _next/static and public assets. This permits the same probe injection on
 * both comparison sides. It does not include runtime RSC navigation responses or
 * all generated icon/OG routes, so test those against the application server.
 * The darkroom case exposed asymmetric freezing when one side used next start.
 */
import { mkdir, readdir, symlink, copyFile, rm } from "node:fs/promises";
import path from "node:path";
import { cli } from "../scripts/lib/cli.mjs";

cli({ known: ["app", "static", "public", "out"], file: import.meta.url });

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const APP = flag("app", "rebuild/.next/server/app");
const STATIC = flag("static", "rebuild/.next/static");
const PUBLIC = flag("public", "rebuild/public");
const OUT = flag("out", "rebuild/static-site");

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
let pages = 0;
async function walk(dir, rel = "") {
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) { await walk(dir, r); continue; }
    if (!e.name.endsWith(".html")) continue;
    const route = r.replace(/\.html$/, "");
    const target = route === "index" ? path.join(OUT, "index.html") : path.join(OUT, route, "index.html");
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(dir, r), target);
    pages++;
  }
}
await walk(APP);
await mkdir(path.join(OUT, "_next"), { recursive: true });
await symlink(path.resolve(STATIC), path.join(OUT, "_next/static"));
let linked = 0;
for (const e of await readdir(PUBLIC).catch(() => [])) {
  await symlink(path.resolve(PUBLIC, e), path.join(OUT, e)).then(() => linked++).catch(() => {});
}
console.log(`static-site assembled: ${OUT} — ${pages} page(s), _next/static linked, ${linked} public entr${linked === 1 ? "y" : "ies"} linked`);
console.log(`serve it with: node scripts/serve.mjs --side rebuild --root ${OUT}`);
