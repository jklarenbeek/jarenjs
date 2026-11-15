//@ts-check
/**
 * @file One recurring-schedule scenario, driven by ONE simulated clock
 * over any number of stores in lockstep, answering one transcript per
 * store: the SQLite test pins the transcript's values, and the
 * PostgreSQL test asserts every engine's transcript is the same. Zone
 * Europe/Amsterdam, across both 2026 transitions (29 March and 25
 * October), with a three-day stretch without ticks across the second.
 */
import { createRuntime } from '@jarenjs/core/runtime';
import { compileRecurrence, defineSeries, floatingValue, zonedValue, utcValue, dateValue } from '@jarenjs/core/calendar';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { jobSchedules } from '@jarenjs/db/schedules';

export const ZONE = 'Europe/Amsterdam';
export const HOUR = 3600000;
export const model = { $model: '0.1', collections: { notes: { key: '/id',
  schema: { type: 'object', properties: { id: { type: 'string' } } } } } };

/** A clock every store reads, and the open options that inject it. */
export function scenarioClock(start = Date.UTC(2026, 2, 20, 12)) {
  const clock = { at: start };
  const provider = createIntlZoneProvider({ revision: 'host ICU' });
  const now = () => clock.at;
  const options = (/** @type {any} */ extra = {}) => ({
    runtime: createRuntime({ zoneProvider: provider, now }),
    jobs: { now, random: () => 0, schedules: jobSchedules(), ...extra },
  });
  return { clock, provider, options };
}

/** The schedules the scenario writes. */
export function scenarioSchedules() {
  const weekly = compileRecurrence({ dtstart: floatingValue('2026-03-02', '09:00'), duration: 'PT1H', rrule: 'FREQ=WEEKLY;BYDAY=MO' });
  const daily = compileRecurrence({ dtstart: floatingValue('2026-03-01', '09:00'), rrule: 'FREQ=DAILY' });
  return [
    // a floating weekly 09:00, bound in the zone: 09:00 local on both sides of each transition
    { id: 'weekly', kind: 'report', payload: { to: 'team' }, series: weekly, zone: ZONE, zoneSource: 'explicit', missed: 'skip' },
    // the same rule as its JSON
    { id: 'daily-skip', kind: 'digest', series: JSON.parse(JSON.stringify(daily)), zone: ZONE, missed: 'skip' },
    { id: 'daily-once', kind: 'digest', series: daily, zone: ZONE, policy: 'later', missed: 'once' },
    // a zoned rule names its own zone
    { id: 'zoned-catchup', kind: 'sync', series: compileRecurrence({
      dtstart: zonedValue('2026-03-01', '07:15', ZONE), rrule: 'FREQ=DAILY' }), missed: { catchUp: 2 } },
    { id: 'utc', kind: 'ping', series: compileRecurrence({ dtstart: utcValue('2026-03-01T05:00:00Z'), rrule: 'FREQ=DAILY;INTERVAL=2' }), missed: 'once' },
    // a series with an excluded date and a cancelled slot
    { id: 'series', kind: 'report', series: defineSeries({ uid: 'standup', base: weekly,
      exdates: [floatingValue('2026-03-30', '09:00')],
      overrides: [{ recurrenceId: '2026-10-19T09:00:00', status: 'cancelled' }] }), zone: ZONE, missed: 'skip' },
    // a date series fires at the first instant of its day
    { id: 'dates', kind: 'close', series: compileRecurrence({ dtstart: dateValue('2026-03-27'), rrule: 'FREQ=WEEKLY;COUNT=3' }),
      zone: ZONE, missed: 'skip' },
    // two generated times that the spring gap moves onto one instant
    { id: 'gap', kind: 'night', series: compileRecurrence({ dtstart: zonedValue('2026-03-28', '02:30', ZONE),
      rrule: 'FREQ=DAILY;BYHOUR=2,3;BYMINUTE=30;COUNT=6' }), missed: 'skip' },
    // no zone: unresolved, never fires
    { id: 'floating', kind: 'digest', series: daily, missed: 'skip' },
  ];
}

/** Written in October, before the three days without ticks. */
export function lateSchedules() {
  const daily = compileRecurrence({ dtstart: floatingValue('2026-03-01', '09:00'), rrule: 'FREQ=DAILY' });
  return [
    // a search budget an hourly tick's search fits and the three-day backlog's does not
    { id: 'stalls', kind: 'digest', series: daily, zone: ZONE, missed: { catchUp: 5 }, limits: { maxWork: 30 } },
  ];
}

