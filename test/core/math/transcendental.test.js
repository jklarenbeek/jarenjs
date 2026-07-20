import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mathf64_E, mathf64_LN2, mathf64_LN10, mathf64_PHI,
  mathf64_log, mathf64_log2, mathf64_log10, mathf64_exp, mathf64_expm1,
  mathf64_tan, mathf64_acos, mathf64_atan, mathf64_sinh, mathf64_cosh,
  mathf64_tanh, mathf64_cbrt,
  Float64,
} from '@jarenjs/core/math';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~= ${b}`);

describe('#Float64 transcendental completeness (A1)', function () {
  it('exposes constants', () => {
    close(mathf64_E, Math.E);
    close(mathf64_LN2, Math.LN2);
    close(mathf64_LN10, Math.LN10);
    close(mathf64_PHI, (1 + Math.sqrt(5)) / 2);
  });

  it('aliases match Math.*', () => {
    close(mathf64_log(Math.E), 1);
    close(mathf64_log2(8), 3);
    close(mathf64_log10(1000), 3);
    close(mathf64_exp(0), 1);
    close(mathf64_expm1(0), 0);
    close(mathf64_tan(0), 0);
    close(mathf64_acos(1), 0);
    close(mathf64_atan(1), Math.PI / 4);
    close(mathf64_sinh(0), 0);
    close(mathf64_cosh(0), 1);
    close(mathf64_tanh(0), 0);
    close(mathf64_cbrt(27), 3);
  });

  it('logBase', () => {
    close(Float64.logBase(2, 8), 3);
    close(Float64.logBase(10, 1000), 3);
  });

  it('sign', () => {
    assert.equal(Float64.sign(-5), -1);
    assert.equal(Float64.sign(5), 1);
    assert.equal(Float64.sign(0), 0);
  });

  it('hypot', () => {
    close(Float64.hypot(3, 4), 5);
    close(Float64.hypot(1, 2, 2), 3);
  });

  it('nthroot handles odd roots of negatives', () => {
    close(Float64.nthroot(27, 3), 3);
    close(Float64.nthroot(-27, 3), -3);
    close(Float64.nthroot(16, 4), 2);
  });

  it('roundTo boundaries', () => {
    close(Float64.roundTo(3.14159, 2), 3.14);
    close(Float64.roundTo(2.5, 0), 3);
    close(Float64.roundTo(1234.5678, -0), 1235);
    assert.equal(Float64.roundTo(Infinity, 2), Infinity);
  });

  it('factorial (integer + gamma bridge)', () => {
    assert.equal(Float64.factorial(0), 1);
    assert.equal(Float64.factorial(5), 120);
    assert.equal(Float64.factorial(10), 3628800);
    assert.ok(Number.isNaN(Float64.factorial(-2)));
    // 0.5! = sqrt(pi)/2
    close(Float64.factorial(0.5), Math.sqrt(Math.PI) / 2, 1e-6);
  });

  it('gamma spot checks', () => {
    close(Float64.gamma(5), 24, 1e-6);      // (n-1)!
    close(Float64.gamma(0.5), Math.sqrt(Math.PI), 1e-6);
    close(Float64.gamma(1), 1, 1e-9);
  });

  it('cosHp is implemented and approximates cos', () => {
    for (const r of [0, 0.5, 1, Math.PI / 2, Math.PI, -1]) {
      close(Float64.cosHp(r), Math.cos(r), 2e-3);
    }
  });
});
