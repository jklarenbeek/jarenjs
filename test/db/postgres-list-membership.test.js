//@ts-check
/**
 * @file Membership over thousands of values on a real PostgreSQL server
 * (the SQLite shapes are `list-membership.test.js`): `$eq` against a bound
 * list, a `$seq` of 5,000 literals and a 5,000-term `$or` of equalities
 * on one member each bind the list as ONE JSON value, the entity column's
 * index seeks it, and a chain mixing equalities and ranges regroups by
 * member to two bound values. A chain nothing regroups (`$and` pairs)
 * costs the server per leaf and row, so one statement carries at most the
 * dialect's bound of leaves (128): above it the engine answers, named, and
 * a load refuses by name. Every answer equals the residual's.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, reasonId } from '@jarenjs/db';
import { postgresDriver } from '@jarenjs/db/postgres';

const url = process.env.JAREN_PG_URL;
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
      id: { type: 'string', ...key }, sku: { type: 'string', 'x-entity': { index: true } }, n: { type: 'integer', 'x-entity': { index: true } } } } },
  },
};
const ROWS = 2000;
const IDS = Array.from({ length: 5000 }, (_, i) => `s${i * 2}`);
const EXPECTED = Array.from({ length: ROWS / 2 }, (_, i) => `i${i * 2}`);
/** @param {string} sql */
const placeholders = (sql) => new Set(sql.match(/\$\d+/g) ?? []).size;
/** @param {any} predicate */
const overItems = (predicate) => ({ $for: { it: '$[*]' }, $where: predicate, $return: '$it.id' });
/** @param {any} predicate */
const overItem = (predicate) => ({ $for: { it: '$.Item[*]' }, $where: predicate, $orderby: ['$it.id'], $return: '$it.id' });
const orOfEqualities = () => ({ $or: IDS.map((id) => ({ $eq: ['$it.sku', id] })) });
/** An `$or` of `terms` terms mixing equalities on the sku with ranges on n: it regroups to one list and one bound. */
const mixedChain = (terms = 5000) => ({ $or: IDS.slice(0, terms / 2).flatMap((id, i) =>
  [{ $eq: ['$it.sku', id] }, { $gt: ['$it.n', 100000 + i] }]) });
/** An `$or` of `terms / 2` `$and` pairs, which nothing regroups: each pair compares the sku and n. */
const pairs = (/** @type {number} */ terms) => ({ $or: IDS.slice(0, terms / 2).map((id, i) =>
  ({ $and: [{ $eq: ['$it.sku', id] }, { $ge: ['$it.n', i] }] })) });
/** The rows the first `terms` leaves of either chain select. @param {number} terms */
const expectedFor = (terms) => sorted(IDS.slice(0, terms / 2).map((id) => `i${id.slice(1)}`));
/** @param {string[]} ids */
const sorted = (ids) => [...ids].sort();

