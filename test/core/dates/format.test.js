import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import {
  compileDateFormat,
  formatRFC3339Parts,
  parseRFC3339Parts,
  parseDuration,
  durationToMs,
  isFixedDuration,
  addDuration,
  monthsBetween,
  addToParts,
  isValidDuration,
} from '@jarenjs/core/dates';

const P = (s) => parseRFC3339Parts(s);

const EN = {
  months: ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'],
  monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  weekdays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  weekdaysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  meridiem: ['AM', 'PM'],
};

describe('compileDateFormat', () => {
  it('should retain parser precision in RFC 3339 output and keep SSS three digits wide', () => {
    for (const value of [
      '2026-09-08T12:34:59.999999Z',
      '2026-09-08T12:34:05.000001Z',
      '2026-09-08T12:34:05.123456+02:00',
      '12:34:05.123456-05:30',
    ]) {
      const parts = P(value);
      const output = formatRFC3339Parts(parts);
      assert.strictEqual(output, value);
      assert.deepStrictEqual(P(output), parts);
    }
    assert.strictEqual(formatRFC3339Parts(P('2026-09-08T12:34:05.120000Z')),
      '2026-09-08T12:34:05.12Z');
    const millis = compileDateFormat('ss.SSS');
    assert.strictEqual(millis(P('2026-09-08T12:34:59.999999Z')), '59.999');
    assert.strictEqual(millis(P('2026-09-08T12:34:05.000001Z')), '05.000');
    assert.strictEqual(millis(P('2026-09-08T12:34:05.123999Z')), '05.123');
    assert.strictEqual(compileDateFormat('ss.S')(P('2026-09-08T12:34:01.2Z')), '01.2');
  });

  it('should round-trip an RFC 3339 value through its own pattern', () => {
    const iso = compileDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX");
    for (const value of [
      '2026-07-27T14:30:05+02:00',
      '2026-07-27T14:30:05Z',
      '2026-07-27T14:30:05-05:30',
      '1969-12-31T23:59:59Z',
    ]) {
      assert.strictEqual(iso(P(value)), value, value);
    }
  });

  it('should render numeric tokens at each width', () => {
    const p = P('2026-07-05T09:03:07.250Z');
    assert.strictEqual(compileDateFormat('y')(p), '2026');
    assert.strictEqual(compileDateFormat('yy')(p), '26');
    assert.strictEqual(compileDateFormat('yyyy')(p), '2026');
    assert.strictEqual(compileDateFormat('M/d')(p), '7/5');
    assert.strictEqual(compileDateFormat('MM/dd')(p), '07/05');
    assert.strictEqual(compileDateFormat('H:m:s')(p), '9:3:7');
    assert.strictEqual(compileDateFormat('HH:mm:ss')(p), '09:03:07');
    assert.strictEqual(compileDateFormat('SSS')(p), '250');
  });

  it('should render the derived tokens', () => {
    const p = P('2026-07-27T14:30:05Z');
    // 2026-07-27 is a Monday, ISO week 31, quarter 3, day 208
    assert.strictEqual(compileDateFormat('E')(p), '1', 'ISO weekday, Monday = 1');
    assert.strictEqual(compileDateFormat('ww')(p), '31');
    assert.strictEqual(compileDateFormat('Q')(p), '3');
    assert.strictEqual(compileDateFormat('DDD')(p), '208');
  });

  it('should offer both widths of every derived token', () => {
    const p = P('2026-01-05T09:03:07.250Z');
    // 2026-01-05 is ISO week 2, day 5 of the year
    assert.strictEqual(compileDateFormat('w')(p), '2');
    assert.strictEqual(compileDateFormat('ww')(p), '02');
    assert.strictEqual(compileDateFormat('D')(p), '5');
    assert.strictEqual(compileDateFormat('DDD')(p), '005');
    assert.strictEqual(compileDateFormat('S')(p), '2', 'tenths of a second');
    assert.strictEqual(compileDateFormat('SSS')(p), '250');
    assert.strictEqual(compileDateFormat('hh')(p), '09', 'padded 12-hour');
    assert.strictEqual(compileDateFormat('hh')(P('2026-01-05T13:00:00Z')), '01');
    assert.strictEqual(compileDateFormat('hh')(P('2026-01-05T00:00:00Z')), '12');
  });

  it('should use a names provider for the locale-dependent tokens', () => {
    const p = P('2026-07-27T14:30:05Z');
    assert.strictEqual(compileDateFormat('EEEE d MMMM yyyy', EN)(p), 'Monday 27 July 2026');
    assert.strictEqual(compileDateFormat('EEE dd MMM', EN)(p), 'Mon 27 Jul');
    assert.strictEqual(compileDateFormat('h:mm a', EN)(p), '2:30 PM');
    assert.strictEqual(compileDateFormat('h:mm a', EN)(P('2026-07-27T00:30:00Z')), '12:30 AM');
  });

  it('should refuse a name token with no provider rather than guess English', () => {
    // the kernel is locale-free by design; a silent fallback would put
    // English into every unlocalized render
    for (const pattern of ['MMMM', 'MMM', 'EEEE', 'EEE', 'a']) {
      assert.throws(() => compileDateFormat(pattern), TypeError, pattern);
    }
    // a provider missing only the array that pattern needs still fails
    assert.throws(() => compileDateFormat('MMMM', { monthsShort: EN.monthsShort }), TypeError);
    // numeric tokens never need one
    assert.strictEqual(compileDateFormat('yyyy-MM-dd')(P('2026-07-27')), '2026-07-27');
  });

  it('should treat quoted text as a literal', () => {
    const p = P('2026-07-27T14:30:05Z');
    assert.strictEqual(compileDateFormat("'week' ww 'of' yyyy")(p), 'week 31 of 2026');
    assert.strictEqual(compileDateFormat("''yyyy''")(p), "'2026'");
    // an unquoted character that is not a token passes through
    assert.strictEqual(compileDateFormat('yyyy/MM/dd')(p), '2026/07/27');
    assert.throws(() => compileDateFormat("'unterminated"), TypeError);
  });

  it('should render an offset in each of its three widths', () => {
    const p = P('2026-07-27T14:30:05+02:00');
    assert.strictEqual(compileDateFormat('XXX')(p), '+02:00');
    assert.strictEqual(compileDateFormat('XX')(p), '+0200');
    const utc = P('2026-07-27T14:30:05Z');
    assert.strictEqual(compileDateFormat('XXX')(utc), 'Z', 'XXX spells UTC as Z');
    assert.strictEqual(compileDateFormat('X')(utc), '+00:00', 'X always spells the numbers');
    assert.strictEqual(compileDateFormat('XXX')(P('2026-07-27')), '',
      'a bare full-date carries no offset');
  });

  it('should compile once and stay reusable', () => {
    const fmt = compileDateFormat('yyyy-MM-dd');
    assert.strictEqual(fmt(P('2026-07-27')), '2026-07-27');
    assert.strictEqual(fmt(P('1999-01-02')), '1999-01-02');
    assert.strictEqual(typeof fmt, 'function');
    assert.strictEqual(compileDateFormat('')(P('2026-07-27')), '');
    assert.throws(() => compileDateFormat(42), TypeError);
  });
});

