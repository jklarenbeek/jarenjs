//@ts-check
/**
 * @file A store member that takes a query document refuses a chain
 * (`JD0039`): a `@jarenjs/linq` chain keeps its clauses behind methods, so
 * read as a document it was one with no clauses — a collection's `execute`
 * answered `{}`, its `query` `[{}]` and its `live` `[{}]`, and an entity
 * member refused it as a document naming no entity (`JD0033`). A chain is
 * told by its `toDocument()` method, which no query document carries; a
 * document with a member of that name is still a document.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const MODEL = {
  $model: '0.1',
  collections: {
    orders: { schema: { type: 'object', properties: { id: { type: 'string' }, total: { type: 'integer' } } }, key: '/id' },
  },
  entities: {
    Row: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'integer', 'x-entity': { key: true } }, n: { type: 'integer' } },
      },
    },
  },
};

/** A chain as the store meets one: its document behind a method. */
class Chain {
  /** @param {any} document */
  constructor(document) { this.document = document; }
  toDocument() { return this.document; }
  explain() { return { bindings: {} }; }
}

const ORDERS = new Chain({ $for: { it: '$[*]' }, $where: { $gt: ['$it.total', 1] }, $return: '$it' });
const ROWS = new Chain({ $for: { it: '$.Row[*]' }, $where: { $gt: ['$it.n', 1] }, $return: '$it' });

/** The refusal `JD0039` gives a member. @param {string} member */
const refused = (member) => `JD0039: ${member} takes a query document and was handed a chain — `
  + "pass the chain's document, toDocument() with { externals: chain.explain().bindings }, "
  + 'or hand the chain to the handle it was built from, which runs it';

/** What a call refuses with, and how: thrown at the call or a rejected promise.
 * @param {() => any} call @returns {Promise<{ form: string, error: any }>} */
async function refusal(call) {
  let pending;
  try { pending = call(); }
  catch (error) { return { form: 'thrown', error }; }
  try { await pending; }
  catch (error) { return { form: 'rejected', error }; }
  return assert.fail('expected a refusal');
}

/** @param {(store: any) => Promise<void>} body */
async function withStore(body) {
  const store = await openStore(MODEL, { driver: nodeDriver(), capture: true });
  try {
    await store.collection('orders').insert({ id: 'o1', total: 5 });
    await store.entity('Row').create({ id: 1, n: 2 });
    await store.saveChanges();
    await body(store);
  }
  finally { await store.close(); }
}

describe('a store member that takes a query document refuses a chain', () => {
  it('a collection\'s execute, query, explain and live, each as it refuses a document', async () => {
    await withStore(async (store) => {
      const orders = store.collection('orders');
      for (const [member, form] of /** @type {const} */ ([['execute', 'thrown'], ['query', 'thrown'], ['explain', 'rejected'], ['live', 'rejected']])) {
        const { form: answered, error } = await refusal(() => orders[member](ORDERS));
        assert.strictEqual(error.message, refused(`collection('orders').${member}`));
        assert.strictEqual(error.code, 'JD0039');
        assert.strictEqual(answered, form, member);
      }
      assert.strictEqual(store.stats().liveQueries, 0);
      assert.strictEqual((await refusal(() => store.sync.collection('orders').execute(ORDERS))).form, 'thrown');
      assert.strictEqual((await refusal(() => store.sync.collection('orders').explain(ORDERS))).error.code, 'JD0039');
    });
  });

  it('an entity set\'s execute, explain and cursor, and the store\'s execute, explain and live', async () => {
    await withStore(async (store) => {
      const rows = store.entity('Row');
      assert.strictEqual((await refusal(() => rows.execute(ROWS))).error.message, refused('entity execute()'));
      assert.strictEqual((await refusal(() => rows.explain(ROWS))).error.message, refused('entity explain()'));
      assert.strictEqual((await refusal(() => rows.cursor(ROWS))).error.message, refused('entity cursor()'));
      assert.strictEqual((await refusal(() => store.execute(ROWS))).error.message, refused('entity execute()'));
      assert.strictEqual((await refusal(() => store.explain(ROWS))).error.message, refused('entity explain()'));
      assert.strictEqual((await refusal(() => store.live(ROWS))).error.message, refused('store.live'));
      assert.strictEqual((await refusal(() => store.sync.execute(ROWS))).error.code, 'JD0039');
      assert.strictEqual(store.stats().liveQueries, 0);
    });
  });

  it('a transaction\'s views refuse it too', async () => {
    await withStore(async (store) => {
      await store.transaction(async (/** @type {any} */ tx) => {
        assert.strictEqual((await refusal(() => tx.collection('orders').execute(ORDERS))).error.code, 'JD0039');
        assert.strictEqual((await refusal(() => tx.entity('Row').execute(ROWS))).error.code, 'JD0039');
        assert.strictEqual((await refusal(() => tx.live(ROWS))).error.code, 'JD0039');
      });
    });
  });

  it('a document, even one with a member named toDocument, runs as before', async () => {
    await withStore(async (store) => {
      const orders = store.collection('orders');
      assert.deepStrictEqual(await orders.execute(ORDERS.toDocument()), { id: 'o1', total: 5 });
      assert.deepStrictEqual(await orders.execute({ toDocument: 1 }), { toDocument: 1 });
      assert.deepStrictEqual(await store.execute(ROWS.toDocument()), { id: 1, n: 2 });
      const live = await orders.live(ORDERS.toDocument());
      assert.deepStrictEqual(live.result.rows, [{ id: 'o1', total: 5 }]);
    });
  });
});
