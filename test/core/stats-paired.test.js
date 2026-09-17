//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { pairedBootstrap, permutationTest, quantile } from '@jarenjs/core/stats';
import { mulberry32 } from '@jarenjs/core/random';

it('preserves paired delta sampling and downstream nearest-rank arithmetic', () => {
  const pairs = [[1, 2], [2, 4], [4, 3]], options = { resamples: 1000, seed: 123, level: 0.9 };
  const before = structuredClone(pairs), random = mulberry32(options.seed);
  // The independently existing consumer sums precomputed deltas, not two
  // separately accumulated sample means; preserve that reduction exactly.
  const deltas = pairs.map(([a, b]) => b - a), means = [];
  for (let r = 0; r < options.resamples; r++) {
    let sum = 0;
    for (let i = 0; i < deltas.length; i++) sum += deltas[Math.floor(random() * deltas.length)];
    means.push(sum / deltas.length);
  }
  const result = pairedBootstrap(pairs, options);
  assert.deepEqual(result, { estimate: 2 / 3, lower: -1 / 3, upper: 5 / 3,
    ...options, method: 'paired-bootstrap', quantile: 'nearest-rank' });
  assert.equal(result.lower, quantile(means, (1 - options.level) / 2, { method: 'nearest-rank' }));
  assert.equal(result.upper, quantile(means, 1 - (1 - options.level) / 2, { method: 'nearest-rank' }));
  assert.deepEqual(pairs, before);
  assert.deepEqual(pairedBootstrap(pairs, options), result);
});

it('keeps both members together and isolates callback mutation', () => {
  const pairs = [[1, 11], [2, 12], [3, 13]];
  const result = pairedBootstrap(pairs, { seed: -1, resamples: 20, quantile: 'linear', statistic(a, b) {
    for (let i = 0; i < a.length; i++) assert.equal(b[i] - a[i], 10);
    a.fill(99); b.fill(88); return 10;
  } });
  assert.equal(result.estimate, 10); assert.equal(result.lower, 10); assert.equal(result.upper, 10);
  assert.equal(result.seed, 4294967295); assert.deepEqual(pairs, [[1, 11], [2, 12], [3, 13]]);
});

it('uses paired sign swaps, includes ties and applies the Monte Carlo correction', () => {
  const pairs = [[0, 1], [0, 2], [0, 3]], options = { seed: 42, resamples: 99 };
  const two = permutationTest(pairs, options), greater = permutationTest(pairs, { ...options, alternative: 'greater' });
  assert.equal(two.estimate, 2); assert.equal(two.method, 'paired-permutation');
  assert.ok(two.pValue >= greater.pValue && greater.pValue >= 1 / 100);
  assert.equal(permutationTest(pairs, { ...options, alternative: 'less' }).pValue, 1);
  assert.equal(permutationTest([[1, 1]], options).pValue, 1);
  assert.deepEqual(permutationTest(pairs, options), two);
  const custom = permutationTest(pairs, { ...options, statistic: (a, b) => b.reduce((sum, x, i) => sum + x - a[i], 0) / a.length });
  assert.equal(custom.pValue, two.pValue);
});

it('refuses invalid samples, options, nonfinite statistics and excessive work before sampling', () => {
  for (const fn of [pairedBootstrap, permutationTest]) {
    for (const pairs of [[], [[1]], [[0, Infinity]], [[NaN, 1]]]) assert.throws(() => fn(pairs, { seed: 1, resamples: 1 }));
    for (const options of [{ seed: 1, resamples: 0 }, { seed: 0.5, resamples: 1 }, { seed: 1, resamples: 2, maxWork: 1 },
      { seed: 1, resamples: 1000001 }, { seed: 1, resamples: 1, statistic: () => NaN }]) assert.throws(() => fn([[0, 1]], options));
  }
  assert.throws(() => pairedBootstrap([[0, 1]], { seed: 1, resamples: 1, level: 1 }));
  assert.throws(() => pairedBootstrap([[0, 1]], { seed: 1, resamples: 1, quantile: 'bad' }));
  assert.throws(() => permutationTest([[0, 1]], { seed: 1, resamples: 1, alternative: 'bad' }));
});
