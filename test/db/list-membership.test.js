//@ts-check
/**
 * @file Membership over thousands of values (MODEL-FORMAT §10.1, the pushdown contract):
 * `$eq` between a member and a list — a `$seq` of scalars, every item of
 * an external (`$ids[*]`), or an `$or` of equalities on that one member —
 * plans to ONE list predicate, bound as one JSON value whatever the
 * list's length, and the member's index seeks it. A long `$or` that does
 * not fold nests in halves, so a 5,000-term chain prepares and explains;
 * as a flat chain it failed past 996 terms ("Expression tree is too
 * large"), and explain() with it. The answers are the engine's: the
 * differential oracle's membership groups hold indexed, unindexed and
 * forced-residual agreement for collections and entities on both
 * dialects. This file holds the shape — one statement, one list value,
 * an index search — at the sizes that used to refuse.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { compileJsonQuery } from '@jarenjs/json';
import { tempDbPath } from './helpers.js';

const key = { 'x-entity': { key: true } };
const MODEL = {
  $model: '0.1',
  collections: {
    items: {
      schema: { type: 'object', properties: { id: { type: 'string' }, sku: { type: 'string' }, n: { type: 'integer' } } },
      key: '/id', indexes: [{ name: 'sku', path: '$.sku' }],
    },
  },
  entities: {
    Item: { schema: { type: 'object', properties: {
      id: { type: 'string', ...key }, sku: { type: 'string', 'x-entity': { index: true } }, n: { type: 'integer' } } } },
  },
};
const ROWS = 2000;
/** 5,000 skus, every even one below 10,000: every other stored row matches. */
const IDS = Array.from({ length: 5000 }, (_, i) => `s${i * 2}`);
const EXPECTED = Array.from({ length: ROWS / 2 }, (_, i) => `i${i * 2}`);
/** @param {string} sql */
const placeholders = (sql) => (sql.match(/\?/g) ?? []).length;
/** @param {string} member @param {any} list */
const where = (member, list) => ({ $eq: [member, list] });
/** @param {any} predicate */
const overItems = (predicate) => ({ $for: { it: '$[*]' }, $where: predicate, $return: '$it.id' });
/** @param {any} predicate */
const overItem = (predicate) => ({ $for: { it: '$.Item[*]' }, $where: predicate, $return: '$it.id' });
/** An `$or` of 5,000 equalities on the sku, in the list's order. */
const orOfEqualities = (/** @type {string} */ member) => ({ $or: IDS.map((id) => ({ $eq: [member, id] })) });
/** A 5,000-term `$or` no fold applies to: equalities on the sku, ranges on n. */
const mixedChain = (/** @type {string} */ it) => ({ $or: IDS.slice(0, 2500).flatMap((id, i) =>
  [{ $eq: [`${it}.sku`, id] }, { $gt: [`${it}.n`, 100000 + i] }]) });

