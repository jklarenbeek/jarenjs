//@ts-check
/**
 * @file A store member that takes a query document refuses a chain
 * (`JD0039`): a `@jarenjs/linq` chain keeps its clauses behind methods, so
 * read as a document it was one with no clauses — a collection's `execute`
 * answered `{}`, its `query` `[{}]` and its `live` `[{}]`, and an entity
 * member refused it as a document naming no entity (`JD0033`). A chain is
 * told by its `toDocument()` method, which no query document carries; a
 * document with a member of that name is still a document. A document is
 * JSON, so any other object whose prototype is neither `Object.prototype`
 * nor `null` is refused at the root (`JD0041`): the compiler read it by its
 * own members, so `execute(new Date())` answered `{}`; and so is one inside
 * a document with no own member to read (a `Date` in a `$where` compared
 * with `{}`). A class instance inside a document is read by its fields, as
 * before.
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

/** The refusal `JD0041` gives a member handed a non-plain root. @param {string} member @param {string} what */
const notJson = (member, what) => `JD0041: ${member} takes a query document, which is JSON, and was handed ${what} — `
  + 'a document is read by its own members alone, and a Date or a Map has none; pass the document as a plain object';

/** The refusal `JD0041` gives a document holding an object it reads as `{}`. @param {string} what @param {string} at */
const opaque = (what, at) => `JD0041: a query document holds ${what}, which it reads as {} — `
  + `write the JSON value it stands for (a Date as its toISOString()) at ${at}`;

/** A class instance read by its own fields. */
class Point {
  constructor() { this.x = 1; this.y = 2; }
}

/** A query document held as a class instance's own fields. */
class Query {
  constructor() { this.$for = { it: '$[*]' }; this.$return = '$it.id'; }
}

