//@ts-check
/**
 * @file A fill answers every bucket of its window, so a window far wider
 * than its width is a row per position. One call emits at most 100,000
 * such buckets and refuses a window holding more before it builds the
 * first, counting from the ladder's arithmetic. Every refusal here is
 * therefore cheap; the one window that is built is exactly the cap.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resampleSeries } from '@jarenjs/core/series';

const FILLS = ['null', 'zero', 'locf', 'linear'];
const CAP = 100_000;

/** A scripted fixed-offset zone: a named zone with no host tzdb. */
const OFFSET = 120;
const provider = {
  toParts: (/** @type {number} */ epoch) => {
    const d = new Date(epoch + OFFSET * 60_000);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
      hours: d.getUTCHours(), minutes: d.getUTCMinutes(), seconds: d.getUTCSeconds(),
      milliseconds: d.getUTCMilliseconds(), offset: OFFSET };
  },
  toEpoch: (/** @type {any} */ parts) => Date.UTC(parts.year, parts.month - 1, parts.day,
    parts.hours ?? 0, parts.minutes ?? 0, parts.seconds ?? 0, parts.milliseconds ?? 0)
    - OFFSET * 60_000,
};

/** The refusal's message for a count and a width. @param {number} count @param {string} every @param {string} fill */
const refusal = (count, every, fill) => new TypeError(`the window holds ${count} buckets of '${every}',`
  + ` more than the ${CAP} a '${fill}' fill may emit; narrow the window, widen 'every', or use fill 'omit'`);

describe('resampleSeries - a fill is bounded by its window', () => {
  it('emits a window of exactly the cap and refuses one bucket more', () => {
    const rows = [{ at: 5, value: 2 }];
    const full = resampleSeries(rows, { every: 1, start: 0, end: CAP, fill: 'null' });
    assert.strictEqual(full.length, CAP);
    assert.deepStrictEqual(full[5], { at: 5, value: 2, count: 1 });
    assert.deepStrictEqual(full[CAP - 1], { at: CAP - 1, value: null, count: 0 });
    assert.throws(() => resampleSeries(rows, { every: 1, start: 0, end: CAP + 1, fill: 'null' }),
      refusal(CAP + 1, '1', 'null'));
  });

  it('refuses a window far wider than its width under every fill but omit', () => {
    for (const fill of FILLS) {
      assert.throws(
        () => resampleSeries([{ at: 5, value: 2 }], { every: 1, start: 0, end: 1e15, fill }),
        refusal(1e15, '1', fill), fill);
      assert.throws(
        () => resampleSeries([{ at: 5, value: 2 }], { every: 'PT1S', start: 0, end: 1e15, fill, aggregate: 'count' }),
        refusal(1e12, 'PT1S', fill), fill);
    }
    assert.deepStrictEqual(
      resampleSeries([{ at: 5, value: 2 }], { every: 1, start: 0, end: 1e15, fill: 'omit' }),
      [{ at: 5, value: 2, count: 1 }]);
  });

  it('counts the window the data derives, as it counts a declared one', () => {
    const rows = [{ at: 0, value: 1 }, { at: 3.2e13, value: 5 }];
    for (const fill of FILLS)
      assert.throws(() => resampleSeries(rows, { every: 1, fill }), refusal(3.2e13 + 1, '1', fill), fill);
    assert.deepStrictEqual(resampleSeries(rows, { every: 1, aggregate: 'sum' }), [
      { at: 0, value: 1, count: 1 }, { at: 3.2e13, value: 5, count: 1 }]);
  });

  it('refuses a wide window that holds no rows at all', () => {
    assert.throws(() => resampleSeries([], { every: 1, start: 0, end: 1e9, fill: 'zero' }),
      refusal(1e9, '1', 'zero'));
    assert.deepStrictEqual(resampleSeries([], { every: 1, start: 0, end: 1e9 }), []);
  });

  it('counts from the first bucket, not from the origin', () => {
    // a window of 100,000 buckets a billion positions from the origin
    const start = 1e9;
    const full = resampleSeries([], { every: 1, start, end: start + CAP, fill: 'zero' });
    assert.strictEqual(full.length, CAP);
    assert.strictEqual(full[0].at, start);
    assert.throws(() => resampleSeries([], { every: 1, start, end: start + CAP + 1, fill: 'zero' }),
      refusal(CAP + 1, '1', 'zero'));
  });

  it('does not count the bucket that starts at the exclusive end', () => {
    assert.strictEqual(resampleSeries([], { every: 10, start: 0, end: CAP * 10, fill: 'null' }).length, CAP);
    // a window ending inside a bucket holds that bucket
    assert.throws(() => resampleSeries([], { every: 10, start: 0, end: CAP * 10 + 1, fill: 'null' }),
      refusal(CAP + 1, '10', 'null'));
  });

  it('counts a calendar ladder on a named zone, a day at a time', () => {
    const days = 102_000;
    const midnight = (/** @type {number} */ year, /** @type {number} */ day) =>
      Date.UTC(year, 0, day) - OFFSET * 60_000;
    const start = midnight(2000, 1);
    // 102,000 local days from a local midnight: more than the cap
    const end = midnight(2000, 1 + days);
    assert.throws(
      () => resampleSeries([], { every: 'P1D', zone: 'Test/Zone', provider, start, end, fill: 'null' }),
      refusal(days, 'P1D', 'null'));
    const year = resampleSeries([], {
      every: 'P1D', zone: 'Test/Zone', provider, start, end: midnight(2001, 1), fill: 'null' });
    assert.strictEqual(year.length, 366);
  });

  it('names the cap for a calendar window ending past what the calendar can name', () => {
    const message = (/** @type {string} */ every, /** @type {string} */ fill) =>
      new TypeError(`the window runs past the last instant the '${every}' ladder can name and holds more than`
        + ` the ${CAP} buckets a '${fill}' fill may emit; narrow the window, widen 'every', or use fill 'omit'`);
    for (const end of [8.64e15, 1e20]) {
      assert.throws(() => resampleSeries([], { every: 'P1M', start: 0, end, fill: 'null' }), message('P1M', 'null'));
      assert.throws(() => resampleSeries([], { every: 'P1Y', offset: 60, start: 0, end, fill: 'zero' }), message('P1Y', 'zero'));
    }
    // a width the integers can count still names its count
    assert.throws(() => resampleSeries([], { every: 'PT1H', start: 0, end: 8.64e15, fill: 'null' }),
      refusal(8.64e15 / 3.6e6, 'PT1H', 'null'));
  });

  it('keeps every small answer as it was', () => {
    const rows = [{ at: 0, value: 1 }, { at: 1, value: 3 }, { at: 7, value: 5 }];
    assert.deepStrictEqual(resampleSeries(rows, { every: 2, aggregate: 'sum', fill: 'zero' }), [
      { at: 0, value: 4, count: 2 }, { at: 2, value: 0, count: 0 }, { at: 4, value: 0, count: 0 },
      { at: 6, value: 5, count: 1 }]);
    assert.deepStrictEqual(resampleSeries(rows, { every: 2, aggregate: 'sum', fill: 'linear', start: -2, end: 10 }), [
      { at: -2, value: null, count: 0 }, { at: 0, value: 4, count: 2 }, { at: 2, value: 4 + 1 / 3, count: 0 },
      { at: 4, value: 4 + 2 / 3, count: 0 }, { at: 6, value: 5, count: 1 }, { at: 8, value: null, count: 0 }]);
  });
});
