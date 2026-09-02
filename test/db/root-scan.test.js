//@ts-check
/**
 * @file The bare root wildcard over a collection — `'$[*]'`, the
 * degenerate query every linq chain emits until an operator is applied
 * — is planned as the collection scan it abbreviates: a native plan
 * streamed row by row from an open statement, the same rows in the same
 * order as the `$for` phrase, and the same answer from `explain` on the
 * store and on the chain. Before this it was a path barrier that fetched
 * the collection whole and walked it in JS, so a bare `for await` over a
 * collection handle materialised the table while its own explain said
 * `streaming: 'row'`.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { open } from '@jarenjs/linq/db';
import { recordingDriver } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    rows: {
      schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' }, n: { type: 'integer' } } },
      key: '/id',
      indexes: [],
    },
  },
};
const FLWOR = { $for: { it: '$[*]' }, $return: '$it' };

describe("a bare '$[*]' over a collection is the collection scan", () => {
  it('plans native and streams row by row, the same rows in the same order as the $for phrase', async () => {
    const { driver, executed } = recordingDriver(nodeDriver());
    const store = await openStore(MODEL, { driver });
    const rows = store.collection('rows');
    for (let i = 0; i < 5; i++) await rows.insert({ id: i, n: i * i });
    const explained = /** @type {any} */ (await rows.explain('$[*]'));
    assert.strictEqual(explained.mode, 'native');
    assert.strictEqual(explained.streaming, 'row');
    assert.strictEqual(explained.barrier, null);
    const viaPath = await rows.execute('$[*]');
    const viaFlwor = await rows.execute(FLWOR);
    assert.deepStrictEqual(viaPath, viaFlwor);
    assert.strictEqual(/** @type {any[]} */ (viaPath).length, 5);
    const cursor = rows.query('$[*]');
    assert.strictEqual(cursor.streaming, 'row');
    const pulled = [];
    for await (const row of cursor) {
      pulled.push(row.id);
      if (pulled.length === 2) break;
    }
    assert.deepStrictEqual(pulled, [0, 1], 'two rows cost two pulls; the break releases the statement');
    assert.ok(!executed.some((sql) => /json_group_array|json_agg/i.test(sql)), 'no whole-collection aggregate was executed');
    await store.close();
  });

  it("the linq collection handle's bare chain emits '$[*]' and its explain now agrees with the store's", async () => {
    const client = await open(MODEL, { driver: nodeDriver(), validator: null });
    for (let i = 0; i < 3; i++) await client.collections.rows.insert({ id: i, n: i });
    assert.strictEqual(client.collections.rows.toDocument(), '$[*]');
    const own = /** @type {any} */ (client.collections.rows.explain());
    const stores = /** @type {any} */ (await client.collections.rows.explain('$[*]'));
    assert.strictEqual(own.streaming, 'row');
    assert.strictEqual(stores.streaming, 'row');
    assert.strictEqual(stores.mode, 'native');
    const seen = [];
    for await (const row of client.collections.rows) seen.push(row.id);
    assert.deepStrictEqual(seen, [0, 1, 2]);
    await client.close();
  });
});
