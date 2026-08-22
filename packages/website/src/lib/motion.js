//@ts-check
/**
 * The motion layer's browser half: the DOM work the stylesheet cannot
 * do on its own, installed from the app's committed-frame boundary
 * (`afterRender`) because the render is async-scheduled and an effect
 * touching the DOM would race the patch.
 *
 * Two behaviours share one IntersectionObserver:
 *  - REVEAL — a card that first scrolls into view rises in. All this
 *    stamps is the class pair; the transition, its stagger and its
 *    easing are the stylesheet's motion vocabulary, so every surface
 *    moves with one voice. An observer alone is not enough to promise
 *    that: a fast flick or an anchor jump moves the viewport past a
 *    card between two observation cycles, and the card is then never
 *    reported as intersecting at all — it would sit at opacity 0
 *    forever. A scroll-settled sweep over the cards still waiting is
 *    the guarantee that no reader can lose content to the motion.
 *  - COUNT — a measured headline counts up to the value the renderer
 *    already wrote. Only the leading numeric token is animated and the
 *    final frame restores the rendered string verbatim, so a formatted
 *    value is never re-formatted; a headline the renderer replaces
 *    mid-count aborts rather than overwriting the newer answer.
 *
 * Under `prefers-reduced-motion: reduce` nothing moves and nothing
 * counts: the reveal class pair is stamped at once (a final state with
 * no transition, because the stylesheet's motion rules live behind
 * `no-preference`) and a headline keeps the value it rendered with —
 * instant, never a shortened animation. A host with no DOM omits the
 * capability altogether and renders those same final values.
 */

/**
 * What rises in on first view: the site's card vocabulary. Every
 * selector is class-keyed on purpose — the scan runs once per committed
 * frame, and a `*` compound would walk the whole tree on pages that
 * render a thousand rows.
 */
const REVEAL_SELECTOR
  = '.engine-card, .callout, .stat-card, .table-card, .code-card, .chart-card, .doc-md';

/** What counts up: the derived measured lines — an engine card's
 * headline on Home, a stat card's value on Benchmarks. */
const COUNT_SELECTOR = '.stat-value, .engine-perf';

/**
 * The leading numeric token of a headline, and only that: a value the
 * count can drive to its rendered target without inventing a format.
 * The lookahead is what keeps a date (`2026-08-02`), a grouped number
 * (`1,234`) and a version (`v0.39.1`, which has no leading digit at
 * all) out — animating those would rewrite a string, not a number.
 */
const COUNT_TOKEN = /^(\d{1,9}(?:\.\d{1,3})?)(?![\d,.:/-])/;

/** How long a headline takes to reach its value. */
const COUNT_MS = 700;

/** Stagger steps are capped: a grid of twenty cards arriving in one
 * frame must not make the last one wait a second for its turn. */
const MAX_STAGGER = 6;

/** How long the scroll must be still before the safety sweep measures
 * what the observer may have jumped over. */
const SETTLE_MS = 160;

/**
 * Does this host ask for no motion? Read per install rather than
 * subscribed to: a preference that changes mid-session takes effect on
 * the next surface, which is also when everything else re-installs.
 * @param {any} view - The window, or null on a host without one.
 * @returns {boolean}
 */
export function prefersReducedMotion(view) {
  return view?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
}

/**
 * Build the site's per-committed-frame motion install.
 * @param {any} document - The live DOM document.
 * @returns {() => void} The `afterRender` capability: stamp what this
 *   frame committed, and start over when the shell swapped the page.
 */
