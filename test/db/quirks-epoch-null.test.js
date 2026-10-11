//@ts-check
/**
 * @file A nullable epoch member keeps its RFC 3339 string in the document,
 * present `null` included (MODEL-FORMAT section 9.3), so an ordering key that
 * is that `null` is one the engine refuses (`JQ2005`). A statement that read
 * the member as an unknown, as a nullable plain column reads, would order the
 * row silently, so such an ordering runs in the engine, which raises as it
 * does over the documents themselves.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const MODEL = { $model: '0.1', entities: { E: { schema: { type: 'object', required: ['id'], properties: {
  id: { type: 'string', 'x-entity': { key: true } },
  at: { type: ['string', 'null'], format: 'date-time', 'x-entity': { column: 'integer' } },
  nm: { type: ['string', 'null'] },
} } } } };
const ORDER = { $for: { it: '$.E[*]' }, $orderby: ['$it.at', '$it.id'], $return: '$it.id' };
const PREFIX = { $for: { it: '$.E[*]' }, $where: { '$starts-with': ['$it.at', '2026'] }, $return: '$it.id' };
const THREE = [
  { id: 'a', at: '2026-02-01T00:00:00.000Z' },
  { id: 'b', at: '2026-01-01T00:00:00.000Z' },
  { id: 'c' },
];

/** @param {any[]} documents @param {(store: any) => Promise<void>} body */
async function withStore(documents, body) {
  const store = await openStore(MODEL, { driver: nodeDriver() });
  try {
    for (const document of documents) await store.entity('E').create(document);
    await body(store);
  }
  finally { await store.close(); }
}

describe('a nullable epoch member that holds a null', () => {
  it('$orderby raises JQ2005 as the engine does, with pushdown on or off', async () => {
    await withStore([...THREE, { id: 'd', at: null }], async (store) => {
      for (const pushdown of [undefined, false]) {
        await assert.rejects(Promise.resolve().then(() => store.execute(ORDER, { pushdown })),
          (/** @type {any} */ e) => e.code === 'JQ2005', `pushdown ${pushdown}`);
      }
      assert.strictEqual((await store.explain(ORDER)).mode, 'set');
    });
  });

  it('a string operator over it stays native, as over any member typed string and null: the null answers false', async () => {
    await withStore([...THREE, { id: 'd', at: null }], async (store) => {
      assert.deepStrictEqual(await store.execute(PREFIX), ['a', 'b']);
      assert.strictEqual((await store.explain(PREFIX)).mode, 'native');
    });
  });

  it('answers in the engine\'s order where no row holds a null', async () => {
    await withStore(THREE, async (store) => {
      assert.deepStrictEqual(await store.execute(ORDER), ['c', 'b', 'a']);
      assert.deepStrictEqual(await store.execute(ORDER, { pushdown: false }), ['c', 'b', 'a']);
      assert.deepStrictEqual(await store.execute(PREFIX), ['a', 'b']);
    });
  });
});
