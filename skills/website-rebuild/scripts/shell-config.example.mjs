/**
 * Example configuration for DOM-shell generation and verification.
 *
 *   node scripts/build-site.mjs --config scripts/shell-config.mjs
 *   node scripts/verify-shell.mjs --config scripts/shell-config.mjs
 *
 * Adapt the example values and transforms to the captured mirror; see
 * references/dom-shell-strategies.md §2.
 *
 * Both commands import this module, so importing it must not build or change
 * artifacts. In two recorded projects, a verifier imported a build entrypoint,
 * regenerated a modified shell and then passed. Keeping configuration free of
 * such side effects lets verification inspect the existing output
 * (verification-gates.md §2.1.2).
 */
export default {
  /** Documents to build, relative to the mirror root. */
  pages: [
    { rel: "index.html", route: "/" },
    { rel: "about/index.html", route: "/about" },
  ],

  /**
   * Extra files copied into site/ verbatim, e.g. the generated port output from
   * scripts/extract-source.mjs. `from` is a project path, `to` is under site/.
   */
  extras: [{ from: "src/_gen/app.gen.js", to: "assets/js/app.js" }],

  /** Hosts that ARE this site: absolute/protocol-relative URLs -> root-relative. */
  originHosts: ["example.com", "www.example.com"],

  /**
   * Hosts mapped to /ext/<host>/ and handled by serve.mjs stubs. Match the
   * reference server's --stub-ext-hosts configuration so platform adaptation
   * does not introduce a difference between the two sides.
   */
  stubExtHosts: ["www.googletagmanager.com", "connect.facebook.net"],

  /** Mirrored external hosts (served from <mirror>/assets/<host>/). */
  mirroredExtHosts: ["fonts.googleapis.com", "fonts.gstatic.com"],

  /**
   * The unofficial-rebuild notice + noindex, injected right after <head>.
   * legal-and-deploy.md requires BOTH, and requires a gate to watch them —
   * that is what the T-NOINDEX floor below is for.
   */
  notice:
    "<!--\n" +
    "  UNOFFICIAL STUDY REBUILD — not the real <site>. Generated from a private\n" +
    "  forensic mirror for the sole purpose of studying its implementation.\n" +
    "  Not affiliated with or endorsed by <owner>. All artwork, copy, fonts and\n" +
    "  trade dress belong to their owners. Private, noindex, never deployed.\n" +
    "-->\n",

  /**
   * Minimum hit counts for individual transforms. A high-frequency URL rewrite
   * can conceal a missing four-hit noindex insertion if only the total is checked
   * (dom-shell-strategies.md §2, step 3).
   *
   * A hit count confirms matching input, not the intended output. One identifier
   * removal matched 25 times but left another spelling in every generated shell.
   * Use purpose checks for the corresponding output condition.
   */
  floors: { "T-LOCALIZE": 100, "T-NOINDEX": 2, "T-SCRIPT": 2 },

  /**
   * Site-specific transforms beyond the built-in T-LOCALIZE / T-NOINDEX.
   * Each gets an id, a REBUILD_PLAN §6 deviation number, and is applied to one
   * document (or one diff hunk — verify-shell replays these on hunks, so they
   * must be anchored on self-contained literals, never on file position).
   */
  transforms: [
    {
      id: "T-SCRIPT",
      dev: "D-B2",
      what: "the site's own bundle -> our generated build",
      apply: (html, { bump }) =>
        html.replace(
          /(<script\b[^>]*\bsrc=")([^"]*\/app\.[a-f0-9]+\.js)(")/gi,
          (m, pre, src, post) => (bump(), `${pre}/assets/js/app.js${post}`),
        ),
      // ONLY THE src VALUE CHANGES. Rebuilding the tag drops async/defer, and
      // loading semantics are not decoration: a measured case turned three
      // non-blocking scripts into parser-blocking ones and changed a canvas
      // bitmap's size (dom-shell-strategies.md).
    },
  ],

  /**
   * Optional purpose assertions: {name, values(mirrorHtml) -> string[]}.
   * After the build, none of the returned strings may appear in the BUILT
   * bytes. Values are read out of the mirror at build time rather than
   * hard-coded, so a live token never enters a tracked file and the check
   * self-updates when the origin rotates one.
   */
  purposeChecks: [],
};
