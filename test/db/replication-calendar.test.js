//@ts-check
/**
 * @file Replay order over a unique calendar member (`x-entity: { temporal,
 * unique: true }`, MODEL-FORMAT §9.3): its unique index is over the text its
 * key columns hold, one per value whatever its spelling, so an envelope that
 * hands such a value from one row to another replays the release before the
 * take exactly as over a unique column — on SQLite and PostgreSQL alike, by
 * `apply` and by `reset`, in each capture mode the engine has — and a rotation, which no order replays, is still
 * refused (`JD2005`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DatabaseSync } from 'node:sqlite';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { storeTemporals } from '@jarenjs/db/temporals';

import { ENGINES, PG_URL, skipFor, withStore } from './store-core-engines.js';
import { tempDbPath } from './helpers.js';

/** Every kind a unique index admits (a zoned key is resolved, and takes none), each value as
 * [held, the same value spelled again, another, a fourth]. */
const KINDS = /** @type {[string, any[]][]} */ ([
  ['utc', ['2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00Z', '2028-01-01T00:00:00.5Z']
    .map((instant) => ({ kind: 'utc', instant }))],
  ['floating', [['2026-07-01', '10:00'], ['2026-07-01', '10:00:00.0'], ['2026-07-02', '10:00'], ['2028-01-01', '09:59:59.5']]
    .map(([date, time]) => ({ kind: 'floating', date, time }))],
  ['date', ['2026-07-01', '2026-07-01', '2026-07-02', '2028-01-01'].map((date) => ({ kind: 'date', date }))],
  ['date-range', [['2026-07-01', '2026-07-03'], ['2026-07-01', '2026-07-03'], ['2026-08-01', '2026-08-03'], ['2028-01-01', '2028-01-02']]
    .map(([start, end]) => ({ kind: 'date-range', start, end }))],
]);

/** @param {string} kind */
const modelOf = (kind) => ({ $model: '0.1', entities: { Ev: { schema: { type: 'object', required: ['id'], properties: {
  id: { type: 'string', 'x-entity': { key: true } }, v: { type: 'object', 'x-entity': { temporal: { kind }, unique: true } } } } } } });

/**
 * Two replicated stores of `model` on `engine`, handed to `fn` and closed
 * (PostgreSQL: one pool, a schema per store, dropped after).
 * @param {string} engine @param {any} model @param {string} mode
 * @param {(a: any, b: any) => Promise<void>} fn
 */
async function replicas(engine, model, mode, fn) {
  const options = (/** @type {string} */ replica) => ({ temporals: storeTemporals(), capture: { mode }, replication: { replica } });
  if (engine === 'sqlite') {
    const a = await openStore(model, { driver: nodeDriver(), ...options('a') });
    const b = await openStore(model, { driver: nodeDriver(), ...options('b') });
    try { await fn(a, b); }
    finally { await a.close(); await b.close(); }
    return;
  }
  const { default: pg } = await import('pg');
  const { postgresDriver } = await import('@jarenjs/db/postgres');
  const pool = new pg.Pool({ connectionString: PG_URL, max: 3 });
  const schemas = ['a', 'b'].map((replica) => `jaren_replication_calendar_${process.pid}_${replica}`);
  const stores = [];
  try {
    for (const schema of schemas) await pool.query(`CREATE SCHEMA "${schema}"`);
    for (const [at, schema] of schemas.entries())
      stores.push(await openStore(model, { driver: postgresDriver(pool, { schema }), ...options(at === 0 ? 'a' : 'b') }));
    await fn(stores[0], stores[1]);
  }
  finally {
    for (const store of stores) await store.close();
    for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool.end();
  }
}

/** Every spelling the calendar admits of a time and of an instant, each kind's key read from it. */
const SPELLINGS = /** @type {[string, any][]} */ ([
  ...['10:00', '10:00:00', '10:00:00.5', '10:00:00.25', '10:00:00.125', '23:59:59.999']
    .map((time) => ['f', { kind: 'floating', date: '2026-07-01', time }]),
  ...['2026-01-01T00:00:00Z', '2026-01-01T00:00:00.5Z', '2026-01-01T00:00:00.25Z', '2026-01-01T00:00:00.125Z', '0000-01-01T00:00:00Z', '9999-12-31T23:59:59.999Z']
    .map((instant) => ['u', { kind: 'utc', instant }]),
  ['d', { kind: 'date', date: '2026-02-28' }],
  ['r', { kind: 'date-range', start: '2026-07-01', end: '2026-07-15' }],
]);
const SPELLED = { $model: '0.1', entities: { Ev: { schema: { type: 'object', required: ['id'], properties: {
  id: { type: 'string', 'x-entity': { key: true } },
  ...Object.fromEntries([['f', 'floating'], ['u', 'utc'], ['d', 'date'], ['r', 'date-range']]
    .map(([name, kind]) => [name, { type: 'object', 'x-entity': { temporal: { kind } } }])) } } } } };

