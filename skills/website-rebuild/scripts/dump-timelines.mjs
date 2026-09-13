#!/usr/bin/env node
// dump-timelines.mjs — dump every animation curve in baked-timeline GLB files
// to JSON numeric ledgers, so a rebuild's scrub/animation system can be
// verified against SOURCE DATA numerically instead of visually
// (careers-kimi lesson: compare recorded values, not screenshots).
//
// Kept as the exemplar of the "numeric baseline first" discipline: before
// porting any animation system, dump the source's authoritative numbers to a
// ledger and gate the rebuild against those. The GLB parser is format-specific;
// the pattern (hand-rolled parser -> JSON ledger -> numeric gate) generalizes
// to any baked data format.
//
//   node dump-timelines.mjs <file.glb> [...more.glb] [--out docs/timeline-baseline]
//
// Zero dependencies: hand-written GLB (glTF binary) chunk + accessor reader.
// Adapted from storytellingnoomo-rebuild/scripts/dump-timelines.mjs.
//

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { cli } from "./lib/cli.mjs";

cli({ known: ["out"], bools: [], file: import.meta.url, positional: "<file.glb> [...more.glb]" });

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const FILES = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
if (FILES.length === 0) {
  console.error("usage: dump-timelines.mjs <file.glb> [...more.glb] [--out docs/timeline-baseline]");
  process.exit(2);
}
const outDir = path.resolve(flag("out", "docs/timeline-baseline"));
await mkdir(outDir, { recursive: true });

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const READERS = { 5120: "readInt8", 5121: "readUInt8", 5122: "readInt16LE", 5123: "readUInt16LE", 5125: "readUInt32LE", 5126: "readFloatLE" };

function parseGlb(buf) {
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67 || buf.readUInt32LE(4) !== 2) {
    throw new Error("Expected a GLB 2.0 header");
  }
  if (buf.readUInt32LE(8) !== buf.length) throw new Error("GLB length does not match the file");
  const jsonLen = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== 0x4e4f534a || jsonLen % 4 || jsonLen > buf.length - 20) {
    throw new Error("Invalid GLB JSON chunk");
  }
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString());
  let bin = null;
  let off = 20 + jsonLen;
  while (off < buf.length) {
    if (off + 8 > buf.length) throw new Error("Truncated GLB chunk header");
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    if (len % 4 || len > buf.length - off - 8) throw new Error("Invalid GLB chunk length");
    if (type === 0x004e4942) {
      if (bin) throw new Error("Multiple GLB BIN chunks are not supported");
      bin = buf.subarray(off + 8, off + 8 + len);
    }
    off += 8 + len;
  }
  return { json, bin };
}

function readAccessor(json, bin, idx) {
  const acc = json.accessors?.[idx];
  if (!acc) throw new Error(`Missing accessor ${idx}`);
  if (acc.sparse) throw new Error(`Sparse accessor ${idx} is not supported`);
  const bv = json.bufferViews?.[acc.bufferView];
  const buffer = json.buffers?.[0];
  if (!bin || !bv || bv.buffer !== 0 || !buffer || buffer.uri) {
    throw new Error(`Accessor ${idx} requires a bufferView in the embedded GLB buffer`);
  }
  const size = COMPONENT_BYTES[acc.componentType];
  const comps = COMPONENTS[acc.type];
  if (!size || !comps) throw new Error(`Unsupported accessor format at ${idx}`);
  if (acc.normalized && ![5120, 5121, 5122, 5123].includes(acc.componentType)) {
    throw new Error(`Invalid normalized component type at accessor ${idx}`);
  }
  const viewOffset = bv.byteOffset ?? 0, offset = acc.byteOffset ?? 0;
  const stride = bv.byteStride ?? comps * size;
  if (![viewOffset, offset, stride, acc.count, bv.byteLength, buffer.byteLength].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      acc.count === 0 || stride < comps * size || stride % size || (viewOffset + offset) % size ||
      buffer.byteLength > bin.length || viewOffset + bv.byteLength > buffer.byteLength ||
      offset + (acc.count - 1) * stride + comps * size > bv.byteLength) {
    throw new Error(`Accessor ${idx} exceeds its bufferView or has an invalid layout`);
  }
  const values = [];
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < comps; c++) {
      let value = bin[READERS[acc.componentType]](viewOffset + offset + i * stride + c * size);
      if (!Number.isFinite(value)) throw new Error(`Non-finite value in accessor ${idx}`);
      if (acc.normalized) {
        const signed = acc.componentType === 5120 || acc.componentType === 5122;
        value = Math.max(signed ? -1 : 0, value / (2 ** (size * 8 - (signed ? 1 : 0)) - 1));
      }
      values.push(value);
    }
  }
  return { values, comps };
}

for (const file of FILES) {
  const src = path.resolve(file);
  const name = path.basename(src).replace(/\.glb$/i, "");
  const buf = await readFile(src);
  const { json, bin } = parseGlb(buf);
  const nodeName = (i) => json.nodes[i]?.name ?? `node${i}`;
  const out = { source: path.relative(process.cwd(), src), animations: [] };
  for (const anim of json.animations || []) {
    const tracks = [];
    for (const ch of anim.channels) {
      const sampler = anim.samplers[ch.sampler];
      const input = readAccessor(json, bin, sampler.input);
      const output = readAccessor(json, bin, sampler.output);
      tracks.push({
        node: nodeName(ch.target.node),
        path: ch.target.path,
        interpolation: sampler.interpolation || "LINEAR",
        keyframes: input.values.length,
        times: input.values,
        components: output.comps,
        values: output.values,
      });
    }
    const duration = tracks.reduce((max, t) => Math.max(max, t.times[t.times.length - 1] ?? 0), 0);
    out.animations.push({ name: anim.name, duration, tracks });
  }
  const dest = path.join(outDir, `${name}.json`);
  await writeFile(dest, JSON.stringify(out));
  const nTracks = out.animations.reduce((s, a) => s + a.tracks.length, 0);
  console.log(`${name}: ${out.animations.length} clips, ${nTracks} tracks -> ${path.relative(process.cwd(), dest)}`);
}
