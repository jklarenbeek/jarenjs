//@ts-check
/**
 * @file Every collection and entity view of a store carries its own source
 * under `STORE_SOURCE`: the store's, a transaction's, the synchronous twin
 * at the root and inside a synchronous transaction. A chain built over a
 * view reports it, so a reader handed the chain can tell which rows its
 * document names without having built the view itself.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore, STORE_SOURCE } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const MODEL = {
  $model: '0.1',
  collections: {
    users: { schema: { type: 'object', properties: { id: { type: 'string' } } }, key: '/id' },
  },
  entities: {
    Row: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'integer', 'x-entity': { key: true } } },
      },
    },
  },
};

const USERS = { kind: 'collection', name: 'users' };
const ROW = { kind: 'entity', name: 'Row' };

/** @param {any} view - a store, or a store view a transaction received */
function sourcesOf(view) {
  return [view.collection('users')[STORE_SOURCE], view.entity('Row')[STORE_SOURCE]];
}

describe('a store view carries its own source', () => {
  it('on the store, a transaction, the synchronous twin and a synchronous transaction alike', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    try {
      assert.strictEqual(STORE_SOURCE, Symbol.for('@jarenjs/db/store-source'));
      assert.deepStrictEqual(sourcesOf(store), [USERS, ROW]);
      assert.deepStrictEqual(sourcesOf(store.sync), [USERS, ROW]);
      assert.deepStrictEqual(await store.transaction(async (/** @type {any} */ tx) => sourcesOf(tx)), [USERS, ROW]);
      assert.deepStrictEqual(await store.transaction(async (/** @type {any} */ tx) => sourcesOf(tx.sync)), [USERS, ROW]);
      assert.deepStrictEqual(store.sync.transaction((/** @type {any} */ tx) => sourcesOf(tx)), [USERS, ROW]);
      assert.ok(Object.isFrozen(store.collection('users')[STORE_SOURCE]));
      // a symbol, so a view's string members (and a hand-written provider's) are untouched
      assert.ok(!Object.keys(store.collection('users')).includes('name'));
    }
    finally { await store.close(); }
  });
});
