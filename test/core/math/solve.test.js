import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newtonRaphson, bisect, secant } from '@jarenjs/core/math';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~= ${b}`);

describe('#numeric root finders (A3)', function () {
  // f(x) = x^2 - 2  → root sqrt(2)
  const f = (x) => x * x - 2;
  const df = (x) => 2 * x;

  it('newtonRaphson finds a known root', () => {
    const r = newtonRaphson(f, df, 1);
    assert.ok(r.converged);
    close(r.root, Math.SQRT2);
  });

  it('newtonRaphson guards a zero derivative away from the root', () => {
    // df(x)=2x vanishes at x=0 while f(0)=-2 ≠ 0 → cannot step, not converged
    const r = newtonRaphson(f, df, 0, { maxIter: 5 });
    assert.equal(r.converged, false);
  });

  it('bisect finds a bracketed root', () => {
    const r = bisect(f, 0, 2);
    assert.ok(r.converged);
    close(r.root, Math.SQRT2, 1e-6);
  });

  it('bisect rejects a non-bracketing interval', () => {
    const r = bisect(f, 2, 3);   // both positive
    assert.equal(r.converged, false);
  });

  it('secant converges without a derivative', () => {
    const r = secant(f, 1, 2);
    assert.ok(r.converged);
    close(r.root, Math.SQRT2);
  });

  it('non-convergence guard caps iterations', () => {
    const r = newtonRaphson((x) => Math.exp(x) + 1, (x) => Math.exp(x), 0, { maxIter: 8 });
    assert.equal(r.iterations <= 8, true);
  });
});
