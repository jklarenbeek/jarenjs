//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { renderToString } from '@jarenjs/view';
import { createSiteApp } from '../../packages/website/src/app/createSiteApp.js';
import { parseHash } from '../../packages/website/src/lib/route.js';
import { createStubHost, fire, serialize } from '../view/dom.stub.js';

/** Fixture benchmark payloads, shaped like website-data.js output. */
const FIXTURES = {
  meta: {
    generated: '2026-07-18T14:15:25.703Z', node: 'v22', cpu: 'Test CPU', platform: 'Test', version: '0.10.0', quick: false,
    qt3: { total: 31821, pass: 1858, unsupportedSyntax: 21191, regressions: 0 },
    conformance: { jsonSchema: { engineStats: {
      jaren: { draft7: { passed: 308, failed: 0, errors: 0 } },
      ajv: { draft7: { passed: 294, failed: 13, errors: 1 } },
    } } },
  },
  jsonpointer: {
    tables: [{
      key: 'absolute', title: 'Absolute JSON Pointer', columns: ['jaren', 'npm'],
      rows: [{ name: 'shallow member', results: [17.23, 53.05] }],
    }],
  },
};

/** A full headless site over the stub DOM with a controllable route. */
function mountSite({ fixtures = FIXTURES, hash = '#/', stored = null, modelContext } = {}) {
  const { document, container } = createStubHost();
  /** @type {any} */
  let routeCb = null;
  const themes = [];
  const hashes = [];
  let storeData = stored;
  const app = createSiteApp({
    node: container,
    document,
    schedule: (f) => f(),
    debounceMs: 0,
    fetchJson: (name) => (name in fixtures
      ? Promise.resolve(fixtures[name])
      : Promise.reject(new Error('404'))),
    applyTheme: (t) => themes.push(t),
    listenHash: (cb) => { routeCb = cb; cb(parseHash(hash)); },
    navigate: (h) => { hashes.push(h); routeCb(parseHash(h)); },
    storage: {
      read: () => storeData,
      write: (data) => { storeData = JSON.parse(JSON.stringify(data)); },
    },
    modelContext,
    onError: (err) => { throw err; },
  });
  const go = (h) => routeCb(parseHash(h));
  return { app, container, go, themes, hashes, storage: () => storeData };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function find(node, pred) {
  if (pred(node)) return node;
  for (const c of node.childNodes ?? []) {
    const hit = find(c, pred);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

describe('website — the site as one app document', function () {
  it('renders the home page through the shell', function () {
    const { container } = mountSite();
    const html = serialize(container);
    assert.match(html, /JSON all the way down/);
    assert.match(html, /One stack, ten engines/);
    assert.match(html, /nav-link active/);
  });

  it('routes by hash: pages are modes, tabs are links', function () {
    const { container, go } = mountSite();
    go('#/docs');
    assert.match(serialize(container), /Installation/);
    go('#/playground');
    assert.match(serialize(container), /Playground/);
    go('#/nonsense');
    assert.match(serialize(container), /JSON all the way down/, 'unknown routes fall back home');
  });

  it('toggles the theme through the apply-theme effect', function () {
    const { app, container, themes } = mountSite();
    const button = find(container, (n) => n.attributes?.get('class') === 'theme-toggle');
    fire(button, 'click');
    assert.deepStrictEqual(themes, ['dark']);
    assert.strictEqual(app.getState().theme, 'dark');
  });

  it('benchmarks: navigating fetches, loads and renders the suite data', async function () {
    const { container, go } = mountSite();
    go('#/benchmarks');
    await tick();
    const html = serialize(container);
    assert.match(html, /Test CPU/);
    assert.match(html, /308 \/ 0 \/ 0/, 'conformance table renders from meta.json');
    assert.match(html, /31821/, 'QT3 scorecard renders');

    go('#/benchmarks?suite=jsonpointer');
    await tick();
    assert.match(serialize(container), /Absolute JSON Pointer/);
    assert.match(serialize(container), /17.2 ns/);
  });

  it('benchmarks: a missing file renders the error callout, not a crash', async function () {
    const { container, go } = mountSite({ fixtures: {} });
    go('#/benchmarks');
    await tick();
    assert.match(serialize(container), /Data unavailable/);
  });

  it('playground: the initial document validates on boot', function () {
    const { app, container } = mountSite({ hash: '#/playground' });
    assert.strictEqual(app.getState().pg.result.valid, true);
    assert.match(serialize(container), /class="badge ok"/);
  });

  it('playground: the generated form renders and writes through form actions', function () {
    const { app, container } = mountSite({ hash: '#/playground' });
    const nameField = find(container, (n) => n.attributes?.get('data-pointer') === '/name');
    assert.notStrictEqual(nameField, undefined, 'standard forms stylesheet rendered the schema');
    const input = find(nameField, (n) => n.tagName === 'input');
    fire(input, 'input', { target: { value: 'Grace' } });
    assert.strictEqual(app.getState().pg.data.name, 'Grace');
    assert.strictEqual(app.getState().pg.result.valid, true, 'revalidated after the form write');
  });

  it('playground: schema edits recompile and errors localize EN/NL', function () {
    const { app, container } = mountSite({ hash: '#/playground' });
    const editor = find(container, (n) =>
      n.tagName === 'textarea' && n.attributes?.get('class') === 'editor');
    fire(editor, 'input', { target: { value: '{ "type": "object", "required": ["missing"] }' } });
    assert.strictEqual(app.getState().pg.result.valid, false);
    let html = serialize(container);
    assert.match(html, /class="badge fail"/);
    assert.match(html, /required/i);

    const nlButton = find(container, (n) =>
      n.tagName === 'button' && n.childNodes?.[0]?.nodeValue === 'NL');
    fire(nlButton, 'click');
    html = serialize(container);
    assert.match(html, /verplicht/, 'Dutch text renders at report time');
  });

  it('playground: invalid schema JSON reports, valid schema recovers', function () {
    const { app, container } = mountSite({ hash: '#/playground' });
    const editor = find(container, (n) =>
      n.tagName === 'textarea' && n.attributes?.get('class') === 'editor');
    fire(editor, 'input', { target: { value: '{ not json' } });
    assert.match(serialize(container), /Invalid JSON/);
    fire(editor, 'input', { target: { value: '{ "type": "object" }' } });
    assert.strictEqual(app.getState().pg.result.valid, true);
  });

  it('SSR: any route renders to an HTML string headless', function () {
    const { app, go } = mountSite();
    go('#/playground');
    const html = renderToString(app.getVnode());
    assert.match(html, /<h1>Playground<\/h1>/);
    assert.match(html, /class="jaren-form/);
  });

  it('deep-dive suites render from the real generated data', async function () {
    const { readFileSync } = await import('node:fs');
    const load = (name) => JSON.parse(readFileSync(
      new URL(`../../packages/website/public/benchmarks/${name}.json`, import.meta.url), 'utf8'));
    const fixtures = {
      meta: load('meta'), validate: load('validate'), jsonpath: load('jsonpath'),
      jsonquery: load('jsonquery'), jslt: load('jslt'),
    };
    const { container, go } = mountSite({ fixtures });

    go('#/benchmarks?suite=validate');
    await tick();
    let html = serialize(container);
    assert.match(html, /Ratio distribution/);
    assert.match(html, /Per-test results/);

    // the search box narrows the table
    const searchBox = find(container, (n) => n.attributes?.get('class') === 'search-input');
    fire(searchBox, 'input', { target: { value: 'unevaluated' } });
    html = serialize(container);
    assert.match(html, /unevaluated/i);
    assert.doesNotMatch(html, /of 1090 shown/, 'filtered below the full success set');

    go('#/benchmarks?suite=jsonquery');
    await tick();
    html = serialize(container);
    assert.match(html, /Scenario matrix/);
    assert.match(html, /the query documents/, 'program sources are unfoldable');

    go('#/benchmarks?suite=jsonpath');
    await tick();
    assert.match(serialize(container), /Compliance by group/);
  });

  it('parseHash covers the route grammar', function () {
    assert.deepStrictEqual(parseHash('#/'), { page: 'home', params: {} });
    assert.deepStrictEqual(parseHash(''), { page: 'home', params: {} });
    assert.deepStrictEqual(
      parseHash('#/benchmarks?suite=validate'),
      { page: 'benchmarks', params: { suite: 'validate' } });
    assert.deepStrictEqual(parseHash('#/bogus'), { page: 'home', params: {} });
  });
});
