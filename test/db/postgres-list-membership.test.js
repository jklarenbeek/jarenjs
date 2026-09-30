//@ts-check
/**
 * @file Membership over thousands of values on a real PostgreSQL server
 * (the SQLite shapes are `list-membership.test.js`): `$eq` against a bound
 * list, a `$seq` of 5,000 literals and a 5,000-term `$or` of equalities
 * on one member each bind the list as ONE JSON value, the entity column's
 * index seeks it, and a 5,000-term chain no fold applies to nests in
 * halves — it prepares and explains. Every answer equals the residual's.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '@jarenjs/db';
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
      id: { type: 'string', ...key }, sku: { type: 'string', 'x-entity': { index: true } }, n: { type: 'integer' } } } },
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
/** An `$or` no fold applies to, of `terms` terms: equalities on the sku, ranges on n. */
const mixedChain = (terms = 5000) => ({ $or: IDS.slice(0, terms / 2).flatMap((id, i) =>
  [{ $eq: ['$it.sku', id] }, { $gt: ['$it.n', 100000 + i] }]) });
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

  it('a 5,000-term chain no fold applies nests in halves: it prepares, explains and answers', async () => {
    assert.deepEqual(await store.execute(overItem(mixedChain())), sorted(EXPECTED));
    assert.equal((await store.explain(overItem(mixedChain()))).mode, 'native');
    assert.equal((await store.entity('Item').load({ where: mixedChain() })).length, EXPECTED.length);
    // a collection re-derives the member's JSON type in every term, so an
    // unfoldable chain costs per term and row here (2,000 terms over 2,000
    // rows: about 16 s, flat or nested alike): a shorter one for the answer
    const short = overItems(mixedChain(300));
    const expected = IDS.slice(0, 150).map((id) => `i${id.slice(1)}`);
    assert.deepEqual(sorted(await store.collection('items').execute(short)), sorted(expected));
    assert.equal((await store.collection('items').explain(short)).mode, 'native');
  });

  it('a bound list holding a null or a boolean runs in the engine; numbers and strings keep their kinds', async () => {
    const query = overItem({ $eq: ['$it.n', '$ids[*]'] });
    assert.deepEqual(await store.execute(query, { externals: { ids: [1, '3', 4.5, 1999] } }), ['i1', 'i1999']);
    assert.equal((await store.explain(query, { externals: { ids: [1, '3'] } })).mode, 'native');
    assert.notEqual((await store.explain(query, { externals: { ids: [1, null] } })).mode, 'native');
    assert.deepEqual(await store.execute(query, { externals: { ids: [1, null, true] } }), 'i1', 'one item answers as itself');
  });
});
