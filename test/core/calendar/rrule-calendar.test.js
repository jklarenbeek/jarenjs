//@ts-check

/**
 * MONTHLY and YEARLY recurrence, worked by hand against RFC 5545 §3.3.10:
 * what DTSTART supplies when the rule leaves a part out, where a BYDAY
 * ordinal counts, invalid dates skipped and never clamped, leap years,
 * negative indexes, BYSETPOS over each period, BYWEEKNO under WKST, the
 * four readings where python-dateutil differs (its fixture leaves them
 * out), the limits on a rule that never matches, local times across the
 * Amsterdam changes, the end of the calendar, series and nextOccurrences.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  compileRecurrence, defineSeries, expandRecurrence, expandSeries, floatingValue, nextOccurrences, zonedValue,
} from '@jarenjs/core/calendar';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';

const provider = createIntlZoneProvider({ revision: 'host' });

/**
 * The dates a floating 09:00 rule makes from `date` (DTSTART counted) up to 2200.
 * @param {string} rrule
 * @param {string} date
 * @param {string} [time]
 */
function dates(rrule, date, time = '09:00') {
  const compiled = compileRecurrence({ dtstart: floatingValue(date, time), rrule });
  const got = expandRecurrence(compiled, { horizon: [floatingValue(date, '00:00'), floatingValue('2200-01-01', '00:00')] });
  assert.strictEqual(got.status, 'complete', rrule);
  return got.occurrences.map((o) => o.recurrenceId.slice(0, 10));
}

