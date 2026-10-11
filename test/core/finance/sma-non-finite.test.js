//@ts-check
/**
 * @file `sma` over a series holding a NaN or an Infinity: the running sum
 * carried the bad value for good, so every window after it read NaN even once
 * the value had left (`wma`, which re-reads each window, recovered).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { sma, wma } from '@jarenjs/core/finance';

describe('sma — a non-finite value in the series', () => {
  it('is NaN only in the windows that hold the NaN', () => {
    const out = sma([1, NaN, 3, 4, 5, 6], 2);
    assert.strictEqual(out[0], null);
    assert.ok(Number.isNaN(out[1]));
    assert.ok(Number.isNaN(out[2]));
    assert.deepStrictEqual(out.slice(3), [3.5, 4.5, 5.5]);
  });

  it('is Infinity only in the windows that hold the Infinity', () => {
    assert.deepStrictEqual(sma([1, 2, Infinity, 4, 5, 6], 2), [null, 1.5, Infinity, Infinity, 4.5, 5.5]);
  });

  it('agrees with wma on which windows are finite', () => {
    const values = [1, NaN, 3, 4, 5, 6, Infinity, 8, 9];
    const finite = (list) => list.map((v) => v !== null && Number.isFinite(v));
    assert.deepStrictEqual(finite(sma(values, 2)), finite(wma(values, 2)));
  });

  it('keeps ordinary series as they were', () => {
    assert.deepStrictEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
    assert.deepStrictEqual(sma([1, 2], 3), [null, null]);
    assert.deepStrictEqual(sma([], 2), []);
  });

  it('reads a null as 0 and answers a gap series in linear time', () => {
    assert.deepStrictEqual(sma([2, null, 4, null], 2), [null, 1, 2, 2]);
    const values = Array.from({ length: 300000 }, (_, i) => (i % 10 === 0 ? null : Math.sin(i)));
    const nans = Array.from({ length: 200000 }, () => NaN);
    const started = Date.now();
    sma(values, 1000);
    sma(nans, 10000);
    assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
  });

  it('agrees with a naive window over random series holding NaN, null and both infinities', () => {
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pool = [NaN, null, Infinity, -Infinity];
    for (let round = 0; round < 300; round++) {
      const values = Array.from({ length: 30 }, () => (next() < 0.25 ? pool[Math.floor(next() * 4)] : Math.floor(next() * 20) - 10));
      const period = 1 + Math.floor(next() * 6);
      const got = sma(values, period);
      values.forEach((_, i) => {
        if (i < period - 1) return assert.strictEqual(got[i], null);
        let total = 0;
        for (let j = i - period + 1; j <= i; j++) total += values[j];
        const expected = total / period;
        assert.ok(Object.is(got[i], expected) || (Number.isNaN(got[i]) && Number.isNaN(expected)), `${JSON.stringify(values)} p${period} i${i}: ${got[i]} vs ${expected}`);
      });
    }
  });
});