/** Refusals the scenario records, as codes. */
export function scenarioRefusals() {
  return [
    ['unknown zone', { id: 'r1', kind: 'k', series: compileRecurrence({ dtstart: floatingValue('2026-03-01', '09:00'), rrule: 'FREQ=DAILY' }),
      zone: 'Mars/Olympus_Mons', missed: 'skip' }],
    ['monthly', { id: 'r2', kind: 'k', series: { kind: 'recurrence', dtstart: { kind: 'floating', date: '2026-03-01', time: '09:00' },
      rrule: { FREQ: 'MONTHLY' }, policy: 'rfc5545' }, zone: ZONE, missed: 'skip' }],
    ['yearly', { id: 'r3', kind: 'k', series: { kind: 'recurrence', dtstart: { kind: 'date', date: '2026-03-01' },
      rrule: 'FREQ=YEARLY', policy: 'rfc5545' }, zone: ZONE, missed: 'skip' }],
    ['zone beside a zoned rule', { id: 'r4', kind: 'k', series: compileRecurrence({
      dtstart: zonedValue('2026-03-01', '07:15', ZONE), rrule: 'FREQ=DAILY' }), zone: ZONE, missed: 'skip' }],
    ['unknown member', { id: 'r5', kind: 'k', series: compileRecurrence({ dtstart: floatingValue('2026-03-01', '09:00'), rrule: 'FREQ=DAILY' }),
      zone: ZONE, missed: 'skip', mised: 'skip' }],
  ];
}

/**
 * Run the scenario on stores in lockstep; one transcript per store.
 * @param {any[]} stores
 * @param {{ at: number }} clock
 */
export async function runScenario(stores, clock) {
  const transcripts = stores.map(() => ({ scheduled: [], refusals: [], ticks: [], schedules: [], jobs: [] }));
  const each = async (fn) => {
    for (const [i, store] of stores.entries()) await fn(store, transcripts[i]);
  };
  for (const spec of scenarioSchedules())
    await each(async (store, t) => { t.scheduled.push(await store.jobs.schedule(spec)); });
  for (const [what, spec] of scenarioRefusals()) {
    await each(async (store, t) => {
      try { await store.jobs.schedule(spec); t.refusals.push([what, 'accepted']); }
      catch (error) { t.refusals.push([what, /** @type {any} */ (error).code]); }
    });
  }
  const tickUntil = async (end, step = HOUR) => {
    while (clock.at < end) {
      clock.at += step;
      await each(async (store, t) => {
        const out = await store.jobs.tick();
        if (out.advanced > 0) t.ticks.push({ at: clock.at, ...out });
      });
    }
  };
  // the spring transition, hour by hour
  await tickUntil(Date.UTC(2026, 3, 1, 12));
  // jump to October, then tick hour by hour up to a three-day stretch without ticks across the autumn transition
  clock.at = Date.UTC(2026, 9, 17, 12);
  await each(async (store, t) => {
    const out = await store.jobs.tick();
    t.ticks.push({ at: clock.at, ...out });
  });
  for (const spec of lateSchedules())
    await each(async (store, t) => { t.scheduled.push(await store.jobs.schedule(spec)); });
  await tickUntil(Date.UTC(2026, 9, 22, 12));
  clock.at = Date.UTC(2026, 9, 25, 12);
  await tickUntil(Date.UTC(2026, 9, 28, 12));
  await each(async (store, t) => {
    t.schedules = await store.jobs.schedules();
    const ids = t.ticks.flatMap((tick) => tick.fired).sort();
    for (const id of ids) t.jobs.push(await store.jobs.get(id));
  });
  return transcripts;
}

/**
 * The values every engine's transcript must hold.
 * @param {any} t - one transcript
 * @param {any} provider
 * @param {typeof import('node:assert/strict')} assert
 */
