// probe-shim.js — deterministic driver shim for A/B same-frame comparison.
// Adapted from storytellingnoomo-rebuild/scripts/probe-shim.js.
//
// Usage: inject into <head> of HTML responses at the SERVING layer (serve.mjs
// does this for requests carrying ?__probe) on BOTH the mirror and the rebuild,
// then from a CDP probe call window.__pump(dt, frames) to advance both sides by
// identical dt sequences and screenshot the same frame. Directly reusable for
// any scroll- or time-driven animation site, including sites whose source
// bundle is minified and cannot be instrumented from inside.
//
// Verification instrumentation only: when the page is opened with ?__probe,
// replace requestAnimationFrame with a manually pumped queue and pin the
// visibility API to "visible/focused", so BOTH the mirror (source bundle) and
// the rebuild can be driven deterministically in a background tab. Timestamps
// start at 0 so time-driven shader phases line up across tabs pumped with
// identical dt sequences. Not part of source behavior; injected at the serving
// layer (mirror) / a pre plugin (rebuild).
(function () {
  if (typeof location === "undefined" || !location.search.includes("__probe")) return;
  try {
    Object.defineProperty(Document.prototype, "hidden", { get: () => false, configurable: true });
    Object.defineProperty(Document.prototype, "visibilityState", {
      get: () => "visible",
      configurable: true,
    });
  } catch (e) {}
  document.hasFocus = () => true;
  var queue = [];
  var nextId = 1;
  var now = 0;
  window.__rafQueue = queue;
  // Background tabs throttle setTimeout to ~1/min; route timers through a
  // pump-driven queue keyed to the real clock so engine sleeps fire promptly.
  var timers = [];
  var timerId = 1000000;
  var nativeSetTimeout = window.setTimeout.bind(window);
  var nativeClearTimeout = window.clearTimeout.bind(window);
  window.__nativeSetTimeout = nativeSetTimeout;
  window.setTimeout = function (cb, delay) {
    if (typeof cb !== "function") return nativeSetTimeout(cb, delay);
    var args = Array.prototype.slice.call(arguments, 2);
    var id = timerId++;
    timers.push({ id: id, cb: cb, due: performance.now() + (delay || 0), args: args });
    return id;
  };
  window.clearTimeout = function (id) {
    for (var i = 0; i < timers.length; i++)
      if (timers[i].id === id) {
        timers.splice(i, 1);
        return;
      }
    nativeClearTimeout(id);
  };
  var runDueTimers = function () {
    var nowR = performance.now();
    for (var i = 0; i < timers.length; i++) {
      if (timers[i].due <= nowR) {
        var t = timers.splice(i, 1)[0];
        i--;
        try {
          t.cb.apply(null, t.args);
        } catch (e) {
          console.error("[__pump timer]", e);
        }
      }
    }
  };
  window.requestAnimationFrame = function (cb) {
    var id = nextId++;
    queue.push({ id: id, cb: cb });
    return id;
  };
  window.cancelAnimationFrame = function (id) {
    for (var i = 0; i < queue.length; i++)
      if (queue[i].id === id) {
        queue.splice(i, 1);
        return;
      }
  };
  window.__pump = function (dt, frames) {
    dt = dt || 16.7;
    frames = frames || 1;
    for (var f = 0; f < frames; f++) {
      now += dt;
      runDueTimers();
      var batch = queue.splice(0, queue.length);
      for (var i = 0; i < batch.length; i++) {
        try {
          batch[i].cb(now);
        } catch (e) {
          console.error("[__pump]", e);
        }
      }
    }
    return now;
  };
  window.__pumpTime = function () {
    return now;
  };
})();
