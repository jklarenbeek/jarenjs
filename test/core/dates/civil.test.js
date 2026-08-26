import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import {
  daysFromCivil,
  civilFromDays,
  daysInMonth,
  isLeapYear,
  weekdayFromDays,
  isoWeekdayFromDays,
  dayOfYear,
  quarterOfYear,
  isoWeekOfYear,
  addToParts,
  startOfParts,
  endOfParts,
  isDateUnit,
  fixedUnitMs,
  DATE_UNITS,
  parseRFC3339Parts,
} from '@jarenjs/core/dates';

const P = (s) => parseRFC3339Parts(s);

/** Render a parts record back to its lexical shape, for readable assertions. */
function show(p) {
  const date = `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  if (p.hours < 0)
    return date;
  const ms = p.seconds - Math.trunc(p.seconds);
  const secs = ms === 0
    ? String(Math.trunc(p.seconds)).padStart(2, '0')
    : (String(Math.trunc(p.seconds)).padStart(2, '0') + ms.toFixed(3).slice(1));
  return `${date}T${String(p.hours).padStart(2, '0')}:${String(p.minutes).padStart(2, '0')}:${secs}`;
}

describe('civil day-number arithmetic', () => {
  it('should round-trip and agree with Date across four decades', () => {
    // the oracle is Date itself: every consecutive day for 40 years must
    // convert both ways and match, which pins the era arithmetic
    let checked = 0;
    for (let z = daysFromCivil(1990, 1, 1); z <= daysFromCivil(2030, 12, 31); z++) {
      const { year, month, day } = civilFromDays(z);
      const native = new Date(z * 86400000);
      assert.strictEqual(year, native.getUTCFullYear(), `year at ${z}`);
      assert.strictEqual(month, native.getUTCMonth() + 1, `month at ${z}`);
      assert.strictEqual(day, native.getUTCDate(), `day at ${z}`);
      assert.strictEqual(weekdayFromDays(z), native.getUTCDay(), `weekday at ${z}`);
      assert.strictEqual(daysFromCivil(year, month, day), z, `round trip at ${z}`);
      checked++;
    }
    assert.strictEqual(checked, 14975);
  });

  it('should handle dates before the epoch and the year-100 boundary', () => {
    assert.strictEqual(daysFromCivil(1970, 1, 1), 0);
    assert.strictEqual(daysFromCivil(1969, 12, 31), -1);
    assert.deepStrictEqual(civilFromDays(-1), { year: 1969, month: 12, day: 31 });
    // Date.UTC maps 0-99 into the 1900s; the day math must not
    assert.deepStrictEqual(civilFromDays(daysFromCivil(99, 1, 1)),
      { year: 99, month: 1, day: 1 });
    assert.deepStrictEqual(civilFromDays(daysFromCivil(1, 1, 1)),
      { year: 1, month: 1, day: 1 });
    // ISO weekday stays 1-7 (Monday-Sunday) before the epoch too
    assert.strictEqual(isoWeekdayFromDays(-1), 3, '1969-12-31 was a Wednesday');
  });

  it('should apply the Gregorian leap rule at century boundaries', () => {
    assert.strictEqual(isLeapYear(2000), true);
    assert.strictEqual(isLeapYear(1900), false);
    assert.strictEqual(isLeapYear(2024), true);
    assert.strictEqual(isLeapYear(2026), false);
    assert.strictEqual(daysInMonth(2024, 2), 29);
    assert.strictEqual(daysInMonth(1900, 2), 28);
    assert.strictEqual(daysInMonth(2026, 12), 31);
  });

  it('should derive day-of-year, quarter and ISO week', () => {
    assert.strictEqual(dayOfYear(P('2026-01-01')), 1);
    assert.strictEqual(dayOfYear(P('2026-12-31')), 365);
    assert.strictEqual(dayOfYear(P('2024-12-31')), 366, 'leap year');
    assert.strictEqual(quarterOfYear(P('2026-01-01')), 1);
    assert.strictEqual(quarterOfYear(P('2026-07-27')), 3);
    assert.strictEqual(quarterOfYear(P('2026-12-31')), 4);
  });

  it('should give the ISO week its own year at the boundary', () => {
    // 2027-01-01 is a Friday, so it belongs to week 53 of 2026 — the
    // reason the week and its year have to be returned together
    assert.deepStrictEqual(isoWeekOfYear(P('2027-01-01')), { year: 2026, week: 53 });
    assert.deepStrictEqual(isoWeekOfYear(P('2026-01-01')), { year: 2026, week: 1 });
    // 2023-01-01 is a Sunday: week 52 of 2022
    assert.deepStrictEqual(isoWeekOfYear(P('2023-01-01')), { year: 2022, week: 52 });
  });
});

describe('addToParts', () => {
  it('should clamp month and year arithmetic to the target month', () => {
    assert.strictEqual(show(addToParts(P('2026-01-31'), 1, 'month')), '2026-02-28');
    assert.strictEqual(show(addToParts(P('2024-01-31'), 1, 'month')), '2024-02-29');
    assert.strictEqual(show(addToParts(P('2024-02-29'), 1, 'year')), '2025-02-28');
    assert.strictEqual(show(addToParts(P('2026-03-31'), -1, 'month')), '2026-02-28');
  });

  it('should roll months across year boundaries in both directions', () => {
    assert.strictEqual(show(addToParts(P('2026-12-15'), 1, 'month')), '2027-01-15');
    assert.strictEqual(show(addToParts(P('2026-01-15'), -1, 'month')), '2025-12-15');
    assert.strictEqual(show(addToParts(P('2026-01-15'), -13, 'month')), '2024-12-15');
    assert.strictEqual(show(addToParts(P('2026-02-10'), 1, 'quarter')), '2026-05-10');
  });

  it('should keep a full-date a full-date', () => {
    const out = addToParts(P('2026-02-28'), 1, 'day');
    assert.strictEqual(show(out), '2026-03-01');
    assert.strictEqual(out.hours, -1, 'no time half is invented');
  });

  it('should carry sub-day units across midnight', () => {
    assert.strictEqual(show(addToParts(P('2026-07-27T23:30:00Z'), 90, 'minute')),
      '2026-07-28T01:00:00');
    assert.strictEqual(show(addToParts(P('2026-01-01T00:00:00Z'), -1, 'second')),
      '2025-12-31T23:59:59');
    assert.strictEqual(show(addToParts(P('2026-07-27T12:00:00Z'), 500, 'millisecond')),
      '2026-07-27T12:00:00.500');
  });

  it('should preserve the value\'s own offset rather than normalizing', () => {
    const out = addToParts(P('2026-07-27T14:30:00+02:00'), 1, 'day');
    assert.strictEqual(out.offset, 120, 'the offset rides along untouched');
  });

  it('should return a fresh record and never mutate its input', () => {
    const input = P('2026-07-27');
    const before = JSON.stringify(input);
    const out = addToParts(input, 5, 'day');
    assert.strictEqual(JSON.stringify(input), before);
    assert.notStrictEqual(out, input);
    assert.strictEqual(show(addToParts(input, 0, 'day')), '2026-07-27');
  });

  it('should reject a unit it does not know', () => {
    assert.throws(() => addToParts(P('2026-07-27'), 1, 'fortnight'), TypeError);
  });

  it('should keep the half of a fractional fixed-width amount', () => {
    // the fraction is real time: truncating it to whole days silently
    // loses twelve hours, which is the shape of a scheduling bug
    assert.strictEqual(show(addToParts(P('2026-01-01T00:00:00Z'), 1.5, 'day')),
      '2026-01-02T12:00:00');
    assert.strictEqual(show(addToParts(P('2026-01-01T00:00:00Z'), -1.5, 'day')),
      '2025-12-30T12:00:00');
    assert.strictEqual(show(addToParts(P('2026-01-01T00:00:00Z'), 0.5, 'week')),
      '2026-01-04T12:00:00');
    assert.strictEqual(show(addToParts(P('2026-01-01T06:00:00Z'), 0.25, 'day')),
      '2026-01-01T12:00:00');
  });

  it('should refuse a fraction of a unit that has no exact length', () => {
    // half of January is not a quantity; the alternative to refusing is
    // to answer 31 January, which is what truncation did
    assert.throws(() => addToParts(P('2026-01-31'), 0.5, 'month'), TypeError);
    assert.throws(() => addToParts(P('2026-01-31'), 0.5, 'quarter'), TypeError);
    assert.throws(() => addToParts(P('2026-01-31'), 0.1, 'year'), TypeError);
    // a fraction that IS exactly a whole number of months stands: a year
    // is twelve months wherever it is applied
    assert.strictEqual(show(addToParts(P('2026-01-15'), 0.5, 'year')), '2026-07-15');
    assert.strictEqual(show(addToParts(P('2026-01-15'), 2 / 3, 'quarter')), '2026-03-15');
  });

  it('should refuse arithmetic that needs a half the value has not got', () => {
    // adding hours to a full-date used to grow a time half out of
    // nowhere, and adding a day to a full-time was a silent no-op
    assert.throws(() => addToParts(P('2026-01-31'), 3, 'hour'), TypeError);
    assert.throws(() => addToParts(P('2026-01-31'), 90, 'minute'), TypeError);
    assert.throws(() => addToParts(P('2026-01-31'), 1.5, 'day'), TypeError);
    assert.throws(() => addToParts(P('12:00:00Z'), 1, 'day'), TypeError);
    assert.throws(() => addToParts(P('12:00:00Z'), 1, 'month'), TypeError);
    assert.throws(() => addToParts(P('12:00:00Z'), 1, 'week'), TypeError);
  });

  it('should keep a full-time a full-time across a clock unit', () => {
    const out = addToParts(P('23:00:00Z'), 3, 'hour');
    assert.strictEqual(out.year, -1, 'no date half is invented');
    assert.strictEqual(out.hours, 2, 'the clock wraps inside the day');
    assert.strictEqual(out.offset, 0);
    const back = addToParts(P('02:00:00+02:00'), -3, 'hour');
    assert.strictEqual(back.hours, 23, 'and wraps the other way');
    assert.strictEqual(back.offset, 120, 'the offset rides along untouched');
  });

  it('should keep negative-epoch and offset arithmetic exact', () => {
    assert.strictEqual(show(addToParts(P('1960-06-15'), 1, 'day')), '1960-06-16');
    assert.strictEqual(show(addToParts(P('1960-06-15'), 1, 'month')), '1960-07-15');
    assert.strictEqual(show(addToParts(P('1900-01-01T00:00:00Z'), 1.5, 'day')),
      '1900-01-02T12:00:00');
    const out = addToParts(P('1960-06-15T14:30:00+02:00'), 12, 'hour');
    assert.strictEqual(show(out), '1960-06-16T02:30:00');
    assert.strictEqual(out.offset, 120);
  });
});

describe('startOfParts and endOfParts', () => {
  it('should truncate to each calendar unit', () => {
    // a date-time keeps its time half, set to midnight — truncating to a
    // coarser unit must not change which of the two forms the value is
    const t = P('2026-07-27T14:35:45.500Z');
    assert.strictEqual(show(startOfParts(t, 'year')), '2026-01-01T00:00:00');
    assert.strictEqual(show(startOfParts(t, 'quarter')), '2026-07-01T00:00:00');
    assert.strictEqual(show(startOfParts(t, 'month')), '2026-07-01T00:00:00');
    assert.strictEqual(show(startOfParts(t, 'day')), '2026-07-27T00:00:00');
    assert.strictEqual(show(startOfParts(t, 'hour')), '2026-07-27T14:00:00');
    assert.strictEqual(show(startOfParts(t, 'minute')), '2026-07-27T14:35:00');
    assert.strictEqual(show(startOfParts(t, 'second')), '2026-07-27T14:35:45');
  });

  it('should leave a full-date a full-date', () => {
    const d = P('2026-07-27');
    assert.strictEqual(show(startOfParts(d, 'year')), '2026-01-01');
    assert.strictEqual(show(startOfParts(d, 'month')), '2026-07-01');
    assert.strictEqual(startOfParts(d, 'day').hours, -1, 'no time half appears');
  });

  it('should start a week on Monday (ISO 8601)', () => {
    // 2026-07-27 is itself a Monday; 2026-08-02 is the Sunday after
    assert.strictEqual(show(startOfParts(P('2026-07-27'), 'week')), '2026-07-27');
    assert.strictEqual(show(startOfParts(P('2026-08-02'), 'week')), '2026-07-27');
    assert.strictEqual(show(startOfParts(P('2026-07-31'), 'week')), '2026-07-27');
  });

  it('should end a date-only value on a day, not a millisecond', () => {
    assert.strictEqual(show(endOfParts(P('2026-02-10'), 'month')), '2026-02-28');
    assert.strictEqual(show(endOfParts(P('2024-02-10'), 'month')), '2024-02-29');
    assert.strictEqual(show(endOfParts(P('2026-05-10'), 'year')), '2026-12-31');
  });

  it('should end a date-time on the last millisecond', () => {
    assert.strictEqual(show(endOfParts(P('2026-02-10T05:00:00Z'), 'month')),
      '2026-02-28T23:59:59.999');
    assert.strictEqual(show(endOfParts(P('2026-07-27T14:35:45Z'), 'hour')),
      '2026-07-27T14:59:59.999');
  });

  it('should refuse a truncation that needs a half the value has not got', () => {
    // end-of hour on a full-date used to answer the PREVIOUS day
    assert.throws(() => endOfParts(P('2026-01-31'), 'hour'), TypeError);
    assert.throws(() => startOfParts(P('2026-01-31'), 'hour'), TypeError);
    assert.throws(() => endOfParts(P('2026-01-31'), 'minute'), TypeError);
    assert.throws(() => startOfParts(P('12:00:00Z'), 'month'), TypeError);
    assert.throws(() => endOfParts(P('12:00:00Z'), 'week'), TypeError);
    assert.throws(() => endOfParts(P('12:00:00Z'), 'year'), TypeError);
  });

  it('should truncate a full-time to the boundaries a clock has', () => {
    // midnight and the last millisecond of a day are both expressible
    // in the time half alone, so neither needs a date
    assert.strictEqual(show(startOfParts(P('12:34:56Z'), 'day')).slice(11), '00:00:00');
    assert.strictEqual(show(endOfParts(P('12:34:56Z'), 'day')).slice(11), '23:59:59.999');
    assert.strictEqual(show(endOfParts(P('12:34:56Z'), 'hour')).slice(11), '12:59:59.999');
    assert.strictEqual(show(endOfParts(P('12:34:56.250Z'), 'second')).slice(11), '12:34:56.999');
    assert.strictEqual(startOfParts(P('12:34:56Z'), 'day').year, -1, 'no date half is invented');
    assert.strictEqual(endOfParts(P('12:34:56+02:00'), 'day').offset, 120);
  });

  it('should bracket every value it is given', () => {
    // the invariant that makes the pair useful: start <= value <= end
    const value = P('2026-05-17T09:12:33Z');
    for (const unit of ['year', 'quarter', 'month', 'week', 'day', 'hour']) {
      const lo = show(startOfParts(value, unit));
      const hi = show(endOfParts(value, unit));
      assert.ok(lo <= show(value), `${unit}: start after value`);
      assert.ok(hi >= show(value), `${unit}: end before value`);
    }
  });
});

describe('the unit vocabulary', () => {
  it('should name every unit the functions accept', () => {
    for (const unit of DATE_UNITS)
      assert.strictEqual(isDateUnit(unit), true, unit);
    assert.strictEqual(isDateUnit('fortnight'), false);
    assert.strictEqual(isDateUnit(null), false);
  });

  it('should report a width only for fixed-width units', () => {
    assert.strictEqual(fixedUnitMs('day'), 86400000);
    assert.strictEqual(fixedUnitMs('week'), 604800000);
    // months, quarters and years have no width without a calendar anchor
    assert.strictEqual(fixedUnitMs('month'), 0);
    assert.strictEqual(fixedUnitMs('quarter'), 0);
    assert.strictEqual(fixedUnitMs('year'), 0);
  });
});
