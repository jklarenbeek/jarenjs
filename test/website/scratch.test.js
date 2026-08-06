//@ts-check
/**
 * @file The Scratch playground surface (`#/scratch`) end to end, headless
 * over the stub DOM: the scratchpad chrome renders, the seeded example runs
 * LIVE on the stage, editing a source pane re-runs, picking an example loads
 * its source + data, the dataset switcher swaps the data against the SAME
 * source, and a broken edit lands as an error result — never a site crash.
 * The registered operator packs are threaded through the boundary, so the
 * `$mean` example runs green here too.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createSiteApp } from '../../packages/website/src/app/createSiteApp.js';
import { parseHash } from '../../packages/website/src/lib/route.js';
import { createStubHost, fire, serialize } from '../view/dom.stub.js';

/** A headless site over the stub DOM, entered at the Scratch playground. */
function mountSite({ hash = '#/scratch' } = {}) {
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
  return { app, container, document, go: (h) => routeCb(parseHash(h)) };
}

function find(node, pred) {
  if (pred(node)) return node;
  for (const c of node.childNodes ?? []) {
    const hit = find(c, pred);
    if (hit !== undefined) return hit;
  }
  return undefined;
}
const scratchRoot = (c) => find(c, (n) => n.getAttribute?.('class') === 'jscratch');
const sourceInput = (c) => find(scratchRoot(c), (n) => n.tagName === 'input' && n.getAttribute?.('class') === 'editor line');
const byText = (root, tag, text) => find(root, (n) => n.tagName === tag && n.childNodes?.[0]?.nodeValue === text);

describe('website — the Scratch playground (#/scratch)', () => {
  it('renders the scratchpad and runs the seeded example LIVE on the stage', () => {
    const { app, container } = mountSite();
    const html = serialize(container);
    assert.match(html, /jscratch/, 'the scratchpad shell rendered');
    assert.match(html, /jscratch-rail/, 'the example rail rendered');
    assert.match(html, /All authors/, 'the seeded example is listed in the rail');
    assert.match(html, /JSONPath/, 'the active engine label shows');

    const r = app.getState().scratch.result;
    assert.ok(r && r.ok === true, 'the seeded example ran green');
    assert.match(r.output, /Nigel Rees/, 'the JSONPath selector produced the authors');
    assert.match(html, /Nigel Rees/, 'the result renders on the stage');
    assert.match(html, /compiled/, 'the timing line shows');
  });

  it('editing the source pane re-runs against the same data', () => {
    const { app, container } = mountSite();
    fire(sourceInput(container), 'input', { target: { value: '$..price' } });
    const r = app.getState().scratch.result;
    assert.ok(r.ok === true, 'the edited selector ran green');
    assert.match(r.output, /8\.95/, 'every price, anywhere — the new selector took effect');
    assert.match(serialize(container), /8\.95/, 'the re-run renders live');
  });

  it('picking an example (via its rail button) loads its source + data and runs', () => {
    const { app, container } = mountSite();
    // the $mean example proves the registered stats pack is threaded in
    fire(byText(scratchRoot(container), 'button', 'Aggregate with the registered $mean'), 'click', {});
    const s = app.getState().scratch;
    assert.strictEqual(s.engine, 'query', 'the engine switched to $query');
    assert.strictEqual(s.exampleId, 'query-mean');
    assert.ok(s.result.ok === true, '$mean is registered — the example runs green, not an error');
    assert.match(serialize(container), /\$query/, 'the query engine chrome shows');
  });

  it('the dataset switcher swaps the data against the same source', () => {
    const { app, container } = mountSite();
    fire(byText(scratchRoot(container), 'button', 'One selector, three shapes'), 'click', {});
    assert.strictEqual(app.getState().scratch.exampleId, 'path-shapes');
    // three datasets → a switcher renders; the seeded 'flat' shape has no array
    assert.match(app.getState().scratch.result.output, /root|inner/, 'the flat shape ran first');

    // switch to the 'array' shape (index 1): the data changes, the run reflects it
    fire(byText(scratchRoot(container), 'button', 'array'), 'click', {});
    const s = app.getState().scratch;
    assert.strictEqual(s.datasetIndex, 1, 'the dataset index moved');
    assert.match(s.result.output, /Ada|Alan/, 'the SAME selector now runs over the array shape');
  });

  it('a broken source lands as an error result — the site never crashes', () => {
    const { app, container } = mountSite();
    fire(sourceInput(container), 'input', { target: { value: '$.[[[bogus' } });
    const r = app.getState().scratch.result;
    assert.strictEqual(r.ok, false, 'the bad selector produced an error result');
    assert.ok(r.error && typeof r.error.message === 'string' && r.error.message !== '',
      'the error is captured with a human message (never thrown)');
    // the shell still rendered — the error is docked, not thrown
    assert.match(serialize(container), /jscratch/, 'the scratchpad is still on screen');
  });

  it('leaving #/scratch tears the surface down; the seeded run persists on return', () => {
    const { app, container, go } = mountSite();
    assert.ok(scratchRoot(container), 'the scratchpad mounted');
    go('#/');
    assert.strictEqual(scratchRoot(container), undefined, 'leaving #/scratch unmounts it');
    go('#/scratch');
    assert.ok(scratchRoot(container), 'returning re-mounts the scratchpad');
    assert.ok(app.getState().scratch.result.ok === true, 'the run survived the round-trip');
  });
});
