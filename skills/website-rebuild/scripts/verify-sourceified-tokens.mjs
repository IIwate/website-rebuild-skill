#!/usr/bin/env node
/**
 * Verify sourceified JavaScript fragments with a pinned Acorn tokenizer.
 *
 * This is a gate, so it does not import the sourceification tool. The plan
 * supplies both exact line ranges and the complete set of permitted changes.
 * Whitespace and comments disappear in Acorn's token stream; every other
 * token, including string and property-key spelling, remains observable.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";

const ACORN_PACKAGE = "acorn@8.14.0";
const ACORN_MAX_ECMA = 2025;
const AUTO_VERSIONS = [2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017, 2016, 2015, 5, 3];
const HELP = `Usage:
  node scripts/verify-sourceified-tokens.mjs --plan <plan.json|plan.mjs> --rename-map <rename-map.json|rename-map.mjs> [--root <dir>] [--ecma-version latest|auto|<number>] [--format text|json]

The plan must contain units (or comparisons). Each unit has an id, an
original fragment, a sourceified fragment, and allowedChanges. A fragment is
{ file, range: { start, end } } with inclusive line numbers. A change is
{ kind: "identifier"|"shorthand-expansion", from, to, count }.

ECMAScript selection:
  latest uses the fixed Acorn 8.14.0 maximum (${ACORN_MAX_ECMA}).
  auto tries the fixed supported versions from high to low and reports the
  selected version. Explicit versions never fall back.

Exit codes:
  0  every comparison passed
  1  token, parse, or verification failure
  2  CLI or plan/mapping configuration error
`;

class ConfigurationError extends Error {}
class VerificationError extends Error {}

function parseArgs(argv) {
  const result = { format: "text", ecmaVersion: "latest" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") result.help = true;
    else if (["--plan", "--rename-map", "--root", "--ecma-version", "--format"].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new ConfigurationError(`${arg} requires a value`);
      if (arg === "--plan") result.plan = value;
      else if (arg === "--rename-map") result.renameMap = value;
      else if (arg === "--root") result.root = value;
      else if (arg === "--ecma-version") result.ecmaVersion = value;
      else result.format = value;
    } else throw new ConfigurationError(`unknown option ${arg}`);
  }
  if (!result.help && !["text", "json"].includes(result.format)) throw new ConfigurationError("--format must be text or json");
  if (!result.help && (!result.plan || !result.renameMap)) throw new ConfigurationError("--plan and --rename-map are required");
  return result;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function loadData(file) {
  const absolute = path.resolve(file);
  if (!statSync(absolute, { throwIfNoEntry: false })?.isFile()) throw new ConfigurationError(`${file}: file does not exist`);
  if (absolute.toLowerCase().endsWith(".json")) {
    try { return JSON.parse(readFileSync(absolute, "utf8")); }
    catch (error) { throw new ConfigurationError(`${file}: invalid JSON: ${error.message}`); }
  }
  if (absolute.toLowerCase().endsWith(".mjs")) {
    try {
      const loaded = await import(`${pathToFileURL(absolute).href}?v=${Date.now()}`);
      return loaded.default ?? loaded.config ?? loaded;
    } catch (error) { throw new ConfigurationError(`${file}: cannot load module: ${error.message}`); }
  }
  throw new ConfigurationError(`${file}: expected .json or .mjs`);
}

function normalizeSlashes(value) {
  return String(value).replaceAll("\\", "/");
}

function isWithin(file, root) {
  const candidate = path.resolve(file);
  const boundary = path.resolve(root);
  return candidate === boundary || candidate.startsWith(`${boundary}${path.sep}`);
}

function resolveRoot(value) {
  const root = path.resolve(process.cwd(), value ?? ".");
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new ConfigurationError(`root: directory does not exist: ${root}`);
  return realPath(root);
}

function resolveInputPath(value, root, field) {
  if (typeof value !== "string" || value === "") throw new ConfigurationError(`${field}.file: expected a non-empty path`);
  const file = path.resolve(root, value);
  if (!isWithin(file, root) || !isWithin(path.resolve(realPath(file)), root)) throw new ConfigurationError(`${field}.file: path escapes root`);
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) throw new ConfigurationError(`${field}.file: file does not exist: ${value}`);
  return file;
}

function realPath(file) {
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

function fileLineStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) if (text[index] === "\n") starts.push(index + 1);
  return starts;
}

function normalizeRange(spec, field, text) {
  if (!isObject(spec)) throw new ConfigurationError(`${field}: expected an object`);
  const range = spec.range ?? spec;
  if (!isObject(range)) throw new ConfigurationError(`${field}.range: expected an object`);
  const starts = fileLineStarts(text);
  if (range.startChar !== undefined || range.endChar !== undefined || range.kind === "characters") {
    const start = Number(range.startChar ?? range.start);
    const end = Number(range.endChar ?? range.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length) throw new ConfigurationError(`${field}.range: invalid character range`);
    return { startOffset: start, endOffset: end, startLine: lineAt(starts, start), endLine: lineAt(starts, end - 1) };
  }
  const pair = Array.isArray(range.lines) ? range.lines : null;
  const start = Number(range.startLine ?? range.from ?? pair?.[0] ?? range.start);
  const end = Number(range.endLine ?? range.to ?? pair?.[1] ?? range.end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > starts.length) throw new ConfigurationError(`${field}.range: invalid inclusive line range`);
  return { startOffset: starts[start - 1], endOffset: end === starts.length ? text.length : starts[end], startLine: start, endLine: end };
}

function lineAt(starts, offset) {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = (low + high) >> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle;
  }
  return low + 1;
}

function normalizeFragment(raw, field, root, cache) {
  if (!isObject(raw)) throw new ConfigurationError(`${field}: expected a fragment object`);
  const file = resolveInputPath(raw.file ?? raw.path, root, field);
  let text = cache.get(file);
  if (text === undefined) {
    text = readFileSync(file, "utf8");
    cache.set(file, text);
  }
  const range = normalizeRange(raw, field, text);
  return {
    file,
    text: text.slice(range.startOffset, range.endOffset),
    range: { startLine: range.startLine, endLine: range.endLine },
    field,
  };
}

function normalizeChange(raw, field) {
  if (!isObject(raw)) throw new ConfigurationError(`${field}: expected an object`);
  const kind = raw.kind ?? raw.type;
  if (kind !== "identifier" && kind !== "shorthand-expansion") throw new ConfigurationError(`${field}.kind: expected identifier or shorthand-expansion`);
  const from = raw.from;
  const to = raw.to;
  if (typeof from !== "string" || from === "" || typeof to !== "string" || to === "" || from === to) throw new ConfigurationError(`${field}: from and to must be different non-empty strings`);
  const count = raw.count ?? raw.occurrences ?? 1;
  if (!Number.isInteger(count) || count < 1) throw new ConfigurationError(`${field}.count: expected a positive integer`);
  const key = raw.key ?? raw.property ?? from;
  if (kind === "shorthand-expansion" && (typeof key !== "string" || key === "")) throw new ConfigurationError(`${field}.key: expected a non-empty string`);
  return { kind, from, to, count, key: String(key) };
}

function normalizeUnits(plan, root, cache) {
  if (!isObject(plan)) throw new ConfigurationError("plan: expected an object");
  const rawUnits = plan.units ?? plan.comparisons ?? plan.records;
  if (!Array.isArray(rawUnits) || rawUnits.length === 0) throw new ConfigurationError("plan.units: expected a non-empty array");
  const sourceType = plan.sourceType ?? "module";
  if (sourceType !== "module" && sourceType !== "script") throw new ConfigurationError("plan.sourceType: expected module or script");
  const ids = new Set();
  return rawUnits.map((raw, index) => {
    const field = `plan.units[${index}]`;
    if (!isObject(raw) || typeof raw.id !== "string" || raw.id === "") throw new ConfigurationError(`${field}.id: expected a unique non-empty string`);
    if (ids.has(raw.id)) throw new ConfigurationError(`${field}.id: duplicate id ${raw.id}`);
    ids.add(raw.id);
    const original = normalizeFragment(raw.original ?? raw.before, `${field}.original`, root, cache);
    const sourceified = normalizeFragment(raw.sourceified ?? raw.source ?? raw.after, `${field}.sourceified`, root, cache);
    const rawChanges = raw.allowedChanges ?? raw.allowedTokenChanges ?? raw.changes;
    if (!Array.isArray(rawChanges)) throw new ConfigurationError(`${field}.allowedChanges: expected an array`);
    const changes = rawChanges.map((change, changeIndex) => normalizeChange(change, `${field}.allowedChanges[${changeIndex}]`));
    const signatures = new Set();
    for (const change of changes) {
      const signature = `${change.kind}:${change.from}->${change.to}:${change.key}`;
      if (signatures.has(signature)) throw new ConfigurationError(`${field}.allowedChanges: duplicate ${signature}`);
      signatures.add(signature);
    }
    const unitSourceType = raw.sourceType ?? sourceType;
    if (unitSourceType !== "module" && unitSourceType !== "script") throw new ConfigurationError(`${field}.sourceType: expected module or script`);
    return { id: raw.id, original, sourceified, changes, sourceType: unitSourceType };
  });
}

function normalizeRenameMap(raw) {
  let entries;
  if (Array.isArray(raw)) entries = raw;
  else if (isObject(raw) && Array.isArray(raw.renames)) entries = raw.renames;
  else if (isObject(raw) && Array.isArray(raw.mapping)) entries = raw.mapping;
  else if (isObject(raw) && isObject(raw.map)) entries = Object.entries(raw.map).map(([from, to]) => ({ from, to }));
  else if (isObject(raw)) entries = Object.entries(raw).map(([from, to]) => ({ from, to }));
  else throw new ConfigurationError("rename-map: expected an object or array");
  if (entries.length === 0) throw new ConfigurationError("rename-map: no mappings supplied");
  const result = [];
  const seenPairs = new Set();
  const fromTo = new Map();
  const toFrom = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const from = typeof entry === "object" ? entry.from ?? entry.old : null;
    const to = typeof entry === "object" ? entry.to ?? entry.new : entry;
    if (typeof from !== "string" || typeof to !== "string" || from === "" || to === "" || from === to) throw new ConfigurationError(`rename-map[${index}]: from and to must be different strings`);
    const pair = `${from}->${to}`;
    if (seenPairs.has(pair)) throw new ConfigurationError(`rename-map[${index}]: duplicate mapping ${pair}`);
    if (fromTo.has(from) && fromTo.get(from) !== to) throw new ConfigurationError(`rename-map[${index}]: ${from} maps to both ${fromTo.get(from)} and ${to}`);
    if (toFrom.has(to) && toFrom.get(to) !== from) throw new ConfigurationError(`rename-map[${index}]: ${to} is targeted by both ${toFrom.get(to)} and ${from}`);
    seenPairs.add(pair);
    fromTo.set(from, to);
    toFrom.set(to, from);
    result.push({ from, to });
  }
  return { entries: result, pairs: new Set(result.map((entry) => `${entry.from}->${entry.to}`)) };
}

function validateChangeMappings(units, renameMap) {
  for (const unit of units) for (const change of unit.changes) {
    if (!renameMap.pairs.has(`${change.from}->${change.to}`)) throw new ConfigurationError(`plan unit ${unit.id}: ${change.from}->${change.to} is not present in rename-map`);
  }
}

function acornFlag(version) {
  return `--ecma${version}`;
}

function tokenType(token) {
  return token?.type?.label ?? "unknown";
}

function tokenName(token) {
  return tokenType(token) === "name" ? String(token.value) : null;
}

function tokenRaw(token, text) {
  return text.slice(Number(token.start), Number(token.end));
}

function nonBindingNameRanges(ast) {
  const ranges = new Set();
  const add = (node) => {
    if (node?.type === "Identifier" && Number.isInteger(node.start) && Number.isInteger(node.end)) {
      ranges.add(`${node.start}:${node.end}`);
    }
  };
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "Property" && !node.computed) add(node.key);
    if ((node.type === "MethodDefinition" || node.type === "PropertyDefinition") && !node.computed) add(node.key);
    if (node.type === "MemberExpression" && !node.computed) add(node.property);
    if (node.type === "MetaProperty") {
      add(node.meta);
      add(node.property);
    }
    if (node.type === "LabeledStatement" || node.type === "BreakStatement" || node.type === "ContinueStatement") add(node.label);
    if (node.type === "ImportSpecifier") add(node.imported);
    if (node.type === "ExportSpecifier") add(node.exported);
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "start" || key === "end") continue;
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
      } else if (value && typeof value === "object") visit(value);
    }
  };
  visit(ast);
  return ranges;
}

function shorthandValueIdentifier(property) {
  if (property?.value?.type === "Identifier") return property.value;
  if (property?.value?.type === "AssignmentPattern" && property.value.left?.type === "Identifier") return property.value.left;
  return null;
}

function shorthandSlots(ast) {
  const original = new Set();
  const expanded = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "Property" && !node.computed && node.key?.type === "Identifier") {
      const value = shorthandValueIdentifier(node);
      if (value) {
        const key = node.key;
        if (node.shorthand) original.add(`${key.start}:${key.end}:${key.name}`);
        else expanded.add(`${key.start}:${key.end}:${value.start}:${value.end}:${key.name}:${value.name}`);
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "start" || key === "end") continue;
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
      } else if (value && typeof value === "object") visit(value);
    }
  };
  visit(ast);
  return { original, expanded };
}

function canonicalToken(token, text) {
  const type = tokenType(token);
  if (type === "eof") return "eof";
  if (type === "name") return `name:${tokenRaw(token, text)}`;
  return `${type}:${tokenRaw(token, text)}`;
}

function runAcorn(executable, args) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
    timeout: 120000,
  });
  if (result.error) return { infrastructure: true, reason: result.error.message };
  if (result.status !== 0) return { infrastructure: false, reason: (result.stderr || result.stdout || "Acorn rejected the fragment").trim() };
  return { stdout: result.stdout };
}

function tokenize(text, label, version, tempDirectory, fileIndex, sourceType) {
  const file = path.join(tempDirectory, `fragment-${fileIndex}.js`);
  writeFileSync(file, text, "utf8");
  const executable = process.platform === "win32" ? "npx.cmd" : "npx";
  const common = ["--yes", ACORN_PACKAGE, acornFlag(version)];
  if (sourceType === "module") common.push("--module");
  const parsed = runAcorn(executable, [...common, "--compact", file]);
  if (parsed.reason) return parsed;
  let ast;
  try {
    ast = JSON.parse(parsed.stdout);
    if (!ast || ast.type !== "Program") return { infrastructure: true, reason: "Acorn output was not a Program AST" };
  } catch (error) {
    return { infrastructure: true, reason: `cannot parse Acorn AST: ${error.message}` };
  }
  const result = runAcorn(executable, [...common, "--tokenize", file]);
  if (result.reason) return result;
  try {
    const tokens = JSON.parse(result.stdout);
    if (!Array.isArray(tokens)) return { infrastructure: true, reason: "Acorn output was not a token array" };
    return {
      tokens,
      nonBindingRanges: nonBindingNameRanges(ast),
      shorthandSlots: shorthandSlots(ast),
    };
  } catch (error) {
    return { infrastructure: true, reason: `cannot parse Acorn output: ${error.message}` };
  }
}

function parsePair(unit, version, tempDirectory, fileIndex) {
  const left = tokenize(unit.original.text, `${unit.id}.original`, version, tempDirectory, fileIndex, unit.sourceType);
  if (!left.tokens) return { error: formatParseError(unit.original, unit.id, version, left.reason), infrastructure: left.infrastructure };
  const right = tokenize(unit.sourceified.text, `${unit.id}.sourceified`, version, tempDirectory, fileIndex + 1, unit.sourceType);
  if (!right.tokens) return { error: formatParseError(unit.sourceified, unit.id, version, right.reason), infrastructure: right.infrastructure };
  return {
    left: left.tokens,
    right: right.tokens,
    leftNonBindingRanges: left.nonBindingRanges,
    rightNonBindingRanges: right.nonBindingRanges,
    leftShorthandSlots: left.shorthandSlots,
    rightShorthandSlots: right.shorthandSlots,
  };
}

function formatParseError(fragment, unitId, version, reason) {
  return `${fragment.file}:L${fragment.range.startLine}-L${fragment.range.endLine} (unit ${unitId}, ECMAScript ${version}): ${reason}`;
}

function expectedChanges(unit) {
  const result = new Map();
  for (const change of unit.changes) {
    const key = change.kind === "identifier"
      ? `identifier:${change.from}->${change.to}`
      : `shorthand-expansion:${change.from}->${change.to}:${change.key}`;
    result.set(key, change.count);
  }
  return result;
}

function addActual(actual, key, detail) {
  const entry = actual.get(key) ?? { count: 0, details: [] };
  entry.count += 1;
  entry.details.push(detail);
  actual.set(key, entry);
}

function compareTokenStreams(unit, left, right, version, leftNonBindingRanges, rightNonBindingRanges, leftShorthandSlots, rightShorthandSlots) {
  const expected = expectedChanges(unit);
  const actual = new Map();
  let leftIndex = 0;
  let rightIndex = 0;
  let mismatch = null;
  while (leftIndex < left.length || rightIndex < right.length) {
    const leftToken = left[leftIndex];
    const rightToken = right[rightIndex];
    const expansion = unit.changes.find((change) => {
      if (change.kind !== "shorthand-expansion" || !leftToken || !rightToken) return false;
      return tokenName(leftToken) === change.from
        && tokenName(rightToken) === change.key
        && tokenType(right[rightIndex + 1]) === ":"
        && tokenName(right[rightIndex + 2]) === change.to
        && leftShorthandSlots.original.has(`${leftToken.start}:${leftToken.end}:${change.from}`)
        && rightShorthandSlots.expanded.has(`${rightToken.start}:${rightToken.end}:${right[rightIndex + 2]?.start}:${right[rightIndex + 2]?.end}:${change.key}:${change.to}`);
    });
    if (expansion) {
      addActual(actual, `shorthand-expansion:${expansion.from}->${expansion.to}:${expansion.key}`, {
        originalIndex: leftIndex,
        sourceIndex: rightIndex,
        original: tokenRaw(leftToken, unit.original.text),
        source: `${tokenRaw(rightToken, unit.sourceified.text)}: ${tokenRaw(right[rightIndex + 2], unit.sourceified.text)}`,
      });
      leftIndex += 1;
      rightIndex += 3;
      continue;
    }
    if (leftToken && rightToken && canonicalToken(leftToken, unit.original.text) === canonicalToken(rightToken, unit.sourceified.text)) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    const rename = unit.changes.find((change) => {
      if (change.kind !== "identifier" || tokenName(leftToken) !== change.from || tokenName(rightToken) !== change.to) return false;
      const leftKey = `${leftToken.start}:${leftToken.end}`;
      const rightKey = `${rightToken.start}:${rightToken.end}`;
      return !leftNonBindingRanges.has(leftKey) && !rightNonBindingRanges.has(rightKey);
    });
    if (rename) {
      addActual(actual, `identifier:${rename.from}->${rename.to}`, {
        originalIndex: leftIndex,
        sourceIndex: rightIndex,
        original: tokenRaw(leftToken, unit.original.text),
        source: tokenRaw(rightToken, unit.sourceified.text),
      });
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    mismatch = {
      originalIndex: leftIndex,
      sourceIndex: rightIndex,
      original: leftToken ? { type: tokenType(leftToken), raw: tokenRaw(leftToken, unit.original.text), start: leftToken.start, end: leftToken.end } : null,
      source: rightToken ? { type: tokenType(rightToken), raw: tokenRaw(rightToken, unit.sourceified.text), start: rightToken.start, end: rightToken.end } : null,
      reason: "unexpected token, insertion, deletion, or token type/value change",
    };
    break;
  }
  if (!mismatch) {
    const expectedEntries = [...expected.entries()];
    const actualEntries = [...actual.entries()];
    if (expectedEntries.length !== actualEntries.length || expectedEntries.some(([key, count]) => actual.get(key)?.count !== count)) {
      mismatch = {
        originalIndex: null,
        sourceIndex: null,
        reason: "actual difference set does not exactly equal expected difference set",
        expected: Object.fromEntries(expectedEntries),
        actual: Object.fromEntries(actualEntries.map(([key, entry]) => [key, entry.count])),
        details: Object.fromEntries(actualEntries.map(([key, entry]) => [key, entry.details])),
      };
    }
  }
  return {
    id: unit.id,
    status: mismatch ? "fail" : "pass",
    ecmaVersion: version,
    original: { file: normalizeSlashes(unit.original.file), range: unit.original.range },
    sourceified: { file: normalizeSlashes(unit.sourceified.file), range: unit.sourceified.range },
    originalTokenCount: left.length,
    sourceifiedTokenCount: right.length,
    expectedChanges: Object.fromEntries(expected),
    actualChanges: Object.fromEntries([...actual].map(([key, entry]) => [key, entry.count])),
    actualChangeDetails: Object.fromEntries([...actual].map(([key, entry]) => [key, entry.details])),
    mismatch,
  };
}

function formatResult(result) {
  const lines = [`--- verify-sourceified-tokens (Acorn ${ACORN_PACKAGE}) ---`];
  if (result.error) return [...lines, `FATAL: ${result.error}`].join("\n");
  lines.push(`ECMAScript version: ${result.ecmaVersion}`);
  for (const unit of result.units) {
    lines.push(`${unit.status === "pass" ? "PASS" : "FAIL"} ${unit.id} tokens ${unit.originalTokenCount}/${unit.sourceifiedTokenCount}`);
    if (unit.mismatch) lines.push(`  ${JSON.stringify(unit.mismatch)}`);
  }
  lines.push(result.ok ? "PASS" : "FAIL");
  return lines.join("\n");
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(`FATAL: ${error.message}`); process.exitCode = 2; return; }
  if (options.help) {
    console.log(HELP);
    return;
  }
  try {
    if (!/^(?:latest|auto|\d+)$/.test(options.ecmaVersion)) throw new ConfigurationError(`--ecma-version must be latest, auto, or a number`);
    const root = resolveRoot(options.root);
    const plan = await loadData(options.plan);
    const renameMap = normalizeRenameMap(await loadData(options.renameMap));
    const cache = new Map();
    const units = normalizeUnits(plan, root, cache);
    validateChangeMappings(units, renameMap);
    const requested = options.ecmaVersion;
    const candidateVersions = requested === "auto" ? AUTO_VERSIONS : [requested === "latest" ? ACORN_MAX_ECMA : Number(requested)];
    const tempDirectory = mkdtempSync(path.join(tmpdir(), "sourceified-token-"));
    const attempts = [];
    let selectedVersion = null;
    let parsedPairs = null;
    try {
      for (const candidate of candidateVersions) {
        if (!Number.isInteger(candidate) || candidate < 3) throw new ConfigurationError(`unsupported ECMAScript version ${candidate}`);
        const pairs = [];
        let failed = null;
        for (let index = 0; index < units.length; index += 1) {
          const parsed = parsePair(units[index], candidate, tempDirectory, index * 2);
          if (parsed.error) {
            failed = parsed;
            break;
          }
          pairs.push(parsed);
        }
        if (!failed) {
          selectedVersion = candidate;
          parsedPairs = pairs;
          break;
        }
        attempts.push({ version: candidate, error: failed.error });
        if (failed.infrastructure || requested !== "auto") throw new VerificationError(failed.error);
      }
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
    if (selectedVersion === null) {
      const detail = attempts.map((attempt) => `ECMAScript ${attempt.version}: ${attempt.error}`).join("\n");
      throw new VerificationError(`auto could not parse all comparison units:\n${detail}`);
    }
    const results = units.map((unit, index) => compareTokenStreams(
      unit,
      parsedPairs[index].left,
      parsedPairs[index].right,
      selectedVersion,
      parsedPairs[index].leftNonBindingRanges,
      parsedPairs[index].rightNonBindingRanges,
      parsedPairs[index].leftShorthandSlots,
      parsedPairs[index].rightShorthandSlots,
    ));
    const output = { ok: results.every((result) => result.status === "pass"), acorn: ACORN_PACKAGE, requestedEcmaVersion: requested, ecmaVersion: selectedVersion, units: results };
    if (options.format === "json") console.log(JSON.stringify(output, null, 2));
    else console.log(formatResult(output));
    if (!output.ok) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.format === "json") console.log(JSON.stringify({ ok: false, error: message, acorn: ACORN_PACKAGE }, null, 2));
    else console.error(`FATAL: ${message}`);
    process.exitCode = error instanceof ConfigurationError ? 2 : 1;
  }
}

await main();
