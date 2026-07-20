import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pmt, pv, fv, nper, rate } from '@jarenjs/core/finance';

const close = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) <= eps, `${a} !~= ${b}`);

describe('#finance TVM (A-fin)', function () {
  // A $200,000 loan, 30 years monthly, 6%/yr → payment ≈ -1199.10
  const r = 0.06 / 12;
  const n = 360;

  it('pmt matches the textbook mortgage payment', () => {
    close(pmt(r, n, 200000), -1199.101, 1e-3);
  });

  it('the five TVM functions are mutually consistent (identity)', () => {
    const payment = pmt(r, n, 200000);          // negative (cash out)
    close(fv(r, n, payment, 200000), 0, 1e-2);   // loan fully paid
    close(pv(r, n, payment, 0), 200000, 1e-2);
    close(nper(r, payment, 200000, 0), 360, 1e-4);
    close(rate(n, payment, 200000, 0, 0, 0.01), r, 1e-7);
  });

  it('fv of an ordinary annuity', () => {
    // deposit 100/mo, 1%/mo, 12 months → 1268.25
    close(fv(0.01, 12, -100, 0), 1268.250, 1e-2);
  });

  it('annuity-due (type=1) exceeds ordinary by (1+i)', () => {
    const ord = fv(0.01, 12, -100, 0, 0);
    const due = fv(0.01, 12, -100, 0, 1);
    close(due, ord * 1.01, 1e-6);
  });

  it('zero-rate degenerates to linear', () => {
    close(pmt(0, 10, 1000), -100, 1e-9);
    close(fv(0, 10, -100, 0), 1000, 1e-9);
    close(nper(0, -100, 1000, 0), 10, 1e-9);
  });
});
