#!/usr/bin/env node
/**
 * verify-spa-navigation.mjs — Generic Interactive SPA Navigation & SSR Verification Gate Template.
 *
 * Verifies client-side interactive route transitions, navigation menus/drawers,
 * preloader dismissal, and direct deep-link/SSR hydrations in a real browser.
 *
 * Core Verification Mechanics:
 *   1. Dedicated CDP Target session per test run
 *   2. Continuous requestAnimationFrame pump (prevents animation loop freeze in headless mode)
 *   3. Real-time exception & error listeners:
 *      - Runtime.exceptionThrown (uncaught JavaScript exceptions)
 *      - Runtime.consoleAPICalled (console.error)
 *      - Network.responseReceived (HTTP 4xx / 5xx responses)
 *      - Unintended navigation redirects (e.g. /error or fallback pages)
 *   4. DOM container mounting, text snippet matching, and opacity: '1' stability verification (>= 2s)
 *   5. Fully driven by external configuration (navigation.config.mjs)
 *
 * Usage:
 *   node scripts/verify-navigation.mjs [--config navigation.config.mjs] [--base http://127.0.0.1:29001]
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Resolves helper modules whether run from scripts/ or assets/templates/
async function loadHelper(name) {
  const candidates = [
    path.resolve(process.cwd(), "scripts/lib", name),
    path.resolve(import.meta.dirname, "../../scripts/lib", name),
    path.resolve(import.meta.dirname, "./lib", name),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return import(pathToFileURL(c).href);
    }
  }
  throw new Error(`Cannot resolve helper module: ${name}`);
}

const { findChrome, launchChrome, preflightChrome, spawnReaped } = await loadHelper("chrome.mjs");
const { chromeSentinel, assertOwnBrowser, resolvePort } = await loadHelper("ports.mjs");

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};

if (args.includes("--help") || args.includes("-h")) {
  console.log(`verify-spa-navigation.mjs — Interactive SPA Navigation Gate

Usage:
  node verify-spa-navigation.mjs [options]

Options:
  --config <path>     Path to navigation config file (default: navigation.config.mjs)
  --base <url>        Base URL of target server (default: from config or http://127.0.0.1:29001)
  --port <port>       Port to use for serve lane
  --cdp-port <port>   Chrome DevTools Protocol port
  --case <name>       Filter and run only test cases matching this name
  --help              Show this help message
`);
  process.exit(0);
}

// 1. Locate and load configuration
const configCandidates = [
  flag("config", null),
  path.resolve(process.cwd(), "navigation.config.mjs"),
  path.resolve(process.cwd(), "navigation.config.js"),
  path.resolve(process.cwd(), "scripts/navigation.config.mjs"),
].filter(Boolean);

let configPath = null;
for (const cand of configCandidates) {
  const resolved = path.isAbsolute(cand) ? cand : path.resolve(process.cwd(), cand);
  if (fs.existsSync(resolved)) {
    configPath = resolved;
    break;
  }
}

if (!configPath) {
  console.error(`FATAL: No navigation config file found.`);
  console.error(`       Create navigation.config.mjs or specify --config <path>.`);
  console.error(`       See assets/templates/navigation.config.example.mjs for a template.`);
  process.exit(1);
}

let configModule;
try {
  configModule = await import(pathToFileURL(configPath).href);
} catch (e) {
  console.error(`FATAL: Failed to load config file ${configPath}: ${e.message}`);
  process.exit(1);
}

const config = configModule.default || configModule;
if (!config || !Array.isArray(config.cases) || config.cases.length === 0) {
  console.error(`FATAL: Config file ${configPath} must export a default object with a non-empty 'cases' array.`);
  process.exit(1);
}

// 2. Resolve Server Base URL
const { port: PORT } = resolvePort({
  lane: "serve",
  side: "rebuild",
  cli: flag("port", null),
  env: process.env.PORT || null,
});

const defaultBase = config.base || `http://127.0.0.1:${PORT}`;
const BASE = (flag("base", process.env.BASE_URL || defaultBase) || "").replace(/\/+$/, "");

let serverChild = null;

async function checkServer(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function waitForServer(url, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkServer(url)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server at ${url} failed to respond within ${timeoutMs}ms`);
}

const serverRunning = await checkServer(BASE);
if (!serverRunning && config.server?.cmd) {
  console.log(`[verify-navigation] Launching local server (${config.server.cmd})...`);
  serverChild = spawnReaped({
    bin: config.server.cmd,
    args: config.server.args || [],
    role: "server",
    tool: "verify-spa-navigation.mjs",
  });
  await waitForServer(config.server.readyUrl || BASE, config.server.timeoutMs || 10000);
} else if (!serverRunning) {
  console.error(`FATAL: Target server at ${BASE} is not reachable.`);
  console.error(`       Please start your local server or configure 'server' in navigation.config.mjs.`);
  process.exit(1);
}

// 3. Launch Chrome with CDP
const { port: CDP_PORT, label: PORT_LABEL } = resolvePort({
  lane: "probe.cdp",
  side: "rebuild",
  cli: flag("cdp-port", null),
  env: process.env.CDP_PORT || null,
});

await preflightChrome({
  role: "verify-navigation",
  port: CDP_PORT,
  tool: "verify-spa-navigation.mjs",
});

const sentinel = chromeSentinel();
const chrome = launchChrome({
  bin: findChrome(),
  role: "verify-navigation",
  port: CDP_PORT,
  tool: "verify-spa-navigation.mjs",
  args: [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    "--no-first-run",
    "--disable-gpu-sandbox",
    "--hide-scrollbars",
    "--mute-audio",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1280,800",
    sentinel.url,
  ],
});

let exitCode = 0;

try {
  const target = await assertOwnBrowser({
    port: CDP_PORT,
    sentinel,
    tool: "verify-spa-navigation.mjs",
    pid: chrome.pid,
  });

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let msgId = 0;
  const pending = new Map();

  const pageExceptions = [];
  const consoleErrors = [];
  const networkErrors = [];

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      return;
    }
    if (m.method === "Runtime.exceptionThrown") {
      const details = m.params.exceptionDetails;
      const desc = details?.exception?.description || details?.text || "Unknown exception";
      const stack = details?.stackTrace ? JSON.stringify(details.stackTrace) : "";
      pageExceptions.push({ desc, stack, url: details?.url, line: details?.lineNumber });
    }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      const argsText = (m.params.args || [])
        .map((a) => a.value || a.description || JSON.stringify(a))
        .join(" ");
      consoleErrors.push({ text: argsText, location: m.params.stackTrace });
    }
    if (m.method === "Network.responseReceived") {
      const resp = m.params.response;
      if (resp && resp.status >= 400) {
        networkErrors.push({ url: resp.url, status: resp.status, statusText: resp.statusText });
      }
    }
  };

  const send = (method, params = {}, timeoutMs = 30000) =>
    new Promise((resolve, reject) => {
      const id = ++msgId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");

  console.log(`=== verify-spa-navigation (Interactive Client-Side SPA Navigation Gate) ===\n`);
  console.log(`Target Server: ${BASE}`);
  console.log(`CDP Debugger:  ${PORT_LABEL}`);
  console.log(`Config File:   ${configPath}\n`);

  async function pumpRAF() {
    await send("Runtime.evaluate", {
      expression: `(() => {
        window.__pump = window.__pump || function pump() { requestAnimationFrame(pump); };
        requestAnimationFrame(window.__pump);
      })()`,
      returnByValue: true,
    }).catch(() => {});
  }

  async function handlePreloader(preloaderConfig) {
    if (!preloaderConfig) return true;
    const timeout = preloaderConfig.timeoutMs || 15000;
    const checkExpr = preloaderConfig.checkExpression || "({ noPreloader: true })";
    const dismissExpr = preloaderConfig.dismissExpression || "true";
    const verifyExpr = preloaderConfig.verifyDismissedExpression || "true";

    const start = Date.now();
    let ready = false;

    while (Date.now() - start < timeout) {
      await pumpRAF();
      const checkRes = await send("Runtime.evaluate", {
        expression: checkExpr,
        returnByValue: true,
      });
      const val = checkRes.result?.value;
      if (val?.noPreloader || val?.isCompleted) {
        return true;
      }
      if (val?.isReady) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    if (!ready) {
      console.error(`  FAIL: Preloader did not reach ready state within ${timeout}ms.`);
      return false;
    }

    await send("Runtime.evaluate", {
      expression: dismissExpr,
      returnByValue: true,
    });

    const dismissStart = Date.now();
    while (Date.now() - dismissStart < 10000) {
      await pumpRAF();
      const verifyRes = await send("Runtime.evaluate", {
        expression: verifyExpr,
        returnByValue: true,
      });
      if (verifyRes.result?.value) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    console.error(`  FAIL: Preloader dismissal verification timed out.`);
    return false;
  }

  function checkErrors(checkpoint) {
    let ok = true;
    if (pageExceptions.length > checkpoint.ex) {
      const newEx = pageExceptions.slice(checkpoint.ex);
      console.error(`  FAIL: Uncaught page exception(s) detected:`, newEx);
      ok = false;
    }
    if (consoleErrors.length > checkpoint.con) {
      const newCon = consoleErrors.slice(checkpoint.con);
      console.error(`  FAIL: Console error(s) detected:`, newCon);
      ok = false;
    }
    if (networkErrors.length > checkpoint.net) {
      const newNet = networkErrors.slice(checkpoint.net);
      console.error(`  FAIL: Network HTTP 4xx/5xx response(s) detected:`, newNet);
      ok = false;
    }
    return ok;
  }

  async function runTestCase(testCase, index, totalCount) {
    const {
      name = `Case ${index + 1}`,
      type = "navigation",
      startPath = "/",
      targetPath = "/",
      triggerSelector = null,
      triggerWaitMs = 800,
      linkSelector = null,
      expectedPath = "",
      expectedSelector = "body",
      expectedTexts = [],
      stabilityMs = 2000,
      timeoutMs = 20000,
    } = testCase;

    console.log(`[${index + 1}/${totalCount}] TEST CASE: ${name} (${type})`);

    const checkpoint = {
      ex: pageExceptions.length,
      con: consoleErrors.length,
      net: networkErrors.length,
    };

    const initialNavPath = type === "direct" ? targetPath : startPath;
    const initialUrl = `${BASE}${initialNavPath}`;

    await send("Page.navigate", { url: initialUrl });
    await new Promise((r) => setTimeout(r, 1000));
    await pumpRAF();

    if (config.preloader) {
      const preloaderOk = await handlePreloader(config.preloader);
      if (!preloaderOk) return false;
      await new Promise((r) => setTimeout(r, 500));
    }

    if (type === "navigation") {
      if (triggerSelector) {
        const trigRes = await send("Runtime.evaluate", {
          expression: `(() => {
            const el = document.querySelector('${triggerSelector}');
            if (!el) return false;
            el.click();
            return true;
          })()`,
          returnByValue: true,
        });
        if (!trigRes.result?.value) {
          console.error(`  FAIL: Trigger selector '${triggerSelector}' not found.`);
          return false;
        }
        await new Promise((r) => setTimeout(r, triggerWaitMs));
      }

      if (linkSelector) {
        const linkRes = await send("Runtime.evaluate", {
          expression: `(() => {
            const el = document.querySelector('${linkSelector}');
            if (!el) return false;
            el.click();
            return true;
          })()`,
          returnByValue: true,
        });
        if (!linkRes.result?.value) {
          console.error(`  FAIL: Link selector '${linkSelector}' not found.`);
          return false;
        }
      }
    }

    // Wait and assert route arrival, DOM container, text copy, and opacity
    const targetRoutePattern = type === "direct" ? targetPath : expectedPath;
    const requiredTexts = Array.isArray(expectedTexts) ? expectedTexts : [expectedTexts];
    const pollStart = Date.now();
    let arrived = false;

    while (Date.now() - pollStart < timeoutMs) {
      await pumpRAF();
      const checkRes = await send("Runtime.evaluate", {
        expression: `(() => {
          const el = document.querySelector('${expectedSelector}');
          const text = el ? (el.innerText || '') : '';
          const url = window.location.href;
          const norm = (s) => (s || '')
            .replace(/[\\u2018\\u2019\\u0027\\u0060\\u00B4]/g, "'")
            .replace(/\\u00a0/g, " ")
            .replace(/\\s+/g, " ")
            .trim()
            .toLowerCase();
          const normText = norm(text);
          const required = ${JSON.stringify(requiredTexts)};
          const matchedText = required.length === 0 || required.some(t => normText.includes(norm(t)));
          const opacity = el ? window.getComputedStyle(el).opacity : null;
          return {
            url,
            isErrorUrl: url.includes('/error') || url.includes('/404'),
            hasTargetEl: !!el,
            pageOpacity: opacity,
            matchedText,
            snippet: normText.slice(0, 120),
          };
        })()`,
        returnByValue: true,
      });

      const data = checkRes.result?.value;
      if (data?.isErrorUrl) {
        console.error(`  FAIL: Navigation erroneously redirected to error page: ${data.url}`);
        return false;
      }

      if (
        data &&
        (!targetRoutePattern || data.url.includes(targetRoutePattern)) &&
        data.hasTargetEl &&
        data.matchedText &&
        data.pageOpacity === "1"
      ) {
        // Assert stability for >= stabilityMs
        let stable = true;
        const stabilityInterval = 200;
        const stabilityLoops = Math.max(1, Math.floor(stabilityMs / stabilityInterval));

        for (let s = 0; s < stabilityLoops; s++) {
          await new Promise((r) => setTimeout(r, stabilityInterval));
          await pumpRAF();
          const stabRes = await send("Runtime.evaluate", {
            expression: `(() => {
              const el = document.querySelector('${expectedSelector}');
              const op = el ? window.getComputedStyle(el).opacity : null;
              return {
                url: window.location.href,
                hasEl: !!el,
                opacity: op,
                isError: window.location.href.includes('/error'),
              };
            })()`,
            returnByValue: true,
          });
          const sv = stabRes.result?.value;
          if (!sv?.hasEl || sv.opacity !== "1" || sv.isError) {
            stable = false;
            console.error(`  FAIL: Stability assertion broken at ${s * stabilityInterval}ms:`, sv);
            break;
          }
        }

        if (stable) {
          arrived = true;
          console.log(`  PASS: Transition to ${data.url}`);
          console.log(`        Container '${expectedSelector}' active (opacity: 1 stable >= ${stabilityMs}ms)`);
          if (data.snippet) {
            console.log(`        Matched copy snippet: "${data.snippet.slice(0, 70)}..."`);
          }
          break;
        }
      }

      await new Promise((r) => setTimeout(r, 250));
    }

    if (!arrived) {
      console.error(`  FAIL: Navigation assertion timed out after ${timeoutMs}ms.`);
      return false;
    }

    const errOk = checkErrors(checkpoint);
    if (!errOk) return false;

    console.log();
    return true;
  }

  const caseFilter = flag("case", null);
  const selectedCases = caseFilter
    ? config.cases.filter((c) => c.name?.toLowerCase().includes(caseFilter.toLowerCase()))
    : config.cases;

  if (selectedCases.length === 0) {
    console.error(`FATAL: No test cases matched filter '--case ${caseFilter}'.`);
    process.exit(1);
  }

  let passed = 0;
  for (let i = 0; i < selectedCases.length; i++) {
    const ok = await runTestCase(selectedCases[i], i, selectedCases.length);
    if (ok) passed++;
    else break;
  }

  if (passed === selectedCases.length) {
    console.log(`=======================================================`);
    console.log(`ALL ${passed}/${selectedCases.length} SPA NAVIGATION GATES PASSED CLEANLY.`);
    console.log(`=======================================================`);
    exitCode = 0;
  } else {
    console.error(`=======================================================`);
    console.error(`SPA NAVIGATION GATE FAILED (${passed}/${selectedCases.length} passed).`);
    console.error(`=======================================================`);
    exitCode = 1;
  }
} catch (err) {
  console.error("Fatal error during navigation verification:", err);
  exitCode = 1;
} finally {
  try {
    if (chrome && typeof chrome.reap === "function") {
      chrome.reap();
    } else if (chrome) {
      chrome.kill("SIGKILL");
    }
  } catch {}
  if (serverChild) {
    try {
      if (typeof serverChild.reap === "function") {
        serverChild.reap();
      } else {
        serverChild.kill();
      }
    } catch {}
  }
  process.exit(exitCode);
}
