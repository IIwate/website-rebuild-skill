/**
 * Shared CLI option validation and help output.
 *
 *   import { cli } from "./lib/cli.mjs";
 *   const { positionals, flag } = cli({ known: ["out"], bools: ["check"], file: import.meta.url });
 *
 * Call before starting work so --help and invalid options do not trigger it.
 * --help/-h prints the file header, option inventory and version, then exits 0.
 * --version prints the shared skill version and exits 0. Unknown long options
 * exit 2 and list the supported names. Short options other than -h are treated
 * as positional arguments.
 *
 * Returns { argv, positionals, flag(name, defaultValue), has(name) }. The returned
 * reader supports --key=value and --key value. Some callers use their own readers;
 * validation alone does not make those readers accept both spellings. Value options
 * consume the next token unless it starts with --. A bare -- ends option parsing.
 *
 * An observed --settle/--wait mismatch caused three hours of diagnosis because
 * the script ignored the unknown option. Only 9 of 57 scripts checked it before
 * the shared validator was introduced.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SKILL_VERSION } from "./version.mjs";

/**
 * Exit-code categories used by the toolchain. See scripts/README.md for their scope.
 */
export const EXIT = {
  OK: 0,          // successful check or completed operation
  FAIL: 1,        // check failed or required input could not be read
  USAGE: 2,       // bad invocation: missing/invalid/unknown flag, missing input, bad config
  IDENTITY: 3,    // port taken, wrong side, attached to somebody else's browser (lib/ports.mjs)
  TRANSPORT: 4,   // CDP transport died (payload ceiling, close 1006, timeout)
  FATAL: 5,       // precondition not met: container unrecognised, nothing to examine, blank frame
  STATE: 6,       // page never reached the requested state (--ready / --hold)
  INTERRUPTED: 130, // SIGINT after a ledger flush
};

export function headerOf(file) {
  if (!file) return "";
  let src;
  try { src = readFileSync(file.startsWith("file:") ? fileURLToPath(file) : file, "utf8"); } catch { return ""; }
  const lines = src.split("\n");
  let i = 0;
  if (lines[0]?.startsWith("#!")) i = 1;
  while (i < lines.length && lines[i].trim() === "") i++;
  const out = [];
  if (lines[i]?.trimStart().startsWith("/*")) {
    for (; i < lines.length; i++) {
      const l = lines[i];
      const end = l.includes("*/");
      let t = l.replace(/^\s*\/\*+\s?/, "").replace(/\*\/\s*$/, "").replace(/^\s*\*\s?/, "");
      if (t.trim() !== "" || out.length) out.push(t);
      if (end) break;
    }
  } else {
    for (; i < lines.length && lines[i].startsWith("//"); i++) out.push(lines[i].replace(/^\/\/\s?/, ""));
  }
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out.join("\n");
}

export function cli({ known = [], bools = [], file = null, argv = process.argv.slice(2), positional = "" } = {}) {
  const names = new Set([...known, ...bools]);
  const isBool = new Set(bools);
  if (argv.includes("--help") || argv.includes("-h")) {
    const header = headerOf(file);
    const inv = [...names].sort().map((n) => (isBool.has(n) ? `--${n}` : `--${n} <v>`)).join(" ");
    process.stdout.write(
      (header ? header + "\n\n" : "") +
      `flags: ${inv || "(none)"}${positional ? `\npositional: ${positional}` : ""}\n` +
      `--help / --version are always accepted; any other unknown flag is FATAL (exit 2).\n` +
      `skill version ${SKILL_VERSION}\n`,
    );
    process.exit(EXIT.OK);
  }
  if (argv.includes("--version")) { console.log(SKILL_VERSION); process.exit(EXIT.OK); }
  const bad = [], positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { positionals.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith("--")) { positionals.push(a); continue; }
    const name = a.slice(2).split("=")[0];
    if (!names.has(name)) { bad.push(a); continue; }
    if (!isBool.has(name) && !a.includes("=") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) i++;
  }
  if (bad.length) {
    console.error(`FATAL: unknown flag(s): ${bad.join(" ")}`);
    console.error(`       known: ${[...names].sort().map((n) => "--" + n).join(" ") || "(none)"}   (--help for usage)`);
    process.exit(EXIT.USAGE);
  }
  const flag = (n, d) => {
    const eq = argv.find((x) => x.startsWith(`--${n}=`));
    if (eq !== undefined) return eq.slice(n.length + 3);
    const i = argv.indexOf(`--${n}`);
    return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
  };
  const has = (n) => argv.includes(`--${n}`) || argv.some((x) => x.startsWith(`--${n}=`));
  return { argv, positionals, flag, has };
}
