//@ts-check

/**
 * The temporal schema twin: every constructor's answer validates; every
 * refusal's input fails the schema in the definition named after its
 * code, where the schema can say it; and over a generated corpus of
 * times, dates and instants `parseTemporal` accepts exactly what the
 * schema validates. Two refusals the schema cannot express - a zone the
 * provider does not know, a date range that does not end after it
 * starts - are pinned as validating, so the gap stays visible.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { JarenValidator } from '@jarenjs/validate';
import temporalSchema from '@jarenjs/core/schemas/calendar/temporal.schema.json' with { type: 'json' };
import {
  dateValue, floatingValue, utcValue, zonedValue, dateRangeValue, parseTemporal, CalendarError,
} from '@jarenjs/core/calendar';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';

const validator = new JarenValidator({ skipErrors: false, collectErrors: true });
const checkStart = validator.compile(temporalSchema);
const checkEnd = new JarenValidator({ skipErrors: false, collectErrors: true })
  .compile({ ...temporalSchema, $id: `${temporalSchema.$id}/end`, $ref: '#/$defs/end' });
const check = (/** @type {unknown} */ json, /** @type {'start' | 'end'} */ bound) => (bound === 'end' ? checkEnd : checkStart)(json);

/** The definitions that each name one refusal, by the code they mirror. */
const REASONS = /** @type {Record<string, string>} */ ({
  dateForm: 'JY0013', timeForm: 'JY0013', clockRange: 'JY0013', instantForm: 'JY0013', instantClockRange: 'JY0013',
  calendarDate: 'JY0012', instantDate: 'JY0012',
  offsetOnWallTime: 'JY0011',
  subMillisecond: 'JY0010',
  leapSecond: 'JY0009',
  endOfDayAtStart: 'JY0008', instantEndOfDay: 'JY0008',
  zoneName: 'JY0001',
});

/**
 * The codes the schema's leaf errors name: a reason definition's own, or
 * JY0013 for a member shape (a kind, a required or extra member, a type).
 * @param {any} outcome
 * @returns {Set<string>}
 */
function codesOf(outcome) {
  const codes = new Set();
  for (const error of outcome.errors ?? []) {
    if (['allOf', 'anyOf', 'oneOf', 'if', 'then', '$ref'].includes(error.keyword))
      continue;
    const name = /\$defs\/([A-Za-z]+)$/.exec(error.schemaPath)?.[1];
    codes.add(name !== undefined && Object.hasOwn(REASONS, name) ? REASONS[name] : 'JY0013');
  }
  return codes;
}

/** @param {() => unknown} run @returns {string | null} the code thrown, or null */
function codeOf(run) {
  try {
    run();
    return null;
  }
  catch (error) {
    assert.ok(error instanceof CalendarError, String(error));
    return error.code;
  }
}

