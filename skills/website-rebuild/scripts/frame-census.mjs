#!/usr/bin/env node
/**
 * Check PNG colour distributions for low-information captures.
 * Reports the number of distinct RGB values and the most common colour's share.
 * Fewer than 64 colours or more than 97% of one colour marks a suspected blank
 * frame. These are heuristics: sparse valid pages can fail, and a nonblank frame
 * does not establish that the intended scene or application state was captured.
 *
 * Zero mean difference between two captures can also result from equal blank
 * frames or coarse-grid averaging. Use page-specific readiness checks as well.
 *
 *   node scripts/frame-census.mjs docs/compare/mirror-home-frozen.png [...]
 */
import { readFile } from "node:fs/promises";
import { decodePng } from "./lib/png.mjs";
import { cli } from "./lib/cli.mjs";

cli({ file: import.meta.url, positional: "<frame.png> [...]" });

let frames = 0, failures = 0;
for (const f of process.argv.slice(2)) {
  const { width, height, data } = decodePng(await readFile(f));
  const colours = new Set();
  const hist = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const k = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    colours.add(k);
    hist.set(k, (hist.get(k) || 0) + 1);
  }
  let top = 0, topK = 0;
  for (const [k, n] of hist) if (n > top) { top = n; topK = k; }
  const px = width * height;
  const bgShare = (top / px) * 100;
  const hex = "#" + topK.toString(16).padStart(6, "0");
  const suspectedBlank = colours.size < 64 || bgShare > 97;
  const verdict = suspectedBlank ? "FAIL suspected blank frame" : "PASS colour distribution";
  console.log(`  ${verdict}  ${f.split("/").pop().padEnd(30)} ${width}x${height}  distinct=${String(colours.size).padStart(6)}  dominant ${hex} ${bgShare.toFixed(1)}%`);
  frames++;
  if (suspectedBlank) failures++;
}
process.exit(frames > 0 && failures === 0 ? 0 : 1);
