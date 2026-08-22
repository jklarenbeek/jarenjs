//@ts-check
/**
 * @file The legacy experiment IDE surface: the retired `#/playground`
 * left saved experiments in users' storage and share links in the wild.
 * Both keep working — a legacy experiment or token translates into the
 * equivalent play session and lands on `#/play`. (The project IDE
 * store flows are covered in studio.test.js.) Plus the docs pages and
 * the mobile menu, which share this mount helper.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createSiteApp } from '../../packages/website/src/app/createSiteApp.js';
import { parseHash } from '../../packages/website/src/lib/route.js';
import { buildSiteContent } from '../../scripts/generate-site-data.js';
import { createStubHost, fire, serialize } from '../view/dom.stub.js';

/** The real collected site content: the docs sections a package owns
 * arrive through the same fetch the browser makes. Read once. */
const SITE_CONTENT = buildSiteContent();

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function mountSite({ hash = '#/project', stored = null, modelContext, share } = {}) {
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
    fetchSite: (name) => (name === 'content'
      ? Promise.resolve(SITE_CONTENT)
      : Promise.reject(new Error('404'))),
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

describe('website — legacy playground experiments translate into play sessions', function () {
  it('a saved engine experiment loads as the equivalent play session on #/play', function () {
    const stored = {
      experiments: {
        'all prices': { engine: 'path', inputs: { selector: '$..price', data: '{"a":{"price":7}}' }, savedAt: 'x' },
      },
    };
    const { app, hashes } = mountSite({ stored });
    assert.deepStrictEqual(app.getState().ide.names, ['all prices'], 'the legacy save is listed');
    app.dispatch('ide/load', 'all prices');
    assert.strictEqual(hashes.at(-1), '#/play', 'loading lands on #/play');
    const play = app.getState().play;
    assert.strictEqual(play.engine, 'path');
    assert.strictEqual(play.source.selector, '$..price', 'the selector pane translated');
    assert.strictEqual(play.data.data, '{"a":{"price":7}}', 'the data pane translated');
    assert.ok(play.result?.ok === true, 'and the session ran green');
  });

  it('a saved validate experiment (schemaText + data VALUE) translates too', function () {
    const stored = {
      experiments: {
        demo: { engine: 'validate', inputs: { schemaText: '{"type":"object"}', data: { a: 1 } }, savedAt: 'x' },
      },
    };
    const { app } = mountSite({ stored });
    app.dispatch('ide/load', 'demo');
    const play = app.getState().play;
    assert.strictEqual(play.engine, 'validate');
    assert.strictEqual(play.source.schema, '{"type":"object"}');
    assert.match(play.data.data, /"a": 1/, 'the data value serialized into the pane text');
    assert.ok(play.result?.ok === true, 'the translated session validated');
  });

  it('an experiment naming an unknown engine is left alone (no crash, no navigation)', function () {
    const stored = {
      experiments: { odd: { engine: 'nonesuch', inputs: { x: '1' }, savedAt: 'x' } },
    };
    const { app, hashes } = mountSite({ stored });
    app.dispatch('ide/load', 'odd');
    assert.deepStrictEqual(hashes, [], 'no navigation for an untranslatable experiment');
    assert.strictEqual(app.getState().route.page, 'project');
  });
});

describe('website — legacy playground links redirect to #/play', function () {
  it('#/playground redirects to #/play', function () {
    const { app, hashes } = mountSite({ hash: '#/playground' });
    assert.strictEqual(hashes.at(-1), '#/play');
    assert.strictEqual(app.getState().route.page, 'play');
    assert.ok(app.getState().play.result !== null, 'play seeded and ran on arrival');
  });

  it('an old playground share token translates into a play session token', async function () {
    const { encodeShare } = await import('@jarenjs/app');
    const token = encodeShare({ e: 'path', i: { selector: '$..price', data: '{"b":{"price":3}}' } });
    const { app, hashes } = mountSite({ hash: `#/playground?engine=path&s=${token}` });
    assert.match(hashes.at(-1) ?? '', /^#\/play\?s=/, 'the redirect carries a translated token');
    const play = app.getState().play;
    assert.strictEqual(play.engine, 'path');
    assert.strictEqual(play.source.selector, '$..price', 'the shared experiment restored on #/play');
  });

  it('a corrupt legacy token still lands on #/play, on the engine the link named', function () {
    const { app, hashes } = mountSite({ hash: '#/playground?engine=path&s=%%%bogus' });
    // the token is unreadable, but `engine` is not — falling back to it
    // beats dropping the whole link on the floor
    assert.strictEqual(hashes.at(-1), '#/play?engine=path');
    assert.strictEqual(app.getState().route.page, 'play');
    assert.strictEqual(app.getState().play.engine, 'path');
  });
});

describe('website — docs, examples, menu', function () {
  it('docs render sections from the content document, deep-linkable', async function () {
    const { container, go } = mountSite();
    go('#/docs');
    assert.match(serialize(container), /Every package is published on npm/, 'default section is installation');
    // a package's own section arrives with the collected site content,
    // one turn after the route: the JSLT material is @jarenjs/json's
    go('#/docs?s=json');
    await tick();
    const html = serialize(container);
    assert.match(html, /JSLT stylesheets/);
    assert.match(html, /apply-templates/);
  });

  it('the emit docs section explains the cyclic verification, not just the API', async function () {
    // The reason a generated type can be trusted is the loop back to the
    // validator. A docs section that only showed the CLI would sell the
    // feature and omit the argument for it.
    const { container, go } = mountSite();
    go('#/docs?s=emit');
    await tick();
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