describe('the temporal schema twin', () => {
  it('has its $id under the core schema namespace', () => {
    assert.strictEqual(temporalSchema.$id, 'https://jarenjs.dev/schemas/jaren-core/calendar/temporal/0.1');
  });

  it("validates every constructor's answer", () => {
    const starts = [
      dateValue('2026-03-29'), dateValue('0000-02-29'), dateValue('2000-02-29'), dateValue('9999-12-31'),
      floatingValue('2026-03-29', '09:00'), floatingValue('2026-03-29', '23:59:59.999'), floatingValue('2026-03-29', '00:00:00'),
      utcValue('2026-03-29T01:30:00Z'), utcValue(0), utcValue(-1), utcValue('2026-03-29T01:30:00.5Z'),
      zonedValue('2026-10-25', '02:30', 'Europe/Amsterdam'), zonedValue('2026-10-25', '02:30:15.25', 'UTC'),
      dateRangeValue('2026-07-01', '2026-07-14'), dateRangeValue('2028-02-29', '2028-02-29'),
    ];
    for (const value of starts) {
      assert.strictEqual(check(value, 'start').valid, true, JSON.stringify(value));
      assert.strictEqual(check(value, 'end').valid, true, JSON.stringify(value));
    }
    for (const value of [floatingValue('2026-03-29', '24:00', { bound: 'end' }), zonedValue('2026-03-29', '24:00:00.000', 'UTC', { bound: 'end' })]) {
      assert.strictEqual(check(value, 'end').valid, true, JSON.stringify(value));
      assert.strictEqual(check(value, 'start').valid, false, JSON.stringify(value));
    }
  });

  it("fails every refusal's input in the definition named after its code", () => {
    const at = { kind: 'floating', date: '2026-03-29' };
    const refused = /** @type {Array<[unknown, 'start' | 'end', string]>} */ ([
      [{ ...at, time: '24:00' }, 'start', 'JY0008'],
      [{ ...at, time: '24:00:00.000' }, 'start', 'JY0008'],
      [{ kind: 'zoned', date: '2026-03-29', time: '24:00', zone: 'UTC' }, 'start', 'JY0008'],
      [{ kind: 'utc', instant: '2026-03-29T24:00:00Z' }, 'end', 'JY0008'],
      [{ ...at, time: '23:59:60' }, 'start', 'JY0009'],
      [{ kind: 'utc', instant: '2016-12-31T23:59:60Z' }, 'start', 'JY0009'],
      [{ ...at, time: '09:00:00.0001' }, 'start', 'JY0010'],
      [{ ...at, time: '24:00:00.0000' }, 'end', 'JY0010'],
      [{ kind: 'utc', instant: '2026-03-29T09:00:00.1234Z' }, 'start', 'JY0010'],
      [{ ...at, time: '09:00+01:00' }, 'start', 'JY0011'],
      [{ ...at, time: '09:00Z' }, 'end', 'JY0011'],
      [{ kind: 'zoned', date: '2026-03-29', time: '09:00-05:00', zone: 'UTC' }, 'start', 'JY0011'],
      [{ kind: 'date', date: '2026-02-30' }, 'start', 'JY0012'],
      [{ kind: 'date', date: '2100-02-29' }, 'start', 'JY0012'],
      [{ kind: 'date-range', start: '2026-07-01', end: '2026-13-01' }, 'start', 'JY0012'],
      [{ kind: 'utc', instant: '2026-02-30T00:00:00Z' }, 'start', 'JY0012'],
      [{ kind: 'utc', instant: '2026-03-29T09:00:00+00:00' }, 'start', 'JY0013'],
      [{ kind: 'utc', instant: '2026-03-29T09:60:00Z' }, 'start', 'JY0013'],
      [{ kind: 'utc', instant: '2026-03-29T24:00:00.5Z' }, 'start', 'JY0013'],
      [{ ...at, time: '25:00' }, 'start', 'JY0013'],
      [{ ...at, time: '24:00:00.5' }, 'end', 'JY0013'],
      [{ ...at, time: '9:00' }, 'start', 'JY0013'],
      [{ ...at, time: 900 }, 'start', 'JY0013'],
      [{ ...at }, 'start', 'JY0013'],
      [{ ...at, time: '09:00', zone: 'UTC' }, 'start', 'JY0013'],
      [{ kind: 'instant', instant: 0 }, 'start', 'JY0013'],
      [{ date: '2026-03-29' }, 'start', 'JY0013'],
      ['2026-03-29', 'start', 'JY0013'],
      [{ kind: 'zoned', date: '2026-03-29', time: '09:00', zone: '' }, 'start', 'JY0001'],
      [{ kind: 'zoned', date: '2026-03-29', time: '09:00', zone: 7 }, 'start', 'JY0001'],
    ]);
    for (const [json, bound, code] of refused) {
      const label = `${JSON.stringify(json)} (${bound})`;
      assert.strictEqual(codeOf(() => parseTemporal(json, { bound })), code, label);
      const outcome = check(json, bound);
      assert.strictEqual(outcome.valid, false, label);
      assert.deepStrictEqual([...codesOf(outcome)], [code], label);
    }
  });

  it('cannot express a zone the provider does not know or a range that does not end after it starts', () => {
    const provider = createIntlZoneProvider();
    const unknownZone = { kind: 'zoned', date: '2026-03-29', time: '09:00', zone: 'Mars/Olympus' };
    assert.strictEqual(codeOf(() => parseTemporal(unknownZone, { provider })), 'JY0001');
    assert.strictEqual(check(unknownZone, 'start').valid, true);
    const backwards = { kind: 'date-range', start: '2026-07-02', end: '2026-07-01' };
    assert.strictEqual(codeOf(() => parseTemporal(backwards)), 'JY0013');
    assert.strictEqual(check(backwards, 'start').valid, true);
  });

  it('accepts exactly what parseTemporal accepts, over a generated corpus', () => {
    const hours = ['00', '09', '23', '24', '25', '99'];
    const minutes = ['00', '30', '59', '60'];
    const tails = ['', ':00', ':59', ':60', ':61', ':00.0', ':00.5', ':59.999', ':00.000', ':00.0000', ':00.1234', '.5'];
    const offsets = ['', 'Z', 'z', '+01:00', '-05:30'];
    const dates = ['2026-03-29', '2026-02-28', '2026-02-29', '2028-02-29', '1900-02-29', '2000-02-29', '2026-04-31',
      '2026-00-10', '2026-12-32', '0000-01-01', '9999-12-31', '26-03-29'];
    let agreed = 0;
    const agree = (/** @type {any} */ json, /** @type {'start' | 'end'} */ bound) => {
      const accepted = codeOf(() => parseTemporal(json, { bound })) === null;
      assert.strictEqual(check(json, bound).valid, accepted, `${JSON.stringify(json)} (${bound})`);
      agreed++;
    };
    for (const bound of /** @type {const} */ (['start', 'end'])) {
      for (const h of hours) {
        for (const m of minutes) {
          for (const tail of tails) {
            for (const offset of offsets) {
              agree({ kind: 'floating', date: '2026-03-29', time: `${h}:${m}${tail}${offset}` }, bound);
              agree({ kind: 'zoned', date: '2026-03-29', time: `${h}:${m}${tail}${offset}`, zone: 'UTC' }, bound);
              if (tail.startsWith(':'))
                agree({ kind: 'utc', instant: `2026-03-29T${h}:${m}${tail}${offset}` }, bound);
            }
          }
        }
      }
      for (const date of dates) {
        agree({ kind: 'date', date }, bound);
        agree({ kind: 'utc', instant: `${date}T12:00:00Z` }, bound);
        if (date !== '0000-01-01') // an empty range: not expressible, pinned above
          agree({ kind: 'date-range', start: '0000-01-01', end: date }, bound);
      }
    }
    assert.ok(agreed > 4000, `${agreed} inputs compared`);
  });
});
