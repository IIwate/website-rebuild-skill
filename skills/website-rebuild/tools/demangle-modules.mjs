#!/usr/bin/env node
/**
 * Rename selected JavaScript bindings with Babel scope information.
 *
 * The writer applies only source-range edits. Babel is used to decide which
 * identifiers belong to a Binding; it is never used to regenerate the file,
 * so comments, formatting, property keys, and unrelated tokens stay intact.
 */
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const HELP = `Usage:
  node tools/demangle-modules.mjs --help
  node tools/demangle-modules.mjs --input <file> --output <file> --rename-map <file> [--config <file>] [--check]

Rename map formats:
  { "renames": [{ "from": "short", "to": "descriptive" }] }
  { "short": "descriptive" }
  An entry without a selector applies to every Binding with that name. Use
  bindingId, declarationLine/declarationColumn, or declaration.start to
  select one Binding when shadowed names need different destinations.

Config fields:
  root, sourceType, parserPlugins, and optional allowReturnOutsideFunction.
  Paths are resolved below root and are rejected when they escape it.

Behavior:
  Direct eval and WithStatement are dynamic-scope boundaries. They fail before
  any output is written. Object shorthand is expanded at the AST-selected
  occurrence, while ObjectMethod names and non-computed property keys stay put.

Exit codes:
  0  transformation or --check passed
  1  parse, dynamic-scope, binding, or collision failure
  2  CLI, dependency, or configuration failure
`;

class ConfigurationError extends Error {}
class TransformationError extends Error {}

const DEFAULT_PLUGINS = [
  "asyncGenerators",
  "classProperties",
  "classPrivateProperties",
  "classPrivateMethods",
  "decorators-legacy",
  "dynamicImport",
  "exportDefaultFrom",
  "importAttributes",
  "importMeta",
  "logicalAssignment",
  "nullishCoalescingOperator",
  "numericSeparator",
  "objectRestSpread",
  "optionalCatchBinding",
  "optionalChaining",
  "topLevelAwait",
];

