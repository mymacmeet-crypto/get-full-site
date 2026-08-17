/* eslint-env browser */
/* global getComputedStyle */

/**
 * Reveal pass - injected into every frame before the page loads.
 *
 * Text that animates in on scroll (AOS, WOW.js, ScrollReveal, Elementor, GSAP,
 * Framer Motion, hand-rolled IntersectionObserver code) sits at `opacity: 0`
 * until the reader scrolls it into view. A headless capture never scrolls, so
 * that text is still invisible when the page is saved - and the capture engine
 * then deletes it outright as a hidden element. Either way it is missing from
 * the archived file.
 *
 * Three layers fix that, weakest-assumption first:
 *
 *   1. Auto-scroll the frame top to bottom. This is the honest fix: the site's
 *      own IntersectionObserver / scroll handlers fire and reveal the content
 *      themselves, exactly as they would for a reader.
 *   2. Finish every running CSS animation and transition via getAnimations(),
 *      so a reveal that was triggered but is still mid-fade jumps to its end
 *      state instead of being captured half-transparent.
 *   3. Force visibility on what is still invisible *while occupying layout
 *      space*. An element that takes up room but cannot be seen is a reveal
 *      that never fired. Anything genuinely hidden - `display: none` dropdowns,
 *      closed modals, inactive carousel slides, `[hidden]`, `[aria-hidden]` -
 *      takes up no space or is explicitly marked, and is left alone.
 *
 * Runs in the capture engine's isolated world: it shares the DOM with the page
 * (so scrolling and style changes are real) but not the page's JavaScript, so
 * it can never collide with the site's own variables.
 *
 * Knobs come from globalThis.__WEB_ARCHIVER_REVEAL__, which src/archiver.js
 * writes as a companion script injected immediately before this one.
 */

