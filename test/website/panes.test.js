//@ts-check
/**
 * @file The one-pane protocol, proven once across every studio the site
 * mounts. `@jarenjs/play` established the pattern and `#/project`,
 * `#/flow` and `#/data` adopted it; each owns its pane names, its state
 * key and its stylesheet, so what a shared test can pin is the CONTRACT
 * they agreed on rather than any one implementation:
 *
 *   1. the pane container carries `data-pane`, seeded to the documented
 *      default for that studio;
 *   2. a segmented bar renders one button per pane, in bar order, with
 *      `aria-pressed` true on exactly the live one;
 *   3. switching moves `data-pane` and nothing else — every pane element
 *      is STILL MOUNTED afterwards, which is what lets a hidden editor
 *      keep its caret, its scroll and its undo stack, and what makes a
 *      switch one attribute write instead of a re-render;
 *   4. a junk pane value falls back to the default rather than blanking
 *      the studio (a stale slice or a hand-edited share link).
 *
 * The CSS that turns (1) into one visible pane is a browser fact, pinned
 * by `packages/website/e2e/mobile.spec.js` at a 390×844 viewport.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createSiteApp } from '../../packages/website/src/app/createSiteApp.js';
import { parseHash } from '../../packages/website/src/lib/route.js';
import { createStubHost } from '../view/dom.stub.js';

/** A headless site over the stub DOM, opened at `hash`. */
function mountSite(hash) {
  const { document, container } = createStubHost();
  /** @type {any} */
  let routeCb = null;
  const app = createSiteApp({
    node: container,
    document,
    schedule: (f) => f(),
    debounceMs: 0,
    fetchJson: () => Promise.reject(new Error('404')),
    listenHash: (cb) => { routeCb = cb; cb(parseHash(hash)); },
    navigate: (h) => routeCb(parseHash(h)),
    storage: { read: () => null, write: () => {} },
    onError: (err) => { throw err; },
  });
  return { app, container };
}

/** Every node under `root` satisfying `pred`, document order. */
function findAll(root, pred, out = []) {
  if (pred(root)) out.push(root);
  for (const child of root.childNodes ?? []) findAll(child, pred, out);
  return out;
}

const hasClass = (node, name) => (node.getAttribute?.('class') ?? '')
  .split(/\s+/).includes(name);
const byClass = (root, name) => findAll(root, (n) => hasClass(n, name))[0];
const label = (node) => node.childNodes?.[0]?.nodeValue;

/**
 * The four studios. `panes` is `[id, label, paneClass]` in BAR ORDER —
 * `paneClass` is the element that pane governs, asserted to stay mounted
 * across every switch.
 */
const STUDIOS = [
  {
    name: '#/play', hash: '#/play', slice: 'play', key: 'mobilePane',
    root: 'jplay', bar: 'jplay-mobilebar', action: 'play/mobile-pane',
    fallback: 'editor',
    panes: [
      ['examples', 'Examples', 'jplay-rail'],
      ['editor', 'Editor', 'jplay-editors'],
      ['result', 'Result', 'jplay-stage'],
    ],
  },
  {
    name: '#/project', hash: '#/project', slice: 'project', key: 'mobilePane',
    root: 'jstudio', bar: 'js-panebar', action: 'project/pane',
    fallback: 'editor',
    panes: [
      ['files', 'Files', 'js-rail'],
      ['editor', 'Editor', 'js-editor'],
      ['stage', 'Stage', 'js-stage'],
    ],
  },
  {
    name: '#/flow', hash: '#/flow', slice: 'flow', key: 'mobilePane',
    root: 'flow-grid', bar: 'flow-panebar', action: 'flow/pane',
    fallback: 'diagram',
    // the studio shows its template picker until a document is loaded
    prepare: (app) => app.dispatch('flow/load', {
      kind: 'fsm',
      doc: { initial: 'a', states: ['a', 'b'], transitions: [{ from: 'a', event: 'go', to: 'b' }] },
      runContext: null,
      dagInput: '',
    }),
    panes: [
      ['diagram', 'Diagram', 'flow-canvas-card'],
      ['inspector', 'Inspector', 'flow-inspector'],
      ['run', 'Run', 'flow-run'],
    ],
  },
  {
    name: '#/data', hash: '#/data', slice: 'data', key: 'mobilePane',
    root: 'data-grid', bar: 'data-panebar', action: 'data/pane',
    fallback: 'query',
    panes: [
      ['store', 'Store', 'data-status'],
      ['query', 'Query', 'data-query'],
      ['live', 'Live', 'data-live'],
      ['trip', 'Round trip', 'data-trip'],
    ],
  },
];

