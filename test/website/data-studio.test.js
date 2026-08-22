//@ts-check
/**
 * @file The data studio's PAGE half: what the model pane's edits do to
 * the rest of the surface.
 *
 * The model is editable, so nothing downstream may name a collection
 * literally — the seed, the row read, the query and explain pair and the
 * live subscription all follow the collection the OPEN model declares,
 * and the row list addresses documents by the key pointer that model
 * declares too. What the worker does with those requests is
 * `data-handlers.test.js`; this is the state and the view model.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { createSiteApp } from '../../packages/website/src/app/createSiteApp.js';
import { dataViewModel } from '../../packages/website/src/boundaries/data.js';
import { parseHash } from '../../packages/website/src/lib/route.js';
import { createStubHost, serialize } from '../view/dom.stub.js';

/** The site headless on `#/data`; the worker never boots in Node, which
 * is exactly why the state transitions are asserted directly. */
function mount() {
  const { document, container } = createStubHost();
  const app = createSiteApp({
    node: container,
    document,
    schedule: (/** @type {any} */ f) => f(),
    debounceMs: 0,
    fetchJson: () => Promise.reject(new Error('404')),
    listenHash: (/** @type {any} */ cb) => cb(parseHash('#/data')),
    navigate: () => {},
    onError: (/** @type {any} */ error) => { throw error; },
  });
  return { app, container };
}

const CAPABILITIES = { capture: 'journal', version: '3', operators: [], pushableOperators: [] };

describe('the collection the studio works on', function () {
  it('stays on the seed model\'s when an open answers nothing about it', function () {
    const { app } = mount();
    app.dispatch('data/opened', { vfs: 'x', capabilities: CAPABILITIES });
    assert.strictEqual(app.getState().data.collection, 'notes');
    assert.strictEqual(app.getState().data.keyPointer, '/id');
  });

  it('follows a reopened model — collection and key pointer both', function () {
    const { app } = mount();
    app.dispatch('data/opened', {
      vfs: 'x', collection: 'tasks', keyPointer: '/uid', capabilities: CAPABILITIES,
    });
    assert.strictEqual(app.getState().data.collection, 'tasks',
      'naming a collection literally downstream made editing the model produce a studio'
      + ' that queries one the model no longer declares');
    assert.strictEqual(app.getState().data.keyPointer, '/uid');
    const model = dataViewModel(app.getState());
    assert.strictEqual(model.collection, 'tasks');
    assert.match(model.insertPlaceholder, /new tasks title/);
  });
});

describe('the stored documents, as the store pane lists them', function () {
  const state = (rows, keyPointer = '/id', collection = 'notes') => ({
    data: {
      status: 'ready', topology: 'owner', vfs: 'x', version: '3', capture: 'journal',
      operators: [], pushableOperators: [], refusal: null, modelText: '', queryText: '',
      collection, keyPointer, rows, results: [], explain: null,
      live: { rows: [], seq: null, regs: null }, insertDraft: '', migration: null, error: null,
      mobilePane: 'query',
    },
  });

  it('addresses each document by the pointer the MODEL declares', function () {
    const model = dataViewModel(state(
      [{ uid: 'a', title: 'first' }, { uid: 'b', title: 'second' }], '/uid'));
    assert.deepStrictEqual(model.rowList.map((/** @type {any} */ row) => row.key), ['a', 'b']);
    assert.strictEqual(model.rowList[0].text, '{"uid":"a","title":"first"}');
    assert.strictEqual(model.rowSummary, '2 stored in notes');
  });

  it('leaves a document the pointer misses without a key, so no control addresses nothing', function () {
    const model = dataViewModel(state([{ id: 'a' }, { other: 'b' }]));
    assert.strictEqual(model.rowList[0].key, 'a');
    assert.strictEqual(Object.hasOwn(model.rowList[1], 'key'), false,
      'a delete button with nothing to address is a button that quietly does nothing');
  });

  it('renders one row per document, with a delete on each that has a key', function () {
    const { app, container } = mount();
    app.dispatch('data/rows', { rows: [{ id: 'n1', title: 'first' }, { nokey: true }] });
    const html = serialize(container);
    assert.strictEqual(html.match(/class="data-row"/g)?.length, 2,
      'one row per stored document');
    assert.strictEqual(html.match(/data-row-delete/g)?.length, 1,
      'and a control only where there is a key to address');
    assert.match(html, /2 stored in notes/,
      'the summary counts the documents, not the ones it could address');
  });
});
