//@ts-check
/**
 * @file The Play playground surface (`#/play`) end to end, headless
 * over the stub DOM: the playground chrome renders, the seeded example runs
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

/** A headless site over the stub DOM, entered at the Play playground. */
function mountSite({ hash = '#/play' } = {}) {
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
const playRoot = (c) => find(c, (n) => n.getAttribute?.('class') === 'jplay');
const sourceInput = (c) => find(playRoot(c), (n) => n.tagName === 'input' && n.getAttribute?.('class') === 'editor line');
const byText = (root, tag, text) => find(root, (n) => n.tagName === tag && n.childNodes?.[0]?.nodeValue === text);
/** Concat every text-bearing panel of a result (the old scalar `output`). */
const outText = (r) => r.panels.filter((p) => p.text != null).map((p) => p.text).join('\n');
/** The vnode of the first `view` panel of a result. */
const viewVnode = (r) => r.panels.find((p) => p.kind === 'view')?.vnode;

describe('website — the Play playground (#/play)', () => {
  it('renders the playground and runs the seeded example LIVE on the stage', () => {
    const { app, container } = mountSite();
    const html = serialize(container);
    assert.match(html, /jplay/, 'the playground shell rendered');
    assert.match(html, /jplay-rail/, 'the example rail rendered');
    assert.match(html, /All authors/, 'the seeded example is listed in the rail');
    assert.match(html, /JSONPath/, 'the active engine label shows');

    const r = app.getState().play.result;
    assert.ok(r && r.ok === true, 'the seeded example ran green');
    assert.match(outText(r), /Nigel Rees/, 'the JSONPath selector produced the authors');
    assert.match(html, /Nigel Rees/, 'the result renders on the stage');
    assert.match(html, /compiled/, 'the timing line shows');
  });

  it('editing the source pane re-runs against the same data', () => {
    const { app, container } = mountSite();
    fire(sourceInput(container), 'input', { target: { value: '$..price' } });
    const r = app.getState().play.result;
    assert.ok(r.ok === true, 'the edited selector ran green');
    assert.match(outText(r), /8\.95/, 'every price, anywhere — the new selector took effect');
    assert.match(serialize(container), /8\.95/, 'the re-run renders live');
  });

  it('picking an example (via its rail button) loads its source + data and runs', () => {
    const { app, container } = mountSite();
    // the $mean example proves the registered stats pack is threaded in
    fire(byText(playRoot(container), 'button', 'Aggregate with the registered $mean'), 'click', {});
    const s = app.getState().play;
    assert.strictEqual(s.engine, 'query', 'the engine switched to $query');
    assert.strictEqual(s.exampleId, 'query-mean');
    assert.ok(s.result.ok === true, '$mean is registered — the example runs green, not an error');
    assert.match(serialize(container), /\$query/, 'the query engine chrome shows');
  });

  it('the dataset switcher swaps the data against the same source', () => {
    const { app, container } = mountSite();
    fire(byText(playRoot(container), 'button', 'One selector, three shapes'), 'click', {});
    assert.strictEqual(app.getState().play.exampleId, 'path-shapes');
    // three datasets → a switcher renders; the seeded 'flat' shape has no array
    assert.match(outText(app.getState().play.result), /root|inner/, 'the flat shape ran first');

    // switch to the 'array' shape (index 1): the data changes, the run reflects it
    fire(byText(playRoot(container), 'button', 'array'), 'click', {});
    const s = app.getState().play;
    assert.strictEqual(s.datasetIndex, 1, 'the dataset index moved');
    assert.match(outText(s.result), /Ada|Alan/, 'the SAME selector now runs over the array shape');
  });

  it('a source-only engine (josl) shows an option select, no data pane, and the mode re-runs live', () => {
    const { app, container } = mountSite();
    fire(byText(playRoot(container), 'button', 'First-class citizens'), 'click', {});
    const s = app.getState().play;
    assert.strictEqual(s.engine, 'josl');
    assert.ok(s.result.ok === true, 'josl parses in its default (JOSL) mode');
    const html = serialize(playRoot(container));
    assert.match(html, /jplay-options/, 'the options row rendered');
    assert.match(html, /<select/, 'a mode select is present');
    assert.match(html, /TOML/, 'the TOML dialect is offered');
    // exactly one editor pane — the source; a source-only engine has no data pane
    assert.strictEqual((html.match(/class="jplay-pane"/g) || []).length, 1, 'no data editor');

    // flip the mode select to strict TOML → the JOSL `null` is now rejected
    fire(find(playRoot(container), (n) => n.tagName === 'select'), 'change', { target: { value: 'toml' } });
    assert.strictEqual(app.getState().play.config.mode, 'toml', 'the option config updated');
    assert.strictEqual(app.getState().play.result.ok, false, 'strict TOML rejects the null extension');
  });

  it('a visual engine (mermaid) renders an SVG vnode on the stage via the host renderer', () => {
    const { app, container } = mountSite();
    fire(byText(playRoot(container), 'button', 'Flowchart'), 'click', {});
    const s = app.getState().play;
    assert.strictEqual(s.engine, 'mermaid');
    assert.ok(s.result.ok === true && Array.isArray(viewVnode(s.result)), 'the host renderer produced a vnode');
    const html = serialize(playRoot(container));
    assert.match(html, /jplay-view/, 'the rendered-view container');
    assert.match(html, /<svg/, 'the SVG diagram rendered on the stage');
  });

  it('a visual engine (markdown) renders HTML via the host renderer', () => {
    const { app, container } = mountSite();
    fire(byText(playRoot(container), 'button', 'GFM tour'), 'click', {});
    assert.ok(app.getState().play.result.ok === true);
    assert.match(serialize(playRoot(container)), /Markdown, as JSON/, 'the rendered markdown heading');
  });

  it('a visual engine (charts) renders an SVG via the host chart renderer', () => {
    const { app, container } = mountSite();
    fire(byText(playRoot(container), 'button', 'Heatmap (log)'), 'click', {});
    const s = app.getState().play;
    assert.strictEqual(s.engine, 'charts');
    assert.ok(s.result.ok === true && Array.isArray(viewVnode(s.result)), 'the chart renderer produced a vnode');
    assert.match(serialize(playRoot(container)), /<svg/, 'the chart SVG rendered on the stage');
  });

  it('a broken source lands as an error result — the site never crashes', () => {
    const { app, container } = mountSite();
    fire(sourceInput(container), 'input', { target: { value: '$.[[[bogus' } });
    const r = app.getState().play.result;
    assert.strictEqual(r.ok, false, 'the bad selector produced an error result');
    assert.ok(r.error && typeof r.error.message === 'string' && r.error.message !== '',
      'the error is captured with a human message (never thrown)');
    // the shell still rendered — the error is docked, not thrown
    assert.match(serialize(container), /jplay/, 'the playground is still on screen');
  });

  it('a multi-panel result (CSV) shows a tab strip; switching a tab is a pure view change (no re-run)', () => {
    const { app, container } = mountSite();
    fire(byText(playRoot(container), 'button', 'RFC 4180'), 'click', {});
    const s = app.getState().play;
    assert.strictEqual(s.engine, 'csv');
    assert.ok(s.result.panels.length > 1, 'CSV yields several screens');
    assert.match(serialize(playRoot(container)), /jplay-tabs/, 'the tab strip renders');
    assert.match(serialize(playRoot(container)), /jplay-note/, 'the summary note is active first');

    const before = app.getState().play.result; // the result reference before the tab switch
    fire(byText(playRoot(container), 'button', 'CSV round-trip'), 'click', {});
    const after = app.getState().play;
    assert.strictEqual(after.panel, 'roundtrip', 'the active panel id switched');
    assert.strictEqual(after.result, before, 'the engine did NOT re-run — the result object is untouched');
    assert.match(serialize(playRoot(container)), /code-block/, 'the round-trip code panel now shows');
  });

  it('switching engines clears the active panel (a new engine has different screens)', () => {
    const { app, container } = mountSite();
    fire(byText(playRoot(container), 'button', 'RFC 4180'), 'click', {});        // csv → multi-panel
    fire(byText(playRoot(container), 'button', 'CSV round-trip'), 'click', {});  // pick a non-first tab
    assert.strictEqual(app.getState().play.panel, 'roundtrip');
    fire(byText(playRoot(container), 'button', 'All authors'), 'click', {});     // back to JSONPath (single panel)
    const s = app.getState().play;
    assert.strictEqual(s.engine, 'path');
    assert.strictEqual(s.panel, null, 'the stale tab was cleared on the engine switch');
    assert.doesNotMatch(serialize(playRoot(container)), /jplay-tabs/, 'a single-panel engine shows no tabs');
  });

  it('leaving #/play tears the surface down; the seeded run persists on return', () => {
    const { app, container, go } = mountSite();
    assert.ok(playRoot(container), 'the playground mounted');
    go('#/');
    assert.strictEqual(playRoot(container), undefined, 'leaving #/play unmounts it');
    go('#/play');
    assert.ok(playRoot(container), 'returning re-mounts the playground');
    assert.ok(app.getState().play.result.ok === true, 'the run survived the round-trip');
  });
});