describe('membership over thousands of values (SQLite)', () => {
  /** @type {any} */
  let store;
  /** @type {DatabaseSync} */
  let raw;
  /** @type {() => void} */
  let cleanup;

  before(async () => {
    const temp = tempDbPath();
    cleanup = temp.cleanup;
    store = await openStore(MODEL, { driver: nodeDriver(), path: temp.dbPath });
    await store.transaction(async (/** @type {any} */ tx) => {
      for (let i = 0; i < ROWS; i++) {
        await tx.collection('items').put({ id: `i${i}`, sku: `s${i}`, n: i });
        await tx.entity('Item').create({ id: `i${i}`, sku: `s${i}`, n: i });
      }
    });
    raw = new DatabaseSync(temp.dbPath);
  });
  after(async () => {
    raw?.close();
    await store?.close();
    cleanup?.();
  });

  it('collection.execute: 5,000 ids bind as the one list value, and the index seeks them', async () => {
    const items = store.collection('items');
    const query = overItems(where('$it.sku', '$ids[*]'));
    const options = { externals: { ids: IDS } };
    assert.deepEqual(await items.execute(query, options), EXPECTED);
    assert.deepEqual(await items.execute(query, { ...options, pushdown: false }), EXPECTED, 'the residual agrees');
    const plan = await items.explain(query, options);
    assert.equal(plan.mode, 'native');
    // no parameter per value: the list's one JSON value, placed in the
    // text branch and the number branch (a member's kind is the document's)
    assert.deepEqual(plan.params, [{ external: 'ids' }, { external: 'ids' }]);
    assert.equal(placeholders(plan.sql), 2);
    assert.match(plan.scanNarrative, /SEARCH items USING INDEX \S+ \(gx_sku=\?\)/);
    assert.match(plan.scanNarrative, /LIST SUBQUERY/);
  });

  it('store.execute over an entity: one placeholder, and the column index seeks the list', async () => {
    const query = overItem(where('$it.sku', '$ids[*]'));
    const options = { externals: { ids: IDS } };
    assert.deepEqual(await store.execute(query, options), EXPECTED);
    assert.deepEqual(await store.execute(query, { ...options, pushdown: false }), EXPECTED, 'the residual agrees');
    const plan = await store.explain(query, options);
    assert.equal(plan.mode, 'native');
    assert.equal(placeholders(plan.sql), 1);
    assert.match(plan.sql, /json_each\(\?\)/);
    assert.match(plan.scanNarrative, /SEARCH t0 USING INDEX Item_sku \(sku=\?\)/);
  });

  it('an entity load: a $seq of 5,000 values is one statement text for every length, and seeks the index', async () => {
    const items = store.entity('Item');
    const loaded = await items.load({ where: where('$it.sku', { $seq: IDS }) });
    assert.deepEqual(loaded.map((/** @type {any} */ row) => row.id), EXPECTED);
    const long = await items.explainLoad({ where: where('$it.sku', { $seq: IDS }) });
    const short = await items.explainLoad({ where: where('$it.sku', { $seq: ['s1', 's2', 's3'] }) });
    assert.equal(long.sql, short.sql, 'the list is a bound value, not statement text');
    assert.equal(placeholders(long.sql), 1);
    const narrative = raw.prepare(`EXPLAIN QUERY PLAN ${long.sql}`).all(JSON.stringify(IDS))
      .map((/** @type {any} */ row) => row.detail).join('; ');
    assert.match(narrative, /SEARCH r USING INDEX Item_sku \(sku=\?\)/);
    // a load binds no externals, and says so by name
    await assert.rejects(items.load({ where: where('$it.sku', '$ids[*]') }),
      (/** @type {any} */ error) => error.code === 'JD0032' && /names the external '\$ids', and a load binds none/.test(error.message));
  });

  it('a 5,000-term $or of equalities on one member folds to the list plan', async () => {
    const items = store.collection('items');
    const folded = overItems(orOfEqualities('$it.sku'));
    assert.deepEqual(await items.execute(folded), EXPECTED);
    assert.equal((await items.explain(folded)).sql, (await items.explain(overItems(where('$it.sku', { $seq: IDS })))).sql);
    const entityFolded = overItem(orOfEqualities('$it.sku'));
    assert.deepEqual(await store.execute(entityFolded), EXPECTED);
    const plan = await store.explain(entityFolded);
    assert.equal(plan.sql, (await store.explain(overItem(where('$it.sku', { $seq: IDS })))).sql);
    assert.match(plan.scanNarrative, /SEARCH t0 USING INDEX Item_sku \(sku=\?\)/);
    const loaded = await store.entity('Item').load({ where: orOfEqualities('$it.sku') });
    assert.equal(loaded.length, EXPECTED.length);
  });

  // the residual over 5,000 terms is the slow half: seconds on Node, longer under Bun
  it('a 5,000-term chain no fold applies to nests in halves: it prepares, explains and answers', { timeout: 60_000 }, async () => {
    const items = store.collection('items');
    const mixed = overItems(mixedChain('$it'));
    assert.deepEqual(await items.execute(mixed), EXPECTED);
    assert.deepEqual(await items.execute(mixed, { pushdown: false }), EXPECTED, 'the residual agrees');
    assert.equal((await items.explain(mixed)).mode, 'native');
    const entityMixed = overItem(mixedChain('$it'));
    assert.deepEqual(await store.execute(entityMixed), EXPECTED);
    assert.equal((await store.explain(entityMixed)).mode, 'native');
    assert.equal((await store.entity('Item').load({ where: mixedChain('$it') })).length, EXPECTED.length);
    // a conjunction nests alike: 5,000 inequalities
    const conjunction = overItem({ $and: IDS.map((id) => ({ $ne: ['$it.sku', id] })) });
    assert.equal((await store.execute(conjunction)).length, ROWS / 2);
    assert.equal((await store.explain(conjunction)).mode, 'native');
  });
});

