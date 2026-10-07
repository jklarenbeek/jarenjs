import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import {
  isTimeOnlyRFC3339,
  isDateTimeRFC3339,
  isTimeOnlyInRange,
  parseRFC3339Parts,
  epochOfRFC3339Parts,
  formatRFC3339Parts,
  compileDateFormat,
  getEpochOfDateTimeRFC3339,
  getEpochOfTimeOnlyRFC3339,
} from '@jarenjs/core/dates';

// RFC 3339 section 5.6: time-hour 00-23, time-minute 00-59, time-second
// 00-58/59/60 "based on leap second rules", time-secfrac = "." 1*DIGIT.
// Section 5.7: a leap second is valid only where the UTC time is 23:59:60
// (the section 5.8 example: 1990-12-31T15:59:60-08:00).

describe('RFC 3339 leap seconds', () => {
  it('accepts :60 only where the UTC time is 23:59', () => {
    for (const time of ['23:59:60Z', '23:59:60z', '23:59:60+00:00', '23:59:60-00:00',
      '15:59:60-08:00', '00:29:60+00:30', '00:59:60+01:00', '23:59:60.5Z']) {
      assert.isTrue(isTimeOnlyRFC3339(time), time);
      assert.isTrue(isDateTimeRFC3339('1990-12-31T' + time), time);
    }
  });

  it('refuses a leap second whose local hour or minute is out of range', () => {
    // each of these lands on 23:59 UTC once the hour wraps modulo 24,
    // which is why a bare UTC check accepted them
    for (const time of ['47:59:60Z', '71:59:60Z', '95:59:60Z', '47:59:60+00:00',
      '24:59:60+01:00', '23:60:60+00:01', '99:59:60Z']) {
      assert.isFalse(isTimeOnlyRFC3339(time), time);
      assert.isFalse(isDateTimeRFC3339('2016-12-31T' + time), time);
    }
    assert.isFalse(isTimeOnlyInRange(47, 59, 60, 0, 0, 1));
    assert.isFalse(isTimeOnlyInRange(24, 59, 60, 1, 0, 1));
    assert.isFalse(isTimeOnlyInRange(23, 60, 60, 0, 1, 1));
    assert.isTrue(isTimeOnlyInRange(23, 59, 60, 0, 0, 1));
    assert.isTrue(isTimeOnlyInRange(15, 59, 60, 8, 0, -1));
  });

  it('refuses a leap second anywhere but 23:59 UTC', () => {
    for (const time of ['22:59:60Z', '23:58:60Z', '23:59:60+01:00', '00:00:60Z', '12:30:60Z']) {
      assert.isFalse(isTimeOnlyRFC3339(time), time);
      assert.isFalse(isDateTimeRFC3339('2016-12-31T' + time), time);
    }
  });

  it('gives a refused leap second no parts and no epoch', () => {
    assert.strictEqual(parseRFC3339Parts('2016-12-31T47:59:60Z'), null);
    assert.strictEqual(getEpochOfDateTimeRFC3339('2016-12-31T47:59:60Z', 'none'), 'none');
    // a valid one still reads lexically; the engine has no :60, so the
    // Date.parse twin is NaN while the parts epoch rolls into the next minute
    assert.deepStrictEqual(parseRFC3339Parts('2016-12-31T23:59:60Z'),
      { year: 2016, month: 12, day: 31, hours: 23, minutes: 59, seconds: 60, offset: 0 });
    assert.ok(Number.isNaN(getEpochOfDateTimeRFC3339('2016-12-31T23:59:60Z')));
    assert.strictEqual(epochOfRFC3339Parts(parseRFC3339Parts('2016-12-31T23:59:60Z')), 1483228800000);
  });
});