describe('what DTSTART supplies when the rule leaves a part out', () => {
  const rows = /** @type {[string, string, string[]][]} */ ([
    // MONTHLY with no BYMONTHDAY or BYDAY: DTSTART's day of the month, skipped where the month has none
    ['FREQ=MONTHLY;COUNT=4', '2026-01-31', ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31']],
    // BYMONTH only limits MONTHLY: the day is still DTSTART's, and February has no 30th
    ['FREQ=MONTHLY;COUNT=3;BYMONTH=2,3', '2026-01-30', ['2026-01-30', '2026-03-30', '2027-03-30']],
    // YEARLY with nothing: DTSTART's month and day; 29 February only in leap years, never moved
    ['FREQ=YEARLY;COUNT=3', '2024-02-29', ['2024-02-29', '2028-02-29', '2032-02-29']],
    // YEARLY with BYMONTH only: DTSTART's day in each named month
    ['FREQ=YEARLY;COUNT=4;BYMONTH=1,7', '2026-01-31', ['2026-01-31', '2026-07-31', '2027-01-31', '2027-07-31']],
    // YEARLY with BYMONTHDAY only: that day of every month
    ['FREQ=YEARLY;COUNT=3;BYMONTHDAY=15', '2026-03-15', ['2026-03-15', '2026-04-15', '2026-05-15']],
    // YEARLY with a plain BYDAY only: every such weekday of the year
    ['FREQ=YEARLY;COUNT=3;BYDAY=MO', '2026-01-05', ['2026-01-05', '2026-01-12', '2026-01-19']],
    // YEARLY with BYWEEKNO only: DTSTART's weekday in that week (dateutil makes all seven days)
    ['FREQ=YEARLY;COUNT=3;BYWEEKNO=20', '2026-05-13', ['2026-05-13', '2027-05-19', '2028-05-17']],
    ['FREQ=YEARLY;COUNT=3;BYYEARDAY=-1', '2026-12-31', ['2026-12-31', '2027-12-31', '2028-12-31']],
  ]);
  for (const [rule, date, want] of rows)
    it(`${rule} from ${date}`, () => assert.deepStrictEqual(dates(rule, date), want));
});

describe('where an ordinal BYDAY counts (errata 1913 and 3779)', () => {
  const rows = /** @type {[string, string, string[]][]} */ ([
    // YEARLY without BYMONTH: within the year
    ['FREQ=YEARLY;COUNT=3;BYDAY=1MO', '2026-01-05', ['2026-01-05', '2027-01-04', '2028-01-03']],
    ['FREQ=YEARLY;COUNT=2;BYDAY=-1SU', '2026-12-27', ['2026-12-27', '2027-12-26']],
    // only years with 53 Mondays
    ['FREQ=YEARLY;COUNT=4;BYDAY=53MO', '2024-12-30', ['2024-12-30', '2029-12-31', '2035-12-31', '2040-12-31']],
    // YEARLY with BYMONTH: within each month
    ['FREQ=YEARLY;COUNT=3;BYDAY=1MO;BYMONTH=1,2', '2026-01-05', ['2026-01-05', '2026-02-02', '2027-01-04']],
    // MONTHLY: within the month; a fifth Friday only where the month has one (29 February 2036 is one)
    ['FREQ=MONTHLY;COUNT=4;BYDAY=5FR', '2036-01-04', ['2036-01-04', '2036-02-29', '2036-05-30', '2036-08-29']],
    ['FREQ=MONTHLY;COUNT=4;BYDAY=-1FR', '2026-01-30', ['2026-01-30', '2026-02-27', '2026-03-27', '2026-04-24']],
    // an ordinal beside BYMONTHDAY limits: the 1st to the 7th that is the month's first Sunday
    ['FREQ=MONTHLY;COUNT=3;BYDAY=1SU;BYMONTHDAY=1,2,3,4,5,6,7', '2026-01-04', ['2026-01-04', '2026-02-01', '2026-03-01']],
  ]);
  for (const [rule, date, want] of rows)
    it(`${rule} from ${date}`, () => assert.deepStrictEqual(dates(rule, date), want));
});

describe('invalid dates are skipped, not clamped; negative indexes count from the end', () => {
  const rows = /** @type {[string, string, string[]][]} */ ([
    // -31 is the 1st of a 31-day month and no day of a shorter one
    ['FREQ=MONTHLY;COUNT=4;BYMONTHDAY=-31', '2026-01-01', ['2026-01-01', '2026-03-01', '2026-05-01', '2026-07-01']],
    ['FREQ=MONTHLY;COUNT=4;BYMONTHDAY=31', '2026-01-31', ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31']],
    ['FREQ=YEARLY;COUNT=2;BYMONTH=2;BYMONTHDAY=29', '2024-02-29', ['2024-02-29', '2028-02-29']],
    // day 366 and day -366 exist only in leap years
    ['FREQ=YEARLY;COUNT=2;BYYEARDAY=366', '2024-12-31', ['2024-12-31', '2028-12-31']],
    ['FREQ=YEARLY;COUNT=2;BYYEARDAY=-366', '2024-01-01', ['2024-01-01', '2028-01-01']],
  ]);
  for (const [rule, date, want] of rows)
    it(`${rule} from ${date}`, () => assert.deepStrictEqual(dates(rule, date), want));
});

describe('BYSETPOS picks from each period\'s whole set, before DTSTART is applied', () => {
  it('the last weekday of the month; the first and last Friday of the year', () => {
    assert.deepStrictEqual(dates('FREQ=MONTHLY;COUNT=4;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', '2026-01-30'),
      ['2026-01-30', '2026-02-27', '2026-03-31', '2026-04-30']);
    assert.deepStrictEqual(dates('FREQ=YEARLY;COUNT=4;BYDAY=FR;BYSETPOS=1,-1', '2026-01-02'),
      ['2026-01-02', '2026-12-25', '2027-01-01', '2027-12-31']);
  });

  it('a position before DTSTART in its own period is not made; times are part of the set', () => {
    // January's first is the 1st, before DTSTART on the 15th
    assert.deepStrictEqual(dates('FREQ=MONTHLY;COUNT=3;BYMONTHDAY=1,15,28;BYSETPOS=1', '2026-01-15'), ['2026-01-15', '2026-02-01', '2026-03-01']);
    const compiled = compileRecurrence({ dtstart: floatingValue('2026-01-01', '17:00'), rrule: 'FREQ=MONTHLY;COUNT=3;BYMONTHDAY=1;BYHOUR=9,17;BYSETPOS=-1' });
    const got = expandRecurrence(compiled, { horizon: [floatingValue('2026-01-01', '00:00'), floatingValue('2027-01-01', '00:00')] });
    assert.deepStrictEqual(got.occurrences.map((o) => o.recurrenceId), ['2026-01-01T17:00:00', '2026-02-01T17:00:00', '2026-03-01T17:00:00']);
  });
});

describe('BYWEEKNO numbers the weeks of the year under WKST', () => {
  it('week 1 can start in December; WKST moves it', () => {
    // 2026-01-01 is a Thursday: ISO week 1 runs Mon 2025-12-29 to Sun 2026-01-04
    assert.deepStrictEqual(dates('FREQ=YEARLY;COUNT=3;BYWEEKNO=1;BYDAY=MO,SU', '2025-12-29'), ['2025-12-29', '2026-01-04', '2027-01-04']);
    // from a Sunday in it, WKST=MO and WKST=SU name different weeks
    assert.deepStrictEqual(dates('FREQ=YEARLY;COUNT=3;BYWEEKNO=1;BYDAY=MO,SU', '2026-01-04'), ['2026-01-04', '2027-01-04', '2027-01-10']);
    assert.deepStrictEqual(dates('FREQ=YEARLY;COUNT=3;BYWEEKNO=1;BYDAY=MO,SU;WKST=SU', '2026-01-04'), ['2026-01-04', '2026-01-05', '2027-01-03']);
  });

  it('a numbered week belongs to its year, with INTERVAL and BYSETPOS (dateutil puts its days in their calendar year)', () => {
    // every other year from 2024: 2026's week 1 starts on 2025-12-29; 2024-12-30 is 2025's week 1
    assert.deepStrictEqual(dates('FREQ=YEARLY;COUNT=3;INTERVAL=2;BYWEEKNO=1;BYDAY=MO', '2024-01-01'), ['2024-01-01', '2025-12-29', '2028-01-03']);
    // INTERVAL counts from the year that numbers DTSTART's week: 2025-12-29 is 2026's week 1, so every other year is 2026, 2028, 2030
    assert.deepStrictEqual(dates('FREQ=YEARLY;COUNT=3;INTERVAL=2;BYWEEKNO=1;BYDAY=MO', '2025-12-29'), ['2025-12-29', '2028-01-03', '2029-12-31']);
    // and 2021-01-02 is 2020's week 53: 2020, 2022, ... of which 2026 and 2032 have a week 53
    assert.deepStrictEqual(dates('FREQ=YEARLY;COUNT=3;INTERVAL=2;BYWEEKNO=53;BYDAY=SA', '2021-01-02'), ['2021-01-02', '2027-01-02', '2033-01-01']);
    // the last day of week 53 is in January; 2020, 2026 and 2032 have a week 53
    assert.deepStrictEqual(dates('FREQ=YEARLY;COUNT=4;BYWEEKNO=53;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYSETPOS=-1', '2020-12-27'),
      ['2020-12-27', '2021-01-03', '2027-01-03', '2033-01-02']);
  });

  it('week 53 only in a year that has it, and -53 is then week 1 (dateutil misses both)', () => {
    assert.deepStrictEqual(dates('FREQ=YEARLY;COUNT=6;BYWEEKNO=53;BYDAY=SA,SU', '2020-12-28'),
      ['2020-12-28', '2021-01-02', '2021-01-03', '2027-01-02', '2027-01-03', '2033-01-01']);
    assert.deepStrictEqual(dates('FREQ=YEARLY;COUNT=3;BYWEEKNO=-53;BYDAY=MO', '2019-12-30'), ['2019-12-30', '2025-12-29', '2031-12-29']);
  });

  it('a horizon that opens on 1 January finds the previous year\'s week 53 without COUNT', () => {
    // 2021-01-02 and 2021-01-03 are days of 2020's week 53: the walk skips ahead, but not past 2020
    const rule = compileRecurrence({ dtstart: floatingValue('2020-12-28', '09:00'), rrule: 'FREQ=YEARLY;BYWEEKNO=53;BYDAY=SA,SU' });
    const got = expandRecurrence(rule, { horizon: [floatingValue('2021-01-01', '00:00'), floatingValue('2021-01-10', '00:00')] });
    assert.deepStrictEqual(got.occurrences.map((o) => o.recurrenceId), ['2021-01-02T09:00:00', '2021-01-03T09:00:00']);
  });
});

describe('BYDAY is a list: plain and ordinal weekdays each select (dateutil intersects them)', () => {
  it('the first Thursday and every Friday', () => {
    assert.deepStrictEqual(dates('FREQ=MONTHLY;COUNT=6;BYDAY=1TH,FR', '2026-01-01'),
      ['2026-01-01', '2026-01-02', '2026-01-09', '2026-01-16', '2026-01-23', '2026-01-30']);
  });
});

describe('limits on a rule that rarely or never matches', () => {
  const never = compileRecurrence({ dtstart: floatingValue('2026-01-01', '09:00'), rrule: 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30' });

  it('a year of horizon is complete and empty, every day examined once', () => {
    const got = expandRecurrence(never, { horizon: [floatingValue('2027-01-01', '00:00'), floatingValue('2028-01-01', '00:00')] });
    assert.deepStrictEqual(got, { status: 'complete', occurrences: [], counts: { emitted: 0, work: 366, providerCalls: 0 } });
  });

  it('nextOccurrences stops at maxWork with exact counts, never spinning', () => {
    const got = nextOccurrences(never, floatingValue('2026-01-02', '00:00'), 1, { limits: { maxWork: 10000 } });
    assert.deepStrictEqual(got, { status: 'incomplete', occurrences: [], counts: { emitted: 0, work: 10000, providerCalls: 0 }, limit: 'maxWork' });
    // under the default limits it walks the 100-year horizon and says so
    const far = nextOccurrences(never, floatingValue('2026-01-02', '00:00'), 1);
    assert.strictEqual(far.status, 'incomplete');
    assert.strictEqual(far.limit, 'maxHorizonDays');
  });

  it('29 February on a Monday: first made in 2044, then 2072', () => {
    const rule = compileRecurrence({ dtstart: floatingValue('2026-01-05', '09:00'), rrule: 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29;BYDAY=MO' });
    const next = nextOccurrences(rule, floatingValue('2026-01-06', '00:00'), 2);
    assert.strictEqual(next.status, 'complete');
    assert.deepStrictEqual(next.occurrences.map((o) => o.recurrenceId), ['2044-02-29T09:00:00', '2072-02-29T09:00:00']);
  });

  it('the work of a short MONTHLY rule: one per day examined, one per start a passing day makes', () => {
    const rule = compileRecurrence({ dtstart: floatingValue('2026-01-01', '09:00'), rrule: 'FREQ=MONTHLY;COUNT=3;BYMONTHDAY=1' });
    const got = expandRecurrence(rule, { horizon: [floatingValue('2026-01-01', '00:00'), floatingValue('2027-01-01', '00:00')] });
    // DTSTART 1, then January 31 + 1, February 28 + 1, March 31 + 1
    assert.deepStrictEqual(got.counts, { emitted: 3, work: 94, providerCalls: 0 });
    // a budget that runs out inside February keeps January's occurrence, never a part of February's set
    const short = expandRecurrence(compileRecurrence({ dtstart: floatingValue('2026-01-01', '09:00'), rrule: 'FREQ=MONTHLY;BYMONTHDAY=1' }),
      { horizon: [floatingValue('2026-01-01', '00:00'), floatingValue('2027-01-01', '00:00')], limits: { maxWork: 40 } });
    assert.deepStrictEqual([short.status, short.limit, short.counts, short.occurrences.map((o) => o.recurrenceId)],
      ['incomplete', 'maxWork', { emitted: 1, work: 40, providerCalls: 0 }, ['2026-01-01T09:00:00']]);
  });
});

describe('local times across the Amsterdam changes, under the rule\'s policy', () => {
  /** @param {'rfc5545' | 'later' | 'reject'} policy @param {number} [from] */
  const lastSundays = (policy, from = Date.UTC(2026, 2, 1)) => expandRecurrence(compileRecurrence({
    dtstart: zonedValue('2026-01-25', '02:30', 'Europe/Amsterdam'), rrule: 'FREQ=MONTHLY;BYDAY=-1SU', policy,
  }), { horizon: [from, Date.UTC(2026, 10, 1)], provider });

  it('02:30 on the last Sunday: moved forward in March, earlier or later in October', () => {
    const earlier = lastSundays('rfc5545');
    assert.strictEqual(earlier.occurrences.length, 8);
    assert.strictEqual(earlier.occurrences[0].instants?.start, Date.UTC(2026, 2, 29, 1, 30));
    assert.deepStrictEqual(earlier.occurrences[0].start, { kind: 'zoned', date: '2026-03-29', time: '03:30:00', zone: 'Europe/Amsterdam' });
    assert.strictEqual(earlier.occurrences[1].instants?.start, Date.UTC(2026, 3, 26, 0, 30));
    assert.strictEqual(earlier.occurrences[7].instants?.start, Date.UTC(2026, 9, 25, 0, 30));
    const later = lastSundays('later');
    assert.strictEqual(later.occurrences[0].instants?.start, Date.UTC(2026, 2, 29, 1, 30));
    assert.strictEqual(later.occurrences[7].instants?.start, Date.UTC(2026, 9, 25, 1, 30));
    assert.ok(earlier.occurrences.every((o) => o.recurrenceId.endsWith('T02:30:00')));
  });

  it('reject refuses the gap, then the fold', () => {
    assert.throws(() => lastSundays('reject'), (/** @type {any} */ error) => error.code === 'JY0002');
    assert.throws(() => lastSundays('reject', Date.UTC(2026, 3, 1)), (/** @type {any} */ error) => error.code === 'JY0003');
  });
});

describe('the end of the calendar', () => {
  it('a MONTHLY end past 9999-12-31 stops incomplete; a YEARLY rule whose last week is there completes', () => {
    const monthly = compileRecurrence({ dtstart: floatingValue('9999-10-31', '09:00'), duration: 'P1D', rrule: 'FREQ=MONTHLY;BYMONTHDAY=31' });
    const got = expandRecurrence(monthly, { horizon: [floatingValue('9999-10-01', '00:00'), floatingValue('9999-12-31', '24:00', { bound: 'end' })] });
    assert.deepStrictEqual([got.status, got.limit, got.occurrences.map((o) => o.recurrenceId)], ['incomplete', 'calendar-end', ['9999-10-31T09:00:00']]);
    // week 52 of 9999 runs from 9999-12-27 into the year 10000
    const yearly = compileRecurrence({ dtstart: floatingValue('9997-12-01', '09:00'), rrule: 'FREQ=YEARLY;BYWEEKNO=52;BYDAY=FR' });
    const last = expandRecurrence(yearly, { horizon: [floatingValue('9997-01-01', '00:00'), floatingValue('9999-12-31', '24:00', { bound: 'end' })] });
    assert.deepStrictEqual([last.status, last.occurrences.map((o) => o.recurrenceId.slice(0, 10))],
      ['complete', ['9997-12-01', '9997-12-26', '9998-12-25', '9999-12-31']]);
  });
});

describe('series and nextOccurrences take MONTHLY rules like any other', () => {
  it('the first Sunday of the month, with an excluded date and a moved slot from outside the horizon', () => {
    const base = compileRecurrence({ dtstart: floatingValue('2026-01-04', '10:00'), duration: 'PT6H', rrule: 'FREQ=MONTHLY;BYDAY=1SU' });
    const series = defineSeries({ uid: 'shop', base, exdates: [floatingValue('2026-03-01', '10:00')],
      overrides: [{ recurrenceId: '2026-06-07T10:00:00', status: 'moved', start: floatingValue('2026-04-19', '10:00') }] });
    const got = expandSeries(series, { horizon: [floatingValue('2026-01-01', '00:00'), floatingValue('2026-05-01', '00:00')] });
    assert.strictEqual(got.status, 'complete');
    assert.deepStrictEqual(got.occurrences.map((o) => [o.recurrenceId, /** @type {any} */ (o.start).date]), [
      ['2026-01-04T10:00:00', '2026-01-04'], ['2026-02-01T10:00:00', '2026-02-01'],
      ['2026-04-05T10:00:00', '2026-04-05'], ['2026-06-07T10:00:00', '2026-04-19']]);
  });

  it('the next three last Fridays', () => {
    const rule = compileRecurrence({ dtstart: floatingValue('2026-01-30', '09:00'), rrule: 'FREQ=MONTHLY;BYDAY=-1FR' });
    const next = nextOccurrences(rule, floatingValue('2026-06-01', '00:00'), 3);
    assert.deepStrictEqual([next.status, next.occurrences.map((o) => o.recurrenceId)],
      ['complete', ['2026-06-26T09:00:00', '2026-07-31T09:00:00', '2026-08-28T09:00:00']]);
  });
});
