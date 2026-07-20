import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  npv, irr, mirr, xnpv, xirr,
  amortizationSchedule,
  simpleInterest, compoundInterest, compoundAmount,
  nominalToEffective, effectiveToNominal, continuousCompound,
  straightLine, decliningBalance, sumOfYearsDigits,
  bondPrice, bondYTM, macaulayDuration, modifiedDuration, convexity,
} from '@jarenjs/core/finance';

const close = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) <= eps, `${a} !~= ${b}`);

describe('#finance cash-flow (A-fin)', function () {
  it('npv vs textbook', () => {
    // rate 10%, flows -1000, 500, 400, 300, 100 → ~78.82
    close(npv(0.1, [-1000, 500, 400, 300, 100]), 78.8199, 1e-3);
  });

  it('irr zeroes npv', () => {
    const flows = [-1000, 500, 400, 300, 100];
    const r = irr(flows);
    close(r, 0.1448884, 1e-4);
    close(npv(r, flows), 0, 1e-6);
  });

  it('mirr', () => {
    close(mirr([-1000, 500, 400, 300, 100], 0.1, 0.12), 0.1316856, 1e-4);
  });

  it('xirr makes xnpv vanish', () => {
    const flows = [-1000, 1100];
    const dates = [new Date('2020-01-01'), new Date('2021-01-01')];
    const r = xirr(flows, dates);
    close(r, 0.0997, 1e-3);
    close(xnpv(r, flows, dates), 0, 1e-4);
  });
});

describe('#finance amortization (A-fin)', function () {
  it('schedule fully amortizes to zero', () => {
    const rows = amortizationSchedule(1000, 0.01, 12);
    assert.equal(rows.length, 12);
    close(rows[rows.length - 1].balance, 0, 1e-6);
    // interest + principal ≈ payment each period
    for (const row of rows) close(row.interest + row.principal, row.payment, 1e-6);
    // total principal repaid equals the loan
    const totalPrincipal = rows.reduce((a, r) => a + r.principal, 0);
    close(totalPrincipal, 1000, 1e-6);
  });
});

describe('#finance interest (A-fin)', function () {
  it('simple + compound', () => {
    close(simpleInterest(1000, 0.05, 3), 150, 1e-9);
    close(compoundAmount(1000, 0.05, 3, 1), 1157.625, 1e-3);
    close(compoundInterest(1000, 0.05, 3, 1), 157.625, 1e-3);
  });
  it('nominal ↔ effective round-trip', () => {
    const eff = nominalToEffective(0.12, 12);
    close(eff, 0.12682503, 1e-6);
    close(effectiveToNominal(eff, 12), 0.12, 1e-9);
  });
  it('continuous compounding', () => {
    close(continuousCompound(1000, 0.05, 3), 1000 * Math.exp(0.15), 1e-6);
  });
});

describe('#finance depreciation (A-fin)', function () {
  it('straight-line', () => {
    const s = straightLine(10000, 1000, 5);
    assert.equal(s.length, 5);
    for (const d of s) close(d, 1800, 1e-9);
    close(s.reduce((a, b) => a + b, 0), 9000, 1e-9);
  });
  it('double-declining never dips below salvage', () => {
    const d = decliningBalance(10000, 1000, 5, 2);
    close(d[0], 4000, 1e-6);
    const total = d.reduce((a, b) => a + b, 0);
    assert.ok(total <= 9000 + 1e-6);
  });
  it('sum-of-years-digits', () => {
    const d = sumOfYearsDigits(10000, 1000, 5);
    close(d[0], 3000, 1e-6);     // 5/15 * 9000
    close(d.reduce((a, b) => a + b, 0), 9000, 1e-6);
  });
});

describe('#finance bond (A-fin)', function () {
  it('price at par when ytm == coupon', () => {
    close(bondPrice(1000, 0.05, 0.05, 10, 2), 1000, 1e-6);
  });
  it('price below par when ytm > coupon', () => {
    assert.ok(bondPrice(1000, 0.05, 0.06, 10, 2) < 1000);
  });
  it('ytm inverts price', () => {
    const price = bondPrice(1000, 0.05, 0.06, 10, 2);
    close(bondYTM(price, 1000, 0.05, 10, 2), 0.06, 1e-5);
  });
  it('durations + convexity are positive and ordered', () => {
    const mac = macaulayDuration(1000, 0.05, 0.05, 10, 2);
    const mod = modifiedDuration(1000, 0.05, 0.05, 10, 2);
    assert.ok(mac > 0 && mod > 0 && mod < mac);
    assert.ok(convexity(1000, 0.05, 0.05, 10, 2) > 0);
  });
});
