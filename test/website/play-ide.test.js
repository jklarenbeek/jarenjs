//@ts-check
/**
 * @file The Play IDE (`#/play`) as a workbench, headless over the stub DOM: a
 * play session is a saveable document. Naming and Saving persists it through
 * the injected storage and lists it; New blanks the current engine; Load
 * restores a saved session; Delete removes it; Share encodes a `#/play?s=`
 * link, and entering that URL decodes and restores the session.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createSiteApp } from '../../packages/website/src/app/createSiteApp.js';
import { parseHash } from '../../packages/website/src/lib/route.js';
import { createStubHost, fire } from '../view/dom.stub.js';

/** A mutable storage cell — pass the SAME one to two mounts to test a reload. */
function storageCell(initial = null) {
  const cell = { data: initial };
  return {
    read: () => cell.data,
    write: (d) => { cell.data = JSON.parse(JSON.stringify(d)); },
    peek: () => cell.data,
    cell,
  };
}

/** A headless site over a persisting in-memory storage, entered at #/play. */
function mountSite({ hash = '#/play', share, store = storageCell() } = {}) {
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
    storage: store,
    share,
    onError: (err) => { throw err; },
  });
  return { app, container, go: (h) => routeCb(parseHash(h)), store, storage: () => store.peek() };
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
const hasClass = (n, cls) => (n.getAttribute?.('class') ?? '').split(' ').includes(cls);
const byClass = (c, cls) => find(playRoot(c), (n) => hasClass(n, cls));
const btn = (c, label) => find(playRoot(c), (n) => n.tagName === 'button' && n.childNodes?.[0]?.nodeValue === label);
const sourceInput = (c) => find(playRoot(c), (n) => n.tagName === 'input' && n.getAttribute?.('class') === 'editor line');

describe('website — the Play IDE (#/play) save/load/share', () => {
  it('names + saves a session, lists it, loads it back, and deletes it', () => {
    const { app, container, storage } = mountSite();
    fire(byClass(container, 'jplay-name'), 'input', { target: { value: 'my-run' } });
    fire(btn(container, 'Save'), 'click', {});
    assert.deepStrictEqual(app.getState().play.names, ['my-run'], 'the saved name is listed');
    assert.ok(storage().play['my-run'], 'persisted through the storage adapter');
    assert.strictEqual(storage().play['my-run'].engine, app.getState().play.engine);

    // Load the saved session back (the dropdown appears once something is saved)
    fire(byClass(container, 'jplay-load'), 'change', { target: { value: 'my-run' } });
    assert.strictEqual(app.getState().play.name, 'my-run', 'the loaded session carries its name');

    // Delete removes it from the store and the list
    fire(btn(container, 'Delete'), 'click', {});
    assert.deepStrictEqual(app.getState().play.names, [], 'the session is gone from the list');
    assert.ok(storage().play['my-run'] === undefined, 'removed from storage');
  });

  it('New blanks the session to the current engine (empty panes, no name)', () => {
    const { app, container } = mountSite();
    const engine = app.getState().play.engine;
    fire(byClass(container, 'jplay-name'), 'input', { target: { value: 'temp' } });
    fire(btn(container, 'New'), 'click', {});
    const s = app.getState().play;
    assert.strictEqual(s.engine, engine, 'the engine is kept');
    assert.deepStrictEqual(s.source, {}, 'the source panes are blanked');
    assert.strictEqual(s.exampleId, null, 'no example is active');
    assert.strictEqual(s.name, '', 'the name is cleared');
  });

  it('a saved session survives a reload (a second mount over the same storage)', () => {
    const store = storageCell();
    const { container } = mountSite({ store });
    fire(byClass(container, 'jplay-name'), 'input', { target: { value: 'keep-me' } });
    fire(btn(container, 'Save'), 'click', {});
    // a fresh site over the SAME storage seeds the saved-name list at boot
    const site2 = mountSite({ store });
    assert.ok(site2.app.getState().play.names.includes('keep-me'), 'the reload lists the saved session');
  });

  it('Share builds a #/play?s= link and entering it restores engine + source', () => {
    const shared = [];
    const { app, container } = mountSite({ share: (h) => { shared.push(h); return 'https://x/' + h; } });
    // edit the seeded selector so the shared session is distinctive
    fire(sourceInput(container), 'input', { target: { value: '$..distinctive' } });
    fire(btn(container, 'Share'), 'click', {});
    assert.strictEqual(shared.length, 1, 'Share produced one link');
    assert.match(shared[0], /^#\/play\?s=/, 'a #/play share link');
    assert.strictEqual(app.getState().play.shared, 'link copied');

    const token = new URLSearchParams(shared[0].split('?')[1]).get('s');
    const site2 = mountSite({ hash: `#/play?s=${token}` });
    const s = site2.app.getState().play;
    assert.strictEqual(s.engine, app.getState().play.engine, 'the engine was restored');
    assert.strictEqual(s.source.selector, '$..distinctive', 'the edited source was restored');
  });
});
