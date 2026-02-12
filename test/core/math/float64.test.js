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
} from '@jarenjs/core/calc'
  //from '../../../packages/core/src/calc/float64.js';

describe('#Mathf64 primitives', function () {

  it('mathf64_abs', (t) => {
    assert.equal(mathf64_abs(-5), 5);
    assert.equal(mathf64_abs(5), 5);
    assert.equal(mathf64_abs(0), 0);
  });

  it('mathf64_sqrt', (t) => {
    assert.equal(mathf64_sqrt(4), 2);
    assert.equal(mathf64_sqrt(9), 3);
    assert.equal(mathf64_sqrt(0), 0);
  });

  it('mathf64_pow', (t) => {
    assert.equal(mathf64_pow(2, 3), 8);
    assert.equal(mathf64_pow(3, 2), 9);
    assert.equal(mathf64_pow(5, 0), 1);
  });

  it.skip('mathf64_sin', (t) => {
    assert.equal(mathf64_sin(Math.PI / 2), 1);
    assert.equal(mathf64_sin(Math.PI), 0);
    assert.equal(mathf64_sin(0), 0);
  });

  it.skip('mathf64_cos', (t) => {
    assert.equal(mathf64_cos(0), 1);
    assert.equal(mathf64_cos(Math.PI), -1);
    assert.equal(mathf64_cos(Math.PI / 2), 0);
  });

  it('mathf64_atan2', (t) => {
    assert.equal(mathf64_atan2(1, 1), Math.PI / 4);
    assert.equal(mathf64_atan2(0, 1), 0);
    assert.equal(mathf64_atan2(1, 0), Math.PI / 2);
  });

  it('mathf64_asin', (t) => {
    assert.equal(mathf64_asin(0), 0);
    assert.equal(mathf64_asin(1), Math.PI / 2);
    assert.equal(mathf64_asin(-1), -Math.PI / 2);
  });

  it('mathf64_ceil', (t) => {
    assert.equal(mathf64_ceil(3.1), 4);
    assert.equal(mathf64_ceil(3.9), 4);
    assert.equal(mathf64_ceil(-3.1), -3);
  });

  it('mathf64_floor', (t) => {
    assert.equal(mathf64_floor(3.1), 3);
    assert.equal(mathf64_floor(3.9), 3);
    assert.equal(mathf64_floor(-3.1), -4);
  });

  it('mathf64_round', (t) => {
    assert.equal(mathf64_round(3.1), 3);
    assert.equal(mathf64_round(3.5), 4);
    assert.equal(mathf64_round(-3.5), -3);
  });

  it('mathf64_min', (t) => {
    assert.equal(mathf64_min(3, 5), 3);
    assert.equal(mathf64_min(-3, 5), -3);
    assert.equal(mathf64_min(3, 3), 3);
  });

  it('mathf64_max', (t) => {
    assert.equal(mathf64_max(3, 5), 5);
    assert.equal(mathf64_max(-3, 5), 5);
    assert.equal(mathf64_max(3, 3), 3);
  });

  it('mathf64_random', (t) => {
    const random = mathf64_random();
    assert(random >= 0 && random < 1);
  });

});

