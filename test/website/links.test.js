//@ts-check
/**
 * @file Addresses and share links the site reads from outside, each defect
 * reproduced before it was fixed:
 *
 * 1. A hash with a second `?` lost everything after it.
 * 2. A retired `#/playground?s=` link whose token names an engine that
 *    Object.prototype answers (`constructor`) threw while the site booted.
 * 3. A session token with an array for a pane was loaded as the pane.
 * 4. Deleting the saved session a play session was bound to blanked the
 *    title of the session still being edited.
 * 5. A shared project could carry a split ratio that is not a number.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { encodeShare } from '@jarenjs/app';
import { createSiteApp } from '../../packages/website/src/app/createSiteApp.js';
import { parseHash } from '../../packages/website/src/lib/route.js';
import { legacyExperimentToSession, sessionToLoaded } from '../../packages/website/src/boundaries/play.js';
import { sharedProject } from '../../packages/website/src/content/projectTemplates.js';
import { createStubHost } from '../view/dom.stub.js';

/** A headless site entered at `hash`, with a recording `navigate`. */
function mountSite(hash, storage = { read: () => null, write: () => {} }) {
  const { document, container } = createStubHost();
  /** @type {any} */
  let routeCb = null;
  /** @type {string[]} */
  const navigated = [];
  const app = createSiteApp({
    node: container,
    document,
    schedule: (f) => f(),
    debounceMs: 0,
    fetchJson: () => Promise.reject(new Error('404')),
    listenHash: (cb) => { routeCb = cb; cb(parseHash(hash)); },
    navigate: (h) => { navigated.push(h); routeCb(parseHash(h)); },
    storage,
    onError: (err) => { throw err; },
  });
  return { app, navigated, go: (h) => routeCb(parseHash(h)) };
}

describe('website — the hash route', () => {
  it('the query is everything after the first ?', () => {
    assert.deepStrictEqual(parseHash('#/docs?s=a?b'), { page: 'docs', params: { s: 'a?b' } });
    assert.deepStrictEqual(parseHash('#/benchmarks?suite=validate&x=1?2'),
      { page: 'benchmarks', params: { suite: 'validate', x: '1?2' } });
  });

  it('a hash without a query, with an empty one, or without a page', () => {
    assert.deepStrictEqual(parseHash('#/docs/'), { page: 'docs', params: {} });
    assert.deepStrictEqual(parseHash('#/docs?'), { page: 'docs', params: {} });
    assert.deepStrictEqual(parseHash('#/?x=1'), { page: 'home', params: { x: '1' } });
    assert.deepStrictEqual(parseHash(''), { page: 'home', params: {} });
    assert.deepStrictEqual(parseHash('#/nowhere?x=1'), { page: 'home', params: { x: '1' } });
  });
});

describe('website — a retired playground link names an engine nobody has', () => {
  for (const engine of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    it(`${engine}: no session, so no boot failure — the site lands on #/play`, () => {
      assert.strictEqual(legacyExperimentToSession(engine, { a: 'x' }), null);
      const token = encodeShare({ e: engine, i: { a: 'x' } });
      const { navigated, app } = mountSite(`#/playground?s=${token}`);
      assert.deepStrictEqual(navigated, ['#/play']);
      assert.strictEqual(app.getState().route.page, 'play');
    });
  }

  it('an engine the site has still translates', () => {
    const session = legacyExperimentToSession('validate', { schemaText: '{}', data: 1 });
    assert.deepStrictEqual(session, {
      engine: 'validate', exampleId: null, source: { schema: '{}' }, data: { data: '1' }, config: {},
    });
  });
});

describe('website — a retired studio link carries its token across as one value', () => {
  it('a token holding & = or # is not split into parameters by the redirect', () => {
    const { navigated } = mountSite('#/studio?s=a%26b%3D1%23c');
    assert.deepStrictEqual(navigated, ['#/project?s=a%26b%3D1%23c']);
  });

  it('a token of the encoder\'s alphabet passes unchanged', () => {
    const token = encodeShare({ e: 'validate', i: { schemaText: '{}', data: 1 } });
    assert.deepStrictEqual(mountSite(`#/studio?s=${token}`).navigated, [`#/project?s=${token}`]);
    assert.deepStrictEqual(mountSite('#/studio').navigated, ['#/project']);
  });
});

describe('website — a session token with a shape of its own', () => {
  it('an array is not a pane record', () => {
    assert.deepStrictEqual(sessionToLoaded({ engine: 'validate', source: [1, 2], data: ['x'], config: [] }),
      { engine: 'validate', exampleId: null, source: {}, data: {}, config: {} });
    assert.deepStrictEqual(sessionToLoaded({ engine: 'validate', source: { schema: '{}' }, data: { data: '1' }, config: { a: 'b' } }),
      { engine: 'validate', exampleId: null, source: { schema: '{}' }, data: { data: '1' }, config: { a: 'b' } });
  });

  it('the site opens one with array panes as empty panes', () => {
    const token = encodeShare({ engine: 'validate', source: [1, 2], data: 'x', config: [] });
    const { app } = mountSite(`#/play?s=${token}`);
    const play = app.getState().play;
    assert.strictEqual(play.engine, 'validate');
    assert.deepStrictEqual([play.source, play.data, play.config], [{}, {}, {}]);
  });
});

describe('website — deleting the saved session a play session is bound to', () => {
  it('unbinds it and keeps the title being edited', () => {
    let saved = null;
    const storage = { read: () => saved, write: (data) => { saved = JSON.parse(JSON.stringify(data)); } };
    const { app } = mountSite('#/play', storage);
    app.dispatch('play/name', null, { target: { value: 'alpha' } });
    app.dispatch('play/save');
    app.dispatch('play/name', null, { target: { value: 'alpha, edited' } });
    app.dispatch('play/delete-session', 'alpha');
    const play = app.getState().play;
    assert.strictEqual(play.savedName, null);
    assert.strictEqual(play.name, 'alpha, edited');
    assert.deepStrictEqual(play.names, []);
  });

  it('a save still adopts the name it wrote', () => {
    const { app } = mountSite('#/play');
    app.dispatch('play/name', null, { target: { value: 'beta' } });
    app.dispatch('play/save');
    assert.strictEqual(app.getState().play.name, 'beta');
    assert.strictEqual(app.getState().play.savedName, 'beta');
  });
});

describe('website — a shared project that carries a layout of its own', () => {
  const share = (layout) => sharedProject({
    e: 'project', i: { project: { files: [{ name: 'a.json', kind: 'data', text: '{}' }], layout } },
  });

  it('keeps a finite split ratio and the other members', () => {
    assert.deepStrictEqual(share({ ratio: 0.3, mode: 'top', autorun: false }).layout,
      { mode: 'top', ratio: 0.3, autorun: false });
  });

  it('replaces a ratio that is not a finite number with the default split', () => {
    for (const ratio of ['abc', '0.3', null, true, [0.3], { a: 1 }, Infinity, undefined]) {
      assert.strictEqual(share({ ratio, mode: 'top' }).layout.ratio, 0.5, String(ratio));
      assert.strictEqual(share({ ratio, mode: 'top' }).layout.mode, 'top');
    }
    assert.deepStrictEqual(share(undefined).layout, { mode: 'classic', ratio: 0.5, autorun: true });
    assert.deepStrictEqual(share(null).layout, { mode: 'classic', ratio: 0.5, autorun: true });
  });
});
