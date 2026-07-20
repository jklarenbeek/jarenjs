import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mathf64_abs,
  mathf64_sqrt,
  mathf64_pow,
  mathf64_sin,
  mathf64_cos,
  mathf64_atan2,
  mathf64_asin,
  mathf64_ceil,
  mathf64_floor,
  mathf64_round,
  mathf64_min,
  mathf64_max,
  mathf64_random,
  Float64,
  remap,
} from '@jarenjs/core/math'
  //from '../../../packages/core/src/calc/float64.js';

describe('#Mathf64 primitives', function () {

  it('mathf64_abs', () => {
    assert.equal(mathf64_abs(-5), 5);
    assert.equal(mathf64_abs(5), 5);
    assert.equal(mathf64_abs(0), 0);
  });

  it('mathf64_sqrt', () => {
    assert.equal(mathf64_sqrt(4), 2);
    assert.equal(mathf64_sqrt(9), 3);
    assert.equal(mathf64_sqrt(0), 0);
  });

  it('mathf64_pow', () => {
    assert.equal(mathf64_pow(2, 3), 8);
    assert.equal(mathf64_pow(3, 2), 9);
    assert.equal(mathf64_pow(5, 0), 1);
  });

  it.skip('mathf64_sin', () => {
    assert.equal(mathf64_sin(Math.PI / 2), 1);
    assert.equal(mathf64_sin(Math.PI), 0);
    assert.equal(mathf64_sin(0), 0);
  });

  it.skip('mathf64_cos', () => {
    assert.equal(mathf64_cos(0), 1);
    assert.equal(mathf64_cos(Math.PI), -1);
    assert.equal(mathf64_cos(Math.PI / 2), 0);
  });

  it('mathf64_atan2', () => {
    assert.equal(mathf64_atan2(1, 1), Math.PI / 4);
    assert.equal(mathf64_atan2(0, 1), 0);
    assert.equal(mathf64_atan2(1, 0), Math.PI / 2);
  });

  it('mathf64_asin', () => {
    assert.equal(mathf64_asin(0), 0);
    assert.equal(mathf64_asin(1), Math.PI / 2);
    assert.equal(mathf64_asin(-1), -Math.PI / 2);
  });

  it('mathf64_ceil', () => {
    assert.equal(mathf64_ceil(3.1), 4);
    assert.equal(mathf64_ceil(3.9), 4);
    assert.equal(mathf64_ceil(-3.1), -3);
  });

  it('mathf64_floor', () => {
    assert.equal(mathf64_floor(3.1), 3);
    assert.equal(mathf64_floor(3.9), 3);
    assert.equal(mathf64_floor(-3.1), -4);
  });

  it('mathf64_round', () => {
    assert.equal(mathf64_round(3.1), 3);
    assert.equal(mathf64_round(3.5), 4);
    assert.equal(mathf64_round(-3.5), -3);
  });

  it('mathf64_min', () => {
    assert.equal(mathf64_min(3, 5), 3);
    assert.equal(mathf64_min(-3, 5), -3);
    assert.equal(mathf64_min(3, 3), 3);
  });

  it('mathf64_max', () => {
    assert.equal(mathf64_max(3, 5), 5);
    assert.equal(mathf64_max(-3, 5), 5);
    assert.equal(mathf64_max(3, 3), 3);
  });

  it('mathf64_random', () => {
    const random = mathf64_random();
    assert(random >= 0 && random < 1);
  });

});