/** The rows a store holds, in key order. @param {any} store */
const rowsOf = async (store) => store.entity('Ev').asNoTracking().load({ orderBy: ['$it.id'] });

for (const engineName of ENGINES) {
  describe(`${engineName}: replay orders a unique calendar member by its key`, { skip: skipFor(engineName) }, () => {
    it('replays a value handed to a row sorting first, in another spelling, after the row giving it up', async () => {
      const outcomes = [];
      const expected = [];
      for (const [kind, [held, again, other, fourth]] of KINDS) for (const mode of engineName === 'sqlite' ? ['session', 'journal'] : ['journal']) for (const how of ['apply', 'reset']) {
        await replicas(engineName, modelOf(kind), mode, async (a, b) => {
          await a.transaction(async (/** @type {any} */ tx) => {
            await tx.entity('Ev').create({ id: 'a1', v: other });
            await tx.entity('Ev').create({ id: 'z9', v: held });
          });
          await b.replication.apply((await a.replication.page({ after: 0 })).items[0]);
          // `a1` sorts first and takes what `z9` gives up
          await a.transaction(async (/** @type {any} */ tx) => {
            await tx.entity('Ev').update('z9', { v: fourth });
            await tx.entity('Ev').update('a1', { v: again });
          });
          const label = `${kind} ${mode} ${how}`;
          try {
            const result = how === 'apply' ? await b.replication.apply((await a.replication.page({ after: 1 })).items[0])
              : await b.replication.reset(await a.replication.snapshot());
            outcomes.push(`${label}: ${result.status}`);
            assert.deepEqual(await rowsOf(b), await rowsOf(a), label);
          }
          catch (error) { outcomes.push(`${label}: ${/** @type {any} */ (error).code}`); }
          expected.push(`${label}: ${how === 'apply' ? 'applied' : 'reset'}`);
        });
      }
      assert.deepEqual(outcomes, expected);
    });

    it('reads a calendar member as its generated key columns hold it, every spelling', async () => {
      const seam = storeTemporals();
      const expected = SPELLINGS.map(([, value], i) => [`s${i}`, seam.hooks.keyValues({ kind: value.kind }, value)]);
      const columns = (/** @type {string} */ name) => (name === 'r' ? ['tk_r', 'tk_r$end'] : [`tk_${name}`]);
      const read = (/** @type {any[]} */ rows) => SPELLINGS.map(([name], i) => {
        const row = rows.find((candidate) => candidate.id === `s${i}`);
        return [row.id, columns(name).map((column) => row[column])];
      });
      const write = async (/** @type {any} */ store) => {
        for (const [i, [name, value]] of SPELLINGS.entries()) await store.entity('Ev').create({ id: `s${i}`, [name]: value });
      };
      if (engineName === 'sqlite') {
        const { dbPath: path, cleanup } = tempDbPath();
        try {
          await withStore('sqlite', SPELLED, write, { temporals: seam, path });
          const db = new DatabaseSync(path);
          try { assert.deepEqual(read(db.prepare('SELECT * FROM "Ev"').all()), expected); }
          finally { db.close(); }
        }
        finally { cleanup(); }
        return;
      }
      await withStore('postgres', SPELLED, async (store, pg) => {
        await write(store);
        const { rows } = await /** @type {any} */ (pg).pool.query(`SELECT * FROM "${/** @type {any} */ (pg).schema}"."Ev"`);
        assert.deepEqual(read(rows), expected);
      }, { temporals: seam });
    });

    it('refuses a rotation, as over a unique column (JD2005)', async () => {
      for (const [kind, [held, again, other, fourth]] of KINDS) {
        await replicas(engineName, modelOf(kind), 'journal', async (a, b) => {
          await a.transaction(async (/** @type {any} */ tx) => {
            await tx.entity('Ev').create({ id: 'u1', v: held });
            await tx.entity('Ev').create({ id: 'u2', v: other });
          });
          await b.replication.apply((await a.replication.page({ after: 0 })).items[0]);
          await a.transaction(async (/** @type {any} */ tx) => {
            await tx.entity('Ev').update('u1', { v: fourth });
            await tx.entity('Ev').update('u2', { v: again });
            await tx.entity('Ev').update('u1', { v: other });
          });
          await assert.rejects(b.replication.apply((await a.replication.page({ after: 1 })).items[0]), { code: 'JD2005' }, kind);
        });
      }
    });
  });
}
