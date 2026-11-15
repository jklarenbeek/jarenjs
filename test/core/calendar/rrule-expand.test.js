//@ts-check

/**
 * Expansion's adversarial cases: generated local times in a gap and a
 * fold under each policy, COUNT across a skipped invalid date, exact
 * counts when a limit stops the walk, horizon edges at an occurrence's
 * start and end, nominal and exact lengths across a change, the end of
 * the calendar, `nextOccurrences`, and floating rules giving one answer
 * under every host zone.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  compileRecurrence, expandRecurrence, nextOccurrences, formatRRule, RECURRENCE_LIMITS,
  floatingValue, dateValue, utcValue, zonedValue, CalendarError,
} from '@jarenjs/core/calendar';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { oracleZone, tableProvider } from './oracle.js';

const DAY = 86400000;
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const amsterdam = tableProvider('Europe/Amsterdam', oracleZone('Europe/Amsterdam'));
const intl = createIntlZoneProvider({ revision: 'host' });
const at = (/** @type {string} */ text) => Date.parse(text);
const iso = (/** @type {number | undefined} */ ms) => new Date(/** @type {number} */ (ms)).toISOString();

/**
 * @param {() => unknown} run
 * @param {string} code
 * @param {string} path
 */
function refuses(run, code, path) {
  assert.throws(run, (/** @type {any} */ error) => {
    assert.ok(error instanceof CalendarError, String(error));
    assert.strictEqual(error.code, code, error.message);
    assert.strictEqual(error.docPath, path, error.message);
    return true;
  });
}

