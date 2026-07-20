//@ts-check
/**
 * @file Time Value of Money (Part A-fin). The five TVM quantities — N,
 * I/Y, PV, PMT, FV — obey one identity; each function here solves for its
 * own variable. Sign convention follows the standard cash-flow model
 * (money in is positive, money out negative), matching Excel/HP-12C:
 *
 *   PV·(1+i)^n + PMT·(1 + i·type)·((1+i)^n − 1)/i + FV = 0
 *
 * `type` is 0 for an ordinary annuity (payment at period end) or 1 for an
 * annuity-due (payment at period begin). Rates are per period; a caller
 * with an annual rate and monthly periods passes `rate/12`.
 *
 * Pure and zero-dep except `math/solve` for the iterative `rate`.
 */

import { newtonRaphson, bisect } from '../math/solve.js';

/**
 * Future value.
 * @param {number} rate @param {number} nper @param {number} pmt
 * @param {number} [pv] @param {number} [type]
 * @returns {number}
 */
export function fv(rate, nper, pmt, pv = 0, type = 0) {
  if (rate === 0) return -(pv + pmt * nper);
  const g = Math.pow(1 + rate, nper);
  return -(pv * g + pmt * (1 + rate * type) * (g - 1) / rate);
}

/**
 * Present value.
 * @param {number} rate @param {number} nper @param {number} pmt
 * @param {number} [fval] @param {number} [type]
 * @returns {number}
 */
export function pv(rate, nper, pmt, fval = 0, type = 0) {
  if (rate === 0) return -(fval + pmt * nper);
  const g = Math.pow(1 + rate, nper);
  return -(fval + pmt * (1 + rate * type) * (g - 1) / rate) / g;
}

/**
 * Payment per period.
 * @param {number} rate @param {number} nper @param {number} pval
 * @param {number} [fval] @param {number} [type]
 * @returns {number}
 */
export function pmt(rate, nper, pval, fval = 0, type = 0) {
  if (nper === 0) return NaN;
  if (rate === 0) return -(pval + fval) / nper;
  const g = Math.pow(1 + rate, nper);
  return -(pval * g + fval) / ((1 + rate * type) * (g - 1) / rate);
}

/**
 * Number of periods.
 * @param {number} rate @param {number} pmtv @param {number} pval
 * @param {number} [fval] @param {number} [type]
 * @returns {number}
 */
export function nper(rate, pmtv, pval, fval = 0, type = 0) {
  if (rate === 0) {
    if (pmtv === 0) return NaN;
    return -(pval + fval) / pmtv;
  }
  const a = pmtv * (1 + rate * type);
  const num = a - fval * rate;
  const den = a + pval * rate;
  return Math.log(num / den) / Math.log(1 + rate);
}

/**
 * Periodic interest rate, solved iteratively (Newton, bisection
 * fallback). Returns `NaN` if no rate is found.
 * @param {number} nperv @param {number} pmtv @param {number} pval
 * @param {number} [fval] @param {number} [type] @param {number} [guess]
 * @returns {number}
 */
export function rate(nperv, pmtv, pval, fval = 0, type = 0, guess = 0.1) {
  const f = (r) => {
    if (r === 0) return pval + pmtv * nperv + fval;
    const g = Math.pow(1 + r, nperv);
    return pval * g + pmtv * (1 + r * type) * (g - 1) / r + fval;
  };
  const df = (r) => {
    const h = 1e-6;
    return (f(r + h) - f(r - h)) / (2 * h);
  };
  const n = newtonRaphson(f, df, guess, { tol: 1e-9, maxIter: 100 });
  if (n.converged && isFinite(n.root)) return n.root;
  const b = bisect(f, -0.9999, 1e6, { tol: 1e-9, maxIter: 200 });
  return b.converged ? b.root : NaN;
}
