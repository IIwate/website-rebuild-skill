#!/usr/bin/env node
/**
 * Verify Markdown source coordinates against a configured source root.
 *
 * The checker is deliberately independent from the producer that created the
 * ledger. It resolves every path, reads the referenced line, and checks an
 * optional needle on that same line. Configuration is the only source of the
 * document set and of historical dead zones.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const HELP = `Usage:
  node scripts/verify-ledger.mjs --help
  node scripts/verify-ledger.mjs --config <config.json|config.mjs> [options]
  node scripts/verify-ledger.mjs --docs <file> [--docs <file> ...] [options]

Options:
  --root <dir>             Project root. Default: current directory.
  --docs <file>            Markdown document to scan. May be repeated.
  --config <file>          JSON or ES module configuration.
  --pretty-root <dir>      Source root containing pretty files.
  --fatal-unresolved       Turn unbound L#### references into failures.
  --format text|json       Output format. Default: text.
  --help                   Print this help and exit.

Configuration fields:
  root, prettyRoot, documents, sourceFiles, and per-document deadZones.
  A document is a string or { path, deadZones }. A source file is a string or
  { path, aliases }. Dead zones require literal start and end markers.

Exit codes:
  0  all checked references passed (unresolved warnings are allowed by default)
  1  a ledger assertion failed, or --fatal-unresolved found an unresolved item
  2  CLI, configuration, or input loading error
`;

const SOURCE_EXTENSIONS = /\.(?:[cm]?js|jsx|ts|tsx)$/i;
const REFERENCE_RE = /\bL(\d+)(?:\s*[–—-]\s*L?(\d+))?/g;
const FILE_TOKEN_RE = /`([^`\r\n]+)`/g;
const NARRATIVE_ARROW_RE = /[→]|->/;

function usageError(message) {
  console.error(`FATAL: ${message}`);
  process.exitCode = 2;
  return null;
}

function parseArgs(argv) {
  const options = { docs: [], format: "text", fatalUnresolved: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--fatal-unresolved") options.fatalUnresolved = true;
    else if (["--root", "--docs", "--config", "--pretty-root", "--format"].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) return usageError(`${arg} requires a value`);
      if (arg === "--docs") options.docs.push(value);
      else if (arg === "--root") options.root = value;
      else if (arg === "--config") options.config = value;
      else if (arg === "--pretty-root") options.prettyRoot = value;
      else options.format = value;
    } else return usageError(`unknown option ${arg}`);
  }
  if (!options.help && !["text", "json"].includes(options.format)) {
    return usageError(`--format must be text or json, got ${options.format}`);
  }
  return options;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function loadData(file) {
  const absolute = path.resolve(file);
  let info;
  try { info = statSync(absolute, { throwIfNoEntry: false }); }
  catch (error) { throw new Error(`${file}: cannot stat configuration: ${error.message}`); }
  if (!info?.isFile()) throw new Error(`${file}: file does not exist`);
  if (absolute.toLowerCase().endsWith(".json")) {
    try { return JSON.parse(readFileSync(absolute, "utf8")); }
    catch (error) { throw new Error(`${file}: invalid JSON: ${error.message}`); }
  }
  if (absolute.toLowerCase().endsWith(".mjs")) {
    try {
      const loaded = await import(`${pathToFileURL(absolute).href}?v=${Date.now()}`);
      return loaded.default ?? loaded.config ?? loaded;
    } catch (error) { throw new Error(`${file}: cannot load module: ${error.message}`); }
  }
  throw new Error(`${file}: expected .json or .mjs`);
}

function normalizeSlashes(value) {
  return String(value).replaceAll("\\", "/");
}

function isWithin(candidate, parent) {
  const child = path.resolve(candidate);
  const base = path.resolve(parent);
  return child === base || child.startsWith(`${base}${path.sep}`);
}

function realPathIfPresent(file) {
  let current = path.resolve(file);
  const suffix = [];
  while (true) {
    try { return path.join(realpathSync(current), ...suffix); }
    catch {}
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(file);
    suffix.unshift(path.basename(current));
    current = parent;
  }
}

function resolvePath(value, base, boundary, field, { mustExist = false } = {}) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field}: expected a non-empty path`);
  const absolute = path.resolve(base, value);
  if (!isWithin(absolute, boundary) || !isWithin(realPathIfPresent(absolute), boundary)) {
    throw new Error(`${field}: path escapes ${boundary}`);
  }
  if (mustExist && !statSync(absolute, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${field}: file does not exist: ${value}`);
  }
  return realPathIfPresent(absolute);
}

function resolveDirectory(value, base, field, boundary = null) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field}: expected a non-empty path`);
  const directory = path.resolve(base, value);
  if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${field}: directory does not exist: ${directory}`);
  const resolved = realPathIfPresent(directory);
  if (boundary && !isWithin(resolved, boundary)) throw new Error(`${field}: path escapes ${boundary}`);
  return resolved;
}

function listSourceFiles(directory) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && SOURCE_EXTENSIONS.test(entry.name)) files.push(file);
    }
  };
  walk(directory);
  return files.sort();
}

function asDocumentEntries(config, cliDocs) {
  const raw = cliDocs.length > 0 ? cliDocs.map((file) => ({ path: file })) : config.documents ?? config.docs;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("documents: provide --docs or a non-empty documents array");
  return raw.map((entry, index) => {
    if (typeof entry === "string") return { path: entry, deadZones: config.deadZones ?? [] };
    if (!isObject(entry)) throw new Error(`documents[${index}]: expected a path or object`);
    return { ...entry, deadZones: entry.deadZones ?? (cliDocs.length ? [] : config.deadZones ?? []) };
  });
}

function asSourceEntries(config) {
  const raw = config.sourceFiles ?? config.sources;
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("sourceFiles: expected a non-empty array");
  return raw.map((entry, index) => {
    if (typeof entry === "string") return { path: entry, aliases: [] };
    if (!isObject(entry)) throw new Error(`sourceFiles[${index}]: expected a path or object`);
    return { ...entry, path: entry.path ?? entry.file, aliases: entry.aliases ?? [] };
  });
}

function resolveSourceFile(value, root, prettyRoot, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field}: expected a non-empty path`);
  const first = path.resolve(prettyRoot, value);
  if (statSync(first, { throwIfNoEntry: false })?.isFile()) return resolvePath(first, prettyRoot, prettyRoot, field, { mustExist: true });
  if (!path.isAbsolute(value)) {
    const rootRelative = path.resolve(root, value);
    if (isWithin(rootRelative, prettyRoot) && statSync(rootRelative, { throwIfNoEntry: false })?.isFile()) {
      return resolvePath(rootRelative, prettyRoot, prettyRoot, field, { mustExist: true });
    }
  }
  return resolvePath(first, prettyRoot, prettyRoot, field, { mustExist: true });
}

function validateDeadZones(rawZones, docLabel, lines) {
  if (rawZones === undefined) return [];
  if (!Array.isArray(rawZones)) throw new Error(`${docLabel}.deadZones: expected an array`);
  const zones = [];
  for (let index = 0; index < rawZones.length; index += 1) {
    const raw = rawZones[index];
    if (!isObject(raw)) throw new Error(`${docLabel}.deadZones[${index}]: expected an object`);
    const start = raw.start ?? raw.begin;
    const end = raw.end ?? raw.finish;
    if (typeof start !== "string" || start === "" || typeof end !== "string" || end === "") {
      throw new Error(`${docLabel}.deadZones[${index}]: start and end markers are required`);
    }
    if (start === end) throw new Error(`${docLabel}.deadZones[${index}]: start and end markers must differ`);
    const startLines = lines.flatMap((line, lineIndex) => line.includes(start) ? [lineIndex + 1] : []);
    const endLines = lines.flatMap((line, lineIndex) => line.includes(end) ? [lineIndex + 1] : []);
    if (startLines.length === 0) throw new Error(`${docLabel}.deadZones[${index}].start: marker not found`);
    if (endLines.length === 0) throw new Error(`${docLabel}.deadZones[${index}].end: marker not found`);
    if (startLines.length !== endLines.length) throw new Error(`${docLabel}.deadZones[${index}]: start/end marker count differs`);
    let previousEnd = 0;
    for (let pair = 0; pair < startLines.length; pair += 1) {
      if (startLines[pair] <= previousEnd || endLines[pair] < startLines[pair]) {
        throw new Error(`${docLabel}.deadZones[${index}]: markers are unordered or overlapping`);
      }
      previousEnd = endLines[pair];
      zones.push({ start: startLines[pair], end: endLines[pair] });
    }
  }
  return zones;
}

function lineInZone(lineNumber, zones) {
  return zones.some((zone) => lineNumber >= zone.start && lineNumber <= zone.end);
}

function sourceTokenKind(content, sourceIndex) {
  const normalized = normalizeSlashes(content).replace(/^\.\//, "");
  if (!SOURCE_EXTENSIONS.test(normalized)) return { kind: "not-source" };
  const exact = sourceIndex.byRelative.get(normalized)
    ?? sourceIndex.byRootRelative.get(normalized)
    ?? sourceIndex.byAbsolute.get(path.resolve(sourceIndex.root, normalized))
    ?? sourceIndex.byAlias.get(normalized);
  if (exact) return { kind: "source", file: exact };
  return { kind: "missing", content };
}

function buildSourceIndex(root, prettyRoot, config) {
  const configured = asSourceEntries(config);
  const entries = configured
    ? configured.map((entry, index) => ({
      field: `sourceFiles[${index}]`,
      file: resolveSourceFile(entry.path, root, prettyRoot, `sourceFiles[${index}].path`),
      aliases: Array.isArray(entry.aliases) ? entry.aliases : (() => { throw new Error(`sourceFiles[${index}].aliases: expected an array`); })(),
    }))
    : listSourceFiles(prettyRoot).map((file) => ({ field: "sourceFiles", file, aliases: [] }));
  const byRelative = new Map();
  const byRootRelative = new Map();
  const byAbsolute = new Map();
  const byAlias = new Map();
  const seen = new Map();
  const keyOwners = new Map();
  for (const entry of entries) {
    const normalized = normalizeSlashes(path.relative(prettyRoot, entry.file));
    const rootRelative = normalizeSlashes(path.relative(root, entry.file));
    if (seen.has(entry.file)) throw new Error(`${entry.field}.path: duplicate path also declared at ${seen.get(entry.file)}`);
    seen.set(entry.file, entry.field);
    for (const [index, key] of [[byRelative, normalized], [byRootRelative, rootRelative], [byAbsolute, path.resolve(entry.file)]]) {
      if (keyOwners.has(key) && keyOwners.get(key).file !== entry.file) throw new Error(`${entry.field}.path: duplicate source mapping ${key} also declared at ${keyOwners.get(key).field}`);
      keyOwners.set(key, { file: entry.file, field: entry.field });
      index.set(key, entry.file);
    }
    for (const alias of entry.aliases) {
      if (typeof alias !== "string" || alias === "") throw new Error(`${entry.field}.aliases: aliases must be non-empty strings`);
      const key = normalizeSlashes(alias).replace(/^\.\//, "");
      if (keyOwners.has(key) && keyOwners.get(key).file !== entry.file) throw new Error(`${entry.field}.aliases: duplicate source mapping ${alias} also declared at ${keyOwners.get(key).field}`);
      keyOwners.set(key, { file: entry.file, field: entry.field });
      if (byAlias.has(key) && byAlias.get(key) !== entry.file) throw new Error(`${entry.field}.aliases: duplicate alias ${alias}`);
      byAlias.set(key, entry.file);
    }
  }
  return { root, prettyRoot, files: entries.map((entry) => entry.file), byRelative, byRootRelative, byAbsolute, byAlias };
}

function fileEventAt(raw, sourceIndex) {
  const events = [];
  FILE_TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = FILE_TOKEN_RE.exec(raw))) {
    const result = sourceTokenKind(match[1], sourceIndex);
    if (result.kind !== "not-source") events.push({ at: match.index, end: FILE_TOKEN_RE.lastIndex, content: match[1], result });
  }
  return events;
}

function needleAfter(raw, referenceEnd, sourceIndex) {
  let position = referenceEnd;
  while (/\s/.test(raw[position] ?? "")) position += 1;
  if (raw[position] === "(") {
    position += 1;
    while (/\s/.test(raw[position] ?? "")) position += 1;
  }
  if (raw[position] !== "`") return null;
  const end = raw.indexOf("`", position + 1);
  if (end < 0) return null;
  const content = raw.slice(position + 1, end);
  const kind = sourceTokenKind(content, sourceIndex);
  if (kind.kind === "source") {
    if (raw[referenceEnd] === "(") return null;
    const suffix = raw.slice(end + 1);
    const match = suffix.match(/^\s*\(\s*`([^`\r\n]+)`/);
    return match ? match[1] : null;
  }
  if (kind.kind === "ambiguous" || kind.kind === "missing") return null;
  return content;
}

function resolveReferenceFile(reference, fileEvents, stickyFile, raw) {
  const previous = fileEvents.filter((event) => event.at < reference.at).at(-1);
  const next = fileEvents.find((event) => event.at > reference.at);
  const separator = /^[\s()[\]{}:;,，、：；（）【】—–-]*$/u;
  const beforeDirect = previous && separator.test(raw.slice(previous.end, reference.at));
  const afterDirect = next && separator.test(raw.slice(reference.end, next.at));
  const direct = [beforeDirect ? previous : null, afterDirect ? next : null].filter(Boolean);
  const directFiles = new Set(direct.filter((event) => event.result.kind === "source").map((event) => event.result.file));
  if (directFiles.size > 1) return { status: "ambiguous", events: direct };
  if (direct.length > 0) {
    const event = direct[0];
    if (event.result.kind === "source") return { status: "ok", file: event.result.file };
    if (event.result.kind === "ambiguous") return { status: "ambiguous", events: direct };
    return { status: "missing", event };
  }
  const lineFiles = new Set(fileEvents.filter((event) => event.result.kind === "source").map((event) => event.result.file));
  if (lineFiles.size > 1) return { status: "ambiguous", events: fileEvents };
  if (lineFiles.size === 1) return { status: "ok", file: [...lineFiles][0] };
  return stickyFile ? { status: "ok", file: stickyFile } : { status: "unresolved" };
}

function findLineNeedle(raw, referenceEnd, sourceIndex) {
  return needleAfter(raw, referenceEnd, sourceIndex);
}

function addFinding(state, kind, doc, line, detail) {
  state.findings.push({ kind, doc, line, detail });
  if (kind === "unresolved") state.stats.unresolved += 1;
  else if (kind === "skipped") state.stats.skipped += 1;
  else if (kind === "failed") state.stats.failed += 1;
}

function scanDocument(document, sourceIndex, state) {
  const text = readFileSync(document.file, "utf8");
  const lines = text.split("\n");
  const zones = validateDeadZones(document.deadZones, `${document.label}`, lines);
  let stickyFile = null;
  for (let index = 0; index < lines.length; index += 1) {
    const docLine = index + 1;
    const raw = lines[index];
    const trimmed = raw.trim();
    if (/^#{1,6}\s/.test(trimmed) || trimmed === "") stickyFile = null;
    const fileEvents = fileEventAt(raw, sourceIndex);
    const isTable = trimmed.startsWith("|");
    REFERENCE_RE.lastIndex = 0;
    const references = [];
    let match;
    while ((match = REFERENCE_RE.exec(raw))) references.push({ at: match.index, end: REFERENCE_RE.lastIndex, start: Number(match[1]), finish: match[2] ? Number(match[2]) : null });
    for (const reference of references) {
      const around = raw.slice(Math.max(0, reference.at - 5), reference.at + 1) + raw.slice(reference.end, Math.min(raw.length, reference.end + 8));
      if (NARRATIVE_ARROW_RE.test(around)) {
        addFinding(state, "skipped", document.label, docLine, `L${reference.start} is narration near an arrow`);
        continue;
      }
      if (lineInZone(docLine, zones)) {
        addFinding(state, "skipped", document.label, docLine, `L${reference.start} is inside a configured dead zone`);
        continue;
      }
      const resolved = resolveReferenceFile(reference, fileEvents, isTable ? null : stickyFile, raw);
      if (resolved.status !== "ok") {
        const detail = resolved.status === "ambiguous"
          ? `L${reference.start} has ambiguous source tokens ${resolved.events.map((event) => `\`${event.content}\``).join(", ")}; place one path adjacent to the coordinate`
          : resolved.status === "missing"
            ? `L${reference.start} names missing or undeclared source \`${resolved.event.content}\``
            : `L${reference.start} has no source file token`;
        if (resolved.status === "unresolved") addFinding(state, "unresolved", document.label, docLine, detail);
        else addFinding(state, "failed", document.label, docLine, detail);
        continue;
      }
      stickyFile = resolved.file;
      const sourceText = readFileSync(resolved.file, "utf8");
      const sourceLines = sourceText.split("\n");
      const endpoints = reference.finish === null ? [reference.start] : [reference.start, reference.finish];
      let boundsPass = true;
      for (const endpoint of endpoints) {
        if (!Number.isInteger(endpoint) || endpoint < 1 || endpoint > sourceLines.length) {
          addFinding(state, "failed", document.label, docLine, `${normalizeSlashes(path.relative(sourceIndex.root, resolved.file))}: L${endpoint} is outside 1..${sourceLines.length}`);
          boundsPass = false;
        }
      }
      state.stats.checked += 1;
      if (!boundsPass) continue;
      const needle = findLineNeedle(raw, reference.end, sourceIndex);
      if (needle !== null && !sourceLines[reference.start - 1].includes(needle)) {
        addFinding(state, "failed", document.label, docLine, `${normalizeSlashes(path.relative(sourceIndex.root, resolved.file))}: L${reference.start} does not contain needle \`${needle}\``);
        continue;
      }
      state.stats.passed += 1;
    }
  }
}

function outputText(result) {
  const { stats, findings } = result;
  const lines = [
    "--- verify-ledger ---",
    `checked=${stats.checked} passed=${stats.passed} skipped=${stats.skipped} unresolved=${stats.unresolved} failed=${stats.failed}`,
  ];
  for (const finding of findings) lines.push(`  [${finding.kind}] ${finding.doc}:${finding.line} :: ${finding.detail}`);
  const failed = stats.failed > 0 || (result.fatalUnresolved && stats.unresolved > 0);
  lines.push(failed ? "FAIL" : "PASS");
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return;
  if (options.help) {
    console.log(HELP);
    return;
  }
  let config = {};
  try {
    if (options.config) config = await loadData(options.config);
    if (!isObject(config)) throw new Error("configuration must export an object");
    const root = resolveDirectory(options.root ?? config.root ?? ".", process.cwd(), "root");
    const prettyRoot = resolveDirectory(options.prettyRoot ?? config.prettyRoot ?? config.sourceRoot ?? "mirror/_pretty", root, "prettyRoot", root);
    const sourceIndex = buildSourceIndex(root, prettyRoot, config);
    const documents = asDocumentEntries(config, options.docs).map((document, index) => {
      const fileValue = document.path ?? document.file;
      const file = resolvePath(fileValue, root, root, `documents[${index}].path`, { mustExist: true });
      if (!file.toLowerCase().endsWith(".md")) throw new Error(`documents[${index}].path: only Markdown documents are scanned`);
      return { ...document, file, label: normalizeSlashes(path.relative(root, file)) || file };
    });
    const seenDocuments = new Set();
    for (const document of documents) {
      if (seenDocuments.has(document.file)) throw new Error(`documents: duplicate path ${document.label}`);
      seenDocuments.add(document.file);
    }
    const result = { fatalUnresolved: options.fatalUnresolved, stats: { checked: 0, passed: 0, skipped: 0, unresolved: 0, failed: 0 }, findings: [] };
    for (const document of documents) scanDocument(document, sourceIndex, result);
    if (options.format === "json") console.log(JSON.stringify({ ok: result.stats.failed === 0 && (!options.fatalUnresolved || result.stats.unresolved === 0), ...result }, null, 2));
    else console.log(outputText(result));
    if (result.stats.failed > 0 || (options.fatalUnresolved && result.stats.unresolved > 0)) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.format === "json") console.log(JSON.stringify({ ok: false, error: message, stats: { checked: 0, passed: 0, skipped: 0, unresolved: 0, failed: 1 }, findings: [] }, null, 2));
    else console.error(`FATAL: ${message}`);
    process.exitCode = 2;
  }
}

await main();
