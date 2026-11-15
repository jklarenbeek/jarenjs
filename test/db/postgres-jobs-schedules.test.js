//@ts-check
/** Recurring job schedules answer identically on PostgreSQL and SQLite (JOBS-FORMAT §11): one clock, one scenario. */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { postgresDriver } from '@jarenjs/db/postgres';
import { nodeDriver } from '@jarenjs/db/node';
import { jobSchedules } from '@jarenjs/db/schedules';
import { createRuntime } from '@jarenjs/core/runtime';
import { compileRecurrence, floatingValue } from '@jarenjs/core/calendar';
import { model, scenarioClock, runScenario, assertScenario, ZONE } from './schedules-scenario.js';

const url = process.env.JAREN_PG_URL;
const daily = compileRecurrence({ dtstart: floatingValue('2026-03-01', '09:00'), rrule: 'FREQ=DAILY' });

describe('PostgreSQL recurring job schedules', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  let pg, serial = 0;
  before(async () => { pg = (await import('pg')).default; });
  async function fixture(fn) {
    const schema = `jaren_schedules_${process.pid}_${serial++}`;
    const pool = new pg.Pool({ connectionString: url, max: 3 });
    const stores = [];
    const open = async (options) => {
      const store = await openStore(model, { driver: postgresDriver(pool, { schema }), ...options });
      stores.push(store);
      return store;
    };
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      await fn({ pool, schema, open });
    }
    finally {
      try { for (const store of stores) await store.close(); }
      finally {
        try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
        finally { await pool.end(); }
      }
    }
  }

  it('answers the scenario as SQLite does: records, fired ids, missed, refusals, stall, unresolved', async () => {
    await fixture(async ({ open }) => {
      const { clock, provider, options } = scenarioClock();
      const native = await open(options());
      const sqlite = await openStore(model, { driver: nodeDriver(), ...options() });
      try {
        const [onPostgres, onSqlite] = await runScenario([native, sqlite], clock);
        assert.deepEqual(onPostgres, onSqlite);
        assertScenario(onPostgres, provider, assert);
      }
      finally { await sqlite.close(); }
    });
  });

  it('stores epochs as NUMERIC and text in the C collation, and creates the table at the first schedule', async () => {
    await fixture(async ({ pool, schema, open }) => {
      const { options } = scenarioClock();
      const store = await open(options());
      const tables = async () => (await pool.query(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name', [schema])).rows.map((row) => row.table_name);
      assert.ok(!(await tables()).includes('_jaren_job_schedules'));
      assert.deepEqual(await store.jobs.schedules(), []);
      await store.jobs.schedule({ id: 'd', kind: 'digest', series: daily, zone: ZONE, missed: 'skip' });
      assert.ok((await tables()).includes('_jaren_job_schedules'));
      const columns = (await pool.query('SELECT column_name, data_type, collation_name FROM information_schema.columns '
        + "WHERE table_schema = $1 AND table_name = '_jaren_job_schedules' ORDER BY ordinal_position", [schema])).rows;
      assert.deepEqual(columns.filter((row) => row.data_type === 'numeric').map((row) => row.column_name),
        ['next_run_at', 'last_run_at', 'created_at', 'updated_at']);
      assert.ok(columns.filter((row) => row.data_type === 'text').every((row) => row.collation_name === 'C'));
      assert.equal(columns.length, 19);
    });
  });

  it('fires each due occurrence once when two clients tick at once', async () => {
    await fixture(async ({ open }) => {
      const { clock, options } = scenarioClock();
      const a = await open(options());
      const b = await open(options());
      const ids = Array.from({ length: 40 }, (_, i) => `s${String(i).padStart(2, '0')}`);
      for (const id of ids) await a.jobs.schedule({ id, kind: 'digest', series: daily, zone: ZONE, missed: 'skip' });
      clock.at = Date.UTC(2026, 2, 21, 8);
      const [x, y] = await Promise.all([a.jobs.tick({ limit: 1000 }), b.jobs.tick({ limit: 1000 })]);
      const fired = [...x.fired, ...y.fired].sort();
      assert.deepEqual(fired, ids.map((id) => `${id}@2026-03-21T09:00:00`));
      assert.equal(x.advanced + y.advanced, ids.length);
      for (const record of await a.jobs.schedules()) assert.deepEqual(record.counts, { fired: 1, skipped: 0 }, record.id);
      assert.equal((await a.jobs.counts()).pending, ids.length);
    });
  });

  it('refuses an adopted store without the table and a tick without a zone provider, as SQLite does', async () => {
    await fixture(async ({ open }) => {
      const { clock, options } = scenarioClock();
      const writer = await open(options());
      const adopted = await open({ ...options(), adopt: true });
      await assert.rejects(async () => adopted.jobs.schedule({ id: 'd', kind: 'k', series: daily, zone: ZONE, missed: 'skip' }), { code: 'JD0002' });
      assert.deepEqual(await adopted.jobs.schedules(), []);
      const before = await writer.jobs.schedule({ id: 'd', kind: 'k', series: daily, zone: ZONE, missed: 'skip' });
      assert.deepEqual(await adopted.jobs.schedules(), [before]);
      const bare = await open({ runtime: createRuntime({ now: () => clock.at }), jobs: { now: () => clock.at, schedules: jobSchedules() } });
      clock.at = Date.UTC(2026, 2, 21, 8);
      await assert.rejects(async () => bare.jobs.tick(), { code: 'JD0016' });
      assert.deepEqual(await writer.jobs.schedules(), [before]);
      assert.deepEqual((await writer.jobs.tick()).fired, ['d@2026-03-21T09:00:00']);
    });
  });
});
