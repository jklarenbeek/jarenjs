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
import { recordingSqlite, recordingPool } from './statement-recorders.js';

const url = process.env.JAREN_PG_URL;
const SECOND = 1000;
const DAY = 86400000;
const T0 = Date.UTC(2026, 2, 20, 12);
const secondly = compileRecurrence({ dtstart: utcValue('2026-03-20T12:00:00Z'), rrule: 'FREQ=SECONDLY' });
/** An occurrence id of `secondly`, `seconds` after its start. @param {number} seconds */
const idAt = (seconds) => new Date(T0 + seconds * SECOND).toISOString().replace('.000Z', 'Z');

/**
 * Amsterdam's offset changes in 2026, as a provider that lists its
 * changes would answer them (minutes east, the instant of each change).
 */
const AMSTERDAM_2026 = [
  { at: Date.UTC(2026, 2, 29, 1), before: 60, after: 120 },
  { at: Date.UTC(2026, 9, 25, 1), before: 120, after: 60 },
];

/**
 * A provider that counts the calls made to it; with `changes`, one that
 * lists Amsterdam's 2026 offset changes too.
 * @param {boolean} [changes]
 */
function countingProvider(changes = false) {
  const base = createIntlZoneProvider({ revision: 'host ICU' });
  const counter = { calls: 0 };
  const provider = Object.freeze({
    ...base,
    toParts: (/** @type {any[]} */ ...args) => { counter.calls += 1; return base.toParts(...args); },
    candidates: (/** @type {any[]} */ ...args) => { counter.calls += 1; return base.candidates(...args); },
    ...(changes ? { offsetChanges: (/** @type {number} */ from, /** @type {number} */ to, /** @type {string} */ zone) => {
      counter.calls += 1;
      assert.equal(zone, ZONE);
      assert.ok(from >= Date.UTC(2026, 0, 1) && to < Date.UTC(2027, 0, 1), 'the list covers 2026 only');
      return AMSTERDAM_2026.filter((change) => change.at >= from && change.at <= to);
    } } : {}),
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
 * @param {{ changes?: boolean, ran?: string[] }} [options] - a provider listing its changes; a statement record
 */
async function withStore(engine, fn, { changes = false, ran = /** @type {string[] | undefined} */ (undefined) } = {}) {
  const schema = `jaren_subdaily_${process.pid}_${serial++}`;
  const clock = { at: T0 };
  const now = () => clock.at;
  const { provider, counter } = countingProvider(changes);
  if (engine === 'postgres') await pool.query(`CREATE SCHEMA "${schema}"`);
  const driver = engine === 'sqlite' ? (ran === undefined ? nodeDriver() : recordingSqlite(ran))
    : postgresDriver(ran === undefined ? pool : recordingPool(pool, ran), { schema });
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
        // a floating SECONDLY series started days before: only the wall clock its span's instants can read
        // is expanded and bound, so the default limits find its next second
        const old = await store.jobs.schedule({ id: 'floating-s', kind: 'k', zone: ZONE, missed: 'skip',
          series: compileRecurrence({ dtstart: floatingValue('2026-03-10', '00:00'), rrule: 'FREQ=SECONDLY' }) });
        assert.deepEqual([old.state, old.stall, old.nextRecurrenceId], ['active', null, '2026-03-20T14:00:00']);
        same('every frequency', { written, fired: fired.slice().sort(), old: old.nextRunAt });
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

    for (const [freq, period] of /** @type {const} */ ([['SECONDLY', SECOND], ['MINUTELY', 60 * SECOND], ['HOURLY', 3600 * SECOND]])) {
      it(`${freq}: any downtime fires exactly what missed says under the default limits, in the same statements`, async () => {
        const series = compileRecurrence({ dtstart: utcValue('2026-03-20T12:00:00Z'), rrule: `FREQ=${freq}` });
        const id = (/** @type {number} */ at) => new Date(at).toISOString().replace('.000Z', 'Z');
        /** @type {any[]} */
        const rows = [];
        for (const downtime of [3600 * SECOND, DAY, 30 * DAY]) {
          /** @type {string[]} */
          const ran = [];
          await withStore(engine, async (store, clock, counter) => {
            for (const [name, missed] of /** @type {const} */ ([['skip', 'skip'], ['once', 'once'], ['catchup', { catchUp: 3 }]]))
              await store.jobs.schedule({ id: name, kind: 'k', series, missed });
            await store.jobs.tick();
            clock.at = T0 + downtime;
            ran.length = 0;
            counter.calls = 0;
            const back = await store.jobs.tick();
            // one enqueue per fired job; every other statement is the tick's own
            const statements = ran.length - back.fired.length;
            const end = T0 + downtime;
            const due = downtime / period;
            // the current one, and the latest missed ones the policy keeps of the due - 1 missed
            const latest = (/** @type {number} */ late) => Array.from({ length: Math.min(late, due - 1) + 1 },
              (_, k) => id(end - (Math.min(late, due - 1) - k) * period));
            assert.deepEqual([...back.fired].sort(), [
              ...latest(3).map((at) => `catchup@${at}`), ...latest(1).map((at) => `once@${at}`), `skip@${id(end)}`,
            ], `${freq} after ${downtime} ms`);
            const records = await store.jobs.schedules();
            // a backlog one search reads is counted whole; a longer one is read from the tick backwards
            const counted = due + 64 <= 10000;
            for (const record of records) {
              assert.deepEqual([record.state, record.stall, record.lastRecurrenceId, record.nextRecurrenceId],
                ['active', null, id(end), id(end + period)], record.id);
              const fired = latest({ catchup: 3, once: 1, skip: 0 }[/** @type {'catchup' | 'once' | 'skip'} */ (record.id)]).length;
              if (counted) assert.deepEqual(record.counts, { fired: 1 + fired, skipped: due - fired }, record.id);
              else assert.equal(record.counts.uncounted, 1, record.id);
            }
            rows.push({ downtime, statements, providerCalls: counter.calls, skipped: back.skipped,
              uncounted: records.map((/** @type {any} */ r) => r.counts.uncounted ?? 0) });
          }, { ran });
        }
        // beside its enqueues, the tick runs the same statements whatever the backlog, and a utc rule asks no provider
        assert.equal(new Set(rows.map((row) => row.statements)).size, 1, JSON.stringify(rows));
        assert.deepEqual(rows.map((row) => row.providerCalls), [0, 0, 0]);
        same(`${freq} downtime`, rows.map(({ downtime, skipped, uncounted }) => ({ downtime, skipped, uncounted })));
      });
    }

    it('a floating SECONDLY schedule ticks under the default limits after a day\'s downtime, bound around the listed offset changes', async () => {
      await withStore(engine, async (store, clock, counter) => {
        const series = compileRecurrence({ dtstart: floatingValue('2026-03-10', '00:00'), rrule: 'FREQ=SECONDLY' });
        for (const [name, missed] of /** @type {const} */ ([['skip', 'skip'], ['once', 'once'], ['catchup', { catchUp: 3 }]]))
          await store.jobs.schedule({ id: name, kind: 'k', series, zone: ZONE, missed });
        await store.jobs.tick();
        clock.at = T0 + DAY;
        counter.calls = 0;
        const back = await store.jobs.tick();
        // 13:00 in Amsterdam on 21 March is 12:00Z
        assert.deepEqual([...back.fired].sort(), ['catchup@2026-03-21T12:59:57', 'catchup@2026-03-21T12:59:58',
          'catchup@2026-03-21T12:59:59', 'catchup@2026-03-21T13:00:00', 'once@2026-03-21T12:59:59',
          'once@2026-03-21T13:00:00', 'skip@2026-03-21T13:00:00']);
        for (const record of await store.jobs.schedules()) {
          assert.deepEqual([record.state, record.nextRecurrenceId, record.counts.uncounted], ['active', '2026-03-21T13:00:01', 1],
            record.id);
        }
        // each schedule's first search binds the day until its budget, then the tail binds a few seconds
        const backlog = counter.calls;
        assert.ok(backlog <= 3 * (100000 + 1000), `${backlog} provider calls`);
        clock.at += SECOND;
        counter.calls = 0;
        assert.equal((await store.jobs.tick()).fired.length, 3);
        // a tick a second later binds the seconds its span and the window past it hold
        assert.ok(counter.calls < 1000, `${counter.calls} provider calls`);
        same('floating downtime', { fired: back.fired.slice().sort(), skipped: back.skipped });
      }, { changes: true });
    });

    it('a floating SECONDLY schedule ticks under the default limits with a provider that lists no changes', async () => {
      await withStore(engine, async (store, clock, counter) => {
        const series = compileRecurrence({ dtstart: floatingValue('2026-03-10', '00:00'), rrule: 'FREQ=SECONDLY' });
        await store.jobs.schedule({ id: 'skip', kind: 'k', series, zone: ZONE, missed: 'skip' });
        await store.jobs.tick();
        /** @type {number[]} */
        const calls = [];
        /** @type {string[]} */
        const fired = [];
        for (const step of [SECOND, 3600 * SECOND]) {
          clock.at += step;
          counter.calls = 0;
          const out = await store.jobs.tick();
          fired.push(...out.fired);
          calls.push(counter.calls);
        }
        assert.deepEqual(fired, ['skip@2026-03-20T13:00:01', 'skip@2026-03-20T14:00:01']);
        const [record] = await store.jobs.schedules();
        assert.deepEqual([record.state, record.counts], ['active', { fired: 3, skipped: 3599 }]);
        // the 26 hours of wall clock every offset can read are bound, within the default 100000 calls
        for (const count of calls) assert.ok(count > 26 * 3600 && count < 100000, `${count} provider calls`);
        same('floating without a list', { fired, calls: calls.length });
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
