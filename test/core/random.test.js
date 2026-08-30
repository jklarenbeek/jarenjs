//@ts-check
/**
 * @file `@jarenjs/core/random` — the suite's one seeded generator and
 * its three draws. The sequence is the contract: every literal below was
 * computed once and pasted, so a generator that drifts by one bit fails
 * here before it silently regenerates a committed corpus differently.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { mulberry32, randomInt, shuffle, drawDistinct } from '@jarenjs/core/random';

/** @param {() => number} random @param {number} count */
const draws = (random, count) => Array.from({ length: count }, () => random());

describe('core/random — mulberry32', function () {
  it('pins the reference sequence for seed 1', function () {
    assert.deepStrictEqual(draws(mulberry32(1), 5), [
      0.6270739405881613,
      0.002735721180215478,
      0.5274470399599522,
      0.9810509674716741,
      0.9683778982143849,
    ]);
  });

  it('normalizes the seed as ToUint32: 1.5 → 1, NaN → 0, -1 → 2^32-1, 2^32+5 → 5', function () {
    assert.strictEqual(mulberry32(1.5)(), mulberry32(1)());
    assert.strictEqual(mulberry32(NaN)(), mulberry32(0)());
    assert.strictEqual(mulberry32(-1)(), mulberry32(4294967295)());
    assert.strictEqual(mulberry32(2 ** 32 + 5)(), mulberry32(5)());
    assert.strictEqual(mulberry32(0)(), 0.26642920868471265);
    assert.strictEqual(mulberry32(-1)(), 0.8964226141106337);
    assert.strictEqual(mulberry32(5)(), 0.6897749109193683);
  });

  it('is a stream: two generators from one seed agree draw for draw, and stay in [0, 1)', function () {
    const a = draws(mulberry32(20260825), 1000);
    const b = draws(mulberry32(20260825), 1000);
    assert.deepStrictEqual(a, b);
    assert.ok(a.every((x) => x >= 0 && x < 1));
    assert.ok(new Set(a).size > 990, 'a thousand draws are not a handful of values');
  });
});

describe('core/random — randomInt', function () {
  it('draws min + floor(r · (max − min)) — the floor draw the corpora were generated with', function () {
    const random = mulberry32(3);
    assert.deepStrictEqual(Array.from({ length: 8 }, () => randomInt(random, 5, 10)),
      [8, 5, 7, 5, 8, 7, 7, 5]);
  });

  it('stays inside the half-open range at every boundary', function () {
    const random = mulberry32(11);
    for (let i = 0; i < 2000; i++) {
      const x = randomInt(random, -3, 3);
      assert.ok(x >= -3 && x < 3 && Number.isInteger(x), String(x));
    }
    assert.strictEqual(randomInt(() => 0, 7, 8), 7);
    assert.strictEqual(randomInt(() => 0.999999, 7, 8), 7);
  });

  it('refuses a non-integer bound and an empty range', function () {
    const random = mulberry32(1);
    assert.throws(() => randomInt(random, 0.5, 2), RangeError);
    assert.throws(() => randomInt(random, 0, Infinity), RangeError);
    assert.throws(() => randomInt(random, 3, 3), RangeError);
    assert.throws(() => randomInt(random, 4, 3), RangeError);
  });
});

describe('core/random — shuffle', function () {
  it('pins the permutation of ten elements under seed 42 (descending Fisher–Yates)', function () {
    const list = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const out = shuffle(mulberry32(42), list);
    assert.strictEqual(out, list, 'in place: the same array comes back');
    assert.deepStrictEqual(list, [0, 7, 3, 5, 2, 1, 8, 9, 4, 6]);
  });

  it('draws nothing for an empty or one-element list', function () {
    let calls = 0;
    const random = () => { calls++; return 0.5; };
    assert.deepStrictEqual(shuffle(random, []), []);
    assert.deepStrictEqual(shuffle(random, ['x']), ['x']);
    assert.strictEqual(calls, 0);
  });

  it('is a permutation: every element survives exactly once', function () {
    const list = Array.from({ length: 100 }, (_, i) => i);
    shuffle(mulberry32(9), list);
    assert.deepStrictEqual([...list].sort((a, b) => a - b), Array.from({ length: 100 }, (_, i) => i));
  });
});

describe('core/random — drawDistinct', function () {
  it('pins four of ten under seed 7 (partial forward Fisher–Yates)', function () {
    assert.deepStrictEqual(drawDistinct(mulberry32(7), 10, 4), [0, 1, 9, 7]);
  });

  it('answers n when asked for more than n, and [] for nothing or from nothing', function () {
    const all = drawDistinct(mulberry32(1), 5, 50);
    assert.strictEqual(all.length, 5);
    assert.deepStrictEqual([...all].sort((a, b) => a - b), [0, 1, 2, 3, 4]);
    let calls = 0;
    const random = () => { calls++; return 0; };
    assert.deepStrictEqual(drawDistinct(random, 10, 0), []);
    assert.deepStrictEqual(drawDistinct(random, 0, 10), []);
    assert.strictEqual(calls, 0);
  });

  it('is distinct over a thousand draws from one stream', function () {
    const random = mulberry32(2026);
    for (let round = 0; round < 1000; round++) {
      const out = drawDistinct(random, 40, 7);
      assert.strictEqual(new Set(out).size, 7);
      assert.ok(out.every((i) => i >= 0 && i < 40));
    }
  });

  it('refuses a non-integer or negative argument', function () {
    const random = mulberry32(1);
    assert.throws(() => drawDistinct(random, 2.5, 1), RangeError);
    assert.throws(() => drawDistinct(random, 5, -1), RangeError);
    assert.throws(() => drawDistinct(random, -5, 1), RangeError);
  });
});
