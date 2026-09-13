// Token comparison using Acorn 8.14.0 through npx. Offline use requires a cache.
// Compares token types and values, including regular-expression patterns and flags.
// Whitespace and positions are excluded, so equality does not establish equivalent
// automatic semicolon insertion or runtime behavior. In the 14islands case,
// formatting altered a nested template: 748,409 tokens became 748,398 while the
// sampled visual and loading checks passed.
import { spawnSync } from "node:child_process";

export const ACORN_VERSION = "8.14.0";
const SEP = String.fromCharCode(1); // Token labels cannot contain this separator.

/** Encode token types and values without source positions. */
export function tokenStream(file, { ecma = "2022" } = {}) {
  const r = spawnSync("npx", ["-y", `acorn@${ACORN_VERSION}`, `--ecma${ecma}`, "--tokenize", file], {
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
  if (r.status !== 0) throw new Error(`acorn@${ACORN_VERSION} failed on ${file}: ${(r.stderr || "").split("\n")[0]}`);
  return JSON.parse(r.stdout).map(
    (t) => `${typeof t.type === "object" ? t.type.label : t.type}${SEP}${t.value === undefined ? "" : JSON.stringify(t.value)}`,
  );
}

/** Return the first differing index, or -1 for equal sequences. */
export function firstDivergence(a, b) {
  const n = Math.min(a.length, b.length);
  let k = 0;
  while (k < n && a[k] === b[k]) k++;
  return k === n && a.length === b.length ? -1 : k;
}

export const showToken = (t) => (t === undefined ? "<end>" : t.split(SEP).join(":").slice(0, 60));
