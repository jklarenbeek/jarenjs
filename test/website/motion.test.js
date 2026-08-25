//@ts-check
/**
 * @file The site's motion layer, proven where its rules are decidable:
 * what it stamps, what it refuses to animate, and what it leaves
 * behind. The browser half — that the stamped classes actually move,
 * and that nothing moves under an emulated `reduce` — is asserted
 * against real engines in `packages/website/e2e/motion.spec.js`; this
 * file pins the logic that decides WHETHER to move, which no screenshot
 * can show: the format-safety of the count-up, the instant final state
 * under `reduce`, the abort when the renderer writes a newer value, and
 * the settle-on-swap.
 *
 * The DOM here is a fake with exactly the surface the module touches —
 * a class list, a text node, one custom property, an observer and a
 * frame clock — because the interesting behaviour is timing, and a
 * frame clock a test can step is what makes it assertable.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMotion, prefersReducedMotion } from '../../packages/website/src/lib/motion.js';

const SRC = fileURLToPath(new URL('../../packages/website/src/', import.meta.url));

/** Every source file of the site, path-relative to `src/`. */
function sources(dir = '') {
  return readdirSync(path.join(SRC, dir), { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory()
      ? sources(path.join(dir, entry.name))
      : (entry.name.endsWith('.js') ? [path.join(dir, entry.name)] : [])));
}

/** One element: the classes it carries, the text it shows, the custom
 * properties stamped on it. */
class FakeElement {
  /**
   * @param {string} classes
   * @param {string} [text]
   */
  constructor(classes, text = '') {
    /** @type {Set<string>} */
    this.classes = new Set(classes.split(' ').filter(Boolean));
    this.textContent = text;
    /** Where the element sits relative to the viewport top — the one
     * measurement the settled-scroll sweep reads. */
    this.top = 0;
    /** @type {Map<string, string>} */
    this.props = new Map();
    this.classList = {
      /** @param {...string} names */
      add: (...names) => { for (const n of names) this.classes.add(n); },
      /** @param {...string} names */
      remove: (...names) => { for (const n of names) this.classes.delete(n); },
      /** @param {string} name */
      contains: (name) => this.classes.has(name),
    };
    this.style = {
      /** @param {string} name @param {string} value */
      setProperty: (name, value) => { this.props.set(name, value); },
    };
  }

  /** The class list as the assertions read it. */
  get className() {
    return [...this.classes].join(' ');
  }

  getBoundingClientRect() {
    return { top: this.top };
  }
}

/** A window with a steppable frame clock and a recording observer. */
function fakeView(reduced) {
  /** @type {{ id: number, cb: (now: number) => void }[]} */
  let frames = [];
  let nextFrame = 1;
  /** @type {any[]} */
  const observers = [];
  class FakeObserver {
    /** @param {(entries: any[]) => void} callback */
    constructor(callback) {
      this.callback = callback;
      /** @type {Set<any>} */
      this.targets = new Set();
      this.disconnected = false;
      observers.push(this);
    }

    /** @param {any} el */
    observe(el) { this.targets.add(el); }
    /** @param {any} el */
    unobserve(el) { this.targets.delete(el); }
    disconnect() { this.targets.clear(); this.disconnected = true; }
    /** Deliver one frame's arrivals, in order. @param {any[]} els */
    arrive(els) {
      this.callback(els.map((target) => ({ target, isIntersecting: true })));
    }
  }
  /** @type {Map<string, ((...args: any[]) => void)[]>} */
  const listeners = new Map();
  /** @type {{ id: number, fn: () => void }[]} */
  let timers = [];
  let nextTimer = 1;
  return {
    innerHeight: 800,
    matchMedia: (/** @type {string} */ query) => ({
      matches: reduced && query === '(prefers-reduced-motion: reduce)',
    }),
    IntersectionObserver: FakeObserver,
    /** @param {string} type @param {(...args: any[]) => void} fn */
    addEventListener: (type, fn) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    /** @param {() => void} fn */
    setTimeout: (fn) => {
      const id = nextTimer++;
      timers.push({ id, fn });
      return id;
    },
    /** @param {number} id */
    clearTimeout: (id) => { timers = timers.filter((t) => t.id !== id); },
    /** Fire an event and let its debounce elapse. @param {string} type */
    scroll: function scroll(type = 'scroll') {
      for (const fn of listeners.get(type) ?? []) fn();
      const due = timers;
      timers = [];
      for (const t of due) t.fn();
    },
    /** @param {(now: number) => void} cb */
    requestAnimationFrame: (cb) => {
      const id = nextFrame++;
      frames.push({ id, cb });
      return id;
    },
    /** @param {number} id */
    cancelAnimationFrame: (id) => { frames = frames.filter((f) => f.id !== id); },
    /** Run everything queued, at `now`. @param {number} now */
    tick: (now) => {
      const due = frames;
      frames = [];
      for (const f of due) f.cb(now);
    },
    pending: () => frames.length,
    observers,
    last: () => observers[observers.length - 1],
  };
}