describe('membership over a physical column that stores present nulls', () => {
  it('a null in the list matches a stored null exactly as $eq does — native for a literal list, the engine for a bound one', async () => {
    const { dbPath, cleanup } = tempDbPath();
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE tag(id INTEGER PRIMARY KEY, label TEXT); INSERT INTO tag VALUES (1, 'a'), (2, NULL), (3, 'b'), (4, 'A');");
    db.close();
    const store = await openStore({ $model: '0.1', entities: { Tag: {
      schema: { type: 'object', properties: { id: { type: 'integer', ...key }, label: { type: ['string', 'null'] } } },
      physical: { table: 'tag', columns: { id: { name: 'id', codec: 'integer', null: 'reject' },
        label: { name: 'label', codec: 'text', null: 'null' } } } } } }, { driver: nodeDriver(), path: dbPath, adopt: true });
    try {
      const rows = await store.entity('Tag').load({});
      /** @param {any} query @param {any} [externals] */
      const engine = (query, externals) => compileJsonQuery(query)({ Tag: rows }, externals);
      const literal = { $for: { t: '$.Tag[*]' }, $where: { $eq: ['$t.label', { $seq: [null, 'a'] }] }, $orderby: ['$t.id'], $return: '$t.id' };
      assert.deepEqual(await store.execute(literal), [1, 2]);
      assert.deepEqual(await store.execute(literal), engine(literal));
      assert.equal((await store.explain(literal)).mode, 'native');
      assert.deepEqual((await store.entity('Tag').load({ where: { $eq: ['$it.label', { $seq: [null, 'a'] }] } }))
        .map((/** @type {any} */ row) => row.id).sort(), [1, 2]);
      const bound = { $for: { t: '$.Tag[*]' }, $where: { $eq: ['$t.label', '$labels[*]'] }, $orderby: ['$t.id'], $return: '$t.id' };
      for (const labels of [[null, 'b'], ['a', 'A'], [], ['a', true]]) {
        assert.deepEqual(await store.execute(bound, { externals: { labels } }), engine(bound, { labels }), JSON.stringify(labels));
      }
      // only a list of strings and numbers binds; any other item runs the call in the
      // engine — and a call that diverted does not make the next explain report a diversion
      assert.equal((await store.explain(bound, { externals: { labels: ['a', 'A'] } })).mode, 'native');
      assert.notEqual((await store.explain(bound, { externals: { labels: [null, 'b'] } })).mode, 'native');
    }
    finally {
      await store.close();
      cleanup();
    }
  });
});