describe('a store member that takes a query document refuses one that is not JSON', () => {
  it('a non-plain root, on every member, each as it refuses a document', async () => {
    await withStore(async (store) => {
      const orders = store.collection('orders');
      // each answered {} (query and live [{}]): the object was read by its own members
      for (const [member, form] of /** @type {const} */ ([['execute', 'thrown'], ['query', 'thrown'], ['explain', 'rejected'], ['live', 'rejected']])) {
        const { form: answered, error } = await refusal(() => orders[member](new Date(0)));
        assert.strictEqual(error.message, notJson(`collection('orders').${member}`, 'a Date instance'));
        assert.strictEqual(error.code, 'JD0041');
        assert.strictEqual(answered, form, member);
      }
      assert.strictEqual((await refusal(() => orders.execute(new Map([['$return', 1]])))).error.message,
        notJson("collection('orders').execute", 'a Map instance'));
      assert.strictEqual((await refusal(() => store.sync.collection('orders').execute(/x/))).error.code, 'JD0041');
      // an entity member refused it as a document naming no entity (JD0033)
      const rows = store.entity('Row');
      assert.strictEqual((await refusal(() => rows.execute(new Date(0)))).error.message, notJson('entity execute()', 'a Date instance'));
      assert.strictEqual((await refusal(() => rows.explain(new Date(0)))).error.message, notJson('entity explain()', 'a Date instance'));
      assert.strictEqual((await refusal(() => rows.cursor(new Date(0)))).error.message, notJson('entity cursor()', 'a Date instance'));
      assert.strictEqual((await refusal(() => store.execute(new Date(0)))).error.code, 'JD0041');
      assert.strictEqual((await refusal(() => store.live(new Date(0)))).error.message, notJson('store.live', 'a Date instance'));
      await store.transaction(async (/** @type {any} */ tx) => {
        assert.strictEqual((await refusal(() => tx.collection('orders').execute(new Date(0)))).error.code, 'JD0041');
        assert.strictEqual((await refusal(() => tx.live(new Date(0)))).error.code, 'JD0041');
      });
      assert.strictEqual(store.stats().liveQueries, 0);
    });
  });

  it('a value inside a document that it read as {}, wherever it stands', async () => {
    await withStore(async (store) => {
      const orders = store.collection('orders');
      const after = (/** @type {any} */ value) => ({ $for: { it: '$[*]' }, $where: { $gt: ['$it.total', value] }, $return: '$it.id' });
      // the same document with a real {} first: its compiled entry never answers for the Date
      assert.strictEqual(await orders.execute(after({})), undefined);
      // each answered as if the value were {}: no row, and { d: {} }
      for (const options of [undefined, { pushdown: false }]) {
        const { error } = await refusal(() => orders.execute(after(new Date(0)), options));
        assert.strictEqual(error.message, opaque('a Date instance', '/$where/$gt/1'));
        assert.strictEqual(error.code, 'JD0041');
        assert.strictEqual(error.docPath, '/$where/$gt/1');
      }
      assert.strictEqual((await refusal(() => orders.execute({ $for: { it: '$[*]' }, $return: { 'a/b': [new Set()] } }))).error.message,
        opaque('a Set instance', '/$return/a~1b/0'));
      assert.strictEqual((await refusal(() => orders.query(after({ $const: new Date(0) })))).error.message,
        opaque('a Date instance', '/$where/$gt/1/$const'));
      assert.strictEqual((await refusal(() => orders.explain(after(new Map())))).form, 'rejected');
      assert.strictEqual((await refusal(() => orders.live(after(new Date(0))))).error.message, opaque('a Date instance', '/$where/$gt/1'));
      const rows = { $for: { r: '$.Row[*]' }, $where: { $gt: ['$r.n', new Date(0)] }, $return: '$r' };
      assert.strictEqual((await refusal(() => store.execute(rows))).error.message, opaque('a Date instance', '/$where/$gt/1'));
      assert.strictEqual((await refusal(() => store.entity('Row').cursor(rows))).error.code, 'JD0041');
      assert.strictEqual((await refusal(() => store.live(rows))).error.message, opaque('a Date instance', '/$where/$gt/1'));
      // a maintained view never runs the engine's compile, and answered { d: {} }
      const stamped = { $for: { it: '$[*]' }, $return: { t: '$it.total', d: new Date(0) } };
      assert.strictEqual((await refusal(() => orders.live(stamped))).error.message, opaque('a Date instance', '/$return/d'));
      const joined = { $for: { r: '$.Row[*]' }, $return: { id: '$r.id', d: new Date(0) } };
      assert.strictEqual((await refusal(() => store.live(joined))).error.message, opaque('a Date instance', '/$return/d'));
      assert.strictEqual(store.stats().liveQueries, 0);
    });
  });

  it('a document that refers to itself is walked once, ending at the value it reads as {}', async () => {
    await withStore(async (store) => {
      const looped = /** @type {any} */ ({ $for: { it: '$[*]' }, $return: {} });
      looped.$return.self = looped;
      looped.$return.d = new Date(0);
      assert.strictEqual((await refusal(() => store.collection('orders').execute(looped))).error.message,
        opaque('a Date instance', '/$return/d'));
    });
  });

  it('a null-prototype document, and a class instance at its root or inside one, answer as before', async () => {
    await withStore(async (store) => {
      const orders = store.collection('orders');
      // a class instance is read by its own fields, at the root as inside a document
      assert.strictEqual(await orders.execute(new Query()), 'o1');
      assert.strictEqual(await store.sync.collection('orders').execute(new Query()), 'o1');
      const bare = Object.assign(Object.create(null), { $for: { it: '$[*]' }, $return: '$it.id' });
      assert.strictEqual(await orders.execute(bare), 'o1');
      assert.deepStrictEqual(await orders.execute({ $for: { it: '$[*]' }, $return: { id: '$it.id', p: new Point() } }),
        { id: 'o1', p: { x: 1, y: 2 } });
      assert.deepStrictEqual(await orders.execute([1, Object.assign(Object.create(null), { a: 2 })]), [1, { a: 2 }]);
      assert.strictEqual(await orders.execute('x'), 'x');
      assert.strictEqual(await orders.execute(null), null);
    });
  });
});
