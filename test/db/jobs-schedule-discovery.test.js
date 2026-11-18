//@ts-check
/**
 * @file A running worker finds a schedule table another PROCESS creates
 * (JOBS-FORMAT §6): the worker ticks from a start before the table
 * existed, a child process writes the database's first schedule, and the
 * worker's probe — one every 16 of its polls — finds it and fires the
 * occurrence within that bound, without a restart. On SQLite (one file)
 * and, where JAREN_PG_URL names a server, on PostgreSQL (one schema).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';
import { model, scenarioClock, HOUR } from './schedules-scenario.js';
import { tempDbPath } from './helpers.js';

const url = process.env.JAREN_PG_URL;
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const run = promisify(execFile);

/** The other process: it opens the same database and writes the first schedule at the instant it is given. */
const WRITER = `
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';
import { jobSchedules } from '@jarenjs/db/schedules';
import { createRuntime } from '@jarenjs/core/runtime';
import { compileRecurrence, floatingValue } from '@jarenjs/core/calendar';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
const { engine, path, url, schema, at, model } = JSON.parse(process.env.JAREN_SCHEDULE_WRITER);
const pool = engine === 'postgres' ? new (await import('pg')).default.Pool({ connectionString: url, max: 1 }) : null;
const now = () => at;
const store = await openStore(model, { driver: pool === null ? nodeDriver() : postgresDriver(pool, { schema }),
  ...(path === null ? {} : { path }),
  runtime: createRuntime({ zoneProvider: createIntlZoneProvider({ revision: 'host ICU' }), now }),
  jobs: { now, schedules: jobSchedules() } });
try {
  await store.jobs.schedule({ id: 'daily', kind: 'digest', missed: 'skip', zone: 'Europe/Amsterdam',
    series: compileRecurrence({ dtstart: floatingValue('2026-03-01', '09:00'), rrule: 'FREQ=DAILY' }) });
}
finally {
  await store.close();
  await pool?.end();
}
process.stdout.write('written');
`;

/** Wait, bounded, until a condition holds. @param {() => any} done @param {string} what */
async function until(done, what) {
  const deadline = Date.now() + 20_000;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

for (const engine of /** @type {const} */ (['sqlite', 'postgres'])) {
  describe(`schedule table discovery across processes on ${engine}`, { skip: engine === 'postgres' && !url && 'JAREN_PG_URL is not set' }, () => {
    it('a running worker fires the first schedule another process writes within 16 of its polls', async () => {
      const file = engine === 'sqlite' ? tempDbPath() : null;
      const schema = `jaren_scheduleprocess_${process.pid}`;
      /** @type {any} */
      let pool = null;
      if (engine === 'postgres') {
        // two connections here and one in the writer
        pool = new (await import('pg')).default.Pool({ connectionString: url, max: 2 });
        await pool.query(`CREATE SCHEMA "${schema}"`);
      }
      const { clock, options } = scenarioClock();
      const store = await openStore(model, { driver: pool === null ? nodeDriver() : postgresDriver(pool, { schema }),
        ...(file === null ? {} : { path: file.dbPath }), ...options() });
      /** @type {string[]} */
      const ran = [];
      const worker = store.jobs.createWorker({ pollInterval: 5, tick: true,
        handlers: { digest: (/** @type {unknown} */ _payload, /** @type {any} */ context) => { ran.push(context.job.id); } } }).start();
      try {
        await until(() => worker.stats().polls >= 2, 'the worker\'s first probes');
        assert.equal(worker.stats().ticks, 0, 'no schedule table yet: nothing ticked');
        const written = await run(process.execPath, ['--no-warnings', '--input-type=module', '-e', WRITER], {
          cwd: ROOT,
          env: { ...process.env, FORCE_COLOR: '0', JAREN_SCHEDULE_WRITER: JSON.stringify({ engine, path: file?.dbPath ?? null,
            url: url ?? null, schema, at: clock.at, model }) },
        });
        assert.equal(written.stdout, 'written');
        const from = worker.stats().polls;
        // the first occurrence after the schedule's creation: 09:00 in Amsterdam on 21 March
        clock.at = Date.UTC(2026, 2, 21, 8) + HOUR;
        await until(() => ran.length === 1, 'the first occurrence run');
        const polls = worker.stats().polls - from;
        assert.ok(polls <= 17, `found after ${polls} polls`);
        assert.deepEqual(ran, ['daily@2026-03-21T09:00:00']);
        assert.ok(worker.stats().ticks > 0);
        assert.equal(worker.stats().tickErrors, 0);
      }
      finally {
        await worker.stop();
        await store.close();
        if (pool !== null) {
          await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          await pool.end();
        }
        file?.cleanup();
      }
    });
  });
}
