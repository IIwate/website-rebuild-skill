# website-rebuild-skill

## Differences from Upstream

This fork is merged up to and including upstream v0.2.8. This file records only the fork-specific differences that still remain.

### Engineering additions

- consolidates cross-platform Chrome/Chromium discovery into `scripts/lib/chrome.mjs`, with Windows and Linux defaults, `CHROME_FLAGS`, and `--no-sandbox` injection for Linux root environments;
- isolates CDP targets per route in `scripts/netcapture.mjs` and makes `--viewports` failure-loud instead of silently shrinking the crawl set;
- gives `verify-mirror.mjs` an off-host census shared with `mirror-site.mjs`, so asset hosts are counted where they are actually seen;
- expands `scripts/module-map.mjs` with container-aware parsing for webpack and Turbopack bundles, and splits `requires` from `externalRequires`;
- extends `scripts/serve.mjs` text rewriting to extension-less files by using the recorded content-type first and the extension second, while keeping probe injection and data-island handling intact;
- adds `?__probe&__noio` to `scripts/probe-shim.js` so IntersectionObserver can be left native for a control run;
- adds optional coordinate and sourceification checks (`verify-ledger.mjs`, `verify-sourceified-tokens.mjs`) plus the Babel-based `demangle-modules.mjs` transformer;
- adds Flat-IIFE ownership-map guidance, constructor/random-consumption accounting, per-branch WebGL readiness checks, and a narrowly scoped data-literal extraction exception;
- documents WebP as a quantitative-gate transport format alongside JPEG;
- fixes `slice-esm.mjs` so chunks without imports do not emit a fake `000-imports.js`, and fixes standalone byte verification for paths containing spaces.

### Upstream defect corrections

These are defects in upstream checks rather than preference-level differences.

- `lib/shell-build.mjs` / `serve.mjs`: the data-island guard belongs to both localisers, not just one side;
- `verify-payload.mjs`: a missing payload file should fail the gate, not abort the whole run;
- `probe.mjs`: the flag set must include every flag the file reads;
- `cold-audit-modules.mjs`: coverage must be evaluated unconditionally, and container identity must come from the container, not the factory shape;
- `verify-mirror.mjs`: type confusion must distinguish image/video bodies correctly;
- `lib/urlpath.mjs`: path-tail flattening must be shared and must not be classified as a page;
- `beautify-bundle.mjs`: a fallback to minified bytes must still fail loudly;
- `name-modules.mjs`: Turbopack parsing must be anchored to the real container, not any `.push([..])`;
- `verify-mirror.mjs` and `netcapture.mjs`: ledger writes must not mutate the mirror or silently disappear;
- `pixel-walk.mjs`: scroll retries and drive semantics must fail on explicit request loss;
- `verify-refs-served.mjs`: raw and decoded scans must be normalized consistently;
- `probe-shim.js`: IntersectionObserver normalization must be disclosed, with `&__noio` as the control run.
