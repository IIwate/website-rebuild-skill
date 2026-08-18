#!/usr/bin/env node
// beautify-bundle.mjs — expand minified bundles with a PINNED js-beautify into
// mirror/_pretty/, so beautified line numbers form a stable coordinate
// system for provenance notes ("ported from bundle.js:14032"). A beautifier
// version bump shifts line numbers and INVALIDATES every recorded reference —
// samsyninja lesson: "版本漂移作废坐标系" — hence the hard pin and the
// auto-generated _pretty/README.md recording the version and the exact
// regeneration command per file.
//
//   node beautify-bundle.mjs <bundle.js> [...more files] [--out mirror/_pretty]
//
// The wrapper itself is zero-dependency; it shells out to
//   npx -y js-beautify@1.15.1
// (the version careers-kimi / storytellingnoomo / landonorris all pinned;
// oryzo introduced the _pretty/ convention, samsy first pinned the version).
//
// New thin wrapper written for the website-rebuild skill: the six projects
// carried this as a documented command + README convention, not a script.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

// The pinned beautifier version. NEVER bump mid-project: regenerate everything
// and re-verify every recorded line reference if you must change it.
const JS_BEAUTIFY_VERSION = "1.15.1";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const FILES = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
if (FILES.length === 0) {
  console.error("usage: beautify-bundle.mjs <bundle.js> [...more] [--out mirror/_pretty]");
  process.exit(2);
}
const OUT = path.resolve(flag("out", "mirror/_pretty"));
mkdirSync(OUT, { recursive: true });

const typeFor = (f) =>
  /\.css$/i.test(f) ? "css" : /\.html?$/i.test(f) ? "html" : "js";

const entries = [];
for (const file of FILES) {
  const src = path.resolve(file);
  const dest = path.join(OUT, path.basename(src));
  const type = typeFor(src);
  console.log(`[beautify] ${path.basename(src)} (${type}) -> ${path.relative(process.cwd(), dest)}`);
  const r = spawnSync(
    "npx",
    ["-y", `js-beautify@${JS_BEAUTIFY_VERSION}`, "--type", type, "-f", src, "-o", dest],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if (r.status !== 0) {
    console.error(`[beautify FAIL] ${src} (exit ${r.status})`);
    process.exit(1);
  }
  const sha = createHash("sha256").update(readFileSync(src)).digest("hex");
  entries.push({
    pretty: path.basename(dest),
    source: path.relative(process.cwd(), src),
    sha256: sha,
    type,
  });
}

// The regeneration ledger. Anyone touching _pretty/ must be able to reproduce
// it byte-for-byte from this file alone.
const readme = `# _pretty/ — beautified bundle coordinate system

Beautified with **js-beautify@${JS_BEAUTIFY_VERSION}** (PINNED — a version bump shifts
line numbers and invalidates every recorded \`file:line\` provenance reference;
never regenerate with a different version).

Generated ${new Date().toISOString()} by scripts/beautify-bundle.mjs.

| pretty file | source | source sha256 | regenerate |
|---|---|---|---|
${entries
  .map(
    (e) =>
      `| ${e.pretty} | ${e.source} | \`${e.sha256.slice(0, 16)}…\` | \`npx -y js-beautify@${JS_BEAUTIFY_VERSION} --type ${e.type} -f ${e.source} -o mirror/_pretty/${e.pretty}\` |`,
  )
  .join("\n")}

Rules:
- Files in _pretty/ are READ-ONLY reference material; never edit them.
- If a source bundle changes upstream (sha256 mismatch), re-mirror first,
  regenerate, and re-audit every line-number citation that pointed into it.
`;
writeFileSync(path.join(OUT, "README.md"), readme);
console.log(`[beautify] ${entries.length} file(s) done; ledger -> ${path.relative(process.cwd(), path.join(OUT, "README.md"))}`);
