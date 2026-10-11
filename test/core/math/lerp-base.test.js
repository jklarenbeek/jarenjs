//@ts-check
/**
 * @file Interpolation from a base that is not zero: `Int32.lerp` multiplied
 * the span by `norm + min` and `Vec2f64.lerp` by `component + norm`, which
 * agree with `min + span * norm` only when the base is the origin (the one
 * case the earlier tests used).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Int32, Vec2f64 } from '@jarenjs/core/math';

describe('Int32.lerp', () => {
  it('starts at min and ends at max', () => {
    assert.strictEqual(Int32.lerp(0, 3, 13), 3);
    assert.strictEqual(Int32.lerp(1, 3, 13), 13);
    assert.strictEqual(Int32.lerp(5, 3, 13), 53);
    assert.strictEqual(Int32.lerp(2, -4, 6), 16);
  });

  it('keeps the origin-based answers', () => {
    assert.strictEqual(Int32.lerp(5, 0, 10), 50);
    assert.strictEqual(Int32.lerp(10, 0, 10), 100);
  });
});

describe('Vec2f64.lerp', () => {
  it('starts at a and ends at b from any base', () => {
    const a = new Vec2f64(10, -20);
    const b = new Vec2f64(30, 20);
    const start = Vec2f64.lerp(0, a, b);
    const mid = Vec2f64.lerp(0.5, a, b);
    const end = Vec2f64.lerp(1, a, b);
    assert.deepStrictEqual([start.x, start.y], [10, -20]);
    assert.deepStrictEqual([mid.x, mid.y], [20, 0]);
    assert.deepStrictEqual([end.x, end.y], [30, 20]);
  });

  it('extrapolates past the ends', () => {
    const result = Vec2f64.lerp(2, new Vec2f64(1, 1), new Vec2f64(2, 3));
    assert.deepStrictEqual([result.x, result.y], [3, 5]);
  });
});
