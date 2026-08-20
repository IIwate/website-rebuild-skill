# website-rebuild-skill

## Differences from Upstream

This package is a fork of [boyang-hu/website-rebuild-skill](https://github.com/boyang-hu/website-rebuild-skill) that diverged after upstream v0.1.49. Compared with the upstream main branch, this fork:

- consolidates cross-platform Chrome/Chromium binary discovery into `scripts/lib/chrome.mjs` (`findChrome`), eliminating duplicate and inconsistent candidate lists across `probe.mjs`, `netcapture.mjs`, and `pixelcompare.mjs` while adding Windows and Linux default executable fallbacks;
- adds automatic `--no-sandbox` flag injection for headless Chrome when running in Linux root environments (such as WSL2 and Docker containers) to prevent browser startup crashes;
- introduces `CHROME_FLAGS` environment variable support in `scripts/lib/chrome.mjs` for passing custom runtime flags to headless Chrome instances.
