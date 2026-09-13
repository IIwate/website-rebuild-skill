#!/usr/bin/env node
/**
 * Manage child process groups and temporary Chrome profiles on POSIX systems.
 *
 * spawnReaped() starts a detached process group. Handled exits signal the group,
 * first with SIGTERM and then with SIGKILL after a grace period. Synchronous
 * cleanup also runs from Node's exit handler. Termination that bypasses these
 * handlers, or children that leave the group, may require later cleanup.
 *
 * Chrome profiles include the workspace slot, role and port. Preflight can
 * report and reap orphaned processes matching that slot and role. Slots are
 * hashed into a finite range and can collide; they are allocation labels, not
 * unique workspace identities. lib/ports.mjs checks browser sentinels and server
 * identity separately.
 *
 * In objectandarchive, 129 Chrome processes remained across about 16 profiles;
 * the oldest was two days and one hour old, with load average 8.7. Such load can
 * change capture timing and the repeated-sample variation used by pixel checks.
 * This module performs cleanup; it does not calculate comparison tolerances.
 *
 *   node scripts/lib/chrome.mjs         # list instances for this workspace slot
 *   node scripts/lib/chrome.mjs --all   # list instances across slots
 *   node scripts/lib/chrome.mjs --reap  # reap listed orphans
 *
 * Uses Node built-ins, POSIX process groups and ps.
 */
import { execFileSync, spawn } from "node:child_process";
import { accessSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertPortFree, labelPort, portSlot } from "./ports.mjs";
import { cli } from "./cli.mjs";

export const PROFILE_PREFIX = "wrs-chrome";

/** Filesystem prefix that identifies (this workspace, this script role). */
export function profilePrefix(role, slot = portSlot()) {
  const r = String(role || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!r) throw new Error("lib/chrome.mjs: role must be a non-empty name (e.g. 'probe')");
  return `${PROFILE_PREFIX}-s${slot}-${r}-`;
}

/** Absolute form of the above — this exact string appears in Chrome's argv. */
export function profileMarker(role, slot = portSlot()) {
  return path.join(tmpdir(), profilePrefix(role, slot));
}

/** Parse a profile dir name back into its parts. null when it is not ours. */
export function parseProfileName(name) {
  const m = new RegExp(`^${PROFILE_PREFIX}-s(\\d+)-([a-z0-9-]+?)-p(\\d+)-`).exec(name);
  return m ? { slot: Number(m[1]), role: m[2], port: Number(m[3]) } : null;
}

// --- chrome binary discovery ------------------------------------------------

/**
 * Standard candidates for local Chrome / Chromium on macOS and Linux.
 * Respects CHROME_BIN / CHROME_PATH overrides.
 */
export const CHROME_CANDIDATES = Object.freeze([
  process.env.CHROME_BIN,
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean));

/**
 * Find the first runnable Chrome executable path from candidate list.
 * Throws a fatal descriptive Error if none can be found.
 */
export async function findChrome() {
  for (const c of CHROME_CANDIDATES) {
    try {
      accessSync(c);
      return c;
    } catch {}
  }
  throw new Error("Chrome not found. Set CHROME_BIN or CHROME_PATH.");
}

// --- process table ----------------------------------------------------------

/**
 * Every process on this machine, with its parent and age. `ps` is used instead
 * of anything clever because the answer has to include processes this Node
 * never started — that is the whole point of a leak sweep.
 */
export function psList() {
  let out = "";
  try {
    out = execFileSync("ps", ["-Awwo", "pid=,ppid=,stat=,etime=,command="], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return null; // no ps (or it failed): callers degrade to "cannot sweep"
  }
  const rows = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), stat: m[3], etime: m[4], command: m[5] });
  }
  return rows;
}

/**
 * Chrome instances started by this toolchain, identified by their user-data-dir.
 * `role`/`slot` narrow the scope; `slot: null` means every workspace.
 * Zombies are excluded — a zombie is already dead and only waiting to be reaped
 * by its parent, and reporting one as a leak would send you chasing nothing.
 */
