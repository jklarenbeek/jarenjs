//@ts-check
/**
 * @file A probe under row-level security on PostgreSQL. PostgreSQL applies a
 * table's UPDATE policy to a locking read, so for a writer whose UPDATE policy
 * is narrower than its SELECT policy a locking probe misses a row the writer
 * may read. A strictly positive probe — the one that locks, a store rule's and
 * a database rule's program alike — therefore refuses a write whose row exists
 * outside the UPDATE policy (MODEL-FORMAT §13.3: a writer references only rows
 * it may also lock), while a negated probe reads unlocked, through the SELECT
 * policy, and refuses the write a row it may read forbids. Live server only
 * (`JAREN_PG_URL`; skipped without it, or where its role creates no roles):
 * one role created and dropped, three connections at most.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { PG_URL, withPostgres } from './store-core-engines.js';

const skip = !PG_URL && 'JAREN_PG_URL is not set';
const CHILD = { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, ref: { type: 'integer' } } };
/** A child whose rule of `enforcement` requires its parent by the key, or forbids a blocked parent. @param {string} enforcement @param {boolean} negated */
const child = (enforcement, negated) => ({ schema: CHILD, invariants: [{ name: 'r', on: ['insert'], enforcement, assert: negated
  ? { $not: { '$exists-row': { entity: 'Parent', match: { id: '$.new.ref', status: 'blocked' } } } }
  : { '$exists-row': { entity: 'Parent', match: { id: '$.new.ref' } } } }] });
const model = { $model: '0.1', entities: {
  Parent: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, tenant: { type: 'string' }, status: { type: 'string' } } } },
  DatabaseKey: child('database', false), DatabaseNot: child('database', true), StoreKey: child('store', false), StoreNot: child('store', true),
} };
const CHILDREN = ['DatabaseKey', 'DatabaseNot', 'StoreKey', 'StoreNot'];

describe('a probe under row-level security on PostgreSQL', () => {
  it('locks only where it decides that a write passes: a negated probe reads through the SELECT policy, a positive one through the UPDATE policy', { skip }, (t) =>
    withPostgres(async ({ pool, schema, driver }) => {
      const { default: pg } = await import('pg');
      const { postgresDriver } = await import('@jarenjs/db/postgres');
      const can = (await pool.query('SELECT rolcreaterole OR rolsuper AS can FROM pg_roles WHERE rolname = current_user')).rows[0]?.can;
      if (!can) return t.skip('the server role creates no roles');
      const role = `jaren_probe_rls_${process.pid}`;
      const store = await openStore(model, { driver: driver() });
      try {
        // tenant a's parents the writer may update; tenant b's it may read alone; parent 3 is blocked
        for (const [id, tenant, status] of [[1, 'a', 'open'], [2, 'b', 'open'], [3, 'b', 'blocked']]) await store.entity('Parent').create({ id, tenant, status });
      }
      finally { await store.close(); }
      const tables = CHILDREN.map((name) => `"${schema}"."${name}"`).join(', ');
      await pool.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'jaren-probe'`);
      try {
        await pool.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"; GRANT USAGE ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${role}";
          GRANT SELECT, UPDATE (status) ON "${schema}"."Parent" TO "${role}"; GRANT SELECT, INSERT, UPDATE, DELETE ON ${tables} TO "${role}";
          ALTER TABLE "${schema}"."Parent" ENABLE ROW LEVEL SECURITY;
          CREATE POLICY reads ON "${schema}"."Parent" FOR SELECT TO "${role}" USING (true);
          CREATE POLICY updates ON "${schema}"."Parent" FOR UPDATE TO "${role}" USING (tenant = 'a')`);
        const url = new URL(/** @type {string} */ (PG_URL));
        url.username = role;
        url.password = 'jaren-probe';
        const writerPool = new pg.Pool({ connectionString: url.href, max: 1 });
        try {
          const writer = await openStore(model, { driver: postgresDriver(writerPool, { schema }) });
          try {
            /** @type {Record<string, string>} */
            const verdicts = {};
            let id = 0;
            for (const [name, ref] of /** @type {[string, number][]} */ ([['DatabaseKey', 1], ['DatabaseKey', 2], ['StoreKey', 1], ['StoreKey', 2],
              ['DatabaseNot', 1], ['DatabaseNot', 3], ['StoreNot', 1], ['StoreNot', 3]]))
              verdicts[`${name} ${ref}`] = await writer.entity(name).create({ id: ++id, ref }).then(() => 'ok', (/** @type {any} */ error) => error.code);
            assert.deepEqual(verdicts, {
              'DatabaseKey 1': 'ok', 'StoreKey 1': 'ok',
              // the parent exists and the writer may read it, but not lock it: refused in the rule's name, as documented
              'DatabaseKey 2': 'JD2096', 'StoreKey 2': 'JD2096',
              'DatabaseNot 1': 'ok', 'StoreNot 1': 'ok',
              // the blocked parent the writer may read refuses the write
              'DatabaseNot 3': 'JD2096', 'StoreNot 3': 'JD2096',
            });
          }
          finally { await writer.close(); }
        }
        finally { await writerPool.end(); }
      }
      finally {
        await pool.query(`DROP OWNED BY "${role}"; DROP ROLE IF EXISTS "${role}"`);
      }
    }));
});