describe('generated local times in a gap or fold resolve under the rule policy', () => {
  const rule = (/** @type {'rfc5545' | 'later' | 'reject'} */ policy) => compileRecurrence({
    dtstart: zonedValue('2026-03-01', '02:30', 'Europe/Amsterdam'), duration: 'PT30M', rrule: 'FREQ=DAILY', policy,
  });
  const day = (/** @type {string} */ date) => [at(`${date}T00:00:00Z`) - 2 * 3600000, at(`${date}T00:00:00Z`) + 22 * 3600000];

  for (const provider of [amsterdam, intl]) {
    const label = provider === intl ? 'the Intl provider' : 'the table provider';
    it(`2026-03-29 02:30 never happens: rfc5545 and later move it to 01:30Z, reject refuses (${label})`, () => {
      for (const policy of /** @type {const} */ (['rfc5545', 'later'])) {
        const got = expandRecurrence(rule(policy), { horizon: /** @type {any} */ (day('2026-03-29')), provider });
        assert.strictEqual(got.occurrences.length, 1);
        const [o] = got.occurrences;
        assert.strictEqual(o.recurrenceId, '2026-03-29T02:30:00');
        assert.strictEqual(iso(o.instants?.start), '2026-03-29T01:30:00.000Z');
        assert.deepStrictEqual(o.start, { kind: 'zoned', date: '2026-03-29', time: '03:30:00', zone: 'Europe/Amsterdam' });
        assert.deepStrictEqual(o.end, { kind: 'zoned', date: '2026-03-29', time: '04:00:00', zone: 'Europe/Amsterdam' });
        assert.strictEqual(o.resolution?.kind, 'gap');
        assert.strictEqual(o.resolution?.policy, policy);
        assert.deepStrictEqual(o.provider, provider.identity);
      }
      refuses(() => expandRecurrence(rule('reject'), { horizon: /** @type {any} */ (day('2026-03-29')), provider }), 'JY0002', '/parts');
      // the refusal is for a time the expansion returns, not for one outside the horizon
      const before = expandRecurrence(rule('reject'), { horizon: /** @type {any} */ (day('2026-03-28')), provider });
      const after = expandRecurrence(rule('reject'), { horizon: /** @type {any} */ (day('2026-03-30')), provider });
      assert.deepStrictEqual([before.occurrences.length, after.occurrences.length], [1, 1]);
    });

    it(`2026-10-25 02:30 happens twice: rfc5545 takes 00:30Z, later 01:30Z, reject refuses (${label})`, () => {
      const got = /** @type {Record<string, string>} */ ({});
      for (const policy of /** @type {const} */ (['rfc5545', 'later'])) {
        const [o] = expandRecurrence(rule(policy), { horizon: /** @type {any} */ (day('2026-10-25')), provider }).occurrences;
        assert.strictEqual(o.recurrenceId, '2026-10-25T02:30:00');
        assert.strictEqual(o.resolution?.kind, 'fold');
        got[policy] = iso(o.instants?.start);
      }
      assert.deepStrictEqual(got, { rfc5545: '2026-10-25T00:30:00.000Z', later: '2026-10-25T01:30:00.000Z' });
      refuses(() => expandRecurrence(rule('reject'), { horizon: /** @type {any} */ (day('2026-10-25')), provider }), 'JY0003', '/parts');
    });
  }

  it('a gap-moved time and the generated time it lands on are two occurrences with one instant', () => {
    const compiled = compileRecurrence({ dtstart: zonedValue('2026-03-29', '02:30', 'Europe/Amsterdam'), rrule: 'FREQ=DAILY;COUNT=1;BYHOUR=2,3' });
    const got = expandRecurrence(compiled, { horizon: [at('2026-03-28T00:00:00Z'), at('2026-03-30T00:00:00Z')], provider: amsterdam });
    assert.deepStrictEqual(got.occurrences.map((o) => [o.recurrenceId, iso(o.instants?.start)]), [
      ['2026-03-29T02:30:00', '2026-03-29T01:30:00.000Z'],
    ]);
    const both = compileRecurrence({ dtstart: zonedValue('2026-03-28', '02:30', 'Europe/Amsterdam'), rrule: 'FREQ=DAILY;BYHOUR=2,3' });
    const next = expandRecurrence(both, { horizon: [at('2026-03-29T00:00:00Z'), at('2026-03-29T12:00:00Z')], provider: amsterdam });
    assert.deepStrictEqual(next.occurrences.map((o) => [o.recurrenceId, iso(o.instants?.start)]), [
      ['2026-03-29T02:30:00', '2026-03-29T01:30:00.000Z'],
      ['2026-03-29T03:30:00', '2026-03-29T01:30:00.000Z'],
    ]);
  });

  it('a start a gap moved forward does not end the walk: a later wall clock can start earlier', () => {
    const rule = compileRecurrence({ dtstart: zonedValue('2026-03-28', '02:00', 'Europe/Amsterdam'), rrule: 'FREQ=DAILY;BYHOUR=2,3;BYMINUTE=0,30' });
    const hour = /** @type {[number, number]} */ ([at('2026-03-29T00:45:00Z'), at('2026-03-29T01:15:00Z')]);
    const got = expandRecurrence(rule, { horizon: hour, provider: amsterdam });
    assert.deepStrictEqual(got.occurrences.map((o) => [o.recurrenceId, iso(o.instants?.start)]), [
      ['2026-03-29T02:00:00', '2026-03-29T01:00:00.000Z'],
      ['2026-03-29T03:00:00', '2026-03-29T01:00:00.000Z'],
    ]);
    const next = nextOccurrences(rule, at('2026-03-29T00:45:00Z'), 1, { provider: amsterdam });
    assert.deepStrictEqual(next.occurrences.map((o) => o.recurrenceId), ['2026-03-29T02:00:00']);
    // the first start found (02:40, moved to 01:40Z) is not the first by instant (03:10 at 01:10Z)
    const picked = compileRecurrence({ dtstart: zonedValue('2026-03-28', '02:40', 'Europe/Amsterdam'),
      rrule: 'FREQ=DAILY;BYHOUR=2,3;BYMINUTE=10,40;BYSETPOS=2,3' });
    const first = nextOccurrences(picked, at('2026-03-29T01:05:00Z'), 1, { provider: amsterdam });
    assert.deepStrictEqual(first.occurrences.map((o) => [o.recurrenceId, iso(o.instants?.start)]),
      [['2026-03-29T03:10:00', '2026-03-29T01:10:00.000Z']]);
    const wide = expandRecurrence(rule, { horizon: [at('2026-03-29T00:00:00Z'), at('2026-03-30T00:00:00Z')], provider: amsterdam });
    assert.deepStrictEqual(wide.occurrences.map((o) => o.recurrenceId), ['2026-03-29T02:00:00', '2026-03-29T03:00:00',
      '2026-03-29T02:30:00', '2026-03-29T03:30:00']);
    const capped = expandRecurrence(rule, { horizon: [at('2026-03-29T00:00:00Z'), at('2026-03-30T00:00:00Z')], provider: amsterdam,
      limits: { maxOccurrences: 2 } });
    assert.deepStrictEqual([capped.limit, capped.occurrences.map((o) => o.recurrenceId)], ['maxOccurrences',
      ['2026-03-29T02:00:00', '2026-03-29T03:00:00']]);
    const until = compileRecurrence({ dtstart: zonedValue('2026-03-28', '02:00', 'Europe/Amsterdam'),
      rrule: 'FREQ=DAILY;UNTIL=20260329T011500Z;BYHOUR=2,3;BYMINUTE=0,30' });
    assert.deepStrictEqual(expandRecurrence(until, { horizon: [at('2026-03-29T00:00:00Z'), at('2026-03-30T00:00:00Z')], provider: amsterdam })
      .occurrences.map((o) => o.recurrenceId), ['2026-03-29T02:00:00', '2026-03-29T03:00:00']);
  });

  it('Apia\'s skipped day: each 2011-12-30 time moves a day forward and the answer is in instant order', () => {
    const apia = tableProvider('Pacific/Apia', oracleZone('Pacific/Apia'));
    const rule = compileRecurrence({ dtstart: zonedValue('2011-12-29', '09:00', 'Pacific/Apia'), rrule: 'FREQ=DAILY;BYHOUR=9,10' });
    const got = expandRecurrence(rule, { horizon: [at('2011-12-30T00:00:00Z'), at('2012-01-01T00:00:00Z')], provider: apia });
    assert.deepStrictEqual(got.occurrences.map((o) => [o.recurrenceId, iso(o.instants?.start), o.resolution?.kind]), [
      ['2011-12-30T09:00:00', '2011-12-30T19:00:00.000Z', 'gap'],
      ['2011-12-31T09:00:00', '2011-12-30T19:00:00.000Z', 'exists'],
      ['2011-12-30T10:00:00', '2011-12-30T20:00:00.000Z', 'gap'],
      ['2011-12-31T10:00:00', '2011-12-30T20:00:00.000Z', 'exists'],
      ['2012-01-01T09:00:00', '2011-12-31T19:00:00.000Z', 'exists'],
      ['2012-01-01T10:00:00', '2011-12-31T20:00:00.000Z', 'exists'],
    ]);
  });

  it('a nominal day lasts 23 hours across spring-forward; an exact one 24; dtend is exact', () => {
    const horizon = /** @type {[number, number]} */ ([at('2026-03-28T00:00:00Z'), at('2026-03-28T23:00:00Z')]);
    const start = zonedValue('2026-03-28', '12:00', 'Europe/Amsterdam');
    const nominal = expandRecurrence(compileRecurrence({ dtstart: start, duration: 'P1D', rrule: 'FREQ=DAILY' }), { horizon, provider: amsterdam });
    const exact = expandRecurrence(compileRecurrence({ dtstart: start, duration: 'PT24H', rrule: 'FREQ=DAILY' }), { horizon, provider: amsterdam });
    assert.strictEqual(nominal.occurrences[0].end.kind === 'zoned' && nominal.occurrences[0].end.time, '12:00:00');
    assert.strictEqual(exact.occurrences[0].end.kind === 'zoned' && exact.occurrences[0].end.time, '13:00:00');
    const [n] = nominal.occurrences;
    assert.strictEqual(/** @type {any} */ (n.instants).end - /** @type {any} */ (n.instants).start, 23 * 3600000);
    const ended = compileRecurrence({ dtstart: zonedValue('2026-03-28', '01:30', 'Europe/Amsterdam'),
      dtend: zonedValue('2026-03-28', '02:30', 'Europe/Amsterdam'), rrule: 'FREQ=DAILY' });
    const [, gapDay] = expandRecurrence(ended, { horizon: [at('2026-03-28T00:00:00Z'), at('2026-03-29T12:00:00Z')], provider: amsterdam }).occurrences;
    assert.deepStrictEqual([gapDay.start.kind === 'zoned' && gapDay.start.time, gapDay.end.kind === 'zoned' && gapDay.end.time],
      ['01:30:00', '03:30:00']);
    refuses(() => expandRecurrence(compileRecurrence({ dtstart: zonedValue('2026-03-28', '09:00', 'Europe/Amsterdam'),
      dtend: zonedValue('2026-03-28', '08:00', 'Europe/Amsterdam'), rrule: 'FREQ=DAILY' }), { horizon, provider: amsterdam }), 'JY0014', '/dtend');
  });
});