(() => {
  'use strict';

  const DEFAULTS = {
    enabled: true,
    // Fraction of a viewport height to advance per scroll step. Below 1 so
    // nothing can slip between two steps without ever intersecting.
    stepFraction: 0.75,
    stepDelayMs: 70,
    // Hard ceiling on the scroll phase. Infinite-scroll pages would otherwise
    // grow faster than we can walk them.
    maxScrollMs: 4000,
    // Settling time at the bottom, for reveals that animate in on a delay.
    settleMs: 250,
    // Give up chasing a document that keeps growing beyond this many pixels.
    maxDocumentHeight: 250000,
    // Return to the top when finished, so the capture sees the page as a
    // reader first meets it.
    restoreScroll: true,
    // Full computed-style sweep is the expensive layer; it runs this many
    // times, spread across the pass, rather than after every scroll step.
    deepPasses: 3,
    // Upper bound on elements examined by one deep pass.
    maxDeepElements: 8000,
    // Record the number of forced elements on <html> as provenance.
    markDocument: true,
  };

  const config = Object.assign({}, DEFAULTS, globalThis.__WEB_ARCHIVER_REVEAL__ || {});
  if (!config.enabled) return;

  /**
   * Elements whose invisibility is intentional UI state rather than an
   * unfired animation. Nothing inside one of these is ever forced visible.
   */
  const HIDDEN_BY_DESIGN =
    'template,[hidden],[aria-hidden="true"],dialog:not([open]),' +
    '[role="dialog"],[role="alertdialog"],[role="tooltip"],[role="menu"],' +
    '.modal,.offcanvas,.dropdown-menu,.tooltip,.popover,.sr-only,.visually-hidden,' +
    '[data-web-archiver-skip]';

  /**
   * Cheap sweep: attributes and class-name conventions used by the popular
   * reveal libraries. Matching one of these is strong evidence of an
   * animation, so these are checked after every scroll step.
   */
  const REVEAL_HINTS =
    '[data-aos],[data-sr],[data-sr-id],[data-scroll],[data-scroll-reveal],' +
    '[data-animate],[data-animation],[data-motion],[data-framer-appear-id],' +
    '.wow,.aos-init,.animated,.animate__animated,.elementor-invisible,' +
    '.wpb_animate_when_almost_visible,.reveal,.js-reveal,.scroll-animate,' +
    '[class*="fade-"],[class*="fadeIn"],[class*="slide-"],[class*="slideIn"],' +
    '[class*="animate-on"],[class*="reveal-"],[class*="-reveal"]';

  /** Tags that are never worth examining in the deep sweep. */
  const IGNORED_TAGS = new Set([
    'SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'TITLE', 'NOSCRIPT', 'TEMPLATE',
    'BR', 'HR', 'SOURCE', 'TRACK', 'PARAM', 'BASE', 'AREA', 'COL', 'WBR',
  ]);

  let forcedCount = 0;
  const forced = new WeakSet();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const documentHeight = () => {
    const body = document.body;
    const root = document.documentElement;
    return Math.max(
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0,
      root ? root.scrollHeight : 0,
      root ? root.offsetHeight : 0,
      root ? root.clientHeight : 0
    );
  };

  /** Override a property hard enough to beat inline styles set by the site. */
  function force(element, property, value) {
    try {
      element.style.setProperty(property, value, 'important');
    } catch {
      /* read-only style on exotic elements */
    }
  }

  /**
   * Make one element visible. Returns true when it actually changed something,
   * so the provenance count stays honest.
   */
  function reveal(element) {
    if (forced.has(element)) return false;
    forced.add(element);
    force(element, 'opacity', '1');
    force(element, 'visibility', 'visible');
    force(element, 'transform', 'none');
    force(element, 'filter', 'none');
    force(element, 'clip-path', 'none');
    force(element, 'animation', 'none');
    force(element, 'transition', 'none');
    forcedCount++;
    return true;
  }

  /**
   * True when this element is invisible but still occupying layout space -
   * the signature of a reveal animation that was never triggered.
   *
   * `display: none` and detached subtrees have no boxes at all, so they fail
   * the size test and are left exactly as the site intended.
   */
  function isUnfiredReveal(element, style) {
    if (style.display === 'none') return false;
    if (style.contentVisibility === 'hidden') return false;

    const invisible =
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      Number.parseFloat(style.opacity) < 0.05;
    if (!invisible) return false;

    // Occupying space is what separates "mid-animation" from "switched off".
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /** Does this element hold text a reader would expect to see? */
  function hasVisibleText(element) {
    const text = element.textContent;
    return Boolean(text) && text.trim().length > 0;
  }

  /** Jump every running CSS animation and transition to its end state. */
  function finishAnimations(root) {
    if (typeof root.getAnimations !== 'function') return;
    let animations;
    try {
      animations = root.getAnimations({ subtree: true });
    } catch {
      return;
    }
    for (const animation of animations) {
      try {
        // Infinite animations cannot be finished and throw; they are
        // decorative by definition, so leaving them running is correct.
        animation.finish();
      } catch {
        /* infinite or already-idle animation */
      }
    }
  }

  /** Cheap pass: nudge the known libraries into their revealed state. */
  function hintPass() {
    let candidates;
    try {
      candidates = document.querySelectorAll(REVEAL_HINTS);
    } catch {
      return;
    }
    for (const element of candidates) {
      if (forced.has(element)) continue;
      if (element.closest(HIDDEN_BY_DESIGN)) continue;
      let style;
      try {
        style = getComputedStyle(element);
      } catch {
        continue;
      }
      if (isUnfiredReveal(element, style)) reveal(element);
    }

    // A handful of libraries key purely off a class the observer adds. Adding
    // it is gentler than overriding styles, because the site's own CSS then
    // produces the final state it was designed for.
    for (const element of document.querySelectorAll('[data-aos]:not(.aos-animate)')) {
      element.classList.add('aos-animate');
    }
    for (const element of document.querySelectorAll('.elementor-invisible')) {
      element.classList.remove('elementor-invisible');
    }
  }

  /**
   * Expensive pass: every element that could be carrying text, checked against
   * computed style. This is what catches hand-rolled reveal code that uses no
   * recognisable class name.
   */
  function deepPass() {
    let elements;
    try {
      elements = document.body ? document.body.getElementsByTagName('*') : [];
    } catch {
      return;
    }
    const limit = Math.min(elements.length, config.maxDeepElements);
    for (let i = 0; i < limit; i++) {
      const element = elements[i];
      if (forced.has(element) || IGNORED_TAGS.has(element.tagName)) continue;
      if (!hasVisibleText(element)) continue;
      let style;
      try {
        style = getComputedStyle(element);
      } catch {
        continue;
      }
      if (!isUnfiredReveal(element, style)) continue;
      if (element.closest(HIDDEN_BY_DESIGN)) continue;
      reveal(element);
    }
  }

  /** Scroll the frame top to bottom, revealing as it goes. */
  async function scrollThrough() {
    const viewport = window.innerHeight || 800;
    const step = Math.max(120, Math.round(viewport * config.stepFraction));
    const deadline = Date.now() + config.maxScrollMs;
    const deepEvery = Math.max(1, Math.round(8 / Math.max(1, config.deepPasses)));

    let position = 0;
    let stepIndex = 0;
    let height = documentHeight();

    while (position < height - viewport && Date.now() < deadline) {
      position += step;
      window.scrollTo(0, position);
      await sleep(config.stepDelayMs);

      hintPass();
      finishAnimations(document);
      if (stepIndex % deepEvery === deepEvery - 1) deepPass();
      stepIndex++;

      const grown = documentHeight();
      // Lazy content extends the page as we walk it; follow it, but refuse to
      // chase an infinite feed forever.
      height = Math.min(grown, config.maxDocumentHeight);
    }

    // Land on the true bottom, in case the loop exited on the step boundary.
    window.scrollTo(0, height);
    await sleep(config.settleMs);
  }

  async function runPass() {
    try {
      await scrollThrough();
    } catch {
      /* a frame that refuses to scroll still gets the passes below */
    }

    // Final sweeps, after every observer has had its chance to fire.
    finishAnimations(document);
    hintPass();
    deepPass();

    if (config.restoreScroll) {
      window.scrollTo(0, 0);
      // Some sticky headers only settle one frame after the scroll resets.
      await sleep(32);
      finishAnimations(document);
    }

    // One last sweep: scrolling back to the top can re-trigger "animate out"
    // handlers on sites that reverse their reveals.
    hintPass();

    if (config.markDocument && forcedCount > 0 && document.documentElement) {
      document.documentElement.setAttribute('data-web-archiver-revealed', String(forcedCount));
    }
  }

  function start() {
    // Never let a failure here stall the capture: the engine is waiting on a
    // timer, not on this script, but an unhandled rejection is still noise.
    runPass().catch(() => {});
  }

  if (document.readyState === 'loading') {
    // DOMContentLoaded rather than load: the scroll then overlaps the tail of
    // the page's own resource loading instead of running after it, which is
    // most of why the pass costs so little wall-clock.
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