export function listInstances({ role = null, slot = portSlot() } = {}) {
  const rows = psList();
  if (rows === null) return null;
  const marker = role !== null && slot !== null
    ? profileMarker(role, slot)
    : path.join(tmpdir(), slot === null ? `${PROFILE_PREFIX}-` : `${PROFILE_PREFIX}-s${slot}-`);
  const found = [];
  for (const r of rows) {
    if (r.stat.includes("Z")) continue;
    const at = r.command.indexOf(`--user-data-dir=${marker}`);
    if (at < 0) continue;
    const dir = r.command.slice(at + "--user-data-dir=".length).split(/\s/)[0];
    found.push({ ...r, profile: dir, ...(parseProfileName(path.basename(dir)) || {}) });
  }
  markOrphans(found);
  return found;
}

/**
 * Decide `orphan` for every matched process, in place. Exported for the
 * selftest; listInstances() is the only production caller.
 *
 * Orphaned = the BROWSER this process belongs to has lost its launcher. Walk up
 * the matched tree (renderer -> zygote/helper -> browser main) to its ROOT — the
 * matched process whose parent is NOT one of ours — and ask whether that parent
 * is gone: reparented to pid 1, or no longer in the process table. Every member
 * of the tree inherits the root's answer.
 *  NOT "its parent is another matched Chrome". That predicate marked every
 * renderer of a LIVE sibling browser — same role, other side, the concurrent
 * mirror + rebuild probe that lib/ports.mjs exists to allow — as an orphan: a
 * false LEFTOVER report, a reap that could not touch them (a renderer is not a
 * group leader, so the group signal finds nothing) and then a "survived
 * SIGKILL" warning about processes that were never leaked. A renderer whose
 * browser has a live owner is that owner's business, exactly like the browser.
 */
export function markOrphans(found) {
  const byPid = new Map(found.map((f) => [f.pid, f]));
  const rootOf = (f) => {
    const seen = new Set();
    let cur = f;
    while (byPid.has(cur.ppid) && !seen.has(cur.pid)) {
      seen.add(cur.pid);
      cur = byPid.get(cur.ppid);
    }
    return cur;
  };
  for (const f of found) {
    const root = rootOf(f);
    f.orphan = root.ppid === 1 || !isAlive(root.ppid);
  }
  return found;
}

function isAlive(pid) {
  if (!pid || pid === 1) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** Is any member of process group `pgid` still alive? */
function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function signalGroup(pgid, sig) {
  try {
    process.kill(-pgid, sig);
    return true;
  } catch (e) {
    if (e.code === "ESRCH") return false;
    // Not a group leader (an old-style leak, pre-`detached`): fall back to the
    // single process. Its own children are then handled as their own rows.
    try {
      process.kill(pgid, sig);
      return true;
    } catch {
      return false;
    }
  }
}

/** Synchronous sleep — required because process.on('exit') cannot await. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * SIGTERM the whole group, wait for it to go, then SIGKILL what is left.
 * Returns 'gone' | 'term' | 'kill' | 'stuck'. Synchronous on purpose.
 */
export function reapGroup(pgid, { graceMs = 1500 } = {}) {
  if (!groupAlive(pgid)) return "gone";
  if (!signalGroup(pgid, "SIGTERM")) return "gone";
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    sleepSync(50);
    if (!groupAlive(pgid)) return "term";
  }
  signalGroup(pgid, "SIGKILL");
  sleepSync(150);
  return groupAlive(pgid) ? "stuck" : "kill";
}

// --- launch + teardown ------------------------------------------------------

const live = new Map(); // pid -> { profile, role, port, tool, child }
let handlersInstalled = false;

/** Reap everything this process launched. Idempotent, synchronous, never throws. */
export function reapAll({ graceMs = 1500 } = {}) {
  for (const [pid, rec] of [...live]) {
    live.delete(pid);
    try {
      reapGroup(pid, { graceMs });
    } catch {}
    // Delete the profile only AFTER the browser is down: a live Chrome keeps
    // writing into it, so rm throws ENOTEMPTY and a passing run exits non-zero
    // on a failure that has nothing to do with what it measured.
    try {
      rmSync(rec.profile, { recursive: true, force: true });
    } catch {}
  }
}

function installHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  // The happy path is the LEAST important of these registrations. The field
  // leak came from the paths below it.
  process.on("exit", () => reapAll({ graceMs: 400 }));
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      console.error(`\n[chrome] ${sig} — reaping ${live.size} browser process group(s)`);
      reapAll();
      process.exit(sig === "SIGINT" ? 130 : sig === "SIGTERM" ? 143 : 129);
    });
  }
  process.on("uncaughtException", (err) => {
    console.error("[chrome] uncaught exception — reaping before exit:");
    console.error(err?.stack || String(err));
    reapAll();
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    console.error("[chrome] unhandled rejection — reaping before exit:");
    console.error(err?.stack || String(err));
    reapAll();
    process.exit(1);
  });
}

/**
 * Report and reap ORPHANED instances of `role` left by a previous run of this
 * workspace. Loud by design: a silent sweep would hide exactly the recurrence
 * this gate exists to catch.
 */
export function sweepStaleChrome({ role, tool = "(script)", quiet = false } = {}) {
  const found = listInstances({ role });
  if (found === null) {
    if (!quiet) console.error(`[chrome] NOTE: cannot run 'ps' here — skipping the stale-instance sweep`);
    return { reaped: 0, kept: 0 };
  }
  const orphans = found.filter((f) => f.orphan);
  const owned = found.filter((f) => !f.orphan);
  if (orphans.length) {
    const oldest = orphans.map((o) => o.etime).sort((a, b) => b.length - a.length || b.localeCompare(a))[0];
    console.error(
      `[chrome] LEFTOVER: ${orphans.length} orphaned '${role}' Chrome process(es) from a previous run of this\n` +
        `[chrome]   workspace are still alive (oldest ${oldest}). Reaping them before this run measures anything —\n` +
        `[chrome]   background load inflates the reference side's self-comparison band, and an inflated band is a\n` +
        `[chrome]   pixel gate that silently forgives real cross-side residuals (see this file's header).`,
    );
    for (const o of orphans) console.error(`[chrome]   pid ${o.pid} (ppid ${o.ppid}, up ${o.etime}) ${o.profile}`);
    const groups = [...new Set(orphans.map((o) => o.pid))];
    for (const pid of groups) {
      try {
        reapGroup(pid);
      } catch {}
    }
    const still = (listInstances({ role }) || []).filter((f) => f.orphan);
    if (still.length) {
      console.error(`[chrome]   WARNING: ${still.length} process(es) survived SIGKILL: ${still.map((s) => s.pid).join(", ")}`);
    } else {
      console.error(`[chrome]   reaped ${orphans.length} process(es).`);
    }
  }
  if (owned.length && !quiet) {
    console.error(
      `[chrome] NOTE: ${owned.length} '${role}' Chrome process(es) with a LIVE parent are running — not touching them.` +
        ` If they hold this run's port, the port check below will name them.`,
    );
  }
  sweepStaleProfiles(role, new Set(orphans.map((o) => o.profile)));
  return { reaped: orphans.length, kept: owned.length };
}

/**
 * Delete profile dirs of this (workspace, role) that no live process is using.
 * `justReaped` skips the freshness guard: those directories were being written
 * to seconds ago BY the processes this sweep just killed, so the guard that
 * protects a sibling mid-launch would otherwise leave them behind for a whole
 * extra run.
 */
