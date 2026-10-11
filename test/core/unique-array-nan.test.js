//@ts-check
/**
 * @file `getUniqueArray` keeps a NaN once: it used to drop every NaN (the
 * `indexOf(NaN)` of a filter is always -1), so `isUniqueArray([NaN])` read
 * false. The pass is linear now; it was quadratic.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getUniqueArray, isUniqueArray } from '@jarenjs/core/array';

describe('getUniqueArray / isUniqueArray — NaN', () => {
  it('keeps a NaN once, at its first position', () => {
    const result = /** @type {number[]} */ (getUniqueArray([1, NaN, NaN, 1, 2]));
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0], 1);
    assert.ok(Number.isNaN(result[1]));
    assert.strictEqual(result[2], 2);
  });

  it('reads a lone NaN as unique and two as a duplicate', () => {
    assert.strictEqual(isUniqueArray([NaN]), true);
    assert.strictEqual(isUniqueArray([1, NaN, 2]), true);
    assert.strictEqual(isUniqueArray([NaN, NaN]), false);
  });

  it('keeps first-occurrence order, zero signs together and objects by identity', () => {
    const a = {};
    assert.deepStrictEqual(getUniqueArray([3, 1, 3, 2, 1]), [3, 1, 2]);
    assert.deepStrictEqual(getUniqueArray([0, -0, 1]), [0, 1]);
    assert.deepStrictEqual(getUniqueArray([a, a, {}]), [a, {}]);
    assert.deepStrictEqual(getUniqueArray(['1', 1]), ['1', 1]);
  });

  it('checks a large array in linear time', () => {
    const started = Date.now();
    assert.strictEqual(isUniqueArray(Array.from({ length: 200000 }, (_, i) => i)), true);
    assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
  });
});