describe('the one-pane protocol — every studio agrees', function () {
  for (const studio of STUDIOS) {
    it(`${studio.name} seeds data-pane, renders the bar, and keeps every pane mounted`, function () {
      const { app, container } = mountSite(studio.hash);
      studio.prepare?.(app);

      const defaultPane = app.getState()[studio.slice][studio.key];
      const root = byClass(container, studio.root);
      assert.ok(root !== undefined, `${studio.name} renders its .${studio.root} pane container`);
      assert.strictEqual(root.getAttribute('data-pane'), defaultPane,
        'the container publishes the live pane');

      const bar = byClass(container, studio.bar);
      assert.ok(bar !== undefined, `${studio.name} renders its .${studio.bar} switcher`);
      assert.strictEqual(bar.getAttribute('role'), 'group',
        'a pane is a grid area, not a tabpanel — the bar is a group of toggles');

      const segments = findAll(bar, (n) => n.tagName === 'button');
      assert.deepStrictEqual(segments.map(label), studio.panes.map(([, text]) => text),
        'one segment per pane, in bar order');

      // walk every pane: the attribute follows, aria-pressed tells the
      // truth, and no pane is ever unmounted on the way
      for (const [id] of studio.panes) {
        app.dispatch(studio.action, id);
        assert.strictEqual(app.getState()[studio.slice][studio.key], id,
          `${studio.action} '${id}' lands in state`);

        const live = byClass(container, studio.root);
        assert.strictEqual(live.getAttribute('data-pane'), id,
          `the container republishes '${id}'`);

        const pressed = findAll(byClass(container, studio.bar), (n) => n.tagName === 'button')
          .map((n) => n.getAttribute('aria-pressed'));
        assert.deepStrictEqual(pressed, studio.panes.map(([p]) => (p === id ? 'true' : 'false')),
          `aria-pressed is true on '${id}' alone`);

        for (const [, , paneClass] of studio.panes) {
          assert.ok(byClass(container, paneClass) !== undefined,
            `.${paneClass} stays MOUNTED while '${id}' shows — CSS hides it, the renderer does not`);
        }
      }
    });

    it(`${studio.name} falls back to '${studio.fallback}' on a junk pane value`, function () {
      const { app, container } = mountSite(studio.hash);
      studio.prepare?.(app);
      app.dispatch(studio.action, 'not-a-pane');
      assert.strictEqual(app.getState()[studio.slice][studio.key], 'not-a-pane',
        'state keeps what it was given (the view model, not the action, is the guard)');
      assert.strictEqual(byClass(container, studio.root).getAttribute('data-pane'), studio.fallback,
        'the derivation whitelists it back to the default');
    });
  }
});

describe('the one-pane protocol — the pane follows the gesture', function () {
  it('#/flow: picking a node opens the inspector, running opens the run pane', function () {
    const { app, container } = mountSite('#/flow');
    app.dispatch('flow/load', {
      kind: 'fsm',
      doc: { initial: 'a', states: ['a', 'b'], transitions: [{ from: 'a', event: 'go', to: 'b' }] },
      runContext: null,
      dagInput: '',
    });
    assert.strictEqual(byClass(container, 'flow-grid').getAttribute('data-pane'), 'diagram');

    app.dispatch('flow/pick', { type: 'state', id: 'a', path: '/states/0' });
    assert.strictEqual(app.getState().flow.mobilePane, 'inspector',
      'a plain pick carries the user to the pane that answers it');

    app.dispatch('flow/run');
    assert.strictEqual(app.getState().flow.mobilePane, 'run',
      'booting the machine is a request to watch it run');
  });

  it('#/flow: a connect COMMIT keeps the diagram — the next click has to land there', function () {
    const { app } = mountSite('#/flow');
    app.dispatch('flow/load', {
      kind: 'fsm',
      doc: { initial: 'a', states: ['a', 'b'], transitions: [] },
      runContext: null,
      dagInput: '',
    });
    app.dispatch('flow/pick', { type: 'state', id: 'a', path: '/states/0' });
    app.dispatch('flow/connect-arm');
    app.dispatch('flow/pane', 'diagram');            // the user goes back to draw
    app.dispatch('flow/pick', { type: 'state', id: 'b', path: '/states/1' });
    assert.strictEqual(app.getState().flow.doc.transitions.length, 1, 'the edge committed');
    assert.strictEqual(app.getState().flow.mobilePane, 'diagram',
      'the commit branch does not steal the pane');
  });
});