function sweepStaleProfiles(role, justReaped = new Set()) {
  const prefix = profilePrefix(role);
  const inUse = new Set((listInstances({ role }) || []).map((f) => f.profile));
  let names = [];
  try {
    names = readdirSync(tmpdir());
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const dir = path.join(tmpdir(), name);
    if (inUse.has(dir)) continue;
    try {
      // A dir touched in the last few seconds may belong to a sibling that is
      // launching right now — unless we are the ones who just emptied it.
      if (!justReaped.has(dir) && Date.now() - statSync(dir).mtimeMs < 5000) continue;
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * The one call every CDP script makes before it launches: sweep this role's
 * orphans first (they may be what is holding the port), then assert the port is
 * free. Order matters — swapping these turns a self-inflicted leftover into a
 * fatal "port taken" that the user has to clean up by hand.
 */
export async function preflightChrome({ role, port, tool, note = null }) {
  sweepStaleChrome({ role, tool });
  await assertPortFree(port, { tool, note });
}

/**
 * Spawn any child that must not outlive this process, as its own process group.
 * Use it for anything that forks (a browser, an `npm run dev` that execs node,
 * a server under test) — the direct child is never the whole story.
 * Returns { child, pid, reap }.
 */
export function spawnReaped({ bin, args = [], options = {}, cleanupDir = null, role = "child", port = 0, tool = "(script)" }) {
  installHandlers();
  const child = spawn(bin, args, {
    ...options,
    // THE fix for the leak: a detached child is a process-group leader, so
    // everything it forks shares its group and teardown can signal all of them
    // at once. Without this, killing `child.pid` orphans every one of them.
    detached: true,
  });
  live.set(child.pid, { profile: cleanupDir, role, port, tool, child });
  // Don't let the child's handle hold the event loop open; teardown is the
  // registered reaper's job, not the loop's.
  child.unref();
  return {
    child,
    pid: child.pid,
    /** Reap this child's whole group now (safe to call more than once). */
    reap: () => {
      if (!live.has(child.pid)) return;
      live.delete(child.pid);
      try {
        reapGroup(child.pid);
      } catch {}
      if (cleanupDir) {
        try {
          rmSync(cleanupDir, { recursive: true, force: true });
        } catch {}
      }
    },
  };
}

/**
 * Launch headless Chrome so that it CANNOT outlive this process.
 * `args` is everything except --user-data-dir (added here, pointing at a fresh
 * temp profile that teardown deletes). Returns { child, pid, profile, reap }.
 */
export function launchChrome({ bin, role, port, tool = "(script)", args = [], stdio = "ignore" }) {
  const profile = mkdtempSync(path.join(tmpdir(), `${profilePrefix(role)}p${port}-`));
  const extraArgs = [];
  if (typeof process.getuid === "function" && process.getuid() === 0 && !args.includes("--no-sandbox")) {
    extraArgs.push("--no-sandbox");
  }
  if (process.env.CHROME_FLAGS) {
    extraArgs.push(...process.env.CHROME_FLAGS.split(/\s+/).filter(Boolean));
  }
  const h = spawnReaped({
    bin,
    args: [`--user-data-dir=${profile}`, ...extraArgs, ...args],
    options: { stdio },
    cleanupDir: profile,
    role,
    port,
    tool,
  });
  return { ...h, profile };
}

// --- CDP payload ceiling ----------------------------------------------------

/**
 * Screenshot transport failures depend on image content and runtime versions.
 * Page.captureScreenshot returns the encoded image in one base64 CDP message.
 * The objectandarchive capture recorded these results on one machine:
 *   1280x800 PNG:        2,395,616 characters, 280 ms, received;
 *   390x844 PNG:           734,240 characters, received;
 *   1728x1080 JPEG q100: 1,995,384 characters, 106 ms, received;
 *   1728x1080 JPEG q92:    827,968 characters, 58 ms, received;
 *   1728x1080 PNG:      about 3.6 million characters, connection closed with 1006.
 * A second Chrome 150 / Node 22 setup received 3.33 million characters but failed
 * on a noise image of about 7 million. These observations establish neither a
 * portable size ceiling nor a maximum viewport.
 *
 * CDP close handlers and per-call deadlines turn transport failures into errors.
 * JPEG can reduce message size for coarse visual checks, but its compression is
 * lossy. Identical JPEG captures show repeatability of that sample, not equality
 * with uncompressed pixels. Use PNG when the check requires lossless pixels.
 */
export const SHOT_B64_SOFT_CEILING = 2_400_000;
export const SHOT_PX_SOFT_CEILING = 1500 * 900;

/** Lines to print when a screenshot dies, or before one that is likely to. */
export function shotCeilingAdvice({ w, h, format, quality = null, sizeB64 = null, closeCode = null }) {
  const px = w * h;
  const lines = [];
  if (closeCode !== null || sizeB64 !== null) {
    lines.push(
      `CDP PAYLOAD OVER THE LIMIT: screenshot ${w}x${h} format ${format}` +
        (quality !== null ? ` quality ${quality}` : "") +
        (sizeB64 !== null ? `, ${sizeB64.toLocaleString()} base64 chars` : "") +
        (closeCode !== null ? ` — the CDP WebSocket closed (${closeCode}) mid-transfer` : ""),
    );
  } else {
    lines.push(
      `NOTE: ${w}x${h} (${px.toLocaleString()} px) as ${format} is near or past the measured CDP payload ceiling.`,
    );
  }
  lines.push(
    `  Node's built-in WebSocket carries the whole frame as one message and dies above ~2.4 M base64 chars.`,
    `  Fixes, cheapest first:`,
    `    --format jpeg --quality 92   measured 827,968 chars / 58 ms at 1728x1080 (vs ~3.6 M for png: dead)`,
    `    --format jpeg --quality 100  measured 1,995,384 chars / 106 ms at 1728x1080`,
    `    smaller viewport             png is fine to ~1280x800 (2,395,616 chars)`,
    `  Keep png only where the gate compares BYTES; for a pixel/metric gate jpeg q92 was verified`,
    `  noise-free (two shots of the same static state came back byte-identical).`,
  );
  return lines;
}

/** True when this viewport/format combination is likely to exceed the ceiling. */
export function shotLikelyTooBig({ w, h, format }) {
  return String(format).toLowerCase() === "png" && w * h >= SHOT_PX_SOFT_CEILING;
}

// --- CLI --------------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Only the CLI mode validates argv; importers never pay for it.
  cli({ bools: ["all", "reap"], file: import.meta.url });
  const argv = process.argv.slice(2);
  const all = argv.includes("--all");
  const doReap = argv.includes("--reap");
  const found = listInstances({ role: null, slot: all ? null : portSlot() });
  if (found === null) {
    console.error("cannot run 'ps' on this machine");
    process.exit(3);
  }
  const scope = all ? "every workspace" : `workspace slot ${portSlot()}`;
  console.log(`toolchain Chrome instances (${scope}): ${found.length}`);
  for (const f of found) {
    console.log(
      `  pid ${String(f.pid).padStart(6)} ppid ${String(f.ppid).padStart(6)} up ${f.etime.padEnd(12)}` +
        ` ${f.orphan ? "ORPHAN" : "owned "} role ${f.role ?? "?"} port ${f.port ? labelPort(f.port) : "?"}`,
    );
  }
  const orphans = found.filter((f) => f.orphan);
  if (!orphans.length) {
    console.log("no orphans.");
    process.exit(0);
  }
  if (!doReap) {
    console.log(`\n${orphans.length} orphaned process(es). Re-run with --reap to kill their process groups.`);
    process.exit(1);
  }
  for (const pid of [...new Set(orphans.map((o) => o.pid))]) console.log(`  reap ${pid}: ${reapGroup(pid)}`);
  const left = (listInstances({ role: null, slot: all ? null : portSlot() }) || []).filter((f) => f.orphan);
  console.log(left.length ? `${left.length} survived SIGKILL: ${left.map((l) => l.pid).join(", ")}` : "all orphans reaped.");
  process.exit(left.length ? 1 : 0);
}

/**
 * The headless flag set every CDP script starts from. Tools add their own on top
 * (viewport, autoplay, GL backend); these are the ones that must never differ
 * between the two sides of a comparison — throttling and backgrounding flags
 * change what a frame contains.
 */
export const headlessArgs = ({ port, width = 1280, height = 800, sentinelUrl }) => [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  "--no-first-run",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--mute-audio",
  `--window-size=${width},${height}`,
  ...(sentinelUrl ? [sentinelUrl] : []),
];