describe('PostgreSQL: membership over thousands of values', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  /** @type {any} */
  let pg;
  /** @type {any} */
  let admin;
  /** @type {any} */
  let pool;
  /** @type {any} */
  let store;
  const schema = `jaren_membership_${process.pid}`;

  before(async () => {
    pg = (await import('pg')).default;
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: url, max: 1 });
    store = await openStore(MODEL, { driver: postgresDriver(pool, { schema }) });
    await store.transaction(async (/** @type {any} */ tx) => {
      for (let i = 0; i < ROWS; i++) {
        await tx.collection('items').put({ id: `i${i}`, sku: `s${i}`, n: i });
        await tx.entity('Item').create({ id: `i${i}`, sku: `s${i}`, n: i });
      }
    });
    await admin.query(`ANALYZE "${schema}"."items"`);
    await admin.query(`ANALYZE "${schema}"."Item"`);
  });
  after(async () => {
    await store?.close().catch(() => {});
    await pool?.end().catch(() => {});
    if (admin) {
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await admin.end(); }
    }
  });

  it('a bound list of 5,000 ids: one JSON value, the residual\'s answer, and the entity index seeks it', async () => {
    const items = store.collection('items');
    const query = overItems({ $eq: ['$it.sku', '$ids[*]'] });
    const options = { externals: { ids: IDS } };
    assert.deepEqual(sorted(await items.execute(query, options)), sorted(EXPECTED));
    assert.deepEqual(sorted(await items.execute(query, { ...options, pushdown: false })), sorted(EXPECTED));
    const collectionPlan = await items.explain(query, options);
    assert.equal(collectionPlan.mode, 'native');
    assert.deepEqual(collectionPlan.params, [{ external: 'ids' }, { external: 'ids' }]);

    const entityQuery = overItem({ $eq: ['$it.sku', '$ids[*]'] });
    assert.deepEqual(await store.execute(entityQuery, options), sorted(EXPECTED));
    assert.deepEqual(await store.execute(entityQuery, { ...options, pushdown: false }), sorted(EXPECTED));
    const plan = await store.explain(entityQuery, options);
    assert.equal(plan.mode, 'native');
    assert.equal(placeholders(plan.sql), 1);
    assert.match(plan.scanNarrative, /Index (Only )?Scan using "Item_sku"|Bitmap Index Scan on "Item_sku"/);
  });

  it('a $seq of 5,000 literals and a 5,000-term $or of equalities are the same list plan', async () => {
    const seq = overItem({ $eq: ['$it.sku', { $seq: IDS }] });
    const folded = overItem(orOfEqualities());
    assert.deepEqual(await store.execute(seq), sorted(EXPECTED));
    assert.deepEqual(await store.execute(folded), sorted(EXPECTED));
    const plan = await store.explain(folded);
    assert.equal(plan.sql, (await store.explain(seq)).sql);
    assert.equal(placeholders(plan.sql), 1);
    const loaded = await store.entity('Item').load({ where: { $eq: ['$it.sku', { $seq: IDS }] } });
    assert.deepEqual(sorted(loaded.map((/** @type {any} */ row) => row.id)), sorted(EXPECTED));
    assert.deepEqual(sorted(await store.collection('items').execute(overItems(orOfEqualities()))), sorted(EXPECTED));
  });

  it('a mixed chain regroups to one list and one bound: two values bound, the residual\'s answer, on both forms', async () => {
    const items = store.collection('items');
    const plan = await items.explain(overItems(mixedChain(400)));
    assert.equal(plan.mode, 'native');
    assert.deepEqual(plan.params, [{ literal: JSON.stringify(IDS.slice(0, 200)) }, { literal: 100000 }]);
    assert.deepEqual(sorted(await items.execute(overItems(mixedChain(400)))), expectedFor(400));
    assert.deepEqual(sorted(await items.execute(overItems(mixedChain(400)), { pushdown: false })), expectedFor(400));
    const entityPlan = await store.explain(overItem(mixedChain(400)));
    assert.equal(entityPlan.mode, 'native');
    assert.equal(placeholders(entityPlan.sql), 2);
    assert.deepEqual(await store.execute(overItem(mixedChain(400))), expectedFor(400));
    // the whole 5,000-term chain is the same two values
    assert.deepEqual((await items.explain(overItems(mixedChain()))).params,
      [{ literal: JSON.stringify(IDS.slice(0, 2500)) }, { literal: 100000 }]);
    assert.deepEqual(sorted(await items.execute(overItems(mixedChain()))), sorted(EXPECTED));
    assert.deepEqual(await store.execute(overItem(mixedChain())), sorted(EXPECTED));
    assert.equal((await store.entity('Item').load({ where: mixedChain() })).length, EXPECTED.length);
  });

  it('a chain of $and pairs, which nothing regroups, is bounded: a short one prepares natively, a long one runs in the engine, and a load refuses it', async () => {
    // every leaf of an unregrouped chain reads its member's typed extraction
    // per row, so its cost is per leaf and row, and a long enough one is
    // priced into a JIT compile the server cannot cancel: one statement
    // carries at most the dialect's bound of leaves, and above it the engine
    // answers with the reason named — where a load, which has no engine
    // path, refuses by name
    const items = store.collection('items');
    assert.deepEqual(await store.execute(overItem(pairs(64))), expectedFor(64));
    assert.equal((await store.explain(overItem(pairs(64)))).mode, 'native');
    assert.equal((await store.entity('Item').load({ where: pairs(64) })).length, 32);
    const within = overItems(pairs(64));
    assert.deepEqual(sorted(await items.execute(within)), expectedFor(64));
    assert.deepEqual(sorted(await items.execute(within, { pushdown: false })), expectedFor(64));
    const plan = await items.explain(within);
    assert.equal(plan.mode, 'native');
    assert.equal(plan.params.length, 64, 'one value per leaf: nothing regrouped');
    const where = /\sWHERE (.*) ORDER BY /s.exec(plan.sql)?.[1] ?? '';
    assert.equal((where.match(/THEN 'text' WHEN jsonb_typeof/g) ?? []).length, 0,
      'a literal comparison reads the typed extraction alone: no discriminator per leaf');
    const entityPlan = await store.explain(overItem(pairs(400)));
    assert.equal(entityPlan.mode, 'set');
    assert.equal(reasonId(entityPlan.residual.reasons[0].reason), 'predicate.termBound');
    assert.deepEqual(await store.execute(overItem(pairs(400))), expectedFor(400));
    const long = overItems(pairs(300));
    assert.equal(reasonId((await items.explain(long)).residual.reasons[0].reason), 'predicate.termBound');
    assert.deepEqual(sorted(await items.execute(long)), expectedFor(300));
    assert.deepEqual(sorted(await items.execute(long, { pushdown: false })), expectedFor(300));
    await assert.rejects(store.entity('Item').load({ where: pairs(400) }),
      (/** @type {any} */ error) => error.code === 'JD0032' && /more predicate terms/.test(error.message));
  });

  it('a number list compares as numeric, the type a number column is declared as, so the column index seeks it', async () => {
    const query = overItem({ $eq: ['$it.n', '$ids[*]'] });
    assert.deepEqual(await store.execute(query, { externals: { ids: [1, 2.5, 1999] } }), ['i1', 'i1999']);
    const plan = await store.explain(query, { externals: { ids: [1, 2] } });
    // costed with sequential scans off: the index is usable, not merely unchosen
    await admin.query(`SET search_path TO "${schema}"`);
    await admin.query('SET enable_seqscan = off');
    try {
      const rows = (await admin.query({ text: `EXPLAIN ${plan.sql}`, values: [JSON.stringify([1, 2])] })).rows;
      assert.match(rows.map((/** @type {any} */ row) => row['QUERY PLAN']).join('\n'), /Index Cond: \(\(n = .*::numeric\)/);
    }
    finally {
      await admin.query('RESET enable_seqscan');
      await admin.query('RESET search_path');
    }
  });

  it('a profile predicate naming a bound list binds in the native statement and in the residual\'s root fetch', async () => {
    const profile = { predicates: { Item: { $eq: ['$it.sku', '$allowed[*]'] } } };
    const native = overItem({ $lt: ['$it.n', 10] });
    const residual = overItem({ $eq: [{ $count: '$it.id' }, 1] });
    assert.equal((await store.explain(native, { profile, externals: { allowed: ['s1', 's3'] } })).mode, 'native');
    assert.deepEqual(await store.execute(native, { profile, externals: { allowed: ['s1', 's3', 's11'] } }), ['i1', 'i3']);
    assert.deepEqual(await store.execute(residual, { profile, externals: { allowed: ['s1', 's3'] } }), ['i1', 'i3']);
    // a null the column cannot hold (its NULL reads as absent) matches nothing, as in the engine
    assert.deepEqual(await store.execute(residual, { profile, externals: { allowed: ['s1', null] } }), 'i1');
    assert.deepEqual(await store.execute(native, { profile, externals: { allowed: ['s1', 's3', null] } }), ['i1', 'i3']);
    await assert.rejects(async () => store.execute(residual, { profile, externals: {} }),
      (/** @type {any} */ error) => error.code === 'JD0011' && /cannot bind '\$allowed' for this call/.test(error.message));
  });

  it('an inferred integer foreign key compares as the numeric its key is declared as', async () => {
    const fkSchema = `${schema}_fk`;
    await admin.query(`CREATE SCHEMA "${fkSchema}"`);
    const fkPool = new pg.Pool({ connectionString: url, max: 1 });
    /** @type {any} */
    let fkStore;
    try {
      fkStore = await openStore({ $model: '0.1', entities: {
        User: { schema: { type: 'object', required: ['uid'], properties: { uid: { type: 'integer', ...key },
          posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } } } } },
        Post: { schema: { type: 'object', required: ['pid'], properties: { pid: { type: 'integer', ...key } } } },
      } }, { driver: postgresDriver(fkPool, { schema: fkSchema }) });
      await fkStore.entity('User').create({ uid: 1 });
      await fkStore.entity('Post').create({ pid: 10, authorId: 1 });
      await fkStore.entity('Post').create({ pid: 11 });
      for (const predicate of [{ $eq: ['$p.authorId', 1] }, { $eq: ['$p.authorId', { $seq: [1, 2] }] }, { $eq: ['$p.authorId', '$ids[*]'] }]) {
        const query = { $for: { p: '$.Post[*]' }, $where: predicate, $return: '$p.pid' };
        assert.deepEqual(await fkStore.execute(query, { externals: { ids: [1] } }), 10, JSON.stringify(predicate));
        assert.equal((await fkStore.explain(query, { externals: { ids: [1] } })).mode, 'native');
      }
    }
    finally {
      await fkStore?.close().catch(() => {});
      await fkPool.end().catch(() => {});
      await admin.query(`DROP SCHEMA IF EXISTS "${fkSchema}" CASCADE`);
    }
  });

  it('a bound list holding a null or a boolean runs in the engine; numbers and strings keep their kinds', async () => {
    const query = overItem({ $eq: ['$it.n', '$ids[*]'] });
    assert.deepEqual(await store.execute(query, { externals: { ids: [1, '3', 4.5, 1999] } }), ['i1', 'i1999']);
    assert.equal((await store.explain(query, { externals: { ids: [1, '3'] } })).mode, 'native');
    assert.notEqual((await store.explain(query, { externals: { ids: [1, null] } })).mode, 'native');
    assert.deepEqual(await store.execute(query, { externals: { ids: [1, null, true] } }), 'i1', 'one item answers as itself');
  });
});
