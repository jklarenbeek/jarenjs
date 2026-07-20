//@ts-check
/**
 * @file Cash-flow analysis (Part A-fin): NPV, IRR, MIRR and their
 * date-indexed variants XNPV/XIRR. Built on `math/solve`. Cash flows are
 * arrays with element `t` occurring at period `t` (index 0 = now).
 */

import { newtonRaphson, bisect } from '../math/solve.js';

const MS_PER_DAY = 86400000;
const DAYS_PER_YEAR = 365;

/**
 * Net present value of a period-indexed cash-flow series.
 * @param {number} rate discount rate per period
 * @param {number[]} cashflows cashflows[t] at period t (index 0 = t0)
 * @returns {number}
 */
export function npv(rate, cashflows) {
  let acc = 0;
  for (let t = 0; t < cashflows.length; t++) {
    acc += cashflows[t] / Math.pow(1 + rate, t);
  }
  return acc;
}

/**
 * Internal rate of return: the rate for which `npv` is zero. Newton with
 * a bisection fallback; returns `NaN` if no rate is found.
 * @param {number[]} cashflows
 * @param {number} [guess]
 * @returns {number}
 */
export function irr(cashflows, guess = 0.1) {
  const f = (r) => npv(r, cashflows);
  const df = (r) => {
    let acc = 0;
    for (let t = 1; t < cashflows.length; t++) {
      acc += -t * cashflows[t] / Math.pow(1 + r, t + 1);
    }
    return acc;
  };
  const n = newtonRaphson(f, df, guess, { tol: 1e-9, maxIter: 100 });
  if (n.converged && isFinite(n.root) && n.root > -1) return n.root;
  const b = bisect(f, -0.999999, 1e6, { tol: 1e-9, maxIter: 300 });
  return b.converged ? b.root : NaN;
}

/**
 * Modified internal rate of return.
 * @param {number[]} cashflows
 * @param {number} financeRate rate paid on negative flows
 * @param {number} reinvestRate rate earned on positive flows
 * @returns {number}
 */
export function mirr(cashflows, financeRate, reinvestRate) {
  const n = cashflows.length - 1;
  let pvNeg = 0;
  let fvPos = 0;
  for (let t = 0; t < cashflows.length; t++) {
    const cf = cashflows[t];
    if (cf < 0) pvNeg += cf / Math.pow(1 + financeRate, t);
    else fvPos += cf * Math.pow(1 + reinvestRate, n - t);
  }
  if (pvNeg === 0 || fvPos === 0) return NaN;
  return Math.pow(-fvPos / pvNeg, 1 / n) - 1;
}

/**
 * Convert an array of dates (Date, ms timestamp, or day number) to year
 * fractions from the first date.
 * @param {Array<Date|number>} dates
 * @returns {number[]}
 */
function yearFractions(dates) {
  const toMs = (d) => (d instanceof Date ? d.getTime() : d * (typeof d === 'number' && d < 1e6 ? MS_PER_DAY : 1));
  const t0 = toMs(dates[0]);
  return dates.map((d) => (toMs(d) - t0) / MS_PER_DAY / DAYS_PER_YEAR);
}

/**
 * Date-indexed NPV. `dates` may be `Date`s or ms timestamps.
 * @param {number} rate annual discount rate
 * @param {number[]} cashflows
 * @param {Array<Date|number>} dates
 * @returns {number}
 */
export function xnpv(rate, cashflows, dates) {
  const yf = yearFractions(dates);
  let acc = 0;
  for (let i = 0; i < cashflows.length; i++) {
    acc += cashflows[i] / Math.pow(1 + rate, yf[i]);
  }
  return acc;
}

/**
 * Date-indexed IRR.
 * @param {number[]} cashflows
 * @param {Array<Date|number>} dates
 * @param {number} [guess]
 * @returns {number}
 */
export function xirr(cashflows, dates, guess = 0.1) {
  const yf = yearFractions(dates);
  const f = (r) => {
    let acc = 0;
    for (let i = 0; i < cashflows.length; i++) acc += cashflows[i] / Math.pow(1 + r, yf[i]);
    return acc;
  };
  const df = (r) => {
    let acc = 0;
    for (let i = 0; i < cashflows.length; i++) {
      acc += -yf[i] * cashflows[i] / Math.pow(1 + r, yf[i] + 1);
    }
    return acc;
  };
  const n = newtonRaphson(f, df, guess, { tol: 1e-9, maxIter: 100 });
  if (n.converged && isFinite(n.root) && n.root > -1) return n.root;
  const b = bisect(f, -0.999999, 1e6, { tol: 1e-9, maxIter: 300 });
  return b.converged ? b.root : NaN;
}
