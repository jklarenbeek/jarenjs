//@ts-check
/**
 * @file `@jarenjs/core/stats` — the descriptive statistics and the one
 * rule that matters most: a quantile names its method or is refused.
 * Every expected value is a literal; the even-count median case is the
 * one that separates the three "middle" definitions.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { mean, variance, stddev, median, quantile } from '@jarenjs/core/stats';

describe('core/stats — mean, variance, stddev', function () {
  it('computes the mean and the SAMPLE variance (n − 1)', function () {
    assert.strictEqual(mean([2, 4, 4, 4, 5, 5, 7, 9]), 5);
    assert.strictEqual(variance([2, 4, 4, 4, 5, 5, 7, 9]), 32 / 7);
    assert.strictEqual(stddev([2, 4, 4, 4, 5, 5, 7, 9]), Math.sqrt(32 / 7));
    assert.strictEqual(variance([1, 2, 3, 4]), 5 / 3);
  });

  it('answers undefined for what it cannot summarize: an empty sample, one value for a variance', function () {
    assert.strictEqual(mean([]), undefined);
    assert.strictEqual(variance([]), undefined);
    assert.strictEqual(variance([7]), undefined);
    assert.strictEqual(stddev([7]), undefined);
    assert.strictEqual(mean([7]), 7);
  });
});

describe('core/stats — median', function () {
  it('is the middle value, or the mean of the two middles on an even count', function () {
    assert.strictEqual(median([3, 1, 2]), 2);
    assert.strictEqual(median([1, 2, 3, 4]), 2.5);
    assert.strictEqual(median([10, 1, 4, 100]), 7);
    assert.strictEqual(median([5]), 5);
    assert.strictEqual(median([]), undefined);
  });

  it('the three middles on an even count: median, nearest-rank p50 and linear p50', function () {
    const sample = [1, 2, 3, 10];
    assert.strictEqual(median(sample), 2.5);
    assert.strictEqual(quantile(sample, 0.5, { method: 'nearest-rank' }), 2);
    assert.strictEqual(quantile(sample, 0.5, { method: 'linear' }), 2.5);
    // the same p50 under 'linear' is a coincidence of spacing, not identity:
    assert.strictEqual(quantile([1, 2, 3, 100], 0.5, { method: 'linear' }), 2.5);
    assert.strictEqual(median([1, 2, 3, 100]), 2.5);
    assert.strictEqual(quantile([1, 3, 3, 100], 0.5, { method: 'linear' }), 3);
    assert.strictEqual(median([1, 3, 3, 100]), 3);
  });
});

describe('core/stats — quantile', function () {
  const sample = [5, 1, 4, 2, 3];

  it('nearest rank: the value at rank max(1, ceil(p · n)) — always a measured value', function () {
    const q = (p) => quantile(sample, p, { method: 'nearest-rank' });
    assert.deepStrictEqual([q(0), q(0.25), q(0.5), q(0.95), q(1)], [1, 2, 3, 5, 5]);
    assert.strictEqual(quantile([10, 20], 0.5, { method: 'nearest-rank' }), 10);
    assert.strictEqual(quantile([10, 20], 0.51, { method: 'nearest-rank' }), 20);
  });

  it('linear: rank (n − 1) · p, interpolated (type 7)', function () {
    const q = (p) => quantile(sample, p, { method: 'linear' });
    assert.deepStrictEqual([q(0), q(0.25), q(0.5), q(0.95), q(1)], [1, 2, 3, 4.8, 5]);
    assert.strictEqual(quantile([10, 20], 0.5, { method: 'linear' }), 15);
    assert.strictEqual(quantile([7], 0.3, { method: 'linear' }), 7);
  });

  it('refuses an unnamed or unknown method with a TypeError', function () {
    assert.throws(() => /** @type {any} */ (quantile)(sample, 0.5), TypeError);
    assert.throws(() => /** @type {any} */ (quantile)(sample, 0.5, {}), TypeError);
    assert.throws(() => /** @type {any} */ (quantile)(sample, 0.5, { method: 'midpoint' }), TypeError);
  });

  it('refuses p outside [0, 1] with a RangeError', function () {
    assert.throws(() => quantile(sample, 1.5, { method: 'linear' }), RangeError);
    assert.throws(() => quantile(sample, -0.1, { method: 'nearest-rank' }), RangeError);
    assert.throws(() => quantile(sample, NaN, { method: 'linear' }), RangeError);
    assert.throws(() => quantile(sample, 95, { method: 'linear' }), RangeError, 'a 0..100 scale is the caller\'s to divide');
  });

  it('answers undefined for an empty sample under either method', function () {
    assert.strictEqual(quantile([], 0.5, { method: 'linear' }), undefined);
    assert.strictEqual(quantile([], 0.5, { method: 'nearest-rank' }), undefined);
  });

  it('never reorders the caller\'s array', function () {
    const values = [3, 1, 2];
    quantile(values, 0.5, { method: 'nearest-rank' });
    median(values);
    assert.deepStrictEqual(values, [3, 1, 2]);
  });
});
