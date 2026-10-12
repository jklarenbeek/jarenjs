import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Int32, Vec2i32 } from '@jarenjs/core/math';

// Products of two int32 values reach 2^62: a double product loses the low
// bits before the wrap, so every product must wrap exactly (Math.imul).
const A = 2147483647;
const B = 2147483645;

describe('fixed-width integer products wrap exactly', () => {
  it('Int32 dot, cross, mag2 and lerp', () => {
    assert.equal(Int32.dot(A, 0, B, 0), 3);
    assert.equal(Int32.cross(A, 0, 0, A), 1);
    assert.equal(Int32.mag2(A, 0), 1);
    assert.equal(Int32.lerp(A, 0, A), 1);
  });

  it('Vec2i32 static products', () => {
    const a = new Vec2i32(A, A);
    const b = new Vec2i32(B, B);
    assert.deepEqual(Vec2i32.mul(a, b), new Vec2i32(3, 3));
    assert.deepEqual(Vec2i32.muls(a, B), new Vec2i32(3, 3));
    assert.equal(Vec2i32.dot(new Vec2i32(A, 0), new Vec2i32(B, 0)), 3);
    assert.equal(Vec2i32.mag2(new Vec2i32(A, 0)), 1);
    assert.equal(Vec2i32.cross(new Vec2i32(A, 0), new Vec2i32(0, B)), 3);
  });

  it('Vec2i32.cross3 wraps to int32', () => {
    const r = Vec2i32.cross3(
      new Vec2i32(0, 0),
      new Vec2i32(A, 0),
      new Vec2i32(0, B),
    );
    assert.equal(r, 3);
    assert.equal(r | 0, r);
  });

  it('Vec2i32 in-place operators wrap', () => {
    assert.deepEqual(new Vec2i32(A, A).imul(new Vec2i32(B, B)), new Vec2i32(3, 3));
    assert.deepEqual(new Vec2i32(A, A).imuls(B), new Vec2i32(3, 3));
    assert.deepEqual(new Vec2i32(A, A).iadd(new Vec2i32(1, 1)), new Vec2i32(-2147483648, -2147483648));
    assert.deepEqual(new Vec2i32(A, A).iadds(1), new Vec2i32(-2147483648, -2147483648));
    assert.deepEqual(new Vec2i32(-2147483648, 0).isub(new Vec2i32(1, 1)), new Vec2i32(A, -1));
    assert.deepEqual(new Vec2i32(-2147483648, 0).isubs(1), new Vec2i32(A, -1));
  });

  it('second terms and y axes wrap too', () => {
    assert.equal(Int32.dot(0, A, 0, B), 3);
    assert.equal(Int32.dot(A, A, B, B), 6);
    assert.equal(Int32.mag2(0, A), 1);
    assert.equal(Int32.cross(0, A, B, 0), -3);
    assert.equal(Int32.cross(A, A, B, B), 0);
    assert.equal(Int32.cross(1, 0, 0, A), A);
    assert.equal(Int32.cross(0, A, -A, 0), 1);
    assert.equal(Vec2i32.mag2(new Vec2i32(0, A)), 1);
    assert.equal(Vec2i32.mag2(new Vec2i32(A, A)), 2);
    assert.equal(Vec2i32.dot(new Vec2i32(0, A), new Vec2i32(0, B)), 3);
    assert.equal(Vec2i32.dot(new Vec2i32(A, A), new Vec2i32(B, B)), 6);
    assert.equal(Vec2i32.cross(new Vec2i32(0, A), new Vec2i32(B, 0)), -3);
    assert.equal(Vec2i32.cross(new Vec2i32(0, A), new Vec2i32(-A, 0)), 1);
  });

  it('cross3 wraps each product and their difference', () => {
    const o = new Vec2i32(0, 0);
    assert.equal(Vec2i32.cross3(o, new Vec2i32(0, A), new Vec2i32(B, 0)), -3);
    assert.equal(Vec2i32.cross3(o, new Vec2i32(1, 1), new Vec2i32(-A, A)), -2);
    assert.equal(
      Vec2i32.cross3(o, new Vec2i32(100000, 0), new Vec2i32(0, 100000)),
      1410065408,
    );
  });

  it('in-place y components wrap', () => {
    const y = new Vec2i32(0, A);
    assert.equal(new Vec2i32(0, A).imul(new Vec2i32(0, B)).y, 3);
    assert.equal(new Vec2i32(0, A).imuls(B).y, 3);
    assert.equal(new Vec2i32(0, A).iadd(new Vec2i32(0, 1)).y, -2147483648);
    assert.equal(new Vec2i32(0, A).iadds(1).y, -2147483648);
    assert.equal(new Vec2i32(0, -2147483648).isub(new Vec2i32(0, 1)).y, A);
    assert.equal(new Vec2i32(0, -2147483648).isubs(1).y, A);
    assert.equal(y.y, A);
  });
});
