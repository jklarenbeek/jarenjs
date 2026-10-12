//@ts-check
/**
 * @file The nearest-rank quantile takes the rank a decimal probability
 * names. `p * n` of a decimal `p` carries the rounding of `p` (0.07 * 100
 * is 7.000000000000001), and a bare ceiling read that as rank 8: the next
 * measured value, and for the default 95% bootstrap interval a lower bound
 * one rank too high.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { pairedBootstrap, quantile } from '@jarenjs/core/stats';
import { mulberry32 } from '@jarenjs/core/random';

/** 1..n, so the value at rank r is r. @param {number} n */
const ranks = (n) => Array.from({ length: n }, (_, i) => i + 1);

describe('quantile - nearest rank on decimal probabilities', () => {
  it('reads p = 0.07 over a hundred values as the seventh', () => {
    assert.strictEqual(quantile(ranks(100), 0.07, { method: 'nearest-rank' }), 7);
    assert.strictEqual(quantile(ranks(200), 0.07, { method: 'nearest-rank' }), 14);
    assert.strictEqual(quantile(ranks(1400), 0.07, { method: 'nearest-rank' }), 98);
  });

  it('reads the tail of a 95% interval over a thousand values as rank 25 and 975', () => {
    const tail = (1 - 0.95) / 2;
    assert.strictEqual(tail * 1000 > 25, true, 'the tail is a hair above 0.025');
    assert.strictEqual(quantile(ranks(1000), tail, { method: 'nearest-rank' }), 25);
    assert.strictEqual(quantile(ranks(1000), 1 - tail, { method: 'nearest-rank' }), 975);
  });

  it('still rounds a probability between ranks up', () => {
    assert.strictEqual(quantile(ranks(100), 0.071, { method: 'nearest-rank' }), 8);
    assert.strictEqual(quantile(ranks(10), 0.95, { method: 'nearest-rank' }), 10);
    assert.strictEqual(quantile(ranks(4), 0.5, { method: 'nearest-rank' }), 2);
    assert.strictEqual(quantile(ranks(3), 0, { method: 'nearest-rank' }), 1);
    assert.strictEqual(quantile(ranks(3), 1, { method: 'nearest-rank' }), 3);
  });

  it('gives the default bootstrap interval the symmetric ranks of its resamples', () => {
    const pairs = [[1, 2], [2, 4], [4, 3], [5, 9], [3, 3]];
    const options = { resamples: 1000, seed: 7 };
    const random = mulberry32(options.seed);
    const deltas = pairs.map(([a, b]) => b - a);
    const means = [];
    for (let r = 0; r < options.resamples; r++) {
      let sum = 0;
      for (let i = 0; i < deltas.length; i++) sum += deltas[Math.floor(random() * deltas.length)];
      means.push(sum / deltas.length);
    }
    means.sort((a, b) => a - b);
    const result = pairedBootstrap(pairs, options);
    assert.strictEqual(result.lower, means[24]);
    assert.strictEqual(result.upper, means[974]);
  });
});
