# website-rebuild-skill

## Differences from Upstream

This package is a fork of [boyang-hu/website-rebuild-skill](https://github.com/boyang-hu/website-rebuild-skill), merged up to and including upstream v0.1.52. It records only what differs from upstream; for what the skill is and how to run it, read `skills/website-rebuild/SKILL.md`.

### Engineering additions

Capability this fork adds for real deployment environments (WSL2, Docker, Linux root, cross-platform Chrome) and for framework-driven SPAs:

- consolidates cross-platform Chrome/Chromium binary discovery into `scripts/lib/chrome.mjs` (`findChrome`), eliminating duplicate and inconsistent candidate lists across `probe.mjs`, `netcapture.mjs`, and `pixelcompare.mjs` while adding Windows and Linux default executable fallbacks;
- adds automatic `--no-sandbox` flag injection for headless Chrome when running in Linux root environments (such as WSL2 and Docker containers) to prevent browser startup crashes;
- introduces `CHROME_FLAGS` environment variable support in `scripts/lib/chrome.mjs` for passing custom runtime flags to headless Chrome instances;
- isolates CDP targets per route in `scripts/netcapture.mjs` (`Target.createTarget` / `Target.closeTarget`) to prevent WebGL context and DOM memory leaks across SPA multi-route crawls;
- expands `scripts/module-map.mjs` with Webpack 4/5 JSONP chunk container parsing (`/(?:webpackJsonp|webpackChunk)/i`), ESM export helpers (`__webpack_require__.d`), and second-parameter CommonJS export extraction;
- enhances CLI ergonomy for `verify-mirror.mjs` (`--root` alias, default `external.txt` excuses) and `verify-offline.mjs` (`--url` single-URL shortcut);
- provides generic SPA interactive navigation and hydration gate templates (`assets/templates/verify-spa-navigation.mjs` and `navigation.config.example.mjs`) with continuous rAF animation pumping and opacity stability verification;
- refactors `scripts/serve.mjs` text rewriting to check Content-Type headers for extension-less files, eliminating binary corruption risks for extension-less WASM and data slices;
- adds `?__probe&__noio` to `scripts/probe-shim.js`, leaving `IntersectionObserver` native while the rest of the determinism shim still applies, so a run can be compared against itself with and without the IO takeover.

### Upstream defect corrections

These are defects in upstream's own checks rather than differences of preference. They are listed apart from the additions above only because they would become redundant if upstream ever corrects them; until then this fork carries the corrections.

- **`cold-audit-modules.mjs` — the coverage gate did not run whenever the check found anything.** The 80% gate added in v0.1.50 was written as an `else if` after the suspicious-call-site branch, so any candidate skipped it entirely. Confirmed on a real chunk (lights, `module-map-b30f9f2`, 65 modules): upstream examined 48 of them — 73.8%, under its own threshold — printed four review candidates, and exited 0 PASS. The four candidates were themselves false positives (`n(new Error("http status code: " + f.statusCode))` and friends, a node-style callback that survives the arity and `new` heuristics), so the gate was not traded away for a finding but for noise. This is the third appearance of the failure mode v0.1.50 was written to close, and a gate hanging off an `else` branch is not a gate. Now evaluated unconditionally.

- **`cold-audit-modules.mjs` — the packer was inferred from the factory shape instead of the container.** v0.1.50 computed `TURBO` from `MAP.container` and then never used it, deciding instead that an arrow factory means Turbopack. Webpack 5 emits `(module, exports, require) => {}` on modern targets — Next.js output is literally `(e,t,r)=>{` — so the first parameter was taken for a Turbopack `ctx` and searched for `e.i(`, finding no requires while still counting toward coverage. The arrow branch also required a `^`, `,` or `[` prefix that the indented `id: (e, t, r) => {` head js-beautify produces never satisfies, so on a webpack 5 bundle every module fell through to 0% coverage instead. Now the container decides, webpack arrow factories resolve the third parameter, and factories with no require binding are counted and reported separately rather than deflating coverage.

- **`pixel-walk.mjs` — `--rescroll-ms` could exceed the pump budget and disable itself in silence.** The re-issued scroll runs on virtual pump time, so once `--rescroll-ms` reaches `dt x frames` its `setTimeout` is never pumped and the walk reverts to one scroll at load — the exact defect the re-issue exists to fix, with nothing in the output to say so. `--pump 16.7,60` alone is enough to kill the default `--rescroll-ms 1500`. Now a hard failure that names the frame count required.

- **`probe-shim.js` — the `IntersectionObserver` takeover normalised semantics without an opt-out or a disclosure.** Intersection is computed against the viewport with `isIntersecting = ratio > 0`, discarding `root`, `rootMargin` and `threshold`. Since both sides run the same shim, a rebuild and a mirror that genuinely disagree on a threshold are flattened onto the same frame and pass. The takeover is kept — its measured benefit is real — but each observer now reports which options were discarded, and `&__noio` provides the control run. Also fixed: `disconnect()` left the record in the pump's walk list, holding element references and costing a forced layout per frame for every dead observer; and `deliverIntersections` walked the live array, so a one-shot reveal disconnecting from inside its own callback caused the next observer to be skipped for that frame.
