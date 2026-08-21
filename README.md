# website-rebuild-skill

## Differences from Upstream

This package is a fork of [boyang-hu/website-rebuild-skill](https://github.com/boyang-hu/website-rebuild-skill) that diverged after upstream v0.1.49. Compared with the upstream main branch, this fork:

- consolidates cross-platform Chrome/Chromium binary discovery into `scripts/lib/chrome.mjs` (`findChrome`), eliminating duplicate and inconsistent candidate lists across `probe.mjs`, `netcapture.mjs`, and `pixelcompare.mjs` while adding Windows and Linux default executable fallbacks;
- adds automatic `--no-sandbox` flag injection for headless Chrome when running in Linux root environments (such as WSL2 and Docker containers) to prevent browser startup crashes;
- introduces `CHROME_FLAGS` environment variable support in `scripts/lib/chrome.mjs` for passing custom runtime flags to headless Chrome instances;
- isolates CDP targets per route in `scripts/netcapture.mjs` (`Target.createTarget` / `Target.closeTarget`) to prevent WebGL context and DOM memory leaks across SPA multi-route crawls;
- expands `scripts/module-map.mjs` with Webpack 4/5 JSONP chunk container parsing (`/(?:webpackJsonp|webpackChunk)/i`), ESM export helpers (`__webpack_require__.d`), and second-parameter CommonJS export extraction;
- enhances CLI ergonomy for `verify-mirror.mjs` (`--root` alias, default `external.txt` excuses) and `verify-offline.mjs` (`--url` single-URL shortcut);
- provides generic SPA interactive navigation and hydration gate templates (`assets/templates/verify-spa-navigation.mjs` and `navigation.config.example.mjs`) with continuous rAF animation pumping and opacity stability verification;
- refactors `scripts/serve.mjs` text rewriting to check Content-Type headers for extension-less files, eliminating binary corruption risks for extension-less WASM and data slices.
