// shell-build.mjs — the strategy-A transform engine, shared by the builder and
// the gate so there is exactly one implementation of "what the table does".
//
// verification-gates.md §2.1.1: any logic two places must agree on gets ONE
// implementation. build-site.mjs applies the table to a document; verify-shell
// replays it on a diff hunk. Two copies would drift, and a gate that drifts
// from its builder reports differences that are its own.
//
// ⛔ NO SIDE EFFECTS IN THIS FILE OR IN A PROJECT'S shell-config.mjs. The gate
// imports both, and a gate must never import a module that produces what it
// audits (§2.1.2).

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The bytes T-NOINDEX inserts. Exported because verify-shell sees that hunk as
 *  a PURE INSERTION — the mirror side of it is empty, and replaying a transform
 *  over an empty string can never reproduce it, so the gate matches these bytes
 *  exactly instead. */
export const noindexBlock = (cfg) =>
  (cfg.notice || "") + '<meta name="robots" content="noindex,nofollow">\n';

/**
 * Apply the configured table to one document (or one diff hunk).
 * Pure: every counter is returned, none is module state.
 *   returns { text, hits: Map<id, n>, sub: Map<ruleId, n> }
 *
 * `head` is false when the caller is classifying a fragment rather than
 * building a page, so a hunk is never "explained" by a transform it did not use.
 */
export function transformPage(html, cfg, { head = true } = {}) {
  const hits = new Map();
  const sub = new Map();
  const bump = (id, n = 1) => hits.set(id, (hits.get(id) || 0) + n);
  const bumpSub = (k, n = 1) => sub.set(k, (sub.get(k) || 0) + n);
  let out = html;

  // --- T-LOCALIZE ------------------------------------------------------------
  // Five spellings matter in the wild; the two below cover the common HTML
  // cases. Escaped forms (https:\/\/host) live inside JSON payloads — if the
  // target has those, add a rule in shell-config.transforms rather than
  // loosening this one, so the count stays attributable.
  for (const host of cfg.originHosts || []) {
    out = out.replace(new RegExp(`https?://${esc(host)}`, "g"), () => (bump("T-LOCALIZE"), bumpSub(`origin.absolute:${host}`), ""));
    out = out.replace(new RegExp(`(?<!:)//${esc(host)}`, "g"), () => (bump("T-LOCALIZE"), bumpSub(`origin.protocol-relative:${host}`), ""));
  }
  for (const host of [...(cfg.stubExtHosts || []), ...(cfg.mirroredExtHosts || [])]) {
    out = out.replace(new RegExp(`https?://${esc(host)}`, "g"), () => (bump("T-LOCALIZE"), bumpSub(`ext.absolute:${host}`), `/ext/${host}`));
    out = out.replace(new RegExp(`(?<!:)//${esc(host)}`, "g"), () => (bump("T-LOCALIZE"), bumpSub(`ext.protocol-relative:${host}`), `/ext/${host}`));
  }

  // --- site-specific transforms ---------------------------------------------
  for (const t of cfg.transforms || []) {
    out = t.apply(out, {
      bump: (n = 1) => bump(t.id, n),
      sub: (k, n = 1) => bumpSub(`${t.id}:${k}`, n),
    });
  }

  // --- T-NOINDEX -------------------------------------------------------------
  if (head && cfg.notice) {
    const before = out;
    out = out.replace(/<head>/i, () => "<head>\n" + noindexBlock(cfg));
    if (out !== before) bump("T-NOINDEX");
  }

  return { text: out, hits, sub };
}

/** Every transform id the table can produce, builder and gate agreeing. */
export const transformIds = (cfg) => [
  "T-LOCALIZE",
  ...(cfg.transforms || []).map((t) => t.id),
  ...(cfg.notice ? ["T-NOINDEX"] : []),
];