export function assertScenario(t, provider, assert) {
  assert.deepEqual(t.refusals, [['unknown zone', 'JY0001'], ['monthly', 'JY0020'], ['yearly', 'JY0020'],
    ['zone beside a zoned rule', 'JD0013'], ['unknown member', 'JD0013']]);
  const fired = t.ticks.flatMap((tick) => tick.fired);
  assert.equal(new Set(fired).size, fired.length, 'no occurrence fires twice');
  const runAt = new Map(t.jobs.map((job) => [job.id, job.runAt]));
  // the weekly 09:00: 08:00Z in winter time, 07:00Z in summer time, on both sides of each transition
  assert.deepEqual(fired.filter((id) => id.startsWith('weekly@')).map((id) => [id, runAt.get(id)]), [
    ['weekly@2026-03-23T09:00:00', Date.UTC(2026, 2, 23, 8)],
    ['weekly@2026-03-30T09:00:00', Date.UTC(2026, 2, 30, 7)],
    ['weekly@2026-10-12T09:00:00', Date.UTC(2026, 9, 12, 7)],
    ['weekly@2026-10-19T09:00:00', Date.UTC(2026, 9, 19, 7)],
    ['weekly@2026-10-26T09:00:00', Date.UTC(2026, 9, 26, 8)],
  ]);
  for (const job of t.jobs.filter((record) => record.id.startsWith('weekly@') || record.id.startsWith('daily-skip@'))) {
    const parts = provider.toParts(job.runAt, ZONE);
    assert.deepEqual([parts.hours, parts.minutes], [9, 0], `${job.id} runs at 09:00 in ${ZONE}`);
  }
  // the spring gap moves 02:30 onto 03:30's instant: both fire, in one tick
  const gap = t.ticks.find((tick) => tick.at === Date.UTC(2026, 2, 29, 2));
  assert.deepEqual(gap.fired, ['gap@2026-03-29T02:30:00', 'gap@2026-03-29T03:30:00']);
  assert.equal(runAt.get('gap@2026-03-29T02:30:00'), Date.UTC(2026, 2, 29, 1, 30));
  assert.equal(runAt.get('gap@2026-03-29T03:30:00'), Date.UTC(2026, 2, 29, 1, 30));
  // the series leaves out its excluded date and its cancelled slot
  assert.ok(!fired.includes('series@2026-03-30T09:00:00') && !fired.includes('series@2026-10-19T09:00:00'));
  assert.ok(fired.includes('series@2026-10-26T09:00:00'));
  // a date series fires at the first instant of its day
  assert.equal(runAt.get('dates@2026-03-27'), Date.UTC(2026, 2, 26, 23));
  // three days without ticks across the autumn transition: skip fires the current one,
  // once the latest missed one beside it, catchUp 2 the latest two
  const back = t.ticks.find((tick) => tick.at === Date.UTC(2026, 9, 25, 13));
  assert.deepEqual(back.fired, ['utc@2026-10-23T05:00:00Z', 'utc@2026-10-25T05:00:00Z',
    'zoned-catchup@2026-10-23T07:15:00', 'zoned-catchup@2026-10-24T07:15:00', 'zoned-catchup@2026-10-25T07:15:00',
    'daily-once@2026-10-24T09:00:00', 'daily-once@2026-10-25T09:00:00', 'daily-skip@2026-10-25T09:00:00']);
  assert.equal(back.skipped, 3);
  const byId = new Map(t.schedules.map((record) => [record.id, record]));
  assert.deepEqual(t.schedules.map((record) => [record.id, record.state]), [
    ['daily-once', 'active'], ['daily-skip', 'active'], ['dates', 'ended'], ['floating', 'unresolved'], ['gap', 'ended'],
    ['series', 'active'], ['stalls', 'stalled'], ['utc', 'active'], ['weekly', 'active'], ['zoned-catchup', 'active']]);
  // the backlog's search ran out of its budget: stalled with its counts, never dropped
  assert.deepEqual(byId.get('stalls').stall, { limit: 'maxWork', counts: { emitted: 0, work: 30, providerCalls: 0 } });
  assert.deepEqual(byId.get('stalls').counts, { fired: 5, skipped: 0 });
  assert.equal(byId.get('stalls').nextRunAt, null);
  assert.equal(byId.get('stalls').lastRecurrenceId, '2026-10-22T09:00:00');
  // no zone, none assumed
  const floating = byId.get('floating');
  assert.deepEqual([floating.nextRunAt, floating.zone, floating.providerRevision, floating.counts],
    [null, null, null, { fired: 0, skipped: 0 }]);
  assert.ok(!fired.some((id) => id.startsWith('floating@')));
  assert.deepEqual(byId.get('weekly'), {
    id: 'weekly', kind: 'report', payload: { to: 'team' },
    series: { kind: 'recurrence', dtstart: { kind: 'floating', date: '2026-03-02', time: '09:00' }, duration: 'PT1H',
      rrule: { FREQ: 'WEEKLY', BYDAY: ['MO'] }, policy: 'rfc5545' },
    zone: ZONE, zoneSource: 'explicit', policy: 'rfc5545', missed: 'skip', limits: null, state: 'active',
    nextRunAt: Date.UTC(2026, 10, 2, 8), nextRecurrenceId: '2026-11-02T09:00:00',
    lastRunAt: Date.UTC(2026, 9, 26, 8), lastRecurrenceId: '2026-10-26T09:00:00', providerRevision: 'host ICU',
    counts: { fired: 5, skipped: 27 }, stall: null, createdAt: Date.UTC(2026, 2, 20, 12), updatedAt: Date.UTC(2026, 9, 26, 8),
  });
  const job = t.jobs.find((record) => record.id === 'weekly@2026-10-26T09:00:00');
  assert.deepEqual(job, { id: 'weekly@2026-10-26T09:00:00', kind: 'report', payload: { to: 'team' }, state: 'pending',
    runAt: Date.UTC(2026, 9, 26, 8), attempts: 0, maxAttempts: 5, leaseUntil: null, leaseOwner: null, leaseGeneration: 0,
    lastError: null, result: null, createdAt: Date.UTC(2026, 9, 26, 8), updatedAt: Date.UTC(2026, 9, 26, 8) });
}
