//@ts-check

/**
 * The five temporal value kinds: each constructor's answer is frozen
 * JSON that keeps what the caller wrote, and each refusal names one
 * fault with its own code - nothing is rounded, truncated or rolled.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  dateValue, floatingValue, utcValue, zonedValue, dateRangeValue, parseTemporal, resolveLocal, CalendarError,
} from '@jarenjs/core/calendar';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';

const provider = createIntlZoneProvider();

/**
 * @param {string} code
 * @param {string} [docPath]
 * @returns {(error: unknown) => boolean}
 */
const refusal = (code, docPath = undefined) => (error) => error instanceof CalendarError && error.code === code
  && (docPath === undefined || error.docPath === docPath);

describe('constructors', () => {
  it('answer frozen plain JSON that keeps the spelling given', () => {
    const values = [
      [dateValue('2026-03-29'), { kind: 'date', date: '2026-03-29' }],
      [floatingValue('2026-03-29', '09:00'), { kind: 'floating', date: '2026-03-29', time: '09:00' }],
      [floatingValue('2026-03-29', '09:00:05.25'), { kind: 'floating', date: '2026-03-29', time: '09:00:05.25' }],
      [utcValue('2026-03-29T01:30:00Z'), { kind: 'utc', instant: '2026-03-29T01:30:00Z' }],
      [zonedValue('2026-10-25', '02:30', 'Europe/Amsterdam'), { kind: 'zoned', date: '2026-10-25', time: '02:30', zone: 'Europe/Amsterdam' }],
      [dateRangeValue('2026-07-01', '2026-07-14'), { kind: 'date-range', start: '2026-07-01', end: '2026-07-15' }],
    ];
    for (const [value, expected] of values) {
      assert.deepStrictEqual(value, expected);
      assert.ok(Object.isFrozen(value));
      assert.deepStrictEqual(JSON.parse(JSON.stringify(value)), expected);
      assert.deepStrictEqual(parseTemporal(JSON.stringify(value)), expected);
    }
  });

  it('spell a utc number with three fraction digits, across the whole range', () => {
    assert.deepStrictEqual(utcValue(0), { kind: 'utc', instant: '1970-01-01T00:00:00.000Z' });
    assert.strictEqual(utcValue(Date.parse('2026-03-29T01:30:00.007Z')).instant, '2026-03-29T01:30:00.007Z');
    assert.strictEqual(utcValue(Date.parse('0000-01-01T00:00:00Z')).instant, '0000-01-01T00:00:00.000Z');
    assert.strictEqual(utcValue(Date.parse('9999-12-31T23:59:59.999Z')).instant, '9999-12-31T23:59:59.999Z');
    assert.strictEqual(utcValue(-1).instant, '1969-12-31T23:59:59.999Z');
  });

  it('dateRangeValue writes the +1: across a month, a year and a leap day', () => {
    assert.strictEqual(dateRangeValue('2026-01-31', '2026-01-31').end, '2026-02-01');
    assert.strictEqual(dateRangeValue('2026-12-01', '2026-12-31').end, '2027-01-01');
    assert.strictEqual(dateRangeValue('2028-02-01', '2028-02-28').end, '2028-02-29');
    assert.strictEqual(dateRangeValue('2028-02-29', '2028-02-29').end, '2028-03-01');
    assert.throws(() => dateRangeValue('2026-07-14', '2026-07-01'), refusal('JY0013', '/endInclusive'));
    assert.throws(() => dateRangeValue('2026-07-01', '9999-12-31'), refusal('JY0012', '/endInclusive'));
    assert.throws(() => dateRangeValue('2026-02-30', '2026-03-01'), refusal('JY0012', '/start'));
  });

  it('admit 24:00 only on an end bound, in each of its spellings', () => {
    for (const time of ['24:00', '24:00:00', '24:00:00.0', '24:00:00.00', '24:00:00.000']) {
      assert.strictEqual(floatingValue('2026-03-29', time, { bound: 'end' }).time, time);
      assert.strictEqual(zonedValue('2026-03-29', time, 'UTC', { bound: 'end' }).time, time);
      assert.throws(() => floatingValue('2026-03-29', time), refusal('JY0008', '/time'));
      assert.throws(() => floatingValue('2026-03-29', time, { bound: 'start' }), refusal('JY0008'));
      assert.throws(() => zonedValue('2026-03-29', time, 'UTC'), refusal('JY0008'));
      assert.throws(() => parseTemporal({ kind: 'floating', date: '2026-03-29', time }), refusal('JY0008'));
      assert.strictEqual(/** @type {any} */ (parseTemporal({ kind: 'floating', date: '2026-03-29', time }, { bound: 'end' })).time, time);
    }
    for (const time of ['24:01', '24:00:01', '24:00:00.5', '25:00'])
      assert.throws(() => floatingValue('2026-03-29', time, { bound: 'end' }), refusal('JY0013'));
    assert.throws(() => floatingValue('2026-03-29', '09:00', /** @type {any} */ ({ bound: 'END' })), refusal('JY0014', '/options/bound'));
  });

  it('a start bound admits every other time of day', () => {
    for (const time of ['00:00', '23:59', '23:59:59', '23:59:59.999', '12:00:00.1', '12:00:00.12'])
      assert.strictEqual(floatingValue('2026-03-29', time, { bound: 'start' }).time, time);
  });
});