describe('#Float64 primitives', function () {

  it('Float64.gcd', (t) => {
    assert.equal(Float64.gcd(48, 18), 6);
    assert.equal(Float64.gcd(100, 75), 25);
    assert.equal(Float64.gcd(17, 23), 1);
  });

  it('Float64.sqrt', (t) => {
    assert.equal(Float64.sqrt(4), 2);
    assert.equal(Float64.sqrt(9), 3);
    assert.equal(Float64.sqrt(0), 0);
  });

  it('Float64.cross', (t) => {
    assert.equal(Float64.cross(1, 2, 3, 4), -2);
    assert.equal(Float64.cross(0, 1, 1, 0), -1);
    assert.equal(Float64.cross(2, 3, 4, 5), -2);
  });

  it('Float64.dot', (t) => {
    assert.equal(Float64.dot(1, 2, 3, 4), 11);
    assert.equal(Float64.dot(0, 1, 1, 0), 0);
    assert.equal(Float64.dot(2, 3, 4, 5), 23);
  });

  it('Float64.mag2', (t) => {
    assert.equal(Float64.mag2(3, 4), 25);
    assert.equal(Float64.mag2(0, 5), 25);
    assert.equal(Float64.mag2(1, 1), 2);
  });

  it('Float64.mag', (t) => {
    assert.equal(Float64.mag(3, 4), 5);
    assert.equal(Float64.mag(0, 5), 5);
    assert.equal(Float64.mag(1, 1), Math.sqrt(2));
  });

  it.skip('Float64.isqrt', (t) => {
    assert.equal(Float64.isqrt(4).toFixed(6), '0.500000');
    assert.equal(Float64.isqrt(9).toFixed(6), '0.333333');
    assert.equal(Float64.isqrt(1).toFixed(6), '1.000000');
  });

  it.skip('Float64.fib', (t) => {
    assert.equal(Float64.fib(0), 0);
    assert.equal(Float64.fib(1), 1);
    assert.equal(Float64.fib(10), 55);
  });

  it('Float64.fib2', (t) => {
    assert.equal(Float64.fib2(0), 0);
    assert.equal(Float64.fib2(1), 1);
    assert.equal(Float64.fib2(10), 55);
  });

  it('Float64.norm', (t) => {
    assert.equal(Float64.norm(5, 0, 10), 0.5);
    assert.equal(Float64.norm(0, 0, 10), 0);
    assert.equal(Float64.norm(10, 0, 10), 1);
  });

  it('Float64.lerp', (t) => {
    assert.equal(Float64.lerp(0.5, 0, 10), 5);
    assert.equal(Float64.lerp(0, 0, 10), 0);
    assert.equal(Float64.lerp(1, 0, 10), 10);
  });

  it('Float64.map', (t) => {
    assert.equal(Float64.map(5, 0, 10, 0, 100), 50);
    assert.equal(Float64.map(0, 0, 10, 0, 100), 0);
    assert.equal(Float64.map(10, 0, 10, 0, 100), 100);
  });

  it('Float64.clamp', (t) => {
    assert.equal(Float64.clamp(5, 0, 10), 5);
    assert.equal(Float64.clamp(-5, 0, 10), 0);
    assert.equal(Float64.clamp(15, 0, 10), 10);
  });

  it('Float64.clampu', (t) => {
    assert.equal(Float64.clampu(5, 0, 10), 5);
    assert.equal(Float64.clampu(-5, 0, 10), 0);
    assert.equal(Float64.clampu(15, 0, 10), 10);
  });

  it('Float64.inRange', (t) => {
    assert.equal(Float64.inRange(5, 0, 10), 1);
    assert.equal(Float64.inRange(-5, 0, 10), 0);
    assert.equal(Float64.inRange(15, 0, 10), 0);
  });

  it('Float64.intersectsRange', (t) => {
    assert.equal(Float64.intersectsRange(0, 5, 3, 8), 1);
    assert.equal(Float64.intersectsRange(0, 2, 3, 5), 0);
    assert.equal(Float64.intersectsRange(0, 10, 5, 15), 1);
  });

  it('Float64.intersectsRect', (t) => {
    assert.equal(Float64.intersectsRect(0, 0, 5, 5, 3, 3, 5, 5), 1);
    assert.equal(Float64.intersectsRect(0, 0, 5, 5, 6, 6, 5, 5), 0);
    assert.equal(Float64.intersectsRect(0, 0, 10, 10, 5, 5, 10, 10), 1);
  });

  it('Float64.toRadian', (t) => {
    assert.equal(Float64.toRadian(180), Math.PI);
    assert.equal(Float64.toRadian(90), Math.PI / 2);
    assert.equal(Float64.toRadian(0), 0);
  });

  it('Float64.toDegrees', (t) => {
    assert.equal(Float64.toDegrees(Math.PI), 180);
    assert.equal(Float64.toDegrees(Math.PI / 2), 90);
    assert.equal(Float64.toDegrees(0), 0);
  });

  it('Float64.wrapRadians', (t) => {
    assert.equal(Float64.wrapRadians(Math.PI * 2), 0);
    assert.equal(Float64.wrapRadians(-Math.PI * 2), 0);
    assert.equal(Float64.wrapRadians(Math.PI / 2), Math.PI / 2);
  });

  it('Float64.sinLp', (t) => {
    assert.equal(Float64.sinLp(0).toFixed(6), '0.000000');
    assert.equal(Float64.sinLp(Math.PI / 2).toFixed(6), '1.000000');
    assert.equal(Float64.sinLp(Math.PI).toFixed(6), '0.000000');
  });

  it('Float64.cosLp', (t) => {
    assert.equal(Float64.cosLp(0).toFixed(6), '1.000000');
    assert.equal(Float64.cosLp(Math.PI / 2).toFixed(6), '0.000000');
    assert.equal(Float64.cosLp(Math.PI).toFixed(6), '-1.000000');
  });

  it('Float64.sinMp', (t) => {
    assert.equal(Float64.sinMp(0).toFixed(6), '0.000000');
    assert.equal(Float64.sinMp(Math.PI / 2).toFixed(6), '1.000000');
    assert.equal(Float64.sinMp(Math.PI).toFixed(6), '0.000000');
  });

  it('Float64.cosMp', (t) => {
    assert.equal(Float64.cosMp(0).toFixed(6), '1.000000');
    assert.equal(Float64.cosMp(Math.PI / 2).toFixed(6), '0.000000');
    assert.equal(Float64.cosMp(Math.PI).toFixed(6), '-1.000000');
  });

  it('Float64.theta', (t) => {
    assert.equal(Float64.theta(1, 1).toFixed(6), '0.785398');
    assert.equal(Float64.theta(0, 1).toFixed(6), '1.570796');
    assert.equal(Float64.theta(1, 0).toFixed(6), '0.000000');
  });

  it('Float64.angle', (t) => {
    assert.equal(Float64.angle(1, 1).toFixed(6), '0.785398');
    assert.equal(Float64.angle(0, 1).toFixed(6), '1.570796');
    assert.equal(Float64.angle(1, 0).toFixed(6), '0.000000');
  });

  it('Float64.phi', (t) => {
    assert.equal(Float64.phi(1, 2).toFixed(6), '0.523599');
    assert.equal(Float64.phi(0, 1).toFixed(6), '0.000000');
    assert.equal(Float64.phi(1, 1).toFixed(6), '1.570796');
  });

});