describe('membership edges', () => {
  it('an inferred integer foreign key compares as the integer its key is — natively, by value and by list', async () => {
    const store = await openStore({ $model: '0.1', entities: {
      User: { schema: { type: 'object', required: ['uid'], properties: { uid: { type: 'integer', ...key },
        posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } } } } },
      Post: { schema: { type: 'object', required: ['pid'], properties: { pid: { type: 'integer', ...key } } } },
    } }, { driver: nodeDriver(), path: ':memory:' });
    try {
      await store.entity('User').create({ uid: 1 });
      await store.entity('Post').create({ pid: 10, authorId: 1 });
      await store.entity('Post').create({ pid: 11 });
      for (const predicate of [{ $eq: ['$p.authorId', 1] }, { $eq: ['$p.authorId', { $seq: [1, 2] }] },
        { $or: [{ $eq: ['$p.authorId', 1] }, { $eq: ['$p.authorId', 2] }] }, { $eq: ['$p.authorId', '$ids[*]'] }]) {
        const query = { $for: { p: '$.Post[*]' }, $where: predicate, $return: '$p.pid' };
        const options = { externals: { ids: [1] } };
        assert.deepEqual(await store.execute(query, options), 10, JSON.stringify(predicate));
        assert.deepEqual(await store.execute(query, { ...options, pushdown: false }), 10, 'the residual agrees');
        assert.equal((await store.explain(query, options)).mode, 'native');
      }
      assert.deepEqual((await store.entity('Post').load({ where: { $eq: ['$it.authorId', { $seq: [1] }] } }))
        .map((/** @type {any} */ post) => post.pid), [10]);
    }
    finally { await store.close(); }
  });

  it('a bound list that is no JSON value (a bigint, a function, a symbol) runs the call in the engine, and answers as it does', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), path: ':memory:' });
    try {
      await store.collection('items').put({ id: 'i1', sku: 's1', n: 10 });
      await store.entity('Item').create({ id: 'i1', sku: 's1', n: 10 });
      for (const value of [10n, () => 10, Symbol('ids')]) {
        for (const [target, root] of /** @type {[any, string][]} */ ([[store.collection('items'), '$[*]'], [store, '$.Item[*]']])) {
          const query = { $for: { it: root }, $where: { $eq: ['$it.n', '$ids[*]'] }, $return: '$it.id' };
          const options = { externals: { ids: value } };
          assert.deepEqual(await target.execute(query, options), await target.execute(query, { ...options, pushdown: false }),
            `${typeof value} over ${root}`);
          assert.notEqual((await target.explain(query, options)).mode, 'native');
        }
      }
    }
    finally { await store.close(); }
  });

  it('a profile predicate naming an external binds under execute(), and a load under it refuses by name', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), path: ':memory:' });
    try {
      for (const [id, sku] of [['i1', 'a'], ['i2', 'b']]) await store.entity('Item').create({ id, sku, n: 1 });
      const profile = { predicates: { Item: { $eq: ['$it.sku', '$allowed[*]'] } } };
      // the native statement and the residual's root fetch both bind it from the call
      const native = overItem({ $eq: ['$it.n', 1] });
      const residual = overItem({ $eq: [{ $count: '$it.id' }, 1] });
      assert.equal((await store.explain(native, { profile, externals: { allowed: ['a'] } })).mode, 'native');
      assert.notEqual((await store.explain(residual, { profile, externals: { allowed: ['a'] } })).mode, 'native');
      for (const query of [native, residual, overItem(true)])
        assert.deepEqual(await store.execute(query, { profile, externals: { allowed: ['a'] } }), 'i1');
      // a value the database cannot compare is refused, never dropped from the fetch
      for (const externals of [{ allowed: ['a', null] }, {}]) {
        for (const query of [native, residual]) {
          // a thunk: over a synchronous driver the refusal is thrown, not a rejection
          await assert.rejects(async () => store.execute(query, { profile, externals }), (/** @type {any} */ error) => error.code === 'JD0011'
            && /the profile's predicate for 'Item' cannot bind '\$allowed' for this call/.test(error.message));
        }
      }
      await assert.rejects(store.entity('Item').load({}, { profile }), (/** @type {any} */ error) => error.code === 'JD0032'
        && /the profile's predicate for 'Item' names the external '\$allowed', and a load binds none/.test(error.message));
    }
    finally { await store.close(); }
  });

  it('a same-operator chain nested thousands deep plans, explains and answers on every path', { timeout: 60_000 }, async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), path: ':memory:' });
    try {
      await store.collection('items').put({ id: 'i1', sku: 's1', n: 1 });
      await store.entity('Item').create({ id: 'i1', sku: 's1', n: 1 });
      // as a client that does not flatten builds it: { $or: [acc, next] }
      let nested = /** @type {any} */ ({ $eq: ['$it.sku', 's0'] });
      for (let i = 1; i < 5000; i++) nested = { $or: [nested, { $eq: ['$it.sku', `s${i}`] }] };
      const items = store.collection('items');
      assert.deepEqual(await items.execute(overItems(nested)), 'i1');
      assert.deepEqual(await items.execute(overItems(nested), { pushdown: false }), 'i1');
      assert.equal((await items.explain(overItems(nested))).mode, 'native');
      assert.deepEqual(await store.execute(overItem(nested)), 'i1');
      assert.deepEqual(await store.execute(overItem(nested), { pushdown: false }), 'i1');
      assert.equal((await store.explain(overItem(nested))).mode, 'native');
      assert.deepEqual((await store.entity('Item').load({ where: nested })).map((/** @type {any} */ row) => row.id), ['i1']);
    }
    finally { await store.close(); }
  });
});