describe('refusals, one code each', () => {
  const cases = /** @type {Array<[string, () => unknown, string, string]>} */ ([
    ['a leap second', () => floatingValue('2016-12-31', '23:59:60'), 'JY0009', '/time'],
    ['a leap second in a utc instant', () => utcValue('2016-12-31T23:59:60Z'), 'JY0009', '/instant'],
    ['a fourth fraction digit', () => floatingValue('2026-03-29', '09:00:00.0001'), 'JY0010', '/time'],
    ['a fourth fraction digit in a utc instant', () => utcValue('2026-03-29T09:00:00.1234Z'), 'JY0010', '/instant'],
    ['a utc number with a fraction of a millisecond', () => utcValue(0.5), 'JY0010', '/instant'],
    ['an offset on a floating time', () => floatingValue('2026-03-29', '09:00+01:00'), 'JY0011', '/time'],
    ['Z on a floating time', () => floatingValue('2026-03-29', '09:00Z'), 'JY0011', '/time'],
    ['an offset on a zoned time', () => zonedValue('2026-03-29', '09:00:00-05:00', 'America/New_York'), 'JY0011', '/time'],
    ['the thirtieth of February', () => dateValue('2026-02-30'), 'JY0012', '/date'],
    ['the twenty-ninth of February in a common year', () => dateValue('2100-02-29'), 'JY0012', '/date'],
    ['month 13', () => dateValue('2026-13-01'), 'JY0012', '/date'],
    ['the thirtieth of February in a utc instant', () => utcValue('2026-02-30T00:00:00Z'), 'JY0012', '/instant'],
    ['a utc number past 9999', () => utcValue(Date.parse('9999-12-31T23:59:59.999Z') + 1), 'JY0012', '/instant'],
    ['24:00 in a utc instant', () => utcValue('2026-03-29T24:00:00Z'), 'JY0008', '/instant'],
    ['a utc instant with an offset', () => utcValue('2026-03-29T09:00:00+00:00'), 'JY0013', '/instant'],
    ['a utc instant without Z', () => utcValue('2026-03-29T09:00:00'), 'JY0013', '/instant'],
    ['a utc instant with lower-case z', () => utcValue('2026-03-29T09:00:00z'), 'JY0013', '/instant'],
    ['a utc instant without seconds', () => utcValue('2026-03-29T09:00Z'), 'JY0013', '/instant'],
    ['a utc instant at minute 60', () => utcValue('2026-03-29T09:60:00Z'), 'JY0013', '/instant'],
    ['a utc instant at second 61', () => utcValue('2026-03-29T09:00:61Z'), 'JY0013', '/instant'],
    ['a utc NaN', () => utcValue(NaN), 'JY0013', '/instant'],
    ['a one-digit hour', () => floatingValue('2026-03-29', '9:00'), 'JY0013', '/time'],
    ['hour 25', () => floatingValue('2026-03-29', '25:00'), 'JY0013', '/time'],
    ['minute 60', () => floatingValue('2026-03-29', '09:60'), 'JY0013', '/time'],
    ['a date with slashes', () => dateValue('2026/03/29'), 'JY0013', '/date'],
    ['a date that is a number', () => dateValue(/** @type {any} */ (20260329)), 'JY0013', '/date'],
    ['an empty zone', () => zonedValue('2026-03-29', '09:00', ''), 'JY0001', '/zone'],
    ['a zone the provider does not know', () => zonedValue('2026-03-29', '09:00', 'Mars/Olympus', { provider }), 'JY0001', '/zone'],
  ]);
  for (const [label, run, code, docPath] of cases) {
    it(`${label} is ${code} at ${docPath}`, () => assert.throws(run, refusal(code, docPath)));
  }

  it('the parts resolveLocal reads keep their one code', () => {
    const at = { year: 2026, month: 3, day: 29 };
    for (const parts of [{ ...at, hours: 24 }, { ...at, seconds: 60 }, { ...at, seconds: 1.0001 }, { ...at, day: 30, month: 2 }])
      assert.throws(() => resolveLocal(parts, 'UTC', { provider, policy: 'reject' }), refusal('JY0007'));
  });
});

