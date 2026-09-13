#!/usr/bin/env node
/**
 * Check configured SPA navigation and direct-load behavior in Chrome.
 * Each case uses an isolated browser context. Navigation selectors are clicked
 * with CDP input; preloader expressions are explicitly evaluated in the page.
 * The expected URL, visible container, all text snippets and opacity must hold
 * throughout the sampled stability window. This does not prove hydration of
 * components that the configured cases never interact with.
 *
 *   node scripts/verify-navigation.mjs --config navigation.config.mjs [--base <url>]
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Templates can run in place or after being copied into a project's scripts/.
async function loadHelper(name) {
  for (const dir of [path.resolve(process.cwd(), "scripts/lib"), path.resolve(import.meta.dirname, "../../scripts/lib"), path.resolve(import.meta.dirname, "lib")]) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return import(pathToFileURL(file).href);
  }
  throw new Error(`Cannot resolve helper module: ${name}`);
}

const { cli } = await loadHelper("cli.mjs");
const { flag } = cli({ known: ["config", "base", "port", "cdp-port", "case"], file: import.meta.url });
const { findChrome, launchChrome, preflightChrome, spawnReaped, headlessArgs } = await loadHelper("chrome.mjs");
const { chromeSentinel, assertOwnBrowser, resolvePort } = await loadHelper("ports.mjs");
const { connectCdp, cdpUrlFor } = await loadHelper("cdp.mjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const explicitConfig = flag("config", null);
const candidates = explicitConfig ? [explicitConfig] : ["navigation.config.mjs", "navigation.config.js", "scripts/navigation.config.mjs"];
const configPath = candidates.map((f) => path.resolve(f)).find((f) => fs.existsSync(f));
if (!configPath) { console.error("FATAL: No navigation config file found. Use --config <path>."); process.exit(2); }
const configModule = await import(pathToFileURL(configPath).href);
const config = configModule.default || configModule;
if (!Array.isArray(config.cases) || !config.cases.length) {
  console.error("FATAL: Config must contain a non-empty cases array."); process.exit(2);
}

const { port: PORT } = resolvePort({ lane: "serve", side: "rebuild", cli: flag("port", null), env: process.env.PORT || null });
const BASE = (flag("base", process.env.BASE_URL || config.base || `http://127.0.0.1:${PORT}`)).replace(/\/+$/, "");
const baseUrl = new URL(BASE);
if (!["http:", "https:"].includes(baseUrl.protocol)) throw new Error("Base URL must use HTTP or HTTPS");
const caseFilter = flag("case", "").toLowerCase();
const cases = config.cases.filter((c) => !caseFilter || c.name?.toLowerCase().includes(caseFilter));
if (!cases.length) { console.error(`FATAL: No cases match --case ${caseFilter}`); process.exit(2); }
for (const c of cases) {
  const type = c.type || "navigation";
  if (!["navigation", "direct"].includes(type) || (type === "navigation" && (!c.linkSelector || !c.expectedPath)) || (type === "direct" && !c.targetPath)) {
    throw new Error(`Invalid case ${c.name || "(unnamed)"}: navigation needs linkSelector/expectedPath; direct needs targetPath`);
  }
  for (const [key, fallback] of [["timeoutMs", 20000], ["stabilityMs", 2000], ["triggerWaitMs", 800]]) {
    const value = c[key] ?? fallback;
    if (!Number.isFinite(value) || value < 0 || (key === "timeoutMs" && value === 0)) throw new Error(`Invalid ${key} in ${c.name}`);
  }
  for (const key of ["startPath", "targetPath", "expectedPath"]) {
    if (c[key] && new URL(c[key], BASE + "/").origin !== baseUrl.origin) throw new Error(`${key} must remain on the configured origin`);
  }
}

let serverChild, chrome, cdp;
let exitCode = 1;
try {
  const serverReady = async () => {
    try { const response = await fetch(config.server?.readyUrl || BASE, { signal: AbortSignal.timeout(2000) }); return response.status < 500; }
    catch { return false; }
  };
  if (!await serverReady()) {
    if (!config.server?.cmd) throw new Error(`Target server is not reachable: ${BASE}`);
    serverChild = spawnReaped({ bin: config.server.cmd, args: config.server.args || [], role: "server", tool: "verify-spa-navigation.mjs" });
    const deadline = performance.now() + (config.server.timeoutMs || 10000);
    while (!await serverReady()) {
      if (performance.now() >= deadline) throw new Error(`Server startup timed out: ${BASE}`);
      await sleep(200);
    }
  }

  const { port } = resolvePort({ lane: "probe.cdp", side: "rebuild", cli: flag("cdp-port", null), env: process.env.CDP_PORT || null });
  await preflightChrome({ role: "verify-navigation", port, tool: "verify-spa-navigation.mjs" });
  const sentinel = chromeSentinel();
  chrome = launchChrome({ bin: await findChrome(), role: "verify-navigation", port, tool: "verify-spa-navigation.mjs", args: headlessArgs({ port, width: 1280, height: 800, sentinelUrl: sentinel.url }) });
  await assertOwnBrowser({ port, sentinel, tool: "verify-spa-navigation.mjs", pid: chrome.pid });
  cdp = await connectCdp(await cdpUrlFor(port), { defaultTimeoutMs: 10000 });
  console.log(`verify-spa-navigation: ${cases.length} case(s), ${BASE}`);

  async function runCase(test, index) {
    const { browserContextId } = await cdp.send("Target.createBrowserContext", { disposeOnDetach: true });
    let unsubscribe;
    try {
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      const send = (method, params = {}) => cdp.send(method, params, { sessionId });
      const evaluate = (expression) => cdp.evaluate(expression, { sessionId });
      const errors = [];
      unsubscribe = cdp.on("*", (message) => {
        if (message.sessionId !== sessionId) return;
        const p = message.params;
        if (message.method === "Runtime.exceptionThrown") errors.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text);
        if (message.method === "Runtime.consoleAPICalled" && p.type === "error") errors.push(p.args.map((a) => a.value ?? a.description ?? "error").join(" "));
        if (message.method === "Log.entryAdded" && p.entry.level === "error") errors.push(p.entry.text);
        if (message.method === "Network.responseReceived" && p.response.status >= 400) errors.push(`HTTP ${p.response.status}: ${p.response.url}`);
        if (message.method === "Network.loadingFailed" && !p.canceled) errors.push(`Network failure: ${p.errorText}`);
      });
      const assertNoErrors = () => { if (errors.length) throw new Error(errors.join("\n")); };
      await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable"); await send("Log.enable");
      await send("Page.bringToFront");
      const type = test.type || "navigation";
      const timeout = test.timeoutMs ?? 20000;
      const initial = new URL(type === "direct" ? test.targetPath : (test.startPath || "/"), BASE + "/").href;
      const expected = new URL(type === "direct" ? test.targetPath : test.expectedPath, BASE + "/").href;
      const result = await send("Page.navigate", { url: initial });
      if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);

      async function waitUntil(expression, timeoutMs, description) {
        const deadline = performance.now() + timeoutMs;
        do {
          assertNoErrors();
          if (await evaluate(expression)) return;
          await sleep(100);
        } while (performance.now() < deadline);
        throw new Error(`Timed out waiting for ${description}`);
      }
      await waitUntil('document.readyState === "complete"', timeout, "document load");

      if (config.preloader) {
        const preloader = config.preloader;
        const readyExpr = preloader.checkExpression || "({noPreloader: true})";
        await waitUntil(`(() => { const s = (${readyExpr}); return s?.noPreloader || s?.isCompleted || s?.isReady; })()`, preloader.timeoutMs || 15000, "preloader readiness");
        const state = await evaluate(readyExpr);
        if (!state?.noPreloader && !state?.isCompleted) {
          if (!preloader.dismissExpression || !preloader.verifyDismissedExpression) throw new Error("Preloader requires dismissal and verification expressions");
          await evaluate(preloader.dismissExpression);
          await waitUntil(preloader.verifyDismissedExpression, preloader.timeoutMs || 15000, "preloader dismissal");
        }
      }

      async function click(selector) {
        const selectorJSON = JSON.stringify(selector);
        await waitUntil(`(() => { const el = document.querySelector(${selectorJSON}); return !!el && el.getClientRects().length > 0; })()`, timeout, `selector ${selector}`);
        const point = await evaluate(`(() => {
          const el = document.querySelector(${selectorJSON});
          el.scrollIntoView({block: "center", inline: "center", behavior: "instant"});
          const r = el.getBoundingClientRect();
          const x = r.left + r.width / 2, y = r.top + r.height / 2;
          const hit = document.elementFromPoint(x, y);
          if (!hit || !el.contains(hit) || el.matches(":disabled")) return null;
          return {x, y};
        })()`);
        if (!point) throw new Error(`Click target is disabled or obscured: ${selector}`);
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
        await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
      }
      if (type === "navigation") {
        if (test.triggerSelector) { await click(test.triggerSelector); await sleep(test.triggerWaitMs ?? 800); }
        await click(test.linkSelector);
      }

      const texts = Array.isArray(test.expectedTexts) ? test.expectedTexts : test.expectedTexts ? [test.expectedTexts] : [];
      if (!texts.every((s) => typeof s === "string")) throw new Error("expectedTexts must contain strings");
      const stateExpression = String.raw`(() => {
        const el = document.querySelector(${JSON.stringify(test.expectedSelector || "body")});
        const norm = (s) => s.replace(/[\u2018\u2019\u0027\u0060\u00B4]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
        const text = norm(el?.innerText || "");
        const style = el && getComputedStyle(el);
        return {
          url: location.href,
          valid: location.href === ${JSON.stringify(expected)} && !!el && el.getClientRects().length > 0 &&
            style.visibility === "visible" && style.opacity === "1" &&
            ${JSON.stringify(texts)}.every((t) => text.includes(norm(t)))
        };
      })()`;
      const deadline = performance.now() + timeout;
      let state;
      do {
        assertNoErrors(); state = await evaluate(stateExpression);
        if (state.valid) break;
        await sleep(100);
      } while (performance.now() < deadline);
      if (!state?.valid) throw new Error(`Target state not reached: expected ${expected}, observed ${state?.url}`);

      const stableUntil = performance.now() + (test.stabilityMs ?? 2000);
      do {
        await sleep(Math.max(0, Math.min(200, stableUntil - performance.now())));
        assertNoErrors();
        state = await evaluate(stateExpression);
        if (!state.valid) throw new Error(`Target state changed during stability window: ${state.url}`);
      } while (performance.now() < stableUntil);
      assertNoErrors();
      console.log(`PASS [${index + 1}/${cases.length}] ${test.name || type}: ${expected}`);
    } finally {
      unsubscribe?.();
      await cdp.send("Target.disposeBrowserContext", { browserContextId });
    }
  }

  for (let i = 0; i < cases.length; i++) await runCase(cases[i], i);
  console.log(`PASS - ${cases.length}/${cases.length} SPA navigation cases`);
  exitCode = 0;
} catch (error) {
  console.error(`FAIL - ${error.message}`);
} finally {
  cdp?.close();
  chrome?.reap();
  serverChild?.reap();
}
process.exit(exitCode);