/** A document over a flat element list — `querySelectorAll` matches the
 * class-keyed selector lists the module uses, and nothing else. */
function fakeDocument(view, elements) {
  const doc = {
    defaultView: view,
    main: new FakeElement('main'),
    elements,
    /** @param {string} selector */
    querySelector: (selector) => (selector === 'main.main' ? doc.main : null),
    /** @param {string} selector */
    querySelectorAll: (selector) => {
      const names = selector.split(',').map((s) => s.trim().replace('.', ''));
      return elements.filter((/** @type {FakeElement} */ el) =>
        names.some((n) => el.classes.has(n)));
    },
  };
  return doc;
}

describe('website — the motion layer', function () {
  it('stamps the pre-view state and observes; an arrival reveals with a capped stagger', function () {
    const cards = Array.from({ length: 9 }, () => new FakeElement('card engine-card'));
    const view = fakeView(false);
    const document = fakeDocument(view, cards);
    const sync = createMotion(document);

    sync();
    for (const card of cards) {
      assert.ok(card.classes.has('reveal'), 'every card carries the pre-view state');
      assert.ok(!card.classes.has('reveal-in'), 'and none of them has arrived yet');
    }
    assert.strictEqual(view.last().targets.size, 9);

    view.last().arrive(cards);
    assert.ok(cards.every((c) => c.classes.has('reveal-in')));
    assert.strictEqual(view.last().targets.size, 0, 'a revealed card stops being observed');
    // one stagger step per card arriving in the SAME frame, capped so the
    // last card of a long grid does not wait a second for its turn
    assert.deepStrictEqual(cards.map((c) => c.props.get('--motion-index')),
      ['0', '1', '2', '3', '4', '5', '6', '6', '6']);
  });

  it('a card the viewport JUMPED past still arrives, once the scroll settles', function () {
    // a flick or an anchor jump moves the viewport between two
    // observation cycles: the observer never reports the card at all,
    // and without the sweep it would sit invisible for good
    const passed = new FakeElement('card engine-card');
    const below = new FakeElement('card engine-card');
    const view = fakeView(false);
    const sync = createMotion(fakeDocument(view, [passed, below]));
    passed.top = 5_000;
    below.top = 6_000;
    sync();
    assert.ok(!passed.classes.has('reveal-in'));

    passed.top = -320;            // scrolled clean past, never intersecting
    below.top = 1_400;            // still below the fold
    view.scroll();
    assert.ok(passed.classes.has('reveal-in'), 'what the viewport passed is shown');
    assert.ok(!below.classes.has('reveal-in'), 'what it has not reached still waits');
    assert.strictEqual(view.last().targets.size, 1, 'and only the waiting card is still observed');
  });

  it('a second frame re-stamps nothing (the scan is per frame, the install once)', function () {
    const card = new FakeElement('card engine-card');
    const view = fakeView(false);
    const sync = createMotion(fakeDocument(view, [card]));
    sync();
    view.last().arrive([card]);
    card.classList.remove('reveal-in');
    sync();
    assert.ok(!card.classes.has('reveal-in'), 'an element already seen is not observed again');
    assert.strictEqual(view.observers.length, 1, 'and no second observer is installed');
  });

  it('counts a measured headline up to the exact value the renderer wrote', function () {
    const value = new FakeElement('stat-value', '1164 / 1166');
    const view = fakeView(false);
    const sync = createMotion(fakeDocument(view, [value]));
    sync();
    view.last().arrive([value]);

    view.tick(0);
    assert.ok(value.classes.has('counting'), 'the count marks itself while it runs');
    assert.match(value.textContent, /^\d+ \/ 1166$/, 'the tail is carried, never re-derived');
    view.tick(200);
    const midway = Number(value.textContent.split(' ')[0]);
    assert.ok(midway > 0 && midway < 1164, `an intermediate value, not the answer: ${midway}`);
    view.tick(700);
    assert.strictEqual(value.textContent, '1164 / 1166', 'it lands on the rendered string itself');
    assert.ok(!value.classes.has('counting'));
    assert.strictEqual(view.pending(), 0, 'and the frame loop stops');
  });

  it('a decimal headline keeps its decimals, and only the leading token moves', function () {
    const perf = new FakeElement('engine-perf', '8.83× faster than json-p3 (geomean)');
    const view = fakeView(false);
    const sync = createMotion(fakeDocument(view, [perf]));
    sync();
    view.last().arrive([perf]);
    view.tick(0);
    view.tick(150);
    assert.match(perf.textContent, /^\d\.\d{2}× faster than json-p3 \(geomean\)$/);
    view.tick(700);
    assert.strictEqual(perf.textContent, '8.83× faster than json-p3 (geomean)');
  });

  it('refuses every string whose leading number is not a quantity', function () {
    // a date, a version, a grouped number, a machine name and a zero:
    // animating any of these rewrites a string rather than a number
    const texts = ['2026-08-02 → 2026-08-21', 'v0.39.1 → v0.40.3', '1,164 tests',
      'Intel(R) Core(TM) i7-8700', '0', '—'];
    const values = texts.map((t) => new FakeElement('stat-value', t));
    const view = fakeView(false);
    const sync = createMotion(fakeDocument(view, values));
    sync();
    view.last().arrive(values);
    view.tick(0);
    view.tick(300);
    assert.deepStrictEqual(values.map((v) => v.textContent), texts);
    assert.ok(values.every((v) => !v.classes.has('counting')));
    assert.strictEqual(view.pending(), 0, 'a refused headline queues no frames at all');
  });

  it('a value the renderer replaces mid-count stands: the newer answer wins', function () {
    const value = new FakeElement('stat-value', '31821 cases');
    const view = fakeView(false);
    const sync = createMotion(fakeDocument(view, [value]));
    sync();
    view.last().arrive([value]);
    view.tick(0);
    value.textContent = '31900 cases';   // the renderer patched a fresher run in
    view.tick(300);
    assert.strictEqual(value.textContent, '31900 cases');
    assert.ok(!value.classes.has('counting'));
    assert.strictEqual(view.pending(), 0);
  });

  it('a page swap disconnects the observers and settles a running count on its final value', function () {
    const value = new FakeElement('stat-value', '1858 passing');
    const card = new FakeElement('stat-card');
    const view = fakeView(false);
    const document = fakeDocument(view, [value, card]);
    const sync = createMotion(document);
    sync();
    view.last().arrive([value]);
    view.tick(0);
    view.tick(100);
    assert.notStrictEqual(value.textContent, '1858 passing');

    // the shell keys <main> on the route: a swapped route IS a new element
    document.main = new FakeElement('main');
    sync();
    assert.strictEqual(value.textContent, '1858 passing', 'the half-counted headline settles');
    assert.strictEqual(view.pending(), 0, 'and its frame loop is cancelled, not abandoned');
    assert.ok(view.observers[0].disconnected, 'the previous surface stops being observed');
    assert.strictEqual(view.observers.length, 2, 'the arriving surface installs its own');
  });

  it('under `reduce` nothing moves and nothing counts: final states, at once', function () {
    const card = new FakeElement('card engine-card');
    const value = new FakeElement('stat-value', '1164 / 1166');
    const view = fakeView(true);
    const sync = createMotion(fakeDocument(view, [card, value]));
    sync();
    assert.strictEqual(card.className, 'card engine-card reveal reveal-in',
      'the final class is stamped immediately — the stylesheet gives it no transition');
    assert.strictEqual(value.textContent, '1164 / 1166', 'the headline keeps what it rendered with');
    assert.strictEqual(view.observers.length, 0, 'no observer is installed at all');
    assert.strictEqual(view.pending(), 0, 'and no frame is ever requested');
    assert.ok(prefersReducedMotion(view));
  });

  it('is the ONLY module that knows the motion APIs, and only the browser bootstrap loads it', function () {
    // motion is browser-only by construction: the headless site renders
    // final values because nothing on the Node path can ask for anything
    // else. That is a property of the import graph, not of a test double.
    const files = sources();
    const knows = files.filter((file) =>
      /IntersectionObserver|prefers-reduced-motion/.test(readFileSync(path.join(SRC, file), 'utf8')));
    assert.deepStrictEqual(knows, ['lib/motion.js']);

    const importers = files.filter((file) =>
      /from '[^']*motion\.js'/.test(readFileSync(path.join(SRC, file), 'utf8')));
    assert.deepStrictEqual(importers, ['main.js'],
      'the app document, its viewmodel and every boundary stay unable to move anything');
  });

  it('degrades on a host without the APIs, and before the shell has mounted', function () {
    const bare = fakeDocument(null, [new FakeElement('card engine-card')]);
    assert.doesNotThrow(() => createMotion(bare)());
    assert.strictEqual(prefersReducedMotion(null), false);

    const view = fakeView(false);
    const document = fakeDocument(view, [new FakeElement('card engine-card')]);
    document.querySelector = () => null;   // no <main> yet
    createMotion(document)();
    assert.strictEqual(view.observers.length, 0);
  });
});
