//@ts-check
/**
 * @file A tick whose backlog is longer than one search reads (JOBS-FORMAT
 * §11, A backlog of any length): where the rule's occurrences are one step
 * apart, the occurrences before the span read from the tick backwards are
 * counted, so the schedule's counts and the tick's `skipped` are those the
 * whole backlog read at once answers; where they are not, the tick still
 * fires what `missed` says and `counts.uncounted` says it passed some
 * uncounted. Each test body runs on SQLite and, where JAREN_PG_URL names a
 * server, on PostgreSQL, answering the same values.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';
import { jobSchedules } from '@jarenjs/db/schedules';
import { createRuntime } from '@jarenjs/core/runtime';
import { compileRecurrence, dateValue, defineSeries, floatingValue, utcValue, zonedValue } from '@jarenjs/core/calendar';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { model, ZONE } from './schedules-scenario.js';

const url = process.env.JAREN_PG_URL;
const MINUTE = 60000;
const DAY = 86400000;
const provider = createIntlZoneProvider({ revision: 'host ICU' });
/** The policies every case writes a schedule under. */
const POLICIES = /** @type {const} */ ([['skip', 'skip', null], ['once', 'once', null], ['catchup', { catchUp: 3 }, null], ['late', { catchUp: 3 }, 2 * DAY]]);

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
 * Write one schedule per policy at `created`, tick at each of `ticks`, and
 * answer what each tick fired and skipped and where each schedule stands.
 * @param {'sqlite' | 'postgres'} engine
 * @param {{ series: any, zone?: string, limits?: Record<string, number> }} spec
 * @param {number} created
 * @param {number[]} ticks
 */
