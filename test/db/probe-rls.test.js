//@ts-check
/**
 * @file A probe under row-level security on PostgreSQL. PostgreSQL applies a
 * table's UPDATE policy to a locking read, so for a writer whose UPDATE policy
 * is narrower than its SELECT policy a locking probe misses a row the writer
 * may read. A strictly positive probe — the one that locks, a store rule's and
 * a database rule's program alike — therefore refuses a write whose row exists
 * outside the UPDATE policy (MODEL-FORMAT §13.3: a writer references only rows
 * it may also lock): a store rule asks its missed probe once more unlocked, on
 * the refusal alone, and refuses `JD2099` where that read finds the row and the
 * rule passes on it, while a database rule's program refuses in the rule's
 * name. A negated probe reads unlocked, through the SELECT policy, and refuses
 * the write a row it may read forbids. Live server only
 * (`JAREN_PG_URL`; skipped without it, or where its role creates no roles):
 * one role created and dropped, three connections at most.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StatementSync } from 'node:sqlite';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { PG_URL, withPostgres } from './store-core-engines.js';

const skip = !PG_URL && 'JAREN_PG_URL is not set';
const CHILD = { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, ref: { type: 'integer' } } };
/** A child whose rule of `enforcement` requires its parent by the key, or forbids a blocked parent. @param {string} enforcement @param {boolean} negated */
const child = (enforcement, negated) => ({ schema: CHILD, invariants: [{ name: 'r', on: ['insert'], enforcement, assert: negated
  ? { $not: { '$exists-row': { entity: 'Parent', match: { id: '$.new.ref', status: 'blocked' } } } }
  : { '$exists-row': { entity: 'Parent', match: { id: '$.new.ref' } } } }] });
/** A child whose store rule requires its parent by the key and a ref other than 2, which a found parent 2 does not pass. */
const storeAnd = { schema: CHILD, invariants: [{ name: 'r', on: ['insert'], enforcement: 'store',
  assert: { $and: [{ '$exists-row': { entity: 'Parent', match: { id: '$.new.ref' } } }, { $ne: ['$.new.ref', 2] }] } }] };
const model = { $model: '0.1', entities: {
  Parent: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, tenant: { type: 'string' }, status: { type: 'string' } } } },
  DatabaseKey: child('database', false), DatabaseNot: child('database', true), StoreKey: child('store', false), StoreNot: child('store', true),
  StoreAnd: storeAnd,
} };
const CHILDREN = ['DatabaseKey', 'DatabaseNot', 'StoreKey', 'StoreNot', 'StoreAnd'];

describe('a refused store rule on SQLite, whose probe takes no lock', () => {
  it('runs its probe once: an unlocked read would answer as the probe did', async () => {
    // each run of a statement, by its text
    const recorded = /** @type {string[]} */ ([]);
    const get = StatementSync.prototype.get;
    const store = await openStore(model, { driver: nodeDriver() });
    try {
      await store.entity('Parent').create({ id: 1, tenant: 'a', status: 'open' });
      StatementSync.prototype.get = function (/** @type {any[]} */ ...rest) {
        recorded.push(this.sourceSQL);
        return get.apply(this, rest);
      };
      assert.equal(await store.entity('StoreKey').create({ id: 1, ref: 2 }).then(() => 'ok', (/** @type {any} */ error) => error.code), 'JD2096');
    }
    finally {
      StatementSync.prototype.get = get;
      await store.close();
    }
    assert.equal(recorded.filter((sql) => sql.includes('"_jaren_row"')).length, 1, recorded.join('\n'));
  });
});

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
        // the probes each write runs, counted by the write's label
        /** @type {string[]} */
        let recorded = [];
        writerPool.on('connect', (/** @type {any} */ client) => {
          const query = client.query.bind(client);
          client.query = (/** @type {any} */ q, /** @type {any[]} */ ...rest) => {
            const sql = typeof q === 'string' ? q : q?.text ?? '';
            if (sql.includes('"_jaren_row"')) recorded.push(sql.includes(' FOR KEY SHARE) AS') ? 'locked' : 'unlocked');
            return query(q, ...rest);
          };
        });
        try {
          const writer = await openStore(model, { driver: postgresDriver(writerPool, { schema }) });
          try {
            /** @type {Record<string, string>} */
            const verdicts = {};
            /** @type {Record<string, string[]>} */
            const probes = {};
            let id = 0;
            for (const [name, ref] of /** @type {[string, number][]} */ ([['DatabaseKey', 1], ['DatabaseKey', 2], ['StoreKey', 1], ['StoreKey', 2],
              ['DatabaseNot', 1], ['DatabaseNot', 3], ['StoreNot', 1], ['StoreNot', 3], ['StoreAnd', 1], ['StoreAnd', 2], ['StoreKey', 4]])) {
              recorded = [];
              verdicts[`${name} ${ref}`] = await writer.entity(name).create({ id: ++id, ref }).then(() => 'ok', (/** @type {any} */ error) => error.code);
              if (name.startsWith('Store')) probes[`${name} ${ref}`] = recorded;
            }
            assert.deepEqual(verdicts, {
              'DatabaseKey 1': 'ok', 'StoreKey 1': 'ok',
              // the parent exists and the writer may read it, but not lock it: a store rule says so, a program refuses in the rule's name
              'DatabaseKey 2': 'JD2096', 'StoreKey 2': 'JD2099',
              'DatabaseNot 1': 'ok', 'StoreNot 1': 'ok',
              // the blocked parent the writer may read refuses the write
              'DatabaseNot 3': 'JD2096', 'StoreNot 3': 'JD2096',
              // the unlocked read finds parent 2, but the rule refuses it anyway: the rule's own refusal
              'StoreAnd 1': 'ok', 'StoreAnd 2': 'JD2096',
              // no parent 4 at all: the rule's own refusal, after the one unlocked read
              'StoreKey 4': 'JD2096',
            });
            // a write that passes runs its probe once; only a refused one asks again, unlocked; a negated probe reads unlocked once
            assert.deepEqual(probes, {
              'StoreKey 1': ['locked'], 'StoreKey 2': ['locked', 'unlocked'], 'StoreNot 1': ['unlocked'], 'StoreNot 3': ['unlocked'],
              'StoreAnd 1': ['locked'], 'StoreAnd 2': ['locked', 'unlocked'], 'StoreKey 4': ['locked', 'unlocked'],
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
