# website-rebuild-skill

## Differences from Upstream

Compared with [upstream/main](https://github.com/boyang-hu/website-rebuild-skill/tree/830647fbe4e31cda85319df69b48514bd224ad79) at `830647f` (v0.3.23). This file records only the fork-specific differences that remain.

### Scope and repository

- Uses a POSIX runtime scope, with Node 22+, npm/npx and local Chrome or Chromium. Offline checks require cached versions of the npm tools they invoke.
- Defines work and verification coverage from the user's requested outcome. Guidance distinguishes observations, inferences, intentional deviations and unavailable checks, and preserves authorization within the agreed scope.
- Keeps project case studies as evidence with stated limits. Script comments are in English; documentation and CLI output use plain text without emoji.
- Loads the skill directly from the repository or skill directory. The private development package (`website-rebuild-skill-repo`) identifies `IIwate/website-rebuild-skill`; root documentation consists of this comparison README.

### Runtime and verification

- Extends shared Chrome discovery with `CHROME_BIN`, supports `CHROME_FLAGS`, and supplies `--no-sandbox` for root environments.
- Uses a fresh CDP target for each netcapture route, rejects invalid or empty viewport selections, and preserves full Content-Type parameters in fetched ledger rows.
- Supports sparse webpack JSONP arrays and additional webpack export metadata. Module maps separate local `requires` from ID-shaped `externalRequires`, including path IDs in path-keyed containers; Turbopack aliases are resolved before that split. Module naming accepts path IDs and anchors Turbopack discovery to its container signature. Cold audits resolve aliases and mapped cross-chunk dependencies, select signatures by container identity, and enforce coverage independently of advisory findings.
- Shares an off-host asset census between the crawler and mirror verifier, preserving long-extension, image-proxy and srcset evidence. The mirror verifier reads `external.txt` by default, accepts `--root`, and writes its complete gap report outside the mirror by default (`--gap-out`).
- Keeps transformed asset paths as files through a shared path-tail mapping. Media authenticity checks distinguish AVIF brands from MP4 while accepting fragmented MP4 segments.
- Rewrites untyped extensionless text using content evidence and preserves lengths in bare flight streams. Build and response layers share protection for inline Nuxt, JSON-LD and speculation-rule data; external `_payload.json` is also protected. Attribute quoting and case are recognized, overlapping selectors preserve each body once, and retained asset URLs remain visible to the builder's checks.
- HLS capture uses the shared query policy and path mapping, preserves existing record metadata, validates playlist headers and worker settings, and rejects corrupt manifests and URL path traversal.
- Resolves external payload paths independently on each side and reports fetch failures per route. Served-reference checks normalize escaped and entity-encoded spellings consistently; the static offline gate also accepts `--url`.
- Makes beautifier fallback to original bytes fail explicitly, accepts top-level await during parsing, and preserves ledger rows and distinct outputs across batches with spaced or colliding filenames. Names importless ESM preambles after their declarations and resolves standalone verification paths correctly when directories contain spaces.
- Resolves ESM entry imports and sourcemaps against the final response URL, applies Referer retries to short imported responses, and validates complete origins when discovering page links.
- Uses Acorn to inspect literal import, re-export and require specifiers for dependency checks, excluding examples inside strings, comments and regular expressions. Token comparisons include regular-expression patterns and flags.
- Validates GLB animation accessor formats, strides and buffer bounds before exporting curves.
- Provides `?__probe&__noio` for a native IntersectionObserver control and reports discarded observer options.
- Rejects pixel walks whose requested second scroll falls outside the configured virtual-time pump budget. CSS freezing handles injection before the HTML root exists, and combined user seeds retain a statement boundary after trailing line comments.
- Validates JSON stub path specifications before listening and propagates browser cache-clearing failures.

### Additional tools and guidance

- Optional `verify-ledger.mjs` and `verify-sourceified-tokens.mjs` checks, plus the Babel Binding-based `demangle-modules.mjs` transformer.
- SPA navigation and hydration templates with isolated sessions, real interaction, error monitoring and transition stability assertions.
- Flat-IIFE ownership maps, constructor/random-consumption accounting, per-branch WebGL readiness, scene topology checks and a narrowly scoped data-literal extraction rule.
- Explicit boundaries for coordinate evidence, sourceification changes, asset closure and scheduler observations. Media guidance accounts for buffered seek ranges, detached elements, failed image loads and player-specific state handling. JPEG/WebP transport is documented for quantitative gates, with PNG retained for byte-fidelity checks.