function parseArgs(argv) {
  const result = { check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--check") result.check = true;
    else if (["--input", "--output", "--rename-map", "--config"].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new ConfigurationError(`${arg} requires a value`);
      if (arg === "--input") result.input = value;
      else if (arg === "--output") result.output = value;
      else if (arg === "--rename-map") result.renameMap = value;
      else result.config = value;
    } else throw new ConfigurationError(`unknown option ${arg}`);
  }
  if (!result.help && (!result.input || !result.output || !result.renameMap)) throw new ConfigurationError("--input, --output, and --rename-map are required");
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

function resolveRoot(value) {
  const root = path.resolve(process.cwd(), value ?? ".");
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new ConfigurationError(`root: directory does not exist: ${root}`);
  return realPath(root);
}

function isWithin(file, root) {
  const candidate = path.resolve(file);
  const boundary = path.resolve(root);
  return candidate === boundary || candidate.startsWith(`${boundary}${path.sep}`);
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

function resolvePath(value, root, field, { mustExist = false } = {}) {
  if (typeof value !== "string" || value === "") throw new ConfigurationError(`${field}: expected a non-empty path`);
  const file = path.resolve(root, value);
  if (!isWithin(file, root) || !isWithin(realPath(file), root)) throw new ConfigurationError(`${field}: path escapes root`);
  if (mustExist && !statSync(file, { throwIfNoEntry: false })?.isFile()) throw new ConfigurationError(`${field}: file does not exist: ${value}`);
  return file;
}

function nodeLocation(node) {
  return `${node.loc?.start.line ?? "?"}:${(node.loc?.start.column ?? 0) + 1}`;
}

function bindingId(binding) {
  return `${binding.identifier.start}:${binding.identifier.end}:${binding.identifier.name}`;
}

function collectBindings(ast, traverse) {
  const bindings = new Set();
  traverse(ast, {
    Scopable(scopePath) {
      for (const binding of Object.values(scopePath.scope.bindings)) bindings.add(binding);
    },
  });
  return [...bindings];
}

function normalizeRenameEntries(raw) {
  let entries;
  if (Array.isArray(raw)) entries = raw;
  else if (isObject(raw) && Array.isArray(raw.renames)) entries = raw.renames;
  else if (isObject(raw) && Array.isArray(raw.bindingRenames)) entries = raw.bindingRenames;
  else if (isObject(raw) && Array.isArray(raw.mapping)) entries = raw.mapping;
  else if (isObject(raw) && isObject(raw.map)) entries = Object.entries(raw.map).map(([from, to]) => ({ from, to }));
  else if (isObject(raw) && typeof raw.from === "string" && typeof raw.to === "string") entries = [raw];
  else if (isObject(raw)) entries = Object.entries(raw).map(([from, to]) => ({ from, to }));
  else throw new ConfigurationError("rename-map: expected an object or array");
  if (entries.length === 0) throw new ConfigurationError("rename-map: no mappings supplied");
  const fromTo = new Map();
  const toFrom = new Map();
  const pairs = new Set();
  return entries.map((entry, index) => {
    if (!isObject(entry)) throw new ConfigurationError(`rename-map[${index}]: expected an object`);
    const from = entry.from ?? entry.old;
    const to = entry.to ?? entry.new;
    if (typeof from !== "string" || typeof to !== "string" || from === "" || to === "" || from === to) throw new ConfigurationError(`rename-map[${index}]: from and to must be different strings`);
    const pair = `${from}->${to}`;
    if (pairs.has(pair)) throw new ConfigurationError(`rename-map[${index}]: duplicate mapping ${pair}`);
    if (fromTo.has(from) && fromTo.get(from) !== to) throw new ConfigurationError(`rename-map[${index}]: ${from} maps to both ${fromTo.get(from)} and ${to}`);
    if (toFrom.has(to) && toFrom.get(to) !== from) throw new ConfigurationError(`rename-map[${index}]: ${to} is targeted by both ${toFrom.get(to)} and ${from}`);
    pairs.add(pair);
    fromTo.set(from, to);
    toFrom.set(to, from);
    return { ...entry, from, to, pair };
  });
}

function selectorFor(entry) {
  const selector = isObject(entry.selector) ? entry.selector : null;
  if (entry.bindingId !== undefined) return { id: String(entry.bindingId) };
  if (typeof entry.binding === "string") return { id: entry.binding };
  if (selector?.bindingId !== undefined) return { id: String(selector.bindingId) };
  const declaration = isObject(entry.declaration) ? entry.declaration : isObject(selector?.declaration) ? selector.declaration : null;
  const start = entry.start ?? entry.declarationStart ?? selector?.start ?? declaration?.start ?? declaration?.offset;
  const line = entry.declarationLine ?? entry.line ?? selector?.line ?? declaration?.line;
  const column = entry.declarationColumn ?? entry.column ?? selector?.column ?? declaration?.column;
  if (start !== undefined || line !== undefined || column !== undefined) return { start, line, column };
  return null;
}

function selectBindings(entries, bindings) {
  const selected = [];
  const seenTargets = new Set();
  for (const entry of entries) {
    const candidates = bindings.filter((binding) => binding.identifier.name === entry.from);
    if (candidates.length === 0) throw new TransformationError(`rename ${entry.from}->${entry.to}: no Binding with that name`);
    const selector = selectorFor(entry);
    let matches = candidates;
    if (selector) {
      matches = candidates.filter((binding) => {
        if (selector.id !== undefined) return bindingId(binding) === selector.id;
        if (selector.start !== undefined && Number(binding.identifier.start) !== Number(selector.start)) return false;
        if (selector.line !== undefined && Number(binding.identifier.loc?.start.line) !== Number(selector.line)) return false;
        if (selector.column !== undefined && Number(binding.identifier.loc?.start.column) !== Number(selector.column) && Number(binding.identifier.loc?.start.column) + 1 !== Number(selector.column)) return false;
        return true;
      });
      if (matches.length !== 1) throw new TransformationError(`rename ${entry.from}->${entry.to}: selector ${JSON.stringify(selector)} matched ${matches.length} Bindings`);
    }
    for (const binding of matches) {
      const targetKey = bindingId(binding);
      if (seenTargets.has(targetKey)) throw new TransformationError(`Binding ${targetKey} is selected more than once`);
      seenTargets.add(targetKey);
      selected.push({ ...entry, binding });
    }
  }
  return selected;
}

function validateIdentifier(name, parser, parserOptions) {
  if (!/^[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*$/u.test(name)) throw new TransformationError(`invalid Identifier name ${name}`);
  try {
    parser.parse(`const ${name} = 0;`, { ...parserOptions, sourceType: "module" });
  } catch (error) {
    throw new TransformationError(`invalid or reserved Identifier ${name}: ${error.message}`);
  }
}

function pathBelongsToBinding(identifierPath, binding) {
  return identifierPath?.node?.type === "Identifier" && identifierPath.scope.getBinding(identifierPath.node.name) === binding;
}

function bindingPaths(binding, ast, traverse) {
  const paths = new Map();
  const add = (identifierPath) => {
    if (!pathBelongsToBinding(identifierPath, binding)) return;
    const key = `${identifierPath.node.start}:${identifierPath.node.end}`;
    paths.set(key, identifierPath);
  };
  add(binding.identifierPath);
  for (const reference of binding.referencePaths) add(reference);
  for (const violation of binding.constantViolations) {
    if (violation.isIdentifier?.()) add(violation);
    else violation.traverse({ Identifier(identifierPath) { add(identifierPath); } });
  }
  traverse(ast, {
    Identifier(identifierPath) {
      if (identifierPath.isBindingIdentifier() || identifierPath.isReferencedIdentifier()) add(identifierPath);
    },
  });
  return [...paths.values()].sort((a, b) => a.node.start - b.node.start);
}

function isInsideScope(scope, ancestor) {
  let current = scope;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function assertNoReferenceCapture(target, ast, traverse, input) {
  for (const identifierPath of bindingPaths(target.binding, ast, traverse)) {
    let scope = identifierPath.scope;
    while (scope && scope !== target.binding.scope) {
      const binding = scope.bindings[target.to];
      if (binding && binding !== target.binding) {
        throw new TransformationError(`${input}:${nodeLocation(identifierPath.node)}: rename ${target.from}->${target.to} would be shadowed by Binding ${bindingId(binding)}`);
      }
      scope = scope.parent;
    }
  }
  traverse(ast, {
    Identifier(identifierPath) {
      if (identifierPath.node.name !== target.to || !identifierPath.isReferencedIdentifier?.()) return;
      if (!isInsideScope(identifierPath.scope, target.binding.scope)) return;
      const resolved = identifierPath.scope.getBinding(target.to);
      if (!resolved || !isInsideScope(resolved.scope, target.binding.scope)) {
        throw new TransformationError(`${input}:${nodeLocation(identifierPath.node)}: rename ${target.from}->${target.to} would capture an existing reference`);
      }
    },
  });
}

function isShorthandSlot(identifierPath, propertyPath) {
  const value = propertyPath.node.value;
  if (value?.type === "Identifier") return value.start === identifierPath.node.start && value.end === identifierPath.node.end;
  if (value?.type === "AssignmentPattern") {
    const left = value.left;
    return left?.type === "Identifier" && left.start === identifierPath.node.start && left.end === identifierPath.node.end;
  }
  return false;
}

function shorthandProperty(identifierPath) {
  let current = identifierPath.parentPath;
  while (current) {
    if (current.isObjectMethod?.()) return null;
    if (current.isObjectProperty?.()) {
      if (!current.node.shorthand || current.node.computed || !isShorthandSlot(identifierPath, current)) return null;
      return current;
    }
    if (current.isFunction?.() || current.isProgram?.()) return null;
    current = current.parentPath;
  }
  return null;
}

function collectEdits(selected, ast, traverse, source) {
  const edits = new Map();
  const summaries = [];
  for (const target of selected) {
    const paths = bindingPaths(target.binding, ast, traverse);
    if (paths.length === 0) throw new TransformationError(`rename ${target.from}->${target.to}: Binding ${bindingId(target.binding)} has no resolvable paths`);
    const occurrences = [];
    for (const identifierPath of paths) {
      const start = identifierPath.node.start;
      const end = identifierPath.node.end;
      if (source.slice(start, end) !== target.from) throw new TransformationError(`rename ${target.from}->${target.to}: AST range ${start}-${end} does not contain the source name`);
      const propertyPath = shorthandProperty(identifierPath);
      let replacement = target.to;
      let kind = "identifier";
      if (propertyPath) {
        const key = propertyPath.node.key;
        const keyText = source.slice(key.start, key.end);
        replacement = `${keyText}: ${target.to}`;
        kind = "shorthand-expansion";
      }
      const existing = edits.get(`${start}:${end}`);
      if (existing && (existing.replacement !== replacement || existing.target !== target)) throw new TransformationError(`overlapping rename edits at ${start}-${end}`);
      edits.set(`${start}:${end}`, { start, end, replacement, kind, target });
      occurrences.push({ start, end, kind });
    }
    summaries.push({ from: target.from, to: target.to, bindingId: bindingId(target.binding), declaration: nodeLocation(target.binding.identifier), referenceCount: target.binding.referencePaths.length, constantViolationCount: target.binding.constantViolations.length, occurrenceCount: occurrences.length, occurrences });
  }
  const ordered = [...edits.values()].sort((a, b) => a.start - b.start);
  for (let index = 1; index < ordered.length; index += 1) if (ordered[index - 1].end > ordered[index].start) throw new TransformationError(`overlapping rename edits at ${ordered[index - 1].start}-${ordered[index].start}`);
  return { edits: ordered, summaries };
}

function applyEdits(source, edits) {
  let result = source;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  return result;
}

function dynamicScopeFindings(ast, traverse) {
  const findings = [];
  traverse(ast, {
    CallExpression(path) {
      if (path.node.callee?.type !== "Identifier" || path.node.callee.name !== "eval") return;
      if (!path.scope.getBinding("eval")) findings.push({ path, reason: "direct eval creates a dynamic scope boundary" });
    },
    WithStatement(path) {
      findings.push({ path, reason: "WithStatement creates a dynamic scope boundary" });
    },
  });
  return findings;
}

async function importBabel() {
  try {
    const parserModule = await import("@babel/parser");
    const traverseModule = await import("@babel/traverse");
    return { parser: parserModule.default ?? parserModule, traverse: traverseModule.default?.default ?? traverseModule.default ?? traverseModule };
  } catch (error) {
    throw new ConfigurationError(`Babel dependencies are unavailable; install the target project's Babel devDependencies: ${error.message}`);
  }
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
    const config = options.config ? await loadData(options.config) : {};
    if (!isObject(config)) throw new ConfigurationError("config: expected an object");
    const root = resolveRoot(config.root);
    const input = resolvePath(options.input, root, "--input", { mustExist: true });
    const output = resolvePath(options.output, root, "--output");
    const renameMap = await loadData(options.renameMap);
    const entries = normalizeRenameEntries(renameMap);
    const { parser, traverse } = await importBabel();
    const source = readFileSync(input, "utf8");
    const parserPlugins = config.parserPlugins ?? DEFAULT_PLUGINS;
    if (!Array.isArray(parserPlugins)) throw new ConfigurationError("parserPlugins: expected an array");
    const parserOptions = {
      sourceType: config.sourceType ?? "unambiguous",
      sourceFilename: input,
      plugins: parserPlugins,
      allowReturnOutsideFunction: Boolean(config.allowReturnOutsideFunction),
    };
    let ast;
    try { ast = parser.parse(source, parserOptions); }
    catch (error) { throw new TransformationError(`${input}: parse failed at ${error.loc?.line ?? "?"}:${(error.loc?.column ?? 0) + 1}: ${error.message}`); }
    const dynamic = dynamicScopeFindings(ast, traverse);
    if (dynamic.length > 0) {
      const details = dynamic.map(({ path: nodePath, reason }) => `${input}:${nodeLocation(nodePath.node)}: ${reason}`).join("\n");
      throw new TransformationError(`dynamic scope detected; no output was written:\n${details}`);
    }
    const allBindings = collectBindings(ast, traverse);
    const selected = selectBindings(entries, allBindings);
    for (const target of selected) {
      validateIdentifier(target.to, parser, parserOptions);
      const local = target.binding.scope.bindings[target.to];
      if (local && local !== target.binding) throw new TransformationError(`${input}:${nodeLocation(target.binding.identifier)}: rename ${target.from}->${target.to} collides with Binding ${bindingId(local)} in the target scope`);
      const referenced = target.binding.scope.references?.[target.to];
      if (referenced?.length) throw new TransformationError(`${input}:${nodeLocation(target.binding.identifier)}: rename ${target.from}->${target.to} would capture an existing reference in the target scope`);
      assertNoReferenceCapture(target, ast, traverse, input);
    }
    const { edits, summaries } = collectEdits(selected, ast, traverse, source);
    const transformed = applyEdits(source, edits);
    try { parser.parse(transformed, parserOptions); }
    catch (error) { throw new TransformationError(`${input}: transformed source failed to parse at ${error.loc?.line ?? "?"}:${(error.loc?.column ?? 0) + 1}: ${error.message}`); }
    if (options.check) {
      if (!statSync(output, { throwIfNoEntry: false })?.isFile()) throw new TransformationError(`--check: output file does not exist: ${options.output}`);
      const current = readFileSync(output, "utf8");
      if (current !== transformed) throw new TransformationError(`--check: output is stale: ${options.output}`);
    } else {
      writeFileSync(output, transformed, "utf8");
    }
    console.log(`${options.check ? "CHECK" : "WRITE"} PASS ${path.relative(root, output) || output} (${summaries.length} Binding targets, ${edits.length} occurrences)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`FATAL: ${message}`);
    process.exitCode = error instanceof ConfigurationError ? 2 : 1;
  }
}

await main();
