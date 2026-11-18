//@ts-check
/**
 * @file Recurring job schedules over SECONDLY, MINUTELY and HOURLY rules
 * (JOBS-FORMAT §11): every frequency the calendar enumerates is accepted
 * and fired, a day without ticks fires exactly what `missed` says within
 * the calendar's limits, a search the limits stop fires the prefix it
 * proved and stalls, and a tick looks past itself by the rule's own
 * period. Each test body runs on SQLite and, where JAREN_PG_URL names a
 * server, on PostgreSQL, answering the same values.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';
import { jobSchedules } from '@jarenjs/db/schedules';
import { createRuntime } from '@jarenjs/core/runtime';
import { compileRecurrence, floatingValue, utcValue, zonedValue } from '@jarenjs/core/calendar';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { model, ZONE } from './schedules-scenario.js';

const url = process.env.JAREN_PG_URL;
const SECOND = 1000;
const DAY = 86400000;
const T0 = Date.UTC(2026, 2, 20, 12);
const secondly = compileRecurrence({ dtstart: utcValue('2026-03-20T12:00:00Z'), rrule: 'FREQ=SECONDLY' });
/** An occurrence id of `secondly`, `seconds` after its start. @param {number} seconds */
const idAt = (seconds) => new Date(T0 + seconds * SECOND).toISOString().replace('.000Z', 'Z');

/** A provider that counts the calls a tick makes to it. */
function countingProvider() {
  const base = createIntlZoneProvider({ revision: 'host ICU' });
  const counter = { calls: 0 };
  const provider = Object.freeze({
    ...base,
    toParts: (/** @type {any[]} */ ...args) => { counter.calls += 1; return base.toParts(...args); },
    candidates: (/** @type {any[]} */ ...args) => { counter.calls += 1; return base.candidates(...args); },
  });
  return { provider, counter };
}

/** @type {any} */
let pool = null;
let serial = 0;
before(async () => {
  if (!url) return;
  const pg = (await import('pg')).default;
  pool = new pg.Pool({ connectionString: url, max: 3 });
});
after(async () => { await pool?.end(); });

/**
 * One store over a fresh database on an engine, with a clock the test steps.
 * @param {'sqlite' | 'postgres'} engine
 * @param {(store: any, clock: { at: number }, counter: { calls: number }) => Promise<void>} fn
 */