describe('parseDuration', () => {
  it('should decompose each designator', () => {
    assert.deepStrictEqual(parseDuration('P1Y2M3DT4H5M6S'), {
      negative: false, years: 1, months: 2, weeks: 0, days: 3,
      hours: 4, minutes: 5, seconds: 6,
    });
    assert.strictEqual(parseDuration('P1W').weeks, 1);
    assert.strictEqual(parseDuration('PT30M').minutes, 30);
    assert.strictEqual(parseDuration('-P3D').negative, true);
    assert.strictEqual(parseDuration('PT1.5H').hours, 1.5);
    assert.strictEqual(parseDuration('PT1,5H').hours, 1.5, 'comma is also a decimal sign');
  });

  it('should require designators coarse-to-fine, each at most once', () => {
    for (const bad of ['PT1S1H', 'P2M1Y', 'P1M1M', 'PT1M1M', 'P1D1D']) {
      assert.strictEqual(parseDuration(bad), null, bad);
    }
    assert.notStrictEqual(parseDuration('PT1H30M'), null);
  });

  it('should reject malformed input rather than throw', () => {
    for (const bad of ['P', 'PT', '1Y', 'P1YT', 'P1Y1W', 'PT1Y', 'P1H', '', 'nonsense', null, 42]) {
      assert.strictEqual(parseDuration(bad), null, JSON.stringify(bad));
    }
  });

  it('should be a deliberate superset of the RFC 3339 format validator', () => {
    // the validator backs the JSON Schema `duration` format and stays
    // strict; the parser accepts what ISO 8601 additionally allows
    for (const iso of ['PT1.5H', '-P3D']) {
      assert.notStrictEqual(parseDuration(iso), null, iso);
      assert.strictEqual(isValidDuration(iso), false, `${iso} is not RFC 3339`);
    }
    // and they agree on the common grammar
    for (const both of ['P1Y2M3DT4H5M6S', 'P1W', 'PT1H']) {
      assert.notStrictEqual(parseDuration(both), null, both);
      assert.strictEqual(isValidDuration(both), true, both);
    }
  });

  it('should convert only fixed-width durations to milliseconds', () => {
    assert.strictEqual(durationToMs(parseDuration('P1W')), 604800000);
    assert.strictEqual(durationToMs(parseDuration('PT1H30M')), 5400000);
    assert.strictEqual(durationToMs(parseDuration('-P3D')), -259200000);
    // a month has no width without a date to stand on — NaN is a refusal,
    // not a failure to compute
    assert.strictEqual(Number.isNaN(durationToMs(parseDuration('P1M'))), true);
    assert.strictEqual(Number.isNaN(durationToMs(parseDuration('P1Y'))), true);
    assert.strictEqual(isFixedDuration(parseDuration('P1W')), true);
    assert.strictEqual(isFixedDuration(parseDuration('P1M')), false);
  });
});

