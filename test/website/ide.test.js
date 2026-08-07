//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createSiteApp } from '../../packages/website/src/app/createSiteApp.js';
import { parseHash } from '../../packages/website/src/lib/route.js';
import { createStubHost, fire, serialize } from '../view/dom.stub.js';

function mountSite({ hash = '#/playground', stored = null, modelContext, share } = {}) {
  const { document, container } = createStubHost();
  /** @type {any} */
  let routeCb = null;
  const hashes = [];
  let storeData = stored;
  const app = createSiteApp({
    node: container,
    document,
    schedule: (f) => f(),
    debounceMs: 0,
    fetchJson: () => Promise.reject(new Error('404')),
    listenHash: (cb) => { routeCb = cb; cb(parseHash(hash)); },
    navigate: (h) => { hashes.push(h); routeCb(parseHash(h)); },
    storage: {
      read: () => storeData,
      write: (data) => { storeData = JSON.parse(JSON.stringify(data)); },
    },
    modelContext,
    share,
    onError: (err) => { throw err; },
  });
  return { app, container, go: (h) => routeCb(parseHash(h)), hashes, storage: () => storeData };
}

function find(node, pred) {
  if (pred(node)) return node;
  for (const c of node.childNodes ?? []) {
    const hit = find(c, pred);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

describe('website — the generic engine playgrounds', function () {
  it('renders every engine tab live from its descriptor', function () {
    const { container, go } = mountSite();
    for (const engine of ['path', 'pointer', 'patch', 'query', 'jslt', 'jtlt', 'xquery', 'josl', 'csv', 'markdown']) {
      go(`#/playground?engine=${engine}`);
      const html = serialize(container);
      assert.match(html, /pg-grid two/, `${engine}: input/result grid renders`);
      assert.doesNotMatch(html, /Not yet ported/, `${engine}: no placeholder`);
    }
  });

  it('path engine: editing the selector re-runs and shows values', function () {
    const { app, container, go } = mountSite();
    go('#/playground?engine=path');
    assert.match(serialize(container), /Normalized paths/, 'auto-ran on route entry');
    const selector = find(container, (n) =>
      n.tagName === 'input' && n.attributes?.get('class') === 'editor line');
    fire(selector, 'input', { target: { value: '$.store.book[0].title' } });
    assert.match(serialize(container), /Sayings of the Century/);
    assert.strictEqual(app.getState().eng.path.selector, '$.store.book[0].title');
  });

  it('query engine: compile errors surface with code and docPath', function () {
    const { container, go } = mountSite();
    go('#/playground?engine=query');
    const editor = find(container, (n) => n.tagName === 'textarea');
    fire(editor, 'input', { target: { value: '{ "$bogus": [1] }' } });
    const html = serialize(container);
    assert.match(html, /error-card/);
    assert.match(html, /JQ0/, 'stable error code shown');
  });

  it('patch engine: the changes feed renders alongside the result', function () {
    const { container, go } = mountSite();
    go('#/playground?engine=patch');
    const html = serialize(container);
    assert.match(html, /Changed paths/);
    assert.match(html, /invalidation-sound pointers/);
  });

  it('select fields switch dependent inputs (patch modes)', function () {
    const { container, go } = mountSite();
    go('#/playground?engine=patch');
    const select = find(container, (n) => n.tagName === 'select');
    fire(select, 'change', { target: { value: 'diff' } });
    assert.match(serialize(container), /Target document/, 'diff-mode field appeared');
  });

  it('markdown engine: live preview through the @jarenjs/md component', function () {
    const { app, container, go } = mountSite();
    go('#/playground?engine=markdown');
    const html = serialize(container);
    assert.match(html, /article class="md"/, 'the component article rendered');
    assert.match(html, /Markdown, as JSON/, 'the first example parsed');
    assert.match(html, /tok-kw/, 'the highlight plugin emitted token spans');
    assert.match(html, /Canonical Markdown/, 'the round-trip card rendered');
    const editor = find(container, (n) => n.tagName === 'textarea');
    fire(editor, 'input', { target: { value: '# Live *edit*\n\n- re-parsed\n' } });
    const edited = serialize(container);
    assert.match(edited, /Live /, 'the preview re-rendered from the edit');
    assert.match(edited, /<em>edit<\/em>/, 'inline emphasis rendered');
    assert.strictEqual(app.getState().eng.markdown.source, '# Live *edit*\n\n- re-parsed\n');
  });

  it('csv engine: the damaged example is read and every fix reported', function () {
    const { container, go } = mountSite();
    go('#/playground?engine=csv');
    const chips = [];
    find(container, (n) => {
      if (n.attributes?.get('class') === 'chip') chips.push(n);
      return false;
    });
    // the second CSV example is deliberately broken; strict mode throws on
    // it, so loading it proves repair mode reads it AND names the damage
    fire(chips[1], 'click');
    const html = serialize(container);
    assert.match(html, /Repairs/, 'the repair table renders');
    assert.match(html, /CSV100\d/, 'each fix carries its diagnosis code');
  });

  it('example chips load complete input sets', function () {
    const { app, container, go } = mountSite();
    go('#/playground?engine=josl');
    const chips = [];
    find(container, (n) => {
      if (n.attributes?.get('class') === 'chip') chips.push(n);
      return false;
    });
    fire(chips[chips.length - 1], 'click');
    assert.notStrictEqual(app.getState().eng.josl.text, '', 'inputs replaced');
    // the last JOSL example intentionally demonstrates a repairable
    // error — either card proves the engine re-ran on load
    assert.match(serialize(container), /code-card|error-card/, 're-ran with the loaded example');
  });
});

describe('website — the experiment IDE', function () {
  it('saves, persists, lists, loads and deletes experiments', function () {
    const { app, container, go, storage, hashes } = mountSite();
    go('#/playground?engine=path');
    const selector = find(container, (n) =>
      n.tagName === 'input' && n.attributes?.get('class') === 'editor line');
    fire(selector, 'input', { target: { value: '$..price' } });

    const nameInput = find(container, (n) => n.attributes?.get('class') === 'ide-name');
    fire(nameInput, 'input', { target: { value: 'all prices' } });
    fire(find(container, (n) => n.attributes?.get('class') === 'btn small'), 'click');

    assert.deepStrictEqual(app.getState().ide.names, ['all prices']);
    assert.strictEqual(storage().experiments['all prices'].engine, 'path');
    assert.strictEqual(storage().experiments['all prices'].inputs.selector, '$..price');

    // navigate away, change the input, then recall the experiment
    go('#/playground?engine=path');
    fire(selector, 'input', { target: { value: '$' } });
    fire(find(container, (n) => n.attributes?.get('class') === 'ide-load'), 'click');
    assert.strictEqual(app.getState().eng.path.selector, '$..price', 'experiment restored');
    assert.match(hashes.at(-1), /engine=path/, 'navigated to the saved engine');

    fire(find(container, (n) => n.attributes?.get('class') === 'ide-delete'), 'click');
    assert.deepStrictEqual(app.getState().ide.names, []);
    assert.deepStrictEqual(storage().experiments, {});
  });

  it('boots with previously saved experiments listed', function () {
    const stored = {
      experiments: {
        demo: { engine: 'validate', inputs: { schemaText: '{"type":"object"}', data: {} }, savedAt: 'x' },
      },
    };
    const { app, container } = mountSite({ stored });
    assert.deepStrictEqual(app.getState().ide.names, ['demo']);
    fire(find(container, (n) => n.attributes?.get('class') === 'ide-load'), 'click');
    assert.strictEqual(app.getState().pg.schemaText, '{"type":"object"}');
  });
});

describe('website — share links', function () {
  it('round-trips an engine experiment through a share URL', async function () {
    const { encodeShare, decodeShare } = await import('@jarenjs/app');
    // outbound: the Share button builds a token of the current engine state
    const sharedHashes = [];
    const site1 = mountSite({ share: (h) => { sharedHashes.push(h); return 'https://x/' + h; } });
    site1.go('#/playground?engine=path');
    const sel1 = find(site1.container, (n) =>
      n.tagName === 'input' && n.attributes?.get('class') === 'editor line');
    fire(sel1, 'input', { target: { value: '$..price' } });
    fire(find(site1.container, (n) => n.attributes?.get('title')?.startsWith('Copy a link')), 'click');
    assert.strictEqual(sharedHashes.length, 1);
    const token = new URLSearchParams(sharedHashes[0].split('?')[1]).get('s');
    assert.strictEqual(decodeShare(token).e, 'path');
    assert.match(serialize(site1.container), /link copied/);

    // inbound: opening that URL restores the experiment
    const site2 = mountSite({ hash: `#/playground?engine=path&s=${token}` });
    assert.strictEqual(site2.app.getState().eng.path.selector, '$..price',
      'the shared snapshot loaded on entry');

    // corrupt tokens are ignored, unicode survives
    const site3 = mountSite({ hash: '#/playground?engine=path&s=%%%bogus' });
    assert.notStrictEqual(site3.app.getState().eng.path.selector, '$..price');
    assert.deepStrictEqual(decodeShare(encodeShare({ e: 'josl', i: { text: 'naïve = "日本語"' } })),
      { e: 'josl', i: { text: 'naïve = "日本語"' } });
  });
});

describe('website — docs, examples, menu', function () {
  it('docs render sections from the content document, deep-linkable', function () {
    const { container, go } = mountSite();
    go('#/docs');
    assert.match(serialize(container), /Every package is published on npm/, 'default section is installation');
    go('#/docs?s=jslt');
    const html = serialize(container);
    assert.match(html, /JSLT stylesheets/);
    assert.match(html, /apply-templates/);
  });

  it('the emit docs section explains the cyclic verification, not just the API', function () {
    // The reason a generated type can be trusted is the loop back to the
    // validator. A docs section that only showed the CLI would sell the
    // feature and omit the argument for it.
    const { container, go } = mountSite();
    go('#/docs?s=emit');
    const html = serialize(container);
    assert.match(html, /Schemas as TypeScript/);
    assert.match(html, /jaren-emit --schema/);
    assert.match(html, /cyclic verification/i);
    assert.match(html, /never narrower than the schema/i);
    assert.match(html, /never wider/i);
  });

  it('the mobile menu toggles and closes on navigation', function () {
    const { app, container } = mountSite({ hash: '#/' });
    fire(find(container, (n) => n.attributes?.get('class') === 'menu-toggle'), 'click');
    assert.strictEqual(app.getState().menu, true);
    assert.match(serialize(container), /nav open/);
    fire(find(container, (n) => n.attributes?.get('class') === 'menu-toggle'), 'click');
    assert.strictEqual(app.getState().menu, false);
  });
});
