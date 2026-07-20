//@ts-check
/**
 * @file Bond math (Part A-fin): price, yield-to-maturity, Macaulay and
 * modified duration, and convexity. Basic day-count only (level coupons,
 * whole periods to maturity); exotic conventions are out of scope.
 *
 * Rates and the coupon rate are annual; `freq` coupons are paid per year.
 */

import { newtonRaphson, bisect } from '../math/solve.js';

/**
 * Clean price of a coupon bond.
 * @param {number} face par/redemption value
 * @param {number} couponRate annual coupon rate
 * @param {number} ytm annual yield to maturity
 * @param {number} years years to maturity
 * @param {number} [freq] coupons per year
 * @returns {number}
 */
export function bondPrice(face, couponRate, ytm, years, freq = 2) {
  const n = Math.round(years * freq);
  const c = face * couponRate / freq;
  const y = ytm / freq;
  let price = 0;
  for (let t = 1; t <= n; t++) price += c / Math.pow(1 + y, t);
  price += face / Math.pow(1 + y, n);
  return price;
}

/**
 * Yield to maturity from a market price (iterative).
 * @param {number} price @param {number} face @param {number} couponRate
 * @param {number} years @param {number} [freq]
 * @returns {number}
 */
export function bondYTM(price, face, couponRate, years, freq = 2) {
  const f = (y) => bondPrice(face, couponRate, y, years, freq) - price;
  const df = (y) => {
    const h = 1e-6;
    return (f(y + h) - f(y - h)) / (2 * h);
  };
  const n = newtonRaphson(f, df, couponRate || 0.05, { tol: 1e-9, maxIter: 100 });
  if (n.converged && isFinite(n.root) && n.root > -1) return n.root;
  const b = bisect(f, -0.9999, 5, { tol: 1e-9, maxIter: 300 });
  return b.converged ? b.root : NaN;
}

/**
 * Macaulay duration (in years).
 * @param {number} face @param {number} couponRate @param {number} ytm
 * @param {number} years @param {number} [freq]
 * @returns {number}
 */
export function macaulayDuration(face, couponRate, ytm, years, freq = 2) {
  const n = Math.round(years * freq);
  const c = face * couponRate / freq;
  const y = ytm / freq;
  let weighted = 0;
  let price = 0;
  for (let t = 1; t <= n; t++) {
    const cf = t === n ? c + face : c;
    const dpv = cf / Math.pow(1 + y, t);
    price += dpv;
    weighted += t * dpv;
  }
  return (weighted / price) / freq;
}

/**
 * Modified duration.
 * @param {number} face @param {number} couponRate @param {number} ytm
 * @param {number} years @param {number} [freq]
 * @returns {number}
 */
export function modifiedDuration(face, couponRate, ytm, years, freq = 2) {
  const mac = macaulayDuration(face, couponRate, ytm, years, freq);
  return mac / (1 + ytm / freq);
}

/**
 * Convexity (in years²).
 * @param {number} face @param {number} couponRate @param {number} ytm
 * @param {number} years @param {number} [freq]
 * @returns {number}
 */
export function convexity(face, couponRate, ytm, years, freq = 2) {
  const n = Math.round(years * freq);
  const c = face * couponRate / freq;
  const y = ytm / freq;
  let price = 0;
  let cx = 0;
  for (let t = 1; t <= n; t++) {
    const cf = t === n ? c + face : c;
    const dpv = cf / Math.pow(1 + y, t);
    price += dpv;
    cx += dpv * t * (t + 1);
  }
  return (cx / (price * Math.pow(1 + y, 2))) / (freq * freq);
}
