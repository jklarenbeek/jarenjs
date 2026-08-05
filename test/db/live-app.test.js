//@ts-check
/**
 * @file The end-to-end claim (LIVE-FORMAT §10): a WRITE to the store
 * reaches the DOM through the generated app binding — capture record
 * → live maintenance → subscription handler → patch-carrying action →
 * app state → keyed renderer — and only the changed node is touched.
 * The binding is generated documents plus a registered handler; the
 * db package imports nothing from `@jarenjs/app` (asserted against
 * the manifest), which is the `fsmToApp` boundary discipline.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';

import { createApp } from '@jarenjs/app';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { liveAppBinding, createLiveSubscription, prefixLivePatch } from '@jarenjs/db/app';
import { createStubHost, serialize } from '../view/dom.stub.js';

const MODEL = {
  $model: '0.1',
  collections: {
    todos: {
      schema: { type: 'object', properties: {
        id: { type: 'string' }, label: { type: 'string' }, done: { type: 'boolean' } } },
      key: '/id',
      indexes: [],
    },
  },
};
const QUERY = [{ $for: { it: '$[*]' }, $return: '$it' }];

const sync = (flush) => flush();
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the generated binding documents', () => {
  it('produce the §10 subscription and the two-line action', () => {
    const { subscription, actions } = liveAppBinding({
      statePath: '/live/todos', collection: 'todos', query: QUERY });
    assert.deepStrictEqual(subscription, {
      run: 'db/live',
      with: {
        action: 'db/liveChanged', statePath: '/live/todos',
        collection: 'todos', query: QUERY,
      },
    });
    assert.deepStrictEqual(actions, { 'db/liveChanged': { patch: '$payload' } });
    assert.throws(() => liveAppBinding({ statePath: 'nope', query: QUERY }), TypeError);
    assert.throws(() => liveAppBinding({ statePath: '/x' }), TypeError);
  });

  it('prefixLivePatch prefixes every op path', () => {
    assert.deepStrictEqual(prefixLivePatch([
      { op: 'add', path: '/rows/1', value: 1 },
      { op: 'remove', path: '/rows/0' },
    ], '/live/todos'), [
      { op: 'add', path: '/live/todos/rows/1', value: 1 },
      { op: 'remove', path: '/live/todos/rows/0' },
    ]);
  });

  it('the db manifest declares no @jarenjs/app dependency (documents, not imports)', () => {
    const manifest = JSON.parse(fs.readFileSync(
      new URL('../../packages/db/package.json', import.meta.url), 'utf8'));
    assert.strictEqual(manifest.dependencies?.['@jarenjs/app'], undefined);
    assert.strictEqual(manifest.peerDependencies?.['@jarenjs/app'], undefined);
  });
});

describe('write → store → app → DOM (end to end)', () => {
  const build = async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), capture: true });
    const todos = store.collection('todos');
    await todos.insert({ id: 'a', label: 'first', done: false });
    await todos.insert({ id: 'b', label: 'second', done: false });

    const { subscription, actions } = liveAppBinding({
      statePath: '/live/todos', collection: 'todos', query: QUERY });
    const { document, container } = createStubHost();
    let created = 0;
    const createElement = document.createElement.bind(document);
    document.createElement = (tag) => {
      created += 1;
      return createElement(tag);
    };
    const app = createApp({
      state: { live: { todos: { rows: [] } } },
      view: [
        { match: '$', body: ['ul', {}, [{ $apply: '$.live.todos.rows[*]' }]] },
        { match: '$.live.todos.rows[*]', body: ['li', { key: '$.id' }, '$.label'] },
      ],
      subs: [subscription],
      actions,
    }, {
      node: container, document, schedule: sync,
      subs: { 'db/live': createLiveSubscription(store) },
    });
    await settle(); // the async registration dispatches the initial replace
    return { store, todos, app, container, createdCount: () => created };
  };

  it('a write patches ONLY the changed DOM node', async () => {
    const { store, todos, app, container, createdCount } = await build();
    assert.strictEqual(serialize(container),
      '<div><ul><li>first</li><li>second</li></ul></div>');
    const list = /** @type {any} */ (container.childNodes[0]);
    const [first, second] = list.childNodes;
    const baseline = createdCount();

    await todos.put({ id: 'b', label: 'SECOND', done: true }, 'b');
    assert.strictEqual(serialize(container),
      '<div><ul><li>first</li><li>SECOND</li></ul></div>');
    assert.strictEqual(list.childNodes[0], first,
      'the untouched row keeps its DOM node');
    assert.strictEqual(list.childNodes[1], second,
      'the changed row PATCHES its node in place (keyed identity)');
    assert.strictEqual(createdCount(), baseline,
      'zero elements created for an in-place text change');

    await todos.insert({ id: 'c', label: 'third', done: false });
    assert.strictEqual(serialize(container),
      '<div><ul><li>first</li><li>SECOND</li><li>third</li></ul></div>');
    assert.strictEqual(list.childNodes[0], first);
    assert.strictEqual(list.childNodes[1], second);
    assert.strictEqual(createdCount(), baseline + 1,
      'exactly ONE element created for the inserted row');

    await todos.delete('a');
    assert.strictEqual(serialize(container),
      '<div><ul><li>SECOND</li><li>third</li></ul></div>');
    assert.strictEqual(list.childNodes[0], second, 'survivors keep their nodes');
    app.destroy();
    await store.close();
  });

  it('the subscription cleanup closes the live query', async () => {
    const { store, app } = await build();
    assert.strictEqual(store.stats().liveQueries, 1);
    app.destroy();
    assert.strictEqual(store.stats().liveQueries, 0,
      'destroying the app released the registration');
    await store.close();
  });

  it('a registration failure dispatches the error action, not silence', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() }); // no capture
    const { subscription, actions } = liveAppBinding({
      statePath: '/live/todos', collection: 'todos', query: QUERY });
    const app = createApp({
      state: { live: { todos: { rows: [] } }, failure: null },
      view: [{ match: '$', body: ['p', {}, { $default: ['$.failure.code', 'ok'] }] }],
      subs: [subscription],
      actions: {
        ...actions,
        'db/liveChanged/error': {
          patch: [{ op: 'replace', path: '/failure', value: '$payload' }] },
      },
    }, {
      node: createStubHost().container, document: createStubHost().document,
      schedule: sync,
      subs: { 'db/live': createLiveSubscription(store) },
    });
    await settle();
    assert.strictEqual(app.getState().failure.code, 'JD0050',
      'the coded refusal reached the app state');
    app.destroy();
    await store.close();
  });
});
