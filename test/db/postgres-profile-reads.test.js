//@ts-check
/**
 * @file PostgreSQL: a store profile bounds every read (MODEL-FORMAT §8) —
 * a point read binds its predicate's externals from its own options and
 * answers another tenant's key as absent, a read that binds too few is
 * refused, and a per-call profile narrows the store's on the collection,
 * store-root and graph engines instead of replacing it.
 */

import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore } from '@jarenjs/db';
import { postgresDriver } from '@jarenjs/db/postgres';

const url = process.env.JAREN_PG_URL;
const MODEL = {
  $model: '0.1',
  collections: {
    docs: { schema: { type: 'object', properties: { id: { type: 'string' }, tenant: { type: 'string' }, n: { type: 'integer' } } },
      key: '/id' },
  },
  entities: {
    User: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'integer', 'x-entity': { key: true } }, tenant: { type: 'string' }, age: { type: 'integer' } } } },
  },
};
const PROFILE = { externals: ['tenant'],
  predicates: { docs: { $eq: ['$it.tenant', '$tenant'] }, User: { $eq: ['$it.tenant', 'a'] } } };
const IDS = { $for: { it: '$[*]' }, $return: '$it.id' };
const USER_IDS = { $for: { u: '$.User[*]' }, $return: '$u.id' };
const A = { externals: { tenant: 'a' } };
const B = { externals: { tenant: 'b' } };

describe('PostgreSQL: a store profile bounds every read', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  /** @type {any} */
  let pool;
  /** @type {any} */
  let store;
  const schema = `jaren_profile_reads_${process.pid}`;
  before(async () => {
    const pg = (await import('pg')).default;
    pool = new pg.Pool({ connectionString: url, max: 2 });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    store = await openStore(MODEL, { driver: postgresDriver(pool, { schema }), profile: PROFILE });
    for (const [i, tenant] of ['a', 'b', 'a', 'b'].entries()) {
      await store.collection('docs').insert({ id: `${tenant}${i}`, tenant, n: i });
      await store.entity('User').create({ id: i + 1, tenant, age: 20 + i });
    }
  });
  after(async () => {
    try { await store?.close(); }
    finally {
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await pool.end(); }
    }
  });

  it('binds a point read\'s predicate from its own externals', async () => {
    assert.strictEqual(await store.collection('docs').get('b1', A), undefined);
    assert.deepStrictEqual(await store.collection('docs').get('b1', B), { id: 'b1', tenant: 'b', n: 1 });
    assert.strictEqual(await store.collection('docs').get('nobody', A), undefined);
    await store.transaction(async (/** @type {any} */ tx) => {
      assert.strictEqual(await tx.collection('docs').get('b1', A), undefined);
      assert.strictEqual((await tx.collection('docs').get('a0', A)).tenant, 'a');
    });
    // an entity predicate that names no external judges the read without one
    assert.strictEqual(await store.entity('User').get(2), undefined);
    assert.strictEqual((await store.entity('User').asNoTracking().get(1)).tenant, 'a');
  });

  it('refuses a point read, and a query, that do not bind the predicate\'s external', async () => {
    await assert.rejects(async () => store.collection('docs').get('b1'),
      { code: 'JD0011', message: /predicate for 'docs' cannot bind '\$tenant' for this point read/ });
    // a null the string member cannot hold keeps no row, as the query keeps none
    assert.strictEqual(await store.collection('docs').get('b1', { externals: { tenant: null } }), undefined);
    assert.strictEqual(await store.collection('docs').execute(IDS, { externals: { tenant: null } }), undefined);
    await assert.rejects(async () => store.collection('docs').execute(IDS),
      { code: 'JD0011', message: /predicate for 'docs' cannot bind '\$tenant' for this call/ });
  });

  it('narrows the store\'s profile with a per-call one on every engine', async () => {
    const narrowed = { profile: { maxRows: 50 } };
    assert.deepStrictEqual(await store.collection('docs').execute(IDS, { ...A, ...narrowed }), ['a0', 'a2']);
    const pulled = [];
    for await (const id of store.collection('docs').query(IDS, { ...A, ...narrowed })) pulled.push(id);
    assert.deepStrictEqual(pulled, ['a0', 'a2']);
    assert.deepStrictEqual(await store.execute(USER_IDS, narrowed), [1, 3]);
    assert.deepStrictEqual((await store.entity('User').asNoTracking().load({}, narrowed))
      .map((/** @type {any} */ user) => user.id).sort(), [1, 3]);
    assert.deepStrictEqual(await store.collection('docs').execute(IDS,
      { ...A, profile: { predicates: { docs: { $gt: ['$it.n', 0] } } } }), 'a2');
    await assert.rejects(async () => store.collection('docs').execute(IDS, { ...A, profile: { maxRows: 1 } }),
      { code: 'JD2007' });
    await assert.rejects(async () => store.collection('docs').execute(IDS, { ...A, profile: { maxRows: 5000 } }),
      { code: 'JD0011', message: /asks maxRows 5000, and the store's profile allows 1000/ });
    await assert.rejects(async () => store.execute(USER_IDS, { profile: { limits: { steps: 2_000_000 } } }),
      { code: 'JD0011', message: /asks limits\.steps 2000000, and the store's profile allows 1000000/ });
    // 'safe' spells the store's own values here, so it narrows nothing and answers
    assert.deepStrictEqual(await store.execute(USER_IDS, { profile: 'safe' }), [1, 3]);
  });
});
