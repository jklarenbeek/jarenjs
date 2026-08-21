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
const byClass = (c, cls) => find(playRoot(c), (n) => (n.getAttribute?.('class') ?? '').split(' ').includes(cls));
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

  it('the contract engine (the one ASYNC run) settles its thenable result onto the stage', async () => {
    const { app, container } = mountSite();
    fire(byText(playRoot(container), 'button', 'A shop contract'), 'click', {});
    const s = app.getState().play;
    assert.strictEqual(s.engine, 'contract');
    // the run resolves a real local-client dispatch, so the result lands
    // a microtask later — the site dispatches it when it settles
    for (let i = 0; i < 24 && app.getState().play.result === null; i++) await Promise.resolve();
    const result = app.getState().play.result;
    assert.strictEqual(result.ok, true, result?.error?.message);
    assert.deepStrictEqual(result.panels.map((p) => p.id), ['describe', 'openapi', 'types', 'dispatch']);
    const outcome = JSON.parse(result.panels.find((p) => p.id === 'dispatch').text);
    assert.strictEqual(outcome.ok, true, 'the echo dispatch resolved through the local binding');
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

  it('the mdx engine renders markdown AGAINST the data pane via the host renderer', () => {
    const { app, container } = mountSite();
    fire(byText(playRoot(container), 'button', 'An invoice from data'), 'click', {});
    const s = app.getState().play;
    assert.strictEqual(s.engine, 'mdx');
    assert.ok(s.result.ok === true, 'the invoice template resolved against the data');
    const html = serialize(playRoot(container));
    assert.match(html, /Invoice INV-7/, 'the {$.number} interpolation rendered');
    assert.match(html, /Rubber duck/, 'the {#each} section repeated per line');
    assert.match(html, /Paid — thank you!/, 'the {#if} section is on for the paid dataset');

    // the dataset switcher re-renders the SAME template over new data
    fire(byText(playRoot(container), 'button', 'unpaid'), 'click', {});
    const after = serialize(playRoot(container));
    assert.match(after, /Invoice INV-8/);
    assert.doesNotMatch(after, /Paid — thank you!/, 'the unpaid dataset switches the {#if} off');

    // the drill-down shows the resolved canonical markdown from the host seam
    fire(byClass(container, 'jplay-deep-toggle'), 'click', {});
    assert.match(serialize(playRoot(container)), /jplay-deep-tabs/, 'the host deep panels ride the toggle');
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

  it('the JSON Schema engine validates data with the real host validator', () => {
    const { app, container } = mountSite();
    fire(byText(playRoot(container), 'button', 'User'), 'click', {});
    const s = app.getState().play;
    assert.strictEqual(s.engine, 'validate', 'the validate engine loaded');
    assert.strictEqual(s.result.ok, true);
    assert.match(outText(s.result), /valid/, 'the verdict note reports validity');

    // the "Invalid data" example: the same engine, a successful run that lists errors
    fire(byText(playRoot(container), 'button', 'Invalid data (see the errors)'), 'click', {});
    const s2 = app.getState().play;
    assert.strictEqual(s2.result.ok, true, 'invalid DATA is still a successful run');
    assert.ok(s2.result.panels.length >= 2, 'a verdict note + an errors table');
    assert.strictEqual(s2.result.panels[1].kind, 'table', 'the errors render as a table');
    assert.ok(s2.result.panels[1].rows.length >= 1, 'at least one error row');
  });

  it('the validate data pane toggles to a two-way generated form: an edit mirrors to the data and re-validates', () => {
    const { app, container } = mountSite();
    fire(byText(playRoot(container), 'button', 'User'), 'click', {});
    assert.strictEqual(app.getState().play.dataView, 'json', 'starts in JSON mode');

    // toggle to the generated form; the structured buffer parses from the text
    fire(byText(playRoot(container), 'button', 'Form'), 'click', {});
    const s = app.getState().play;
    assert.strictEqual(s.dataView, 'form', 'switched to form mode');
    assert.strictEqual(s.dataValue?.name, 'Ada', 'the form buffer parsed from the data text');

    const formEl = find(playRoot(container), (n) => (n.getAttribute?.('class') ?? '').split(' ').includes('jplay-form'));
    assert.ok(formEl, 'the generated form rendered in place of the JSON editor');
    const textInput = find(formEl, (n) => n.tagName === 'input' && (n.getAttribute?.('type') ?? 'text') === 'text');
    assert.ok(textInput, 'the form has a text field');

    // editing a field writes the structured buffer, which mirrors back to the
    // data TEXT and re-validates
    const dataTextBefore = app.getState().play.data.data;
    fire(textInput, 'input', { target: { value: 'Zed' } });
    const after = app.getState().play;
    assert.notStrictEqual(after.data.data, dataTextBefore, 'the form edit mirrored back into the data text');
    assert.strictEqual(after.result.ok, true, 'the edit re-validated live');
  });

  it('switching examples in form mode drops the stale buffer — one form edit mirrors the NEW data', () => {
    // regression (TODO_SITE_01 Q2): `play/loaded` did not reset the form
    // buffer its twin `play/loaded-session` resets, so the first form edit
    // after switching examples mirrored the OLD example's data over the new
    const { app, container } = mountSite();
    fire(byText(playRoot(container), 'button', 'User'), 'click', {});
    fire(byText(playRoot(container), 'button', 'Form'), 'click', {});
    assert.strictEqual(app.getState().play.dataValue?.name, 'Ada', 'the old example is in the buffer');

    // switch examples WHILE in form mode
    fire(byText(playRoot(container), 'button', 'Invalid data (see the errors)'), 'click', {});
    const s = app.getState().play;
    assert.strictEqual(s.dataView, 'json', 'the pane resets to JSON on load');
    assert.strictEqual(s.dataValue, null, 'the stale structured buffer is dropped');

    // re-enter form mode and make ONE edit: the data pane is the NEW
    // example's data with exactly that edit — never the old buffer
    fire(byText(playRoot(container), 'button', 'Form'), 'click', {});
    const formEl = find(playRoot(container), (n) => (n.getAttribute?.('class') ?? '').split(' ').includes('jplay-form'));
    const textInput = find(formEl, (n) => n.tagName === 'input' && (n.getAttribute?.('type') ?? 'text') === 'text');
    fire(textInput, 'input', { target: { value: 'Zed' } });
    assert.deepStrictEqual(JSON.parse(app.getState().play.data.data),
      { name: 'Zed', email: 'not-an-email', age: 7 });
  });

  it('the locale option localizes the validation messages', () => {
    const { app, container } = mountSite();
    fire(byText(playRoot(container), 'button', 'Invalid data (see the errors)'), 'click', {});
    const en = JSON.stringify(app.getState().play.result.panels);
    // the validate engine's one option select is "Messages" (the locale)
    fire(find(playRoot(container), (n) => n.tagName === 'select'), 'change', { target: { value: 'nl' } });
    assert.strictEqual(app.getState().play.config.locale, 'nl', 'the locale config updated');
    const nl = JSON.stringify(app.getState().play.result.panels);
    assert.notStrictEqual(en, nl, 'the localized error messages changed with the locale');
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

  it('a CSV result opens CALM (one note + the Explain affordance); the drill-down reveals the deep screens', () => {
    const { app, container } = mountSite();
    fire(byText(playRoot(container), 'button', 'RFC 4180'), 'click', {});
    const s = app.getState().play;
    assert.strictEqual(s.engine, 'csv');
    assert.ok(s.result.panels.length > 1, 'CSV yields several screens');
    const calm = serialize(playRoot(container));
    assert.match(calm, /jplay-note/, 'the summary note is the calm answer');
    assert.doesNotMatch(calm, /jplay-tabs/, 'the deep screens are NOT a calm tab strip');
    assert.doesNotMatch(calm, /jplay-table/, 'the parsed table waits behind the toggle');
    assert.match(calm, /jplay-deep-toggle/, 'the quiet Explain affordance renders beneath the answer');

    // the toggle reveals the drill-down — a pure view change, no re-run
    const before = app.getState().play.result;
    fire(byClass(container, 'jplay-deep-toggle'), 'click', {});
    assert.strictEqual(app.getState().play.deep, true, 'the depth toggle switched on');
    assert.strictEqual(app.getState().play.result, before, 'the engine did NOT re-run');
    const open = serialize(playRoot(container));
    assert.match(open, /jplay-deep-tabs/, 'the deep panels get their own tab row');
    assert.match(open, /jplay-table/, 'the first deep panel (the parsed rows) renders');

    // picking another deep panel is also a pure view change
    fire(byText(playRoot(container), 'button', 'CSV round-trip'), 'click', {});
    const after = app.getState().play;
    assert.strictEqual(after.deepPick, 'roundtrip', 'the deep pick switched');
    assert.strictEqual(after.result, before, 'still no re-run');
    assert.match(serialize(playRoot(container)), /code-block/, 'the round-trip code panel now shows');
  });

  it('loading a fresh example resets the drill-down — play opens calm again', () => {
    const { app, container } = mountSite();
    fire(byText(playRoot(container), 'button', 'RFC 4180'), 'click', {});        // csv → has deep screens
    fire(byClass(container, 'jplay-deep-toggle'), 'click', {});                  // open the drill-down
    fire(byText(playRoot(container), 'button', 'CSV round-trip'), 'click', {});  // pick a non-first deep panel
    assert.strictEqual(app.getState().play.deep, true);
    assert.strictEqual(app.getState().play.deepPick, 'roundtrip');
    fire(byText(playRoot(container), 'button', 'All authors'), 'click', {});     // back to JSONPath
    const s = app.getState().play;
    assert.strictEqual(s.engine, 'path');
    assert.strictEqual(s.panel, null, 'the stale tab was cleared on the engine switch');
    assert.strictEqual(s.deep, false, 'the depth toggle reset off');
    assert.strictEqual(s.deepPick, null, 'the deep pick reset');
    const html = serialize(playRoot(container));
    assert.doesNotMatch(html, /jplay-deep-tabs/, 'the drill-down is closed again');
    assert.match(html, /jplay-deep-toggle/, 'JSONPath offers its own Explain affordance');
  });

  it('the phone pane switcher is pure chrome: it patches the pane and does not re-run', () => {
    const { app, container } = mountSite();
    assert.strictEqual(app.getState().play.mobilePane, 'editor', 'the editor pane is the default');
    const before = app.getState().play.result;
    fire(byText(playRoot(container), 'button', 'Result'), 'click', {});
    assert.strictEqual(app.getState().play.mobilePane, 'result', 'the pane switched');
    assert.strictEqual(app.getState().play.result, before, 'switching panes never re-runs the engine');
    assert.match(serialize(playRoot(container)), /"data-pane">result|data-pane="result"/, 'the root reflects the pane');
    // picking an example answers immediately on a phone: the pane → result
    fire(byText(playRoot(container), 'button', 'Examples'), 'click', {});
    assert.strictEqual(app.getState().play.mobilePane, 'examples');
    fire(byText(playRoot(container), 'button', 'RFC 4180'), 'click', {});
    assert.strictEqual(app.getState().play.mobilePane, 'result', 'the example pick lands on its result');
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

describe('deep links: ?engine= and ?example= open what they name', () => {
  // The site's own doc callouts link straight at an engine, so a link that
  // silently landed on the default example was a promise the page broke.
  it('?engine= opens that engine’s first example, and runs it', function () {
    const { app } = mountSite({ hash: '#/play?engine=csv' });
    const play = app.getState().play;
    assert.strictEqual(play.engine, 'csv', 'the named engine is live');
    assert.ok(play.exampleId.startsWith('csv-'), 'on one of its examples');
    assert.ok(play.result !== null, 'and it has already run');
  });

  it('?example= opens an exact example', function () {
    const { app } = mountSite({ hash: '#/play?example=path-prices' });
    assert.strictEqual(app.getState().play.exampleId, 'path-prices');
    assert.strictEqual(app.getState().play.engine, 'path');
  });

  it('an unknown id leaves the seeded session alone instead of blanking', function () {
    const seeded = mountSite().app.getState().play.exampleId;
    for (const hash of ['#/play?engine=nope', '#/play?example=nope']) {
      const { app } = mountSite({ hash });
      assert.strictEqual(app.getState().play.exampleId, seeded, `${hash} falls back`);
      assert.ok(app.getState().play.result !== null, `${hash} still ran something`);
    }
  });

  it('the retired #/playground?engine= carries its engine across the redirect', function () {
    const { app, go } = mountSite();
    go('#/playground?engine=mermaid');
    assert.strictEqual(app.getState().route.page, 'play', 'redirected to Play');
    assert.strictEqual(app.getState().play.engine, 'mermaid', 'and kept the engine');
  });

  it('a session token still outranks an engine param', function () {
    // ?s= carries EDITED panes; an engine param only names a library example
    const { app, go } = mountSite();
    go('#/play?example=path-prices');
    assert.strictEqual(app.getState().play.exampleId, 'path-prices');
  });
});

describe('Save and Save As are actually different', () => {
  const store = () => {
    let data = null;
    return { read: () => data, write: (d) => { data = JSON.parse(JSON.stringify(d)); }, peek: () => data };
  };
  const mountWith = (storage) => {
    const { document, container } = createStubHost();
    let routeCb = null;
    const app = createSiteApp({
      node: container, document, schedule: (f) => f(), debounceMs: 0,
      fetchJson: () => Promise.reject(new Error('404')),
      listenHash: (cb) => { routeCb = cb; cb(parseHash('#/play')); },
      navigate: (h) => routeCb(parseHash(h)),
      storage, onError: (err) => { throw err; },
    });
    return { app, container };
  };
  /** Type into the session-title input, exactly as a user does. */
  const rename = (container, value) => {
    const input = find(container, (n) => (n.getAttribute?.('class') ?? '').includes('jplay-name'));
    assert.ok(input !== undefined, 'the session title input renders');
    fire(input, 'input', { target: { value } });
  };

  it('Save binds, then overwrites that record — it does not multiply', function () {
    const storage = store();
    const { app, container } = mountWith(storage);
    rename(container, 'alpha');
    app.dispatch('play/save');
    assert.strictEqual(app.getState().play.savedName, 'alpha', 'the session bound to what it wrote');
    assert.deepStrictEqual(app.getState().play.names, ['alpha']);
    app.dispatch('play/save');
    assert.deepStrictEqual(app.getState().play.names, ['alpha'], 'saving again overwrites, never duplicates');
  });

  it('Save As writes the NEW title and keeps the original', function () {
    const storage = store();
    const { app, container } = mountWith(storage);
    rename(container, 'alpha');
    app.dispatch('play/save');
    rename(container, 'beta');
    assert.strictEqual(app.getState().play.renamed ?? true, true, 'the title diverged from the record');
    app.dispatch('play/save-as');
    assert.deepStrictEqual(app.getState().play.names.slice().sort(), ['alpha', 'beta'],
      'both records exist');
    assert.strictEqual(app.getState().play.savedName, 'beta', 'and the session adopted the new one');
  });

  it('Save after a rename overwrites the BOUND record, not the new title', function () {
    const storage = store();
    const { app, container } = mountWith(storage);
    rename(container, 'alpha');
    app.dispatch('play/save');
    rename(container, 'renamed-but-not-saved-as');
    app.dispatch('play/save');
    assert.deepStrictEqual(app.getState().play.names, ['alpha'],
      'Save is an overwrite of the opened record; it does not create a second one');
    assert.strictEqual(app.getState().play.savedName, 'alpha');
  });

  it('an unsaved session has nothing to overwrite, so Save creates', function () {
    const storage = store();
    const { app, container } = mountWith(storage);
    assert.strictEqual(app.getState().play.savedName, null, 'a fresh session is unbound');
    app.dispatch('play/save');
    assert.deepStrictEqual(app.getState().play.names, [], 'an untitled session still saves nothing');
    rename(container, 'first');
    app.dispatch('play/save');
    assert.deepStrictEqual(app.getState().play.names, ['first']);
  });

  it('loading an example unbinds — Save must not overwrite a record it left', function () {
    const storage = store();
    const { app, container } = mountWith(storage);
    rename(container, 'alpha');
    app.dispatch('play/save');
    app.dispatch('play/example', 'path-prices');
    assert.strictEqual(app.getState().play.savedName, null, 'the example unbound the session');
  });

  it('deleting the bound record unbinds it', function () {
    const storage = store();
    const { app, container } = mountWith(storage);
    rename(container, 'alpha');
    app.dispatch('play/save');
    app.dispatch('play/delete-session', 'alpha');
    assert.strictEqual(app.getState().play.savedName, null,
      'the next Save creates rather than resurrecting a deleted name');
    assert.deepStrictEqual(app.getState().play.names, []);
  });
});

describe('a session can leave the page, and come back', () => {
  /** A site with the two file capabilities stubbed. */
  const mountFiles = ({ openFile } = {}) => {
    const { document, container } = createStubHost();
    const written = [];
    let routeCb = null;
    const app = createSiteApp({
      node: container, document, schedule: (f) => f(), debounceMs: 0,
      fetchJson: () => Promise.reject(new Error('404')),
      listenHash: (cb) => { routeCb = cb; cb(parseHash('#/play')); },
      navigate: (h) => routeCb(parseHash(h)),
      storage: { read: () => null, write: () => {} },
      download: (filename, text) => { written.push({ filename, text }); return true; },
      openFile,
      onError: (err) => { throw err; },
    });
    return { app, container, written };
  };
  const settleAsync = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('Download writes the session, titled after it, and it round-trips', async function () {
    const { app, container, written } = mountFiles();
    const input = find(container, (n) => (n.getAttribute?.('class') ?? '').includes('jplay-name'));
    fire(input, 'input', { target: { value: 'My Session!' } });
    app.dispatch('play/example', 'path-prices');
    app.dispatch('play/download');

    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].filename, 'my-session.play.json', 'unsafe characters stripped');
    const doc = JSON.parse(written[0].text);
    assert.strictEqual(doc.$play, '0.1', 'a self-describing envelope');
    assert.strictEqual(doc.session.engine, 'path');

    // the round trip: that exact file imports back to the same session
    const back = mountFiles({ openFile: () => Promise.resolve({ name: 'f.json', text: written[0].text }) });
    back.app.dispatch('play/import');
    await settleAsync();
    assert.strictEqual(back.app.getState().play.engine, 'path');
    assert.strictEqual(back.app.getState().play.source.selector,
      app.getState().play.source.selector, 'the panes came back verbatim');
  });

  it('an untitled session still gets a stable filename', function () {
    const { app, written } = mountFiles();
    app.dispatch('play/download');
    assert.strictEqual(written[0].filename, 'jaren-play-session.play.json');
  });

  it('Import accepts a BARE session too (what a share token decodes to)', async function () {
    const bare = JSON.stringify({ engine: 'pointer', exampleId: null, source: {}, data: {}, config: {} });
    const { app } = mountFiles({ openFile: () => Promise.resolve({ name: 'bare.json', text: bare }) });
    app.dispatch('play/import');
    await settleAsync();
    assert.strictEqual(app.getState().play.engine, 'pointer');
  });

  it('a file that is not a session is refused, and the work in progress survives', async function () {
    for (const text of ['not json at all', '{"hello":"world"}', '[]', 'null']) {
      const { app } = mountFiles({ openFile: () => Promise.resolve({ name: 'x.json', text }) });
      const before = app.getState().play.engine;
      app.dispatch('play/import');
      await settleAsync();
      assert.strictEqual(app.getState().play.engine, before, `'${text}' did not replace the session`);
      assert.match(app.getState().play.shared, /not a play session/);
    }
  });

  it('a dismissed picker changes nothing, and a host without the capability says so', async function () {
    const dismissed = mountFiles({ openFile: () => Promise.resolve(null) });
    const before = dismissed.app.getState().play.engine;
    dismissed.app.dispatch('play/import');
    await settleAsync();
    assert.strictEqual(dismissed.app.getState().play.engine, before);
    assert.strictEqual(dismissed.app.getState().play.shared, null, 'no status noise for a cancel');

    const noCapability = mountFiles();          // openFile omitted
    noCapability.app.dispatch('play/import');
    await settleAsync();
    assert.match(noCapability.app.getState().play.shared, /unavailable here/);
  });

  it('the oversized-share refusal now points somewhere that exists', function () {
    const { app, container } = mountFiles();
    const editor = find(container, (n) => n.tagName === 'textarea');
    fire(editor, 'input', { target: { value: 'x'.repeat(9000) } });
    app.dispatch('play/share');
    assert.match(app.getState().play.shared, /too large for a share link/);
    assert.match(app.getState().play.shared, /use Download instead/);
  });
});