describe('COUNT and UNTIL keep their meaning', () => {
  it('COUNT across a day the month does not have: the invalid date is skipped, not clamped, and not counted', () => {
    const thirtieth = compileRecurrence({ dtstart: floatingValue('2026-01-30', '09:00'), rrule: 'FREQ=DAILY;BYMONTHDAY=30;COUNT=3' });
    const got = expandRecurrence(thirtieth, { horizon: [dateValue('2026-01-01'), dateValue('2027-01-01')] });
    assert.deepStrictEqual(got.occurrences.map((o) => o.recurrenceId), ['2026-01-30T09:00:00', '2026-03-30T09:00:00', '2026-04-30T09:00:00']);
    const last = compileRecurrence({ dtstart: dateValue('2026-01-31'), rrule: 'FREQ=DAILY;BYMONTHDAY=31;COUNT=4' });
    assert.deepStrictEqual(expandRecurrence(last, { horizon: [dateValue('2026-01-01'), dateValue('2027-01-01')] }).occurrences
      .map((o) => o.recurrenceId), ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31']);
  });

  it('FREQ=DAILY;COUNT=10 over a horizon after the tenth occurrence is complete and empty: COUNT does not restart', () => {
    const ten = compileRecurrence({ dtstart: dateValue('2026-01-01'), rrule: 'FREQ=DAILY;COUNT=10' });
    const got = expandRecurrence(ten, { horizon: [dateValue('2026-01-11'), dateValue('2027-01-01')] });
    assert.deepStrictEqual([got.status, got.occurrences.length], ['complete', 0]);
    const tenth = expandRecurrence(ten, { horizon: [dateValue('2026-01-10'), dateValue('2027-01-01')] });
    assert.deepStrictEqual(tenth.occurrences.map((o) => o.recurrenceId), ['2026-01-10']);
  });

  it('DTSTART is the first occurrence even when the rule would not make it, and UNTIL before DTSTART makes none', () => {
    const off = compileRecurrence({ dtstart: floatingValue('2026-01-06', '09:00'), rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=2' });
    assert.deepStrictEqual(expandRecurrence(off, { horizon: [dateValue('2026-01-01'), dateValue('2026-02-01')] }).occurrences
      .map((o) => o.recurrenceId), ['2026-01-06T09:00:00', '2026-01-12T09:00:00']);
    const early = compileRecurrence({ dtstart: floatingValue('2026-01-06', '09:00'), rrule: 'FREQ=DAILY;UNTIL=20260106T085959' });
    assert.deepStrictEqual(expandRecurrence(early, { horizon: [dateValue('2026-01-01'), dateValue('2026-02-01')] }).occurrences, []);
    const exact = compileRecurrence({ dtstart: floatingValue('2026-01-06', '09:00'), rrule: 'FREQ=DAILY;UNTIL=20260108T090000' });
    assert.strictEqual(expandRecurrence(exact, { horizon: [dateValue('2026-01-01'), dateValue('2026-02-01')] }).occurrences.length, 3);
  });

  it('a zoned rule ends at its UTC UNTIL, compared as an instant', () => {
    const compiled = compileRecurrence({ dtstart: zonedValue('2026-01-01', '09:00', 'Europe/Amsterdam'), rrule: 'FREQ=DAILY;UNTIL=20260103T080000Z' });
    const got = expandRecurrence(compiled, { horizon: [at('2026-01-01T00:00:00Z'), at('2026-02-01T00:00:00Z')], provider: amsterdam });
    assert.deepStrictEqual(got.occurrences.map((o) => o.recurrenceId), ['2026-01-01T09:00:00', '2026-01-02T09:00:00', '2026-01-03T09:00:00']);
    const shy = compileRecurrence({ dtstart: zonedValue('2026-01-01', '09:00', 'Europe/Amsterdam'), rrule: 'FREQ=DAILY;UNTIL=20260103T075959Z' });
    assert.strictEqual(expandRecurrence(shy, { horizon: [at('2026-01-01T00:00:00Z'), at('2026-02-01T00:00:00Z')], provider: amsterdam })
      .occurrences.length, 2);
  });

  it('without COUNT the walk jumps to the horizon; with COUNT it walks from DTSTART and charges the work', () => {
    const far = /** @type {[any, any]} */ ([dateValue('2030-01-01'), dateValue('2030-01-15')]);
    const free = expandRecurrence(compileRecurrence({ dtstart: dateValue('2000-01-01'), rrule: 'FREQ=DAILY;INTERVAL=7' }), { horizon: far });
    assert.deepStrictEqual([free.counts.emitted, free.counts.work], [2, 7]);
    const counted = expandRecurrence(compileRecurrence({ dtstart: dateValue('2000-01-01'), rrule: 'FREQ=DAILY;INTERVAL=7;COUNT=100000' }),
      { horizon: far });
    assert.strictEqual(counted.counts.emitted, 2);
    assert.strictEqual(counted.counts.work, 1 + 2 * 1568);
  });
});

describe('limits stop the walk with exact counts', () => {
  const daily = compileRecurrence({ dtstart: floatingValue('2026-01-01', '09:00'), duration: 'PT1H', rrule: 'FREQ=DAILY' });
  const year = /** @type {[any, any]} */ ([dateValue('2026-01-01'), dateValue('2027-01-01')]);

  it('maxWork: DTSTART costs 1, each later day 2 (the day and its one start time)', () => {
    const got = expandRecurrence(daily, { horizon: year, limits: { maxWork: 100 } });
    assert.deepStrictEqual([got.status, got.limit, got.counts], ['incomplete', 'maxWork', { emitted: 49, work: 100, providerCalls: 0 }]);
    assert.strictEqual(got.occurrences.at(-1)?.recurrenceId, '2026-02-18T09:00:00');
  });

  it('maxOccurrences', () => {
    const got = expandRecurrence(daily, { horizon: year, limits: { maxOccurrences: 5 } });
    assert.deepStrictEqual([got.status, got.limit, got.counts], ['incomplete', 'maxOccurrences', { emitted: 5, work: 13, providerCalls: 0 }]);
    const exactly = expandRecurrence(compileRecurrence({ dtstart: floatingValue('2026-01-01', '09:00'), rrule: 'FREQ=DAILY;COUNT=5' }),
      { horizon: year, limits: { maxOccurrences: 5 } });
    assert.strictEqual(exactly.status, 'complete');
  });

  it('maxProviderCalls: one call per zero-length zoned occurrence', () => {
    const zoned = compileRecurrence({ dtstart: zonedValue('2026-01-01', '09:00', 'Europe/Amsterdam'), rrule: 'FREQ=DAILY' });
    const got = expandRecurrence(zoned, { horizon: [at('2026-01-01T00:00:00Z'), at('2027-01-01T00:00:00Z')], provider: amsterdam,
      limits: { maxProviderCalls: 3 } });
    assert.deepStrictEqual([got.status, got.limit, got.counts.emitted, got.counts.providerCalls], ['incomplete', 'maxProviderCalls', 3, 3]);
  });

  it('maxHorizonDays clips the horizon; a rule that ended inside it is still complete', () => {
    const got = expandRecurrence(daily, { horizon: year, limits: { maxHorizonDays: 3 } });
    assert.deepStrictEqual([got.status, got.limit, got.counts.emitted], ['incomplete', 'maxHorizonDays', 3]);
    const two = compileRecurrence({ dtstart: floatingValue('2026-01-01', '09:00'), rrule: 'FREQ=DAILY;COUNT=2' });
    assert.strictEqual(expandRecurrence(two, { horizon: year, limits: { maxHorizonDays: 3 } }).status, 'complete');
    assert.deepStrictEqual(RECURRENCE_LIMITS, { maxOccurrences: 10000, maxWork: 1000000, maxProviderCalls: 100000, maxHorizonDays: 36600 });
  });

  it('a rule that never matches is complete over a year and a bounded refusal from nextOccurrences', () => {
    const never = compileRecurrence({ dtstart: floatingValue('2026-01-01', '09:00'), rrule: 'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30' });
    const after = /** @type {[any, any]} */ ([dateValue('2026-01-02'), dateValue('2027-01-02')]);
    const got = expandRecurrence(never, { horizon: after });
    assert.deepStrictEqual([got.status, got.counts], ['complete', { emitted: 0, work: 366, providerCalls: 0 }]);
    const next = nextOccurrences(never, dateValue('2026-01-02'), 1, { limits: { maxWork: 10000 } });
    assert.deepStrictEqual([next.status, next.limit, next.counts], ['incomplete', 'maxWork', { emitted: 0, work: 10000, providerCalls: 0 }]);
  });
});

describe('horizon edges', () => {
  const hour = compileRecurrence({ dtstart: floatingValue('2026-01-01', '09:00'), duration: 'PT1H', rrule: 'FREQ=DAILY;COUNT=1' });
  const instant = compileRecurrence({ dtstart: floatingValue('2026-01-01', '09:00'), rrule: 'FREQ=DAILY;COUNT=1' });
  /**
   * @param {any} compiled
   * @param {string} from
   * @param {string} to
   */
  const count = (compiled, from, to) => expandRecurrence(compiled, {
    horizon: [floatingValue('2026-01-01', from), floatingValue('2026-01-01', to, { bound: 'end' })],
  }).occurrences.length;

  it('an occurrence overlapping the horizon start is in; one ending exactly at it is out', () => {
    assert.strictEqual(count(hour, '09:59:59', '12:00'), 1);
    assert.strictEqual(count(hour, '10:00', '12:00'), 0);
    assert.strictEqual(count(hour, '09:00', '12:00'), 1);
  });

  it('the horizon end is exclusive: an occurrence starting at it is out', () => {
    assert.strictEqual(count(hour, '08:00', '09:00'), 0);
    assert.strictEqual(count(hour, '08:00', '09:00:01'), 1);
  });

  it('a zero-length occurrence at the horizon start is in, at its end out', () => {
    assert.strictEqual(count(instant, '09:00', '12:00'), 1);
    assert.strictEqual(count(instant, '08:00', '09:00'), 0);
  });

  it('a date range and 24:00 bound a floating horizon', () => {
    const got = expandRecurrence(hour, { horizon: [dateValue('2026-01-01'), floatingValue('2026-01-01', '24:00', { bound: 'end' })] });
    assert.strictEqual(got.occurrences.length, 1);
  });

  it('the end of the calendar stops the walk instead of throwing', () => {
    const late = compileRecurrence({ dtstart: dateValue('9999-12-20'), rrule: 'FREQ=DAILY' });
    const got = expandRecurrence(late, { horizon: [dateValue('9999-12-01'), dateValue('9999-12-31')] });
    assert.deepStrictEqual([got.status, got.occurrences.length], ['complete', 11]);
    const lateTime = compileRecurrence({ dtstart: floatingValue('9999-12-30', '09:00'), duration: 'PT1H', rrule: 'FREQ=DAILY' });
    assert.strictEqual(expandRecurrence(lateTime, { horizon: [dateValue('9999-12-30'), floatingValue('9999-12-31', '24:00', { bound: 'end' })] })
      .occurrences.length, 2);
  });

  it('an occurrence whose end passes 9999-12-31 makes the answer incomplete, never a short complete one', () => {
    const pastEnd = /** @type {[any, any]} */ ([dateValue('9999-12-30'), floatingValue('9999-12-31', '24:00', { bound: 'end' })]);
    const day = compileRecurrence({ dtstart: floatingValue('9999-12-30', '09:00'), duration: 'P1D', rrule: 'FREQ=DAILY' });
    const got = expandRecurrence(day, { horizon: pastEnd });
    assert.deepStrictEqual([got.status, got.limit, got.occurrences.map((o) => o.recurrenceId), got.counts],
      ['incomplete', 'calendar-end', ['9999-12-30T09:00:00'], { emitted: 1, work: 5, providerCalls: 0 }]);
    const next = nextOccurrences(day, floatingValue('9999-12-31', '09:00:01'), 1);
    assert.deepStrictEqual([next.status, next.limit, next.occurrences.length], ['incomplete', 'calendar-end', 0]);
    const dates = compileRecurrence({ dtstart: dateValue('9999-12-29'), duration: 'P2D', rrule: 'FREQ=DAILY' });
    const dated = expandRecurrence(dates, { horizon: [dateValue('9999-12-29'), dateValue('9999-12-31')] });
    assert.deepStrictEqual([dated.status, dated.limit, dated.occurrences.length], ['incomplete', 'calendar-end', 1]);
    const utc = tableProvider('UTC', oracleZone('UTC'));
    const zoned = compileRecurrence({ dtstart: zonedValue('9999-12-30', '09:00', 'UTC'), duration: 'P1D', rrule: 'FREQ=DAILY' });
    const lastInstant = Date.UTC(9999, 11, 31, 24);
    const z = expandRecurrence(zoned, { horizon: [Date.UTC(9999, 11, 30), lastInstant], provider: utc });
    assert.deepStrictEqual([z.status, z.limit, z.occurrences.map((o) => o.recurrenceId)], ['incomplete', 'calendar-end', ['9999-12-30T09:00:00']]);
  });
});

describe('kinds', () => {
  it('a date rule answers dates with an exclusive end; a utc rule answers instants', () => {
    const dates = compileRecurrence({ dtstart: dateValue('2026-01-05'), duration: 'P2D', rrule: 'FREQ=WEEKLY;BYDAY=MO,FR;COUNT=3' });
    assert.deepStrictEqual(expandRecurrence(dates, { horizon: [dateValue('2026-01-01'), dateValue('2026-02-01')] }).occurrences, [
      { recurrenceId: '2026-01-05', start: { kind: 'date', date: '2026-01-05' }, end: { kind: 'date', date: '2026-01-07' } },
      { recurrenceId: '2026-01-09', start: { kind: 'date', date: '2026-01-09' }, end: { kind: 'date', date: '2026-01-11' } },
      { recurrenceId: '2026-01-12', start: { kind: 'date', date: '2026-01-12' }, end: { kind: 'date', date: '2026-01-14' } },
    ]);
    const utc = compileRecurrence({ dtstart: utcValue('2026-01-05T09:00:00Z'), dtend: utcValue('2026-01-05T09:30:00Z'), rrule: 'FREQ=DAILY;COUNT=2' });
    const [first] = expandRecurrence(utc, { horizon: [utcValue('2026-01-01T00:00:00Z'), at('2026-02-01T00:00:00Z')] }).occurrences;
    assert.deepStrictEqual(first, {
      recurrenceId: '2026-01-05T09:00:00Z',
      start: { kind: 'utc', instant: '2026-01-05T09:00:00.000Z' },
      end: { kind: 'utc', instant: '2026-01-05T09:30:00.000Z' },
      instants: { start: at('2026-01-05T09:00:00Z'), end: at('2026-01-05T09:30:00Z') },
    });
    const date = compileRecurrence({ dtstart: dateValue('2026-01-05'), rrule: 'FREQ=DAILY;COUNT=1' });
    assert.deepStrictEqual(expandRecurrence(date, { horizon: [dateValue('2026-01-05'), dateValue('2026-01-06')] }).occurrences[0].end,
      { kind: 'date', date: '2026-01-06' });
  });

  it('a floating rule gives one answer under every host zone', () => {
    const script = "import { compileRecurrence, expandRecurrence, floatingValue, dateValue } from '@jarenjs/core/calendar';"
      + "const r = compileRecurrence({ dtstart: floatingValue('2026-03-27', '02:30'), duration: 'P1D', rrule: 'FREQ=DAILY;BYHOUR=2,3;COUNT=9' });"
      + "process.stdout.write(JSON.stringify(expandRecurrence(r, { horizon: [dateValue('2026-03-01'), dateValue('2026-04-01')] })));";
    const outputs = ['UTC', 'Europe/Amsterdam', 'America/New_York'].map((TZ) => execFileSync(process.execPath,
      ['--input-type=module', '-e', script], { cwd: REPO_ROOT, env: { ...process.env, TZ, FORCE_COLOR: '0' }, encoding: 'utf8' }));
    assert.strictEqual(outputs[1], outputs[0]);
    assert.strictEqual(outputs[2], outputs[0]);
    const parsed = JSON.parse(outputs[0]);
    assert.strictEqual(parsed.occurrences.length, 9);
    assert.deepStrictEqual(parsed.occurrences[4].start, { kind: 'floating', date: '2026-03-29', time: '02:30:00' });
  });
});

describe('nextOccurrences is expandRecurrence stopped after n', () => {
  const weekly = compileRecurrence({ dtstart: floatingValue('2026-01-05', '09:00'), rrule: 'FREQ=WEEKLY;BYDAY=MO,TH' });

  it('the next n from a start, then the same as the horizon would give', () => {
    const next = nextOccurrences(weekly, dateValue('2026-02-01'), 3);
    assert.deepStrictEqual([next.status, next.occurrences.map((o) => o.recurrenceId)],
      ['complete', ['2026-02-02T09:00:00', '2026-02-05T09:00:00', '2026-02-09T09:00:00']]);
    const window = expandRecurrence(weekly, { horizon: [dateValue('2026-02-01'), dateValue('2026-02-10')] });
    assert.deepStrictEqual(next.occurrences, window.occurrences);
  });

  it('complete with fewer when the rule ends; incomplete when the horizon runs out first', () => {
    const ten = compileRecurrence({ dtstart: floatingValue('2026-01-05', '09:00'), rrule: 'FREQ=DAILY;COUNT=10' });
    const got = nextOccurrences(ten, dateValue('2026-01-01'), 20);
    assert.deepStrictEqual([got.status, got.occurrences.length], ['complete', 10]);
    const sparse = nextOccurrences(weekly, dateValue('2026-01-01'), 3, { limits: { maxHorizonDays: 8 } });
    assert.deepStrictEqual([sparse.status, sparse.limit, sparse.occurrences.length], ['incomplete', 'maxHorizonDays', 2]);
    const capped = nextOccurrences(weekly, dateValue('2026-01-01'), 3, { limits: { maxOccurrences: 2 } });
    assert.deepStrictEqual([capped.status, capped.limit], ['incomplete', 'maxOccurrences']);
  });

  it('a zoned walk settles its order only after a gap-moved start, and a limit while settling is incomplete', () => {
    const far = compileRecurrence({ dtstart: zonedValue('2026-01-01', '09:00', 'Europe/Amsterdam'), rrule: 'FREQ=DAILY' });
    // three days of margin before the start (each resolved, none in), then the first found ends it
    assert.deepStrictEqual(nextOccurrences(far, at('2026-01-10T00:00:00Z'), 1, { provider: amsterdam }).counts,
      { emitted: 1, work: 9, providerCalls: 4 });
    const gap = compileRecurrence({ dtstart: zonedValue('2026-03-28', '02:00', 'Europe/Amsterdam'), rrule: 'FREQ=DAILY;BYHOUR=2,3;BYMINUTE=0,30' });
    const settled = nextOccurrences(gap, at('2026-03-29T00:45:00Z'), 1, { provider: amsterdam });
    assert.deepStrictEqual([settled.status, settled.counts], ['complete', { emitted: 1, work: 26, providerCalls: 17 }]);
    const short = nextOccurrences(gap, at('2026-03-29T00:45:00Z'), 1, { provider: amsterdam, limits: { maxProviderCalls: 10 } });
    assert.deepStrictEqual([short.status, short.limit, short.counts.providerCalls], ['incomplete', 'maxProviderCalls', 10]);
  });

  it('a zoned rule takes its provider in the options', () => {
    const zoned = compileRecurrence({ dtstart: zonedValue('2026-03-28', '02:30', 'Europe/Amsterdam'), rrule: 'FREQ=DAILY' });
    const got = nextOccurrences(zoned, at('2026-03-29T00:00:00Z'), 1, { provider: amsterdam });
    assert.strictEqual(iso(got.occurrences[0].instants?.start), '2026-03-29T01:30:00.000Z');
  });
});

describe('options are checked', () => {
  const floating = compileRecurrence({ dtstart: floatingValue('2026-01-05', '09:00'), rrule: 'FREQ=DAILY' });
  const zoned = compileRecurrence({ dtstart: zonedValue('2026-01-05', '09:00', 'Europe/Amsterdam'), rrule: 'FREQ=DAILY' });
  const horizon = /** @type {[any, any]} */ ([dateValue('2026-01-01'), dateValue('2026-02-01')]);

  it('refusals name the option at fault', () => {
    refuses(() => expandRecurrence(/** @type {any} */ ({ kind: 'recurrence' }), { horizon }), 'JY0014', '/compiled');
    refuses(() => expandRecurrence(floating, /** @type {any} */ (undefined)), 'JY0014', '/options');
    refuses(() => expandRecurrence(floating, /** @type {any} */ ({ horizon: [horizon[0]] })), 'JY0014', '/options/horizon');
    refuses(() => expandRecurrence(floating, { horizon: [horizon[1], horizon[0]] }), 'JY0014', '/options/horizon/1');
    refuses(() => expandRecurrence(floating, { horizon: [at('2026-01-01T00:00:00Z'), at('2026-02-01T00:00:00Z')] }), 'JY0013', '/options/horizon/0');
    refuses(() => expandRecurrence(floating, { horizon: [utcValue('2026-01-01T00:00:00Z'), horizon[1]] }), 'JY0013', '/options/horizon/0');
    refuses(() => expandRecurrence(zoned, { horizon, provider: amsterdam }), 'JY0013', '/options/horizon/0');
    refuses(() => expandRecurrence(zoned, { horizon: [0, 1.5], provider: amsterdam }), 'JY0013', '/options/horizon/1');
    refuses(() => expandRecurrence(zoned, { horizon: [0, DAY] }), 'JY0004', '/provider');
    refuses(() => expandRecurrence(floating, { horizon, limits: /** @type {any} */ ({ maxFoo: 1 }) }), 'JY0014', '/options/limits/maxFoo');
    refuses(() => expandRecurrence(floating, { horizon, limits: { maxWork: -1 } }), 'JY0014', '/options/limits/maxWork');
    refuses(() => expandRecurrence(floating, { horizon, limits: /** @type {any} */ (5) }), 'JY0014', '/options/limits');
    refuses(() => nextOccurrences(floating, horizon[0], 0), 'JY0014', '/n');
    refuses(() => nextOccurrences(floating, horizon[0], 1, /** @type {any} */ (7)), 'JY0014', '/options');
    refuses(() => nextOccurrences(floating, utcValue('2026-01-01T00:00:00Z'), 1), 'JY0013', '/from');
  });

  it('a member the call does not read is refused, never ignored', () => {
    refuses(() => compileRecurrence(/** @type {any} */ ({ dtstart: floatingValue('2026-01-05', '09:00'), rrule: 'FREQ=DAILY', zone: 'UTC' })),
      'JY0014', '/zone');
    refuses(() => expandRecurrence(floating, /** @type {any} */ ({ horizon, policy: 'reject' })), 'JY0014', '/options/policy');
    refuses(() => expandRecurrence(zoned, /** @type {any} */ ({ horizon: [0, DAY], provider: amsterdam, zone: 'Europe/Amsterdam' })),
      'JY0014', '/options/zone');
    refuses(() => nextOccurrences(floating, horizon[0], 1, /** @type {any} */ ({ maxWork: 10000 })), 'JY0014', '/options/maxWork');
    refuses(() => formatRRule(/** @type {any} */ ({ kind: 'recurrence', rrule: { FREQ: 'FORTNIGHTLY' } })), 'JY0015', 'rrule.FREQ');
  });

  it('inputs are not changed and answers are frozen', () => {
    const got = expandRecurrence(floating, { horizon });
    assert.ok(Object.isFrozen(got) && Object.isFrozen(got.occurrences) && Object.isFrozen(got.occurrences[0]) && Object.isFrozen(got.counts));
    assert.deepStrictEqual(horizon, [{ kind: 'date', date: '2026-01-01' }, { kind: 'date', date: '2026-02-01' }]);
  });
});