describe('parseTemporal', () => {
  it('reads an object or its JSON text and answers a new frozen value', () => {
    const json = { kind: 'zoned', date: '2026-03-29', time: '09:00', zone: 'Europe/Amsterdam' };
    const value = parseTemporal(json);
    assert.deepStrictEqual(value, json);
    assert.notStrictEqual(value, json);
    assert.ok(Object.isFrozen(value) && !Object.isFrozen(json));
    assert.deepStrictEqual(parseTemporal(JSON.stringify(json), { provider }), json);
    assert.throws(() => parseTemporal({ ...json, zone: 'Mars/Olympus' }, { provider }), refusal('JY0001'));
  });

  it('refuses text that is not JSON, keeping the parse error as the cause', () => {
    assert.throws(() => parseTemporal('{kind: date}'), (error) => refusal('JY0013', '/')(error) && /** @type {any} */ (error).cause instanceof SyntaxError);
  });

  it('refuses an unknown kind and a missing or extra member', () => {
    assert.throws(() => parseTemporal(null), refusal('JY0013', '/'));
    assert.throws(() => parseTemporal([]), refusal('JY0013'));
    assert.throws(() => parseTemporal({ kind: 'instant' }), refusal('JY0013', '/kind'));
    assert.throws(() => parseTemporal({ kind: 'toString' }), refusal('JY0013', '/kind'));
    assert.throws(() => parseTemporal({ date: '2026-03-29' }), refusal('JY0013', '/kind'));
    assert.throws(() => parseTemporal({ kind: 'floating', date: '2026-03-29' }), refusal('JY0013', '/time'));
    assert.throws(() => parseTemporal({ kind: 'date', date: '2026-03-29', zone: 'UTC' }), refusal('JY0013', '/zone'));
    assert.throws(() => parseTemporal({ kind: 'utc', instant: '2026-03-29T00:00:00Z', offset: 0 }), refusal('JY0013', '/offset'));
  });

  it('refuses a date range that does not end after it starts', () => {
    assert.deepStrictEqual(parseTemporal({ kind: 'date-range', start: '2026-07-01', end: '2026-07-02' }),
      { kind: 'date-range', start: '2026-07-01', end: '2026-07-02' });
    assert.throws(() => parseTemporal({ kind: 'date-range', start: '2026-07-01', end: '2026-07-01' }), refusal('JY0013', '/end'));
    assert.throws(() => parseTemporal({ kind: 'date-range', start: '2026-07-02', end: '2026-07-01' }), refusal('JY0013', '/end'));
  });
});