describe('duration arithmetic over dates', () => {
  const show = (p) => `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;

  it('should apply coarse units before fine ones', () => {
    // Jan 31 + P1M1D is February's clamped 28th plus a day, not Mar 1 + 1
    assert.strictEqual(show(addDuration(P('2026-01-31'), parseDuration('P1M1D'))), '2026-03-01');
    assert.strictEqual(show(addDuration(P('2026-01-31'), parseDuration('P1M'))), '2026-02-28');
  });

  it('should subtract when asked, and honour a negative duration', () => {
    assert.strictEqual(show(addDuration(P('2026-07-27'), parseDuration('P1M'), -1)), '2026-06-27');
    assert.strictEqual(show(addDuration(P('2026-07-27'), parseDuration('-P1M'))), '2026-06-27');
    // two negatives compose back to an addition
    assert.strictEqual(show(addDuration(P('2026-07-27'), parseDuration('-P1M'), -1)), '2026-08-27');
  });

  it('should keep a fractional fixed-width component', () => {
    // P1.5D is thirty-six hours; ISO 8601 spells the fraction and the
    // parser reads it, so applying it must not round the half away
    const full = (q) => `${show(q)}T${String(q.hours).padStart(2, '0')}`
      + `:${String(q.minutes).padStart(2, '0')}`;
    assert.strictEqual(full(addDuration(P('2026-01-01T00:00:00Z'), parseDuration('P1.5D'))),
      '2026-01-02T12:00');
    assert.strictEqual(full(addDuration(P('2026-01-01T00:00:00Z'), parseDuration('PT1.5H'))),
      '2026-01-01T01:30');
    assert.strictEqual(full(addDuration(P('2026-01-01T00:00:00Z'), parseDuration('P0.5W'))),
      '2026-01-04T12:00');
    // and subtracting it is its exact inverse
    assert.strictEqual(full(addDuration(P('2026-01-02T12:00:00Z'), parseDuration('P1.5D'), -1)),
      '2026-01-01T00:00');
  });

  it('should refuse a fractional calendar component', () => {
    // P0.5M on 31 January used to answer 31 January
    assert.throws(() => addDuration(P('2026-01-31'), parseDuration('P0.5M')), TypeError);
    assert.throws(() => addDuration(P('2026-01-31T00:00:00Z'), parseDuration('P0.1Y')), TypeError);
    // a fraction with an exact month conversion still applies
    assert.strictEqual(show(addDuration(P('2026-01-15'), parseDuration('P0.5Y'))), '2026-07-15');
  });

  it('should refuse a fixed-width fraction a full-date cannot carry', () => {
    // half a day has nowhere to live in a value with no time half
    assert.throws(() => addDuration(P('2026-01-01'), parseDuration('P1.5D')), TypeError);
    assert.throws(() => addDuration(P('2026-01-01'), parseDuration('PT1H')), TypeError);
    // whole days still apply, and stay a full-date
    assert.strictEqual(show(addDuration(P('2026-01-01'), parseDuration('P1D'))), '2026-01-02');
  });

  it('should count months so that adding them back never overshoots', () => {
    const cases = [
      ['2026-01-31', '2026-02-28', 1],
      ['2026-01-15', '2026-07-20', 6],
      ['2026-03-31', '2026-02-28', -1],
      ['2026-01-31', '2026-03-01', 1],
      ['2026-07-27', '2026-07-27', 0],
    ];
    for (const [from, to, expected] of cases) {
      const months = monthsBetween(P(from), P(to));
      assert.strictEqual(months, expected, `${from} -> ${to}`);
      const back = show(addToParts(P(from), months, 'month'));
      if (months >= 0)
        assert.ok(back <= to, `${from} + ${months}mo = ${back} overshot ${to}`);
      else
        assert.ok(back >= to, `${from} + ${months}mo = ${back} undershot ${to}`);
    }
  });
});