async function transcript(engine, spec, created, ticks) {
  const schema = `jaren_backlog_${process.pid}_${serial++}`;
  const clock = { at: created };
  const now = () => clock.at;
  if (engine === 'postgres') await pool.query(`CREATE SCHEMA "${schema}"`);
  const driver = engine === 'sqlite' ? nodeDriver() : postgresDriver(pool, { schema });
  const store = await openStore(model, { driver, runtime: createRuntime({ zoneProvider: provider, now }),
    jobs: { now, random: () => 0, schedules: jobSchedules() } });
  try {
    for (const [id, missed, latenessMs] of POLICIES)
      await store.jobs.schedule({ id, kind: 'k', ...spec, missed, ...(latenessMs === null ? {} : { latenessMs }) });
    const answers = [];
    for (const at of ticks) {
      clock.at = at;
      const tick = await store.jobs.tick();
      answers.push({ fired: [...tick.fired].sort(), skipped: tick.skipped });
    }
    const records = (await store.jobs.schedules()).map((/** @type {any} */ r) =>
      [r.id, r.state, r.counts, r.lastRecurrenceId, r.nextRecurrenceId]);
    return { answers, records };
  }
  finally {
    try { await store.close(); }
    finally { if (engine === 'postgres') await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
  }
}

const daily = compileRecurrence({ dtstart: zonedValue('2026-03-01', '09:00', ZONE), rrule: 'FREQ=DAILY' });
/** 09:00 in Amsterdam on a 2026 date before 29 March or after 25 October (UTC+1), or between them (UTC+2). */
const nine = (/** @type {number} */ month, /** @type {number} */ day) => {
  const summer = (month > 3 || (month === 3 && day >= 29)) && (month < 10 || (month === 10 && day < 25));
  return Date.UTC(2026, month - 1, day, summer ? 7 : 8);
};

/**
 * The cases whose backlog a tight `maxOccurrences` makes the tick read
 * backwards, each beside the same schedule under the default limits, which
 * reads its backlog whole: [name, spec, created, ticks].
 * @type {[string, { series: any, zone?: string }, number, number[]][]}
 */
const COUNTED = [
  // across 29 March: on the occurrence, a millisecond before it, half an hour after it
  ['zoned DAILY, ticked on an occurrence', { series: daily }, nine(3, 1), [nine(3, 1), nine(4, 30)]],
  ['zoned DAILY, ticked just before one', { series: daily }, nine(3, 1), [nine(3, 1), nine(4, 30) - 1]],
  ['zoned DAILY, ticked between two', { series: daily }, nine(3, 1), [nine(3, 1), nine(4, 30) + 30 * MINUTE]],
  // the first tick reads from the schedule's creation, inclusive
  ['zoned DAILY, first ticked after its backlog', { series: daily }, nine(3, 1), [nine(4, 30)]],
  // across 25 October
  ['zoned DAILY across the October transition', { series: compileRecurrence({ dtstart: zonedValue('2026-10-01', '09:00', ZONE), rrule: 'FREQ=DAILY;INTERVAL=2' }) },
    nine(10, 1), [nine(10, 1), nine(12, 30) - 1]],
  // 02:30 does not exist on 29 March: the slot binds after the gap
  ['floating DAILY in the spring gap', { series: compileRecurrence({ dtstart: floatingValue('2026-03-01', '02:30'), rrule: 'FREQ=DAILY' }), zone: ZONE },
    Date.UTC(2026, 2, 1, 1, 30), [Date.UTC(2026, 2, 1, 1, 30), Date.UTC(2026, 4, 1)]],
  // Apia skipped 30 December 2011 whole: the day's slot binds where 31 December's does
  ['zoned DAILY over a skipped day', { series: compileRecurrence({ dtstart: zonedValue('2011-12-01', '09:00', 'Pacific/Apia'), rrule: 'FREQ=DAILY' }) },
    Date.UTC(2011, 11, 1, 19), [Date.UTC(2011, 11, 1, 19), Date.UTC(2012, 0, 20, 20)]],
  ['date WEEKLY', { series: compileRecurrence({ dtstart: dateValue('2026-01-05'), rrule: 'FREQ=WEEKLY' }), zone: ZONE },
    Date.UTC(2026, 0, 4, 23), [Date.UTC(2026, 0, 4, 23), Date.UTC(2026, 11, 1)]],
  ['utc MINUTELY;INTERVAL=7', { series: compileRecurrence({ dtstart: utcValue('2026-03-20T12:00:00Z'), rrule: 'FREQ=MINUTELY;INTERVAL=7' }) },
    Date.UTC(2026, 2, 20, 12), [Date.UTC(2026, 2, 20, 12), Date.UTC(2026, 2, 23, 12, 3)]],
];

for (const engine of /** @type {const} */ (['sqlite', 'postgres'])) {
  describe(`a backlog read from the tick backwards, on ${engine}`, { skip: engine === 'postgres' && !url && 'JAREN_PG_URL is not set' }, () => {
    for (const [name, spec, created, ticks] of COUNTED) {
      it(`${name}: counts what the whole backlog read at once counts`, async () => {
        const whole = await transcript(engine, spec, created, ticks);
        const backwards = await transcript(engine, { ...spec, limits: { maxOccurrences: 20 } }, created, ticks);
        assert.deepEqual(backwards, whole);
        for (const [, state, counts] of backwards.records) {
          assert.equal(state, 'active');
          assert.equal(counts.uncounted, undefined);
        }
      });
    }

    it('counts 58 passed over the 60 days a DAILY schedule in Amsterdam was not ticked, across 29 March', async () => {
      const { answers, records } = await transcript(engine, { series: daily, limits: { maxOccurrences: 20 } }, nine(3, 1), [nine(3, 1), nine(4, 30) + 30 * MINUTE]);
      assert.deepEqual(answers[1], {
        fired: ['catchup@2026-04-27T09:00:00', 'catchup@2026-04-28T09:00:00', 'catchup@2026-04-29T09:00:00', 'catchup@2026-04-30T09:00:00',
          'late@2026-04-29T09:00:00', 'late@2026-04-30T09:00:00',
          'once@2026-04-29T09:00:00', 'once@2026-04-30T09:00:00', 'skip@2026-04-30T09:00:00'],
        // 60 due: catchup skips 56, once 58, skip 59; late fires none due more than two days before the tick
        skipped: 56 + 58 + 58 + 59,
      });
      assert.deepEqual(records, [
        ['catchup', 'active', { fired: 5, skipped: 56 }, '2026-04-30T09:00:00', '2026-05-01T09:00:00'],
        ['late', 'active', { fired: 3, skipped: 58 }, '2026-04-30T09:00:00', '2026-05-01T09:00:00'],
        ['once', 'active', { fired: 3, skipped: 58 }, '2026-04-30T09:00:00', '2026-05-01T09:00:00'],
        ['skip', 'active', { fired: 2, skipped: 59 }, '2026-04-30T09:00:00', '2026-05-01T09:00:00'],
      ]);
    });

    it('passes the backlog uncounted where the rule\'s occurrences are not one step apart', async () => {
      for (const series of [
        compileRecurrence({ dtstart: utcValue('2026-03-20T12:00:00Z'), rrule: 'FREQ=HOURLY;BYMINUTE=0,30' }),
        // the hours a BYHOUR leaves out are slots one hour apart that are no occurrences
        compileRecurrence({ dtstart: utcValue('2026-03-20T00:00:00Z'), rrule: 'FREQ=HOURLY;BYHOUR=0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20' }),
        // a sub-daily slot in a zone's gap binds past the slots after it
        compileRecurrence({ dtstart: zonedValue('2026-03-27', '00:00', ZONE), rrule: 'FREQ=MINUTELY;INTERVAL=7' }),
        // an excluded date is a slot that is no occurrence
        defineSeries({ uid: 'x', base: compileRecurrence({ dtstart: utcValue('2026-03-20T12:00:00Z'), rrule: 'FREQ=HOURLY' }),
          exdates: [utcValue('2026-03-28T12:00:00Z')] }),
      ]) {
        const created = Date.UTC(2026, 2, 26, 23);
        const ticks = [created, created + 5 * DAY];
        const whole = await transcript(engine, { series }, created, ticks);
        // the span a tick reads backwards is 64 hours past the tick for an hourly rule: 100 occurrences hold it
        const backwards = await transcript(engine, { series, limits: { maxOccurrences: 100 } }, created, ticks);
        // the same occurrences fire, and the schedules stand where they stood
        assert.deepEqual(backwards.answers.map((answer) => answer.fired), whole.answers.map((answer) => answer.fired));
        assert.deepEqual(backwards.records.map(([id, state, counts, last, next]) => [id, state, counts.fired, counts.uncounted, last, next]),
          whole.records.map(([id, state, counts, last, next]) => [id, state, counts.fired, 1, last, next]));
        assert.ok(backwards.answers[1].skipped < whole.answers[1].skipped);
      }
      // a slot `reject` binds to no instant is no occurrence either
      const reject = compileRecurrence({ dtstart: zonedValue('2026-03-01', '09:00', ZONE), rrule: 'FREQ=DAILY', policy: 'reject' });
      const { records } = await transcript(engine, { series: reject, limits: { maxOccurrences: 20 } }, nine(3, 1), [nine(3, 1), nine(4, 30)]);
      assert.deepEqual(records.map(([id, state, counts]) => [id, state, counts.uncounted]),
        [['catchup', 'active', 1], ['late', 'active', 1], ['once', 'active', 1], ['skip', 'active', 1]]);
    });
  });
}
