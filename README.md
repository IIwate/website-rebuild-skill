# website-rebuild-skill

## Differences from Upstream

Compared with [upstream/main](https://github.com/boyang-hu/website-rebuild-skill/tree/main) at v0.3.22 (`412e814`). This file records only the fork-specific differences that remain.

### Runtime and verification

- Extends shared Chrome discovery with `CHROME_BIN`, supports `CHROME_FLAGS`, and supplies `--no-sandbox` for root environments.
- Uses a fresh CDP target for each netcapture route, rejects invalid or empty viewport selections, and preserves full Content-Type parameters in fetched ledger rows.
- Supports sparse webpack JSONP arrays and additional webpack export metadata. Module maps separate local `requires` from ID-shaped `externalRequires`, including path IDs in path-keyed containers; Turbopack aliases are resolved before that split. Module naming accepts path IDs and anchors Turbopack discovery to its container signature. Cold audits resolve aliases and mapped cross-chunk dependencies, select signatures by container identity, and enforce coverage independently of advisory findings.
- Shares an off-host asset census between the crawler and mirror verifier, preserving long-extension, image-proxy and srcset evidence. The mirror verifier reads `external.txt` by default, accepts `--root`, and writes its complete gap report outside the mirror by default (`--gap-out`).
- Keeps transformed asset paths as files through a shared path-tail mapping. Media authenticity checks distinguish AVIF brands from MP4 while accepting fragmented MP4 segments.
- Rewrites untyped extensionless text using content evidence and preserves lengths in bare flight streams. Build and response layers share devalue protection for inline `__NUXT_DATA__` and external `_payload.json`; retained asset URLs are reported, and the builder refuses to ship them.
- Resolves external payload paths independently on each side and reports fetch failures per route. Served-reference checks normalize escaped and entity-encoded spellings consistently; the static offline gate also accepts `--url`.
- Makes beautifier fallback to original bytes fail explicitly, names importless ESM preambles after their declarations, and resolves standalone verification paths correctly when directories contain spaces.
- Provides `?__probe&__noio` for a native IntersectionObserver control and reports discarded observer options.
- Rejects pixel walks whose requested second scroll falls outside the configured virtual-time pump budget.

### Additional tools and guidance

- Optional `verify-ledger.mjs` and `verify-sourceified-tokens.mjs` checks, plus the Babel Binding-based `demangle-modules.mjs` transformer.
- SPA navigation and hydration templates with isolated sessions, real interaction, error monitoring and transition stability assertions.
- Flat-IIFE ownership maps, constructor/random-consumption accounting, per-branch WebGL readiness, scene topology checks and a narrowly scoped data-literal extraction rule.
- Explicit boundaries for coordinate evidence, sourceification changes, asset closure and scheduler observations. JPEG/WebP transport is documented for quantitative gates, with PNG retained for byte-fidelity checks.

### Repository

- The repository package is private (`website-rebuild-skill-repo`) and identifies `IIwate/website-rebuild-skill` in its repository metadata. Root documentation is maintained as this fork comparison.