describe('#Float64 primitives', function () {

  it('Float64.gcd', () => {
    assert.equal(Float64.gcd(48, 18), 6);
    assert.equal(Float64.gcd(100, 75), 25);
    assert.equal(Float64.gcd(17, 23), 1);
  });

  it('Float64.sqrt', () => {
    assert.equal(Float64.sqrt(4), 2);
    assert.equal(Float64.sqrt(9), 3);
    assert.equal(Float64.sqrt(0), 0);
  });

  it('Float64.cross', () => {
    assert.equal(Float64.cross(1, 2, 3, 4), -2);
    assert.equal(Float64.cross(0, 1, 1, 0), -1);
    assert.equal(Float64.cross(2, 3, 4, 5), -2);
  });

  it('Float64.dot', () => {
    assert.equal(Float64.dot(1, 2, 3, 4), 11);
    assert.equal(Float64.dot(0, 1, 1, 0), 0);
    assert.equal(Float64.dot(2, 3, 4, 5), 23);
  });

  it('Float64.mag2', () => {
    assert.equal(Float64.mag2(3, 4), 25);
    assert.equal(Float64.mag2(0, 5), 25);
    assert.equal(Float64.mag2(1, 1), 2);
  });

  it('Float64.mag', () => {
    assert.equal(Float64.mag(3, 4), 5);
    assert.equal(Float64.mag(0, 5), 5);
    assert.equal(Float64.mag(1, 1), Math.sqrt(2));
  });

  it('Float64.isqrt', () => {
    // Fast inverse square root: one Newton iteration, ~0.2% max error
    assert.ok(Math.abs(Float64.isqrt(4) - 0.5) < 0.005);
    assert.ok(Math.abs(Float64.isqrt(9) - 1 / 3) < 0.005);
    assert.ok(Math.abs(Float64.isqrt(1) - 1) < 0.005);
    assert.ok(Math.abs(Float64.isqrt(100) - 0.1) < 0.001);
  });

  it('Float64.fib', () => {
    assert.equal(Float64.fib(0), 0);
    assert.equal(Float64.fib(1), 1);
    assert.equal(Float64.fib(10), 55);
    // Non-integer input is floored instead of looping forever
    assert.equal(Float64.fib(10.9), 55);
  });

  it('Float64.cosHp', () => {
    // now implemented (Part A1): a high-precision polynomial cosine
    for (const r of [0, 0.5, 1, Math.PI / 2, Math.PI, -1]) {
      assert.ok(Math.abs(Float64.cosHp(r) - Math.cos(r)) <= 2e-3);
    }
  });

  it('Float64.fib2', () => {
    assert.equal(Float64.fib2(0), 0);
    assert.equal(Float64.fib2(1), 1);
    assert.equal(Float64.fib2(10), 55);
  });

  it('Float64.norm', () => {
    assert.equal(Float64.norm(5, 0, 10), 0.5);
    assert.equal(Float64.norm(0, 0, 10), 0);
    assert.equal(Float64.norm(10, 0, 10), 1);
  });

  it('Float64.lerp', () => {
    assert.equal(Float64.lerp(0.5, 0, 10), 5);
    assert.equal(Float64.lerp(0, 0, 10), 0);
    assert.equal(Float64.lerp(1, 0, 10), 10);
  });

  it('Float64.map', () => {
    assert.equal(Float64.map(5, 0, 10, 0, 100), 50);
    assert.equal(Float64.map(0, 0, 10, 0, 100), 0);
    assert.equal(Float64.map(10, 0, 10, 0, 100), 100);
  });

  it('Float64.clamp', () => {
    assert.equal(Float64.clamp(5, 0, 10), 5);
    assert.equal(Float64.clamp(-5, 0, 10), 0);
    assert.equal(Float64.clamp(15, 0, 10), 10);
  });

  it('Float64.clampu', () => {
    assert.equal(Float64.clampu(5, 0, 10), 5);
    assert.equal(Float64.clampu(-5, 0, 10), 0);
    assert.equal(Float64.clampu(15, 0, 10), 10);
  });

  it('Float64.inRange', () => {
    assert.equal(Float64.inRange(5, 0, 10), 1);
    assert.equal(Float64.inRange(-5, 0, 10), 0);
    assert.equal(Float64.inRange(15, 0, 10), 0);
  });

  it('Float64.intersectsRange', () => {
    assert.equal(Float64.intersectsRange(0, 5, 3, 8), 1);
    assert.equal(Float64.intersectsRange(0, 2, 3, 5), 0);
    assert.equal(Float64.intersectsRange(0, 10, 5, 15), 1);
  });

  it('Float64.intersectsRect', () => {
    assert.equal(Float64.intersectsRect(0, 0, 5, 5, 3, 3, 5, 5), 1);
    assert.equal(Float64.intersectsRect(0, 0, 5, 5, 6, 6, 5, 5), 0);
    assert.equal(Float64.intersectsRect(0, 0, 10, 10, 5, 5, 10, 10), 1);
  });

  it('Float64.toRadian', () => {
    assert.equal(Float64.toRadian(180), Math.PI);
    assert.equal(Float64.toRadian(90), Math.PI / 2);
    assert.equal(Float64.toRadian(0), 0);
  });

  it('Float64.toDegrees', () => {
    assert.equal(Float64.toDegrees(Math.PI), 180);
    assert.equal(Float64.toDegrees(Math.PI / 2), 90);
    assert.equal(Float64.toDegrees(0), 0);
  });

  it('Float64.wrapRadians', () => {
    assert.equal(Float64.wrapRadians(Math.PI * 2), 0);
    assert.equal(Float64.wrapRadians(-Math.PI * 2), 0);
    assert.equal(Float64.wrapRadians(Math.PI / 2), Math.PI / 2);
  });

  it('Float64.sinLp', () => {
    assert.equal(Float64.sinLp(0).toFixed(6), '0.000000');
    assert.equal(Float64.sinLp(Math.PI / 2).toFixed(6), '1.000000');
    assert.equal(Float64.sinLp(Math.PI).toFixed(6), '0.000000');
  });

  it('Float64.cosLp', () => {
    assert.equal(Float64.cosLp(0).toFixed(6), '1.000000');
    assert.equal(Float64.cosLp(Math.PI / 2).toFixed(6), '0.000000');
    assert.equal(Float64.cosLp(Math.PI).toFixed(6), '-1.000000');
  });

  it('Float64.sinMp', () => {
    assert.equal(Float64.sinMp(0).toFixed(6), '0.000000');
    assert.equal(Float64.sinMp(Math.PI / 2).toFixed(6), '1.000000');
    assert.equal(Float64.sinMp(Math.PI).toFixed(6), '0.000000');
  });

  it('Float64.cosMp', () => {
    assert.equal(Float64.cosMp(0).toFixed(6), '1.000000');
    assert.equal(Float64.cosMp(Math.PI / 2).toFixed(6), '0.000000');
    assert.equal(Float64.cosMp(Math.PI).toFixed(6), '-1.000000');
  });

  it('Float64.theta', () => {
    assert.equal(Float64.theta(1, 1).toFixed(6), '0.785398');
    assert.equal(Float64.theta(0, 1).toFixed(6), '1.570796');
    assert.equal(Float64.theta(1, 0).toFixed(6), '0.000000');
  });

  it('Float64.angle', () => {
    assert.equal(Float64.angle(1, 1).toFixed(6), '0.785398');
    assert.equal(Float64.angle(0, 1).toFixed(6), '1.570796');
    assert.equal(Float64.angle(1, 0).toFixed(6), '0.000000');
  });

  it('Float64.phi', () => {
    assert.equal(Float64.phi(1, 2).toFixed(6), '0.523599');
    assert.equal(Float64.phi(0, 1).toFixed(6), '0.000000');
    assert.equal(Float64.phi(1, 1).toFixed(6), '1.570796');
  });

});