describe('RFC 3339 fractional seconds (time-secfrac = "." 1*DIGIT)', () => {
  it('accepts a fraction of any length', () => {
    for (const fraction of ['1', '123456', '1234567', '12345678', '123456789', '0000000', '12345678901234567890']) {
      assert.isTrue(isTimeOnlyRFC3339(`13:45:30.${fraction}Z`), fraction);
      assert.isTrue(isTimeOnlyRFC3339(`13:45:30.${fraction}+05:30`), fraction);
      assert.isTrue(isDateTimeRFC3339(`2026-01-01T00:00:00.${fraction}Z`), fraction);
    }
  });

  it('still refuses a dot with no digit, a digit run without an offset, and a non-digit', () => {
    for (const time of ['13:45:30.Z', '13:45:30.123456789', '13:45:30.12a4Z', '13:45:30.+01:00']) {
      assert.isFalse(isTimeOnlyRFC3339(time), time);
      assert.isFalse(isDateTimeRFC3339('2026-01-01T' + time), time);
    }
  });

  it('keeps nine fraction digits in the parts record, never carrying into the next second', () => {
    assert.strictEqual(parseRFC3339Parts('2026-01-01T00:00:00.123456789Z').seconds, 0.123456789);
    assert.strictEqual(parseRFC3339Parts('13:45:30.0000001Z').seconds, 30.0000001);
    // twenty nines would sum to 60 in a double; the tenth digit on is cut
    const nines = '9'.repeat(20);
    assert.strictEqual(parseRFC3339Parts(`2026-01-01T00:00:59.${nines}Z`).seconds, 59.999999999);
    assert.strictEqual(parseRFC3339Parts(`23:59:60.${nines}Z`).seconds, 60.999999999);
    assert.strictEqual(formatRFC3339Parts(parseRFC3339Parts(`2026-01-01T00:00:59.${nines}Z`)),
      '2026-01-01T00:00:59.999999Z');
  });

  it('converts to milliseconds by each reader\'s own rule, whatever the digit count', () => {
    // the getEpochOf… readers go through Date.parse, which truncates
    assert.strictEqual(getEpochOfDateTimeRFC3339('2026-01-01T00:00:00.1234567Z'), 1767225600123);
    assert.strictEqual(getEpochOfDateTimeRFC3339('2026-01-01T00:00:00.123456789Z'), 1767225600123);
    assert.strictEqual(getEpochOfDateTimeRFC3339('2026-01-01T00:00:00.9999999Z'), 1767225600999);
    assert.strictEqual(getEpochOfTimeOnlyRFC3339('13:45:30.0000000Z'), 49530000);
    // epochOfRFC3339Parts rounds to the nearest millisecond, as it does
    // for six digits (.999999 already carries into the next second)
    const epoch = (s) => epochOfRFC3339Parts(parseRFC3339Parts(s));
    assert.strictEqual(epoch('2026-01-01T00:00:00.1234567Z'), 1767225600123);
    assert.strictEqual(epoch('2026-01-01T00:00:00.1239Z'), 1767225600124);
    assert.strictEqual(epoch('2026-01-01T00:00:00.999999Z'), 1767225601000);
    assert.strictEqual(epoch('2026-01-01T00:00:00.9999999Z'), 1767225601000);
  });

  it('formats a fraction past six digits cut at the sixth, never carried into the next second', () => {
    const P = parseRFC3339Parts;
    assert.strictEqual(formatRFC3339Parts(P('2026-01-01T00:00:59.9999999Z')), '2026-01-01T00:00:59.999999Z');
    assert.strictEqual(formatRFC3339Parts(P('2026-01-01T00:00:05.1234567Z')), '2026-01-01T00:00:05.123456Z');
    assert.strictEqual(formatRFC3339Parts(P('2026-01-01T00:00:05.000000999Z')), '2026-01-01T00:00:05Z');
    assert.strictEqual(formatRFC3339Parts(P('12:00:01.10000009+02:00')), '12:00:01.1+02:00');
    const millis = compileDateFormat('ss.SSS');
    assert.strictEqual(millis(P('2026-01-01T00:00:59.9999999Z')), '59.999');
    assert.strictEqual(millis(P('2026-01-01T00:00:05.1239999Z')), '05.123');
    // the same cut applies to a computed clock: 0.9999996 s stays in second 0
    assert.strictEqual(formatRFC3339Parts({ year: 1970, month: 1, day: 1, hours: 0, minutes: 0,
      seconds: 0.9999996, offset: 0 }), '1970-01-01T00:00:00.999999Z');
  });

  it('formats every fraction of six digits or fewer exactly as written', () => {
    // a deterministic sweep: the digits come back verbatim, minus trailing zeros
    let state = 12345;
    const next = () => (state = (state * 1103515245 + 12345) % 2147483648);
    for (let n = 0; n < 2000; n++) {
      const width = 1 + (next() % 6);
      const digits = String(next() % (10 ** width)).padStart(width, '0');
      const whole = next() % 60;
      const text = `2026-01-01T00:00:${String(whole).padStart(2, '0')}.${digits}Z`;
      const kept = digits.replace(/0+$/, '');
      const expected = kept === '' ? text.replace(/\.\d+Z$/, 'Z') : text.replace(/\.\d+Z$/, `.${kept}Z`);
      assert.strictEqual(formatRFC3339Parts(parseRFC3339Parts(text)), expected, text);
      assert.strictEqual(compileDateFormat('SSS')(parseRFC3339Parts(text)), digits.padEnd(6, '0').slice(0, 3), text);
    }
  });
});
