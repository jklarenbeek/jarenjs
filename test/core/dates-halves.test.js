//@ts-check
/**
 * @file A parts record is a full-date, a full-time or both, and two kernel
 * functions used to look past which: a formatter wrote the `-1` sentinels of
 * the missing half into its output (`0001-0-1-0-1`), and the whole-month
 * count ignored the clock, so a month read as whole before its instant.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  addToParts,
  compileDateFormat,
  epochOfRFC3339Parts,
  monthsBetween,
  parseRFC3339Parts,
} from '@jarenjs/core/dates';

/** @param {string} text */
const parts = (text) => /** @type {any} */ (parseRFC3339Parts(text));

describe('compileDateFormat — a value without the half a token reads', () => {
  it('refuses a date token over a full-time', () => {
    const format = compileDateFormat('yyyy-MM-dd');
    assert.throws(() => format(parts('12:30:15Z')),
      (error) => error instanceof TypeError && error.half === 'date' && /'yyyy' token reads the date half/.test(error.message));
    assert.throws(() => compileDateFormat('d')(parts('12:30:15Z')), { half: 'date' });
    assert.throws(() => compileDateFormat('Q')(parts('12:30:15Z')), { half: 'date' });
  });

  it('refuses a time token over a full-date', () => {
    assert.throws(() => compileDateFormat('HH:mm:ss')(parts('2024-03-05')),
      (error) => error instanceof TypeError && error.half === 'time' && /'HH' token reads the time half/.test(error.message));
    assert.throws(() => compileDateFormat('yyyy hh')(parts('2024-03-05')), { half: 'time' });
    assert.throws(() => compileDateFormat('SSS')(parts('2024-03-05')), { half: 'time' });
  });

  it('formats whatever the value does carry', () => {
    assert.strictEqual(compileDateFormat('yyyy-MM-dd')(parts('2024-03-05')), '2024-03-05');
    assert.strictEqual(compileDateFormat('HH:mm:ss')(parts('12:30:15Z')), '12:30:15');
    assert.strictEqual(compileDateFormat("yyyy-MM-dd'T'HH:mm")(parts('2024-03-05T07:08:09Z')), '2024-03-05T07:08');
    assert.strictEqual(compileDateFormat('XXX')(parts('2024-03-05')), '');
    assert.strictEqual(compileDateFormat('XXX')(parts('12:30:15+05:30')), '+05:30');
    assert.strictEqual(compileDateFormat("'only text'")(parts('12:30:15Z')), 'only text');
  });
});

describe('monthsBetween — the clock counts when both values have one', () => {
  it('does not count a month before its instant', () => {
    assert.strictEqual(monthsBetween(parts('2024-01-15T12:00:00Z'), parts('2024-02-15T10:00:00Z')), 0);
    assert.strictEqual(monthsBetween(parts('2024-02-15T10:00:00Z'), parts('2024-01-15T12:00:00Z')), 0);
    assert.strictEqual(monthsBetween(parts('2024-01-31T12:00:00Z'), parts('2024-02-29T10:00:00Z')), 0);
  });

  it('counts it at the instant and after', () => {
    assert.strictEqual(monthsBetween(parts('2024-01-15T12:00:00Z'), parts('2024-02-15T12:00:00Z')), 1);
    assert.strictEqual(monthsBetween(parts('2024-01-15T12:00:00Z'), parts('2024-02-15T12:00:01Z')), 1);
    assert.strictEqual(monthsBetween(parts('2024-02-15T12:00:00Z'), parts('2024-01-15T12:00:00Z')), -1);
    assert.strictEqual(monthsBetween(parts('2024-02-15T12:00:00Z'), parts('2024-01-15T11:59:59Z')), -1);
  });

  it('compares instants across offsets', () => {
    // Feb 15 00:30 at +02:00 is Feb 14 22:30Z, before the target of 23:00Z
    assert.strictEqual(monthsBetween(parts('2024-01-15T00:30:00+02:00'), parts('2024-02-14T23:00:00Z')), 1);
  });

  it('never overshoots when the result is added back', () => {
    for (const [from, to] of [
      ['2024-01-15T12:00:00Z', '2024-02-15T10:00:00Z'],
      ['2024-02-15T12:00:00Z', '2024-01-15T10:00:00Z'],
      ['2024-01-31T23:59:59Z', '2024-03-01T00:00:00Z'],
    ]) {
      const a = parts(from);
      const b = parts(to);
      const months = monthsBetween(a, b);
      const back = epochOfRFC3339Parts(addToParts(a, months, 'month'));
      const target = epochOfRFC3339Parts(b);
      assert.ok(months >= 0 ? back <= target : back >= target, `${from} -> ${to} = ${months}`);
    }
  });

  it('counts by instant when the local months are equal or one off, extreme offsets included', () => {
    // 32 days apart by instant, yet both local dates are in January 2024
    assert.strictEqual(monthsBetween(parts('2024-01-01T00:00:00+14:00'), parts('2024-01-31T23:59:59-10:00')), 1);
    assert.strictEqual(monthsBetween(parts('2024-01-31T23:59:59-10:00'), parts('2024-01-01T00:00:00+14:00')), -1);
    assert.strictEqual(monthsBetween(parts('2024-01-01T00:00:00+14:00'), parts('2024-01-30T23:59:59-10:00')), 0);
  });

  it('is the most months that stay on this side of the target, over random instants and offsets', () => {
    const offsets = ['Z', '+02:00', '-05:30', '+14:00', '-10:00', '+05:45'];
    let seed = 11;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const text = () => {
      const day = 1 + Math.floor(next() * 28);
      const month = 1 + Math.floor(next() * 12);
      const hour = Math.floor(next() * 24);
      const pad = (n) => String(n).padStart(2, '0');
      return `2023-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(Math.floor(next() * 60))}:00${offsets[Math.floor(next() * offsets.length)]}`;
    };
    for (let i = 0; i < 4000; i++) {
      const a = parts(text());
      const b = parts(text());
      const got = monthsBetween(a, b);
      const start = epochOfRFC3339Parts(a);
      const target = epochOfRFC3339Parts(b);
      let best = 0;
      for (let m = -40; m <= 40; m++) {
        const at = epochOfRFC3339Parts(addToParts(a, m, 'month'));
        if (target >= start ? (m >= 0 && at <= target && m > best) : (m <= 0 && at >= target && m < best)) best = m;
      }
      assert.strictEqual(got, best, `${a.year}-${a.month}-${a.day} -> ${b.year}-${b.month}-${b.day} (${start}, ${target})`);
    }
  });

  it('keeps comparing whole days when either side has no clock', () => {
    assert.strictEqual(monthsBetween(parts('2024-01-15'), parts('2024-02-15')), 1);
    assert.strictEqual(monthsBetween(parts('2026-01-31'), parts('2026-02-28')), 1);
    assert.strictEqual(monthsBetween(parts('2024-01-15'), parts('2024-02-15T01:00:00Z')), 1);
  });
});