export function createMotion(document) {
  const view = document.defaultView ?? null;
  const usable = view !== null && typeof view.IntersectionObserver === 'function'
    && typeof view.requestAnimationFrame === 'function';

  /** @type {any} */
  let observer = null;
  /** The page element the current install belongs to. The shell keys
   * `<main>` on the route, so a swapped route IS a new element — which
   * makes the identity check the route change, with no state to read. */
  /** @type {any} */
  let page = null;
  let reduced = false;
  let listening = false;
  /** @type {WeakSet<any>} */
  let revealed = new WeakSet();
  /** @type {WeakSet<any>} */
  let counters = new WeakSet();
  /** Stamped but not yet arrived — the only elements the settled-scroll
   * sweep measures, and the only strong references held. A detached one
   * measures as a zero rect, so the first sweep after the renderer
   * dropped it lets it go.
   * @type {Set<any>} */
  let pending = new Set();
  let settle = 0;
  /** In-flight counts, so a page swap can settle them on their final
   * value instead of abandoning a half-counted headline.
   * @type {Map<any, { frame: number, start: number, text: string, written: string }>} */
  const counting = new Map();

  /** Settle every running count on the string the renderer wrote. */
  function settleCounts() {
    for (const [element, run] of counting) {
      view.cancelAnimationFrame(run.frame);
      if (element.textContent === run.written) element.textContent = run.text;
      element.classList.remove('counting');
    }
    counting.clear();
  }

  /**
   * Count one headline up to the value it is already showing.
   * @param {any} element
   */
  function startCount(element) {
    const text = element.textContent ?? '';
    const token = COUNT_TOKEN.exec(text);
    if (token === null) return;
    const target = Number(token[1]);
    if (!(target > 0)) return;
    const decimals = (token[1].split('.')[1] ?? '').length;
    const tail = text.slice(token[1].length);

    /** @param {number} now */
    const frame = (now) => {
      const run = counting.get(element);
      if (run === undefined) return;
      // the renderer owns this node: a value it wrote while the count
      // was running is the newer answer and the count stands down
      if (element.textContent !== run.written) {
        counting.delete(element);
        element.classList.remove('counting');
        return;
      }
      // the first frame is the clock's zero, whatever the host's
      // timestamp happens to be (a frame stamped 0 is a legal one)
      if (run.start < 0) run.start = now;
      const t = Math.min(1, (now - run.start) / COUNT_MS);
      // ease out: the last digits settle rather than snap
      const next = t === 1 ? text : `${(target * (1 - ((1 - t) ** 3))).toFixed(decimals)}${tail}`;
      element.textContent = next;
      run.written = next;
      if (t === 1) {
        counting.delete(element);
        element.classList.remove('counting');
        return;
      }
      run.frame = view.requestAnimationFrame(frame);
    };

    element.classList.add('counting');
    const run = { frame: 0, start: -1, text, written: text };
    counting.set(element, run);
    run.frame = view.requestAnimationFrame(frame);
  }

  /**
   * Arrive a batch together — writes only, so a batch costs one frame
   * and never a forced reflow.
   * @param {any[]} elements
   */
  function arrive(elements) {
    let step = 0;
    for (const element of elements) {
      observer.unobserve(element);
      pending.delete(element);
      element.style.setProperty('--motion-index', String(step < MAX_STAGGER ? step : MAX_STAGGER));
      step += 1;
      element.classList.add('reveal-in');
    }
  }

  /**
   * One observation cycle: the observer has already measured, so the
   * only work here is deciding what each arrival is.
   * @param {any[]} entries
   */
  function onIntersect(entries) {
    const arriving = [];
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      if (counters.has(entry.target)) {
        observer.unobserve(entry.target);
        startCount(entry.target);
        continue;
      }
      arriving.push(entry.target);
    }
    if (arriving.length !== 0) arrive(arriving);
  }

  /**
   * The safety net, once the scroll has settled: anything the viewport
   * has already reached or passed arrives now, whether or not the
   * observer ever saw it cross. All the measuring happens first, so the
   * sweep is one read pass and one write pass.
   */
  function sweep() {
    if (pending.size === 0) return;
    const bottom = view.innerHeight;
    const arriving = [];
    for (const element of pending) {
      if (element.getBoundingClientRect().top < bottom) arriving.push(element);
    }
    if (arriving.length !== 0) arrive(arriving);
  }

  function scheduleSweep() {
    view.clearTimeout(settle);
    settle = view.setTimeout(sweep, SETTLE_MS);
  }

  /** @param {any} next - the page element this install belongs to */
  function install(next) {
    settleCounts();
    if (observer !== null) observer.disconnect();
    revealed = new WeakSet();
    counters = new WeakSet();
    pending = new Set();
    reduced = prefersReducedMotion(view);
    observer = reduced ? null : new view.IntersectionObserver(onIntersect, { threshold: 0 });
    if (!reduced && !listening) {
      view.addEventListener('scroll', scheduleSweep, { passive: true });
      view.addEventListener('resize', scheduleSweep, { passive: true });
      listening = true;
    }
    page = next;
  }

  return function syncMotion() {
    if (!usable) return;
    const main = document.querySelector('main.main');
    if (main === null) return;
    if (main !== page) install(main);
    for (const element of document.querySelectorAll(REVEAL_SELECTOR)) {
      if (revealed.has(element)) continue;
      revealed.add(element);
      if (reduced) {
        // instant final state: the stylesheet's transition never applies
        element.classList.add('reveal', 'reveal-in');
        continue;
      }
      element.classList.add('reveal');
      pending.add(element);
      observer.observe(element);
    }
    if (reduced) return;
    for (const element of document.querySelectorAll(COUNT_SELECTOR)) {
      if (counters.has(element)) continue;
      counters.add(element);
      observer.observe(element);
    }
  };
}