async function withStore(engine, fn) {
  const schema = `jaren_subdaily_${process.pid}_${serial++}`;
  const clock = { at: T0 };
  const now = () => clock.at;
  const { provider, counter } = countingProvider();
  if (engine === 'postgres') await pool.query(`CREATE SCHEMA "${schema}"`);
  const driver = engine === 'sqlite' ? nodeDriver() : postgresDriver(pool, { schema });
  const store = await openStore(model, { driver, runtime: createRuntime({ zoneProvider: provider, now }),
    jobs: { now, random: () => 0, schedules: jobSchedules() } });
  try { await fn(store, clock, counter); }
  finally {
    try { await store.close(); }
    finally { if (engine === 'postgres') await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
  }
}

/** What every engine answers; the PostgreSQL run is compared against it. */
const answers = new Map();

for (const engine of /** @type {const} */ (['sqlite', 'postgres'])) {
  describe(`sub-daily recurring schedules on ${engine}`, { skip: engine === 'postgres' && !url && 'JAREN_PG_URL is not set' }, () => {
    /** @param {string} name @param {any} value */
    const same = (name, value) => {
      if (engine === 'sqlite') answers.set(name, value);
      else if (answers.has(name)) assert.deepEqual(value, answers.get(name), `${name}: the same answer as SQLite`);
    };

    it('accepts every frequency the calendar enumerates, of every kind, and fires each occurrence once', async () => {
      await withStore(engine, async (store, clock) => {
        /** @type {[string, any, any][]} */
        const rules = [
          ['utc-s', compileRecurrence({ dtstart: utcValue('2026-03-20T12:00:00Z'), rrule: 'FREQ=SECONDLY;INTERVAL=20' }), {}],
          ['utc-m', compileRecurrence({ dtstart: utcValue('2026-03-20T12:00:30Z'), rrule: 'FREQ=MINUTELY' }), {}],
          ['zoned-m', compileRecurrence({ dtstart: zonedValue('2026-03-20', '13:00', ZONE), rrule: 'FREQ=MINUTELY;INTERVAL=15' }), {}],
          ['floating-h', compileRecurrence({ dtstart: floatingValue('2026-03-20', '13:00'), rrule: 'FREQ=HOURLY;BYMINUTE=0,30' }),
            { zone: ZONE }],
        ];
        const written = [];
        for (const [id, series, extra] of rules) {
          const record = await store.jobs.schedule({ id, kind: 'k', series, missed: { catchUp: 100 }, ...extra });
          written.push([id, record.state, record.nextRecurrenceId, record.nextRunAt]);
        }
        assert.deepEqual(written, [
          ['utc-s', 'active', '2026-03-20T12:00:00Z', T0],
          ['utc-m', 'active', '2026-03-20T12:00:30Z', T0 + 30 * SECOND],
          ['zoned-m', 'active', '2026-03-20T13:00:00', T0],
          ['floating-h', 'active', '2026-03-20T13:00:00', T0],
        ]);
        /** @type {string[]} */
        const fired = [];
        for (let step = 0; step < 4; step++) {
          clock.at = T0 + step * 20 * 60 * SECOND;
          fired.push(...(await store.jobs.tick()).fired);
        }
        assert.equal(new Set(fired).size, fired.length, 'no occurrence fires twice');
        const of = (/** @type {string} */ id) => fired.filter((job) => job.startsWith(`${id}@`)).length;
        // one hour of each: every 20 s inclusive of both ends, a minute's :30, a quarter's, a half hour's
        assert.deepEqual(rules.map(([id]) => [id, of(id)]), [['utc-s', 181], ['utc-m', 60], ['zoned-m', 5], ['floating-h', 3]]);
        const runAt = (await store.jobs.get('zoned-m@2026-03-20T13:45:00')).runAt;
        assert.equal(runAt, T0 + 45 * 60 * SECOND);
        // a floating SECONDLY series is expanded from two civil days before its span: under the default
        // limits those seconds stop the search, and the schedule says so
        const old = await store.jobs.schedule({ id: 'floating-s', kind: 'k', zone: ZONE, missed: 'skip',
          series: compileRecurrence({ dtstart: floatingValue('2026-03-10', '00:00'), rrule: 'FREQ=SECONDLY' }) });
        assert.deepEqual([old.state, old.stall?.limit, old.nextRunAt], ['stalled', 'maxOccurrences', null]);
        same('every frequency', { written, fired: fired.slice().sort(), old: old.stall });
      });
    });

    it('a day without ticks fires exactly what missed says, within the limits it was given', async () => {
      await withStore(engine, async (store, clock) => {
        const limits = { maxOccurrences: 100000 };
        for (const [id, missed] of /** @type {const} */ ([['skip', 'skip'], ['once', 'once'], ['catchup', { catchUp: 3 }]]))
          await store.jobs.schedule({ id, kind: 'k', series: secondly, missed, limits });
        const first = await store.jobs.tick();
        assert.deepEqual([...first.fired].sort(), ['catchup', 'once', 'skip'].map((id) => `${id}@${idAt(0)}`));
        clock.at = T0 + DAY;
        const back = await store.jobs.tick();
        const fired = [...back.fired].sort();
        assert.deepEqual(fired, [
          ...[-3, -2, -1, 0].map((s) => `catchup@${idAt(86400 + s)}`),
          ...[-1, 0].map((s) => `once@${idAt(86400 + s)}`),
          `skip@${idAt(86400)}`,
        ]);
        assert.equal(back.skipped, 86396 + 86398 + 86399);
        const records = await store.jobs.schedules();
        assert.deepEqual(records.map((/** @type {any} */ r) => [r.id, r.state, r.counts, r.lastRecurrenceId, r.nextRecurrenceId]), [
          ['catchup', 'active', { fired: 5, skipped: 86396 }, idAt(86400), idAt(86401)],
          ['once', 'active', { fired: 3, skipped: 86398 }, idAt(86400), idAt(86401)],
          ['skip', 'active', { fired: 2, skipped: 86399 }, idAt(86400), idAt(86401)],
        ]);
        same('a day without ticks', { fired, skipped: back.skipped });
      });
    });

    it('a day without ticks over the default limits fires what the policy keeps of the proved prefix, and stalls', async () => {
      await withStore(engine, async (store, clock) => {
        await store.jobs.schedule({ id: 'skip', kind: 'k', series: secondly, missed: 'skip' });
        await store.jobs.schedule({ id: 'catchup', kind: 'k', series: secondly, missed: { catchUp: 2 } });
        // a minute's lateness: none of the prefix is that recent, so none of it fires
        await store.jobs.schedule({ id: 'late', kind: 'k', series: secondly, missed: 'skip', latenessMs: 60 * SECOND });
        await store.jobs.tick();
        clock.at = T0 + DAY;
        const back = await store.jobs.tick();
        // the search stops after 10000 occurrences, the one fired before included: the prefix's latest is
        // the latest the tick proved, and the policy picks from the 9999 due ones it holds
        assert.deepEqual([...back.fired].sort(), [
          `catchup@${idAt(9997)}`, `catchup@${idAt(9998)}`, `catchup@${idAt(9999)}`, `skip@${idAt(9999)}`]);
        assert.equal(back.skipped, 9996 + 9999 + 9998);
        const stall = { limit: 'maxOccurrences', counts: { emitted: 10000, work: 20003, providerCalls: 0 } };
        const byId = new Map((await store.jobs.schedules()).map((/** @type {any} */ r) => [r.id, r]));
        for (const id of ['skip', 'catchup', 'late']) {
          const record = byId.get(id);
          assert.deepEqual([record.state, record.stall, record.nextRunAt, record.lastRecurrenceId],
            ['stalled', stall, null, idAt(9999)], id);
        }
        assert.deepEqual(byId.get('late').counts, { fired: 1, skipped: 9999 });
        // nothing is due again until it is written again, which resumes after the prefix
        assert.deepEqual((await store.jobs.tick()).fired, []);
        const resumed = await store.jobs.schedule({ id: 'skip', kind: 'k', series: secondly, missed: 'skip' });
        assert.deepEqual([resumed.state, resumed.nextRecurrenceId, resumed.counts], ['active', idAt(10000), { fired: 2, skipped: 9998 }]);
        same('the prefix a limit stopped', { fired: [...back.fired].sort(), skipped: back.skipped, resumed: resumed.nextRecurrenceId });
      });
    });

    it('a tick looks past itself by the rule\'s own period, not by days of occurrences', async () => {
      await withStore(engine, async (store, clock, counter) => {
        await store.jobs.schedule({ id: 'zoned', kind: 'k', missed: 'skip',
          series: compileRecurrence({ dtstart: zonedValue('2026-03-20', '13:00', ZONE), rrule: 'FREQ=MINUTELY' }) });
        /** @type {number[]} */
        const calls = [];
        for (const step of [60 * SECOND, 60 * SECOND, 8 * 60 * SECOND]) {
          clock.at += step;
          counter.calls = 0;
          const out = await store.jobs.tick();
          assert.equal(out.fired.length, 1);
          calls.push(counter.calls);
        }
        // each search resolves the times it passes and 64 minutes past the tick: never the eight days it once did
        for (const count of calls) assert.ok(count < 200, `${count} provider calls for one tick`);
        assert.ok(calls[2] - calls[1] < 16, 'eight minutes more of backlog cost a call or so a minute, not days of them');
        same('provider calls per tick', calls);
      });
    });
  });
}
