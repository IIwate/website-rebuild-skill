/**
 * navigation.config.example.mjs — Configuration template for SPA navigation gate.
 *
 * Copy this file to `navigation.config.mjs` in your project workspace and customize
 * it for your application's route structure, navigation triggers, preloader behavior,
 * and content assertions.
 *
 * Usage with verify-spa-navigation.mjs:
 *   node scripts/verify-spa-navigation.mjs --config navigation.config.mjs
 */

export default {
  // Target server base URL (can be overridden with --base CLI flag)
  base: "http://127.0.0.1:29001",

  // Optional: command to automatically start the local server if not already running
  // server: {
  //   cmd: "node",
  //   args: ["scripts/serve.mjs", "--root", "dist", "--port", "29001"],
  //   readyUrl: "http://127.0.0.1:29001/",
  //   timeoutMs: 10000,
  // },

  // Optional preloader / splash screen dismissal configuration.
  // Set to null if the application has no preloader.
  preloader: {
    // Timeout in ms to wait for preloader readiness
    timeoutMs: 15000,

    // In-page JS expression to check preloader state.
    // Return: { isReady: boolean, isCompleted: boolean, noPreloader?: boolean }
    // When isCompleted === true or noPreloader === true, navigation proceeds immediately.
    // When isReady === true, dismissExpression will be evaluated.
    checkExpression: `(() => {
      const p = document.querySelector('.preloader');
      if (!p) return { noPreloader: true };
      const cursor = p.style?.cursor;
      const isReady = cursor === 'pointer' || !!p.__vue__?.isReady || p.classList.contains('ready');
      const isCompleted = p.classList.contains('completed') || p.style?.display === 'none';
      return { isReady, isCompleted, noPreloader: false };
    })()`,

    // In-page JS expression to dismiss the preloader once isReady is true.
    dismissExpression: `(() => {
      const p = document.querySelector('.preloader');
      if (p?.__vue__?.clickHandler) {
        p.__vue__.clickHandler();
      } else if (p) {
        p.click();
      }
    })()`,

    // In-page JS expression to verify the preloader has fully faded out / dismissed.
    // Return: boolean
    verifyDismissedExpression: `(() => {
      const p = document.querySelector('.preloader');
      if (!p) return true;
      const op = parseFloat(window.getComputedStyle(p).opacity || '1');
      return op <= 0.05 || p.style?.display === 'none';
    })()`,
  },

  // Test cases matrix: client-side SPA navigation & direct SSR / deep-link hydration
  cases: [
    {
      name: "About Page Navigation",
      type: "navigation", // "navigation" | "direct"
      startPath: "/",
      // Optional trigger action to reveal navigation links (e.g. hamburger drawer)
      triggerSelector: ".button-menu",
      triggerWaitMs: 800,
      linkSelector: 'a[href="/about"]',
      expectedPath: "/about",
      expectedSelector: ".page-about",
      expectedTexts: [
        "About Us",
        "We are a creative studio",
      ],
      // Stability assertion: target container opacity must stay '1' for >= stabilityMs
      stabilityMs: 2000,
      timeoutMs: 20000,
    },
    {
      name: "Work Page Navigation",
      type: "navigation",
      startPath: "/",
      triggerSelector: ".button-menu",
      triggerWaitMs: 800,
      linkSelector: 'a[href="/work"]',
      expectedPath: "/work",
      expectedSelector: ".page-work",
      expectedTexts: [
        "Selected Work",
        "Featured Projects",
      ],
      stabilityMs: 2000,
      timeoutMs: 20000,
    },
    {
      name: "Direct Load & Hydration of About Page",
      type: "direct",
      targetPath: "/about",
      expectedSelector: ".page-about",
      expectedTexts: [
        "About Us",
        "We are a creative studio",
      ],
      stabilityMs: 2000,
      timeoutMs: 20000,
    },
  ],
};
