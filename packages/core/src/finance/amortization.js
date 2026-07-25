//@ts-check
/**
 * @file Loan amortization. Given a principal, a periodic
 * rate and a term, produce the period-by-period split of each payment
 * into interest and principal with the running balance.
 */

import { pmt as tvmPmt } from './tvm.js';

/**
 * @typedef {object} AmortRow
 * @property {number} period 1-based period index
 * @property {number} payment total payment this period
 * @property {number} interest interest portion
 * @property {number} principal principal portion
 * @property {number} balance remaining balance after this payment
 */

/**
 * Build a full amortization schedule. The payment is derived from the
 * standard annuity formula unless an explicit `payment` is supplied
 * (e.g. a rounded real-world instalment); the final period absorbs any
 * rounding residue so the balance lands exactly on zero.
 *
 * @param {number} principal loan amount (positive)
 * @param {number} rate periodic interest rate
 * @param {number} nper number of periods
 * @param {{ payment?: number, type?: number }} [opts]
 * @returns {AmortRow[]}
 */
export function amortizationSchedule(principal, rate, nper, opts = {}) {
  const type = opts.type ?? 0;
  const payment = opts.payment ?? -tvmPmt(rate, nper, principal, 0, type);
  const rows = [];
  let balance = principal;
  for (let period = 1; period <= nper; period++) {
    const interest = balance * rate;
    let principalPart = payment - interest;
    let pay = payment;
    if (period === nper) {
      // clear any residual balance on the last row
      principalPart = balance;
      pay = balance + interest;
    }
    balance -= principalPart;
    if (Math.abs(balance) < 1e-9) balance = 0;
    rows.push({ period, payment: pay, interest, principal: principalPart, balance });
  }
  return rows;
}
