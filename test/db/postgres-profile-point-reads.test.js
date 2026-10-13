//@ts-check
/**
 * @file A point read on a profiled store, on a live PostgreSQL server
 * (`JAREN_PG_URL`; skipped without it, two connections at most): the row of
 * a key is answered only when the root's mandatory predicate keeps it, and
 * agrees row for row with the query engine's answer, for a collection and
 * for an entity, on the same cases the SQLite file runs.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { skipFor, withStore } from './store-core-engines.js';

const MODEL = {
  $model: '0.1',
  collections: {
    docs: {
      schema: { type: 'object', properties: { id: { type: 'string' }, tenant: {}, n: { type: 'integer' } } },
      key: '/id',
    },
  },
  entities: {
    User: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'integer', 'x-entity': { key: true } },
          tenant: { type: 'string', 'x-entity': { index: true } },
          age: { type: 'integer' },
          active: { type: 'boolean' },
        },
      },
    },
  },
};

const skip = skipFor('postgres');

/** @param {any} seen @returns {any[]} */
const listed = (seen) => (Array.isArray(seen) ? seen : seen === undefined ? [] : [seen]);

describe('a point read on a profiled store, on PostgreSQL', { skip }, () => {
  const SHAPES = [
    { id: 'm1', tenant: 'a', n: 1 },
    { id: 'm2', tenant: 'b', n: 2 },
    { id: 'm3', n: 3 },
    { id: 'm4', tenant: null, n: 4 },
    { id: 'm5', tenant: 5, n: 5 },
    { id: 'm6', tenant: 'a' },
    { id: 'm7', tenant: 'A', n: 7 },
    { id: 'm8', tenant: '', n: 8 },
  ];
  const PREDICATES = [
    { $eq: ['$it.tenant', 'a'] },
    { $ne: ['$it.tenant', 'a'] },
    { $not: { $eq: ['$it.tenant', 'a'] } },
    { $and: [{ $eq: ['$it.tenant', 'a'] }, { $gt: ['$it.n', 0] }] },
    { $or: [{ $eq: ['$it.tenant', 'b'] }, { $ge: ['$it.n', 7] }] },
    { $gt: ['$it.n', 3] },
    { $exists: '$it.n' },
  ];

  it('a collection row is answered only when the predicate keeps it, as the query engine keeps it', async () => {
    for (const predicate of PREDICATES) {
      await withStore('postgres', MODEL, async (store) => {
        for (const doc of SHAPES) await store.collection('docs').insert(doc);
        const ids = listed(await store.collection('docs').execute({ $for: { it: '$[*]' }, $return: '$it.id' }));
        for (const { id } of SHAPES) {
          assert.strictEqual((await store.collection('docs').get(id)) !== undefined, ids.includes(id),
            `${JSON.stringify(predicate)}: ${id}`);
        }
        assert.ok(ids.length > 0 && ids.length < SHAPES.length, JSON.stringify(predicate));
        await store.transaction(async (/** @type {any} */ tx) => {
          assert.strictEqual((await tx.collection('docs').get('m1')) !== undefined, ids.includes('m1'));
        });
      }, { profile: { predicates: { docs: predicate } } });
    }
  });

  it('an entity row is answered only when the predicate keeps it, as the query engine keeps it', async () => {
    const rows = [
      { id: 1, tenant: 'a', age: 30, active: true }, { id: 2, tenant: 'b', age: 30, active: true },
      { id: 3, tenant: 'a', age: 10, active: false }, { id: 4, tenant: 'b', age: 41, active: false },
      { id: 5, tenant: 'a', age: 45, active: true }, { id: 6, tenant: 'c', age: 5, active: true },
    ];
    const predicates = [
      { $eq: ['$it.tenant', 'a'] },
      { $and: [{ $ge: ['$it.age', 30] }, { $eq: ['$it.active', true] }] },
      { $or: [{ $lt: ['$it.age', 20] }, { $not: { $eq: ['$it.tenant', 'a'] } }] },
    ];
    for (const predicate of predicates) {
      await withStore('postgres', MODEL, async (store) => {
        for (const row of rows) await store.entity('User').create(row);
        const ids = listed(await store.execute({ $for: { u: '$.User[*]' }, $return: '$u.id' }));
        for (const { id } of rows) {
          assert.strictEqual((await store.entity('User').get(id)) !== undefined, ids.includes(id),
            `${JSON.stringify(predicate)}: ${id}`);
          assert.strictEqual((await store.entity('User').asNoTracking().get(id)) !== undefined, ids.includes(id));
        }
        assert.ok(ids.length > 0 && ids.length < rows.length, JSON.stringify(predicate));
      }, { profile: { predicates: { User: predicate } } });
    }
  });

  it('answers a root whose predicate names an external as stored', async () => {
    const profile = { externals: ['tenant'], predicates: { docs: { $eq: ['$it.tenant', '$tenant'] } } };
    await withStore('postgres', MODEL, async (store) => {
      await store.collection('docs').insert({ id: 'b1', tenant: 'b' });
      assert.strictEqual((await store.collection('docs').get('b1')).tenant, 'b');
    }, { profile });
  });
});
