//@ts-check
/**
 * @file `collection.all()` (MODEL-FORMAT §5): every stored document,
 * ALWAYS as an array with one entry per document, in the order
 * `execute('$[*]')` visits them. `execute('$[*]')` answers the engine's
 * sequence instead — `undefined` for an empty collection, the bare
 * document for one, and for one array-valued document exactly what two
 * documents would give — so `all()` drains the item cursor rather than
 * reading that answer. The same on the asynchronous and synchronous
 * surfaces, inside a transaction, and on the typed client, where `all`
 * given a predicate stays the chain's quantifier.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { open } from '@jarenjs/linq/db';

const MODEL = {
  $model: '0.1',
  collections: { docs: { schema: {}, identity: 'integer', indexes: [] } },
};

/** @param {unknown[]} documents */
async function storeWith(documents) {
  const store = await openStore(MODEL, { driver: nodeDriver() });
  for (const document of documents) await store.collection('docs').insert(document);
  return store;
}

describe('collection.all()', () => {
  it('is always an array, one entry per document — where execute($[*]) collapses', async () => {
    for (const [documents, expected, executed] of /** @type {[unknown[], unknown[], unknown][]} */ ([
      [[], [], undefined],
      [[{ a: 1 }], [{ a: 1 }], { a: 1 }],
      [[[1, 2]], [[1, 2]], [1, 2]],
      [[1, 2], [1, 2], [1, 2]],
    ])) {
      const store = await storeWith(documents);
      try {
        const docs = store.collection('docs');
        assert.deepStrictEqual(await docs.all(), expected, JSON.stringify(documents));
        assert.deepStrictEqual(await docs.execute('$[*]'), executed, 'execute answers the sequence, as documented');
        assert.deepStrictEqual(store.sync?.collection('docs').all(), expected, 'the synchronous twin');
        assert.deepStrictEqual(await store.transaction(async (tx) => tx.collection('docs').all()), expected, 'inside a transaction');
        assert.deepStrictEqual(await store.transaction(async (tx) => tx.sync?.collection('docs').all()), expected);
      }
      finally { await store.close(); }
    }
  });

  it("visits many documents once each, in execute('$[*]')'s order", async () => {
    const documents = Array.from({ length: 250 }, (_, i) => (i % 7 === 0 ? [i, i] : { i, text: `d${i}` }));
    const store = await storeWith(documents);
    try {
      const all = await store.collection('docs').all();
      assert.strictEqual(all.length, 250);
      assert.deepStrictEqual(all, documents);
      const sequence = await store.collection('docs').execute('$[*]');
      // the sequence flattens nothing here either: 250 items, the same order
      assert.deepStrictEqual(all, sequence);
      assert.deepStrictEqual(await store.transaction(async (tx) => {
        await tx.collection('docs').insert({ inside: true });
        return (await tx.collection('docs').all()).length;
      }), 251, 'a transaction sees its own writes');
    }
    finally { await store.close(); }
  });

  it('honours an aborted signal (JD2072) and refuses what a fixed document cannot use (JD0013)', async () => {
    const store = await storeWith([{ a: 1 }, { a: 2 }]);
    try {
      const docs = store.collection('docs');
      const controller = new AbortController();
      controller.abort(new Error('stop'));
      await assert.rejects(docs.all({ signal: controller.signal }), (/** @type {any} */ error) => error.code === 'JD2072');
      assert.throws(() => store.sync?.collection('docs').all({ signal: controller.signal }), (/** @type {any} */ error) => error.code === 'JD2072');
      for (const options of [{ externals: {} }, { pushdown: false }, { strict: true }, 'x', null]) {
        await assert.rejects(docs.all(/** @type {any} */ (options)), (/** @type {any} */ error) => error.code === 'JD0013',
          JSON.stringify(options));
      }
      await assert.rejects(docs.all(/** @type {any} */ ({ signl: controller.signal })), (/** @type {any} */ error) => /'signal'/.test(error.message));
      // the options it reads
      assert.deepStrictEqual(await docs.all({ deadline: Date.now() + 60_000, strictStreaming: true, profile: 'safe' }), [{ a: 1 }, { a: 2 }]);
    }
    finally { await store.close(); }
  });

  it('the typed client: all() is every document, all(predicate) the chain quantifier', async () => {
    const client = await open(MODEL, { driver: nodeDriver(), validator: null });
    try {
      const docs = /** @type {any} */ (client.collections).docs;
      assert.deepStrictEqual(await docs.all(), []);
      await docs.insert({ n: 1 });
      await docs.insert([2, 3]);
      assert.deepStrictEqual(await docs.all(), [{ n: 1 }, [2, 3]]);
      assert.strictEqual(await docs.all((/** @type {any} */ d) => d.eq(d)), true);
      assert.deepStrictEqual(await client.transaction(async (tx) => /** @type {any} */ (tx.collections).docs.all()), [{ n: 1 }, [2, 3]]);
    }
    finally { await client.close(); }
  });
});