describe('#remap (interpolation-correct linear remap)', function () {

  it('remaps across ranges linearly', () => {
    assert.equal(remap(5, 0, 10, 0, 100), 50);
    assert.equal(remap(0, 0, 10, 0, 100), 0);
    assert.equal(remap(10, 0, 10, 0, 100), 100);
    assert.equal(remap(2.5, 0, 10, 0, 100), 25);
  });

  it('handles inverted destination ranges (screen y-flip)', () => {
    assert.equal(remap(0, 0, 1, 100, 0), 100);
    assert.equal(remap(1, 0, 1, 100, 0), 0);
    assert.equal(remap(0.5, 0, 1, 100, 0), 50);
  });

  it('extrapolates outside the source range', () => {
    assert.equal(remap(20, 0, 10, 0, 100), 200);
    assert.equal(remap(-5, 0, 10, 0, 100), -50);
  });

  it('collapses a degenerate source range to dmin', () => {
    assert.equal(remap(5, 3, 3, 7, 9), 7);
  });

  it('differs from the legacy quirky Float64.map when dmin != 0', () => {
    // Float64.map composes the non-standard lerp `(max-min)*(norm+min)`;
    // remap is the standard `dmin + t*(dmax-dmin)`. With dmin=10 they part.
    assert.equal(remap(5, 0, 10, 10, 20), 15);
    assert.equal(Float64.map(5, 0, 10, 10, 20), 105);
  });

});
