//@ts-check
/**
 * @file Return & risk statistics: CAGR, holding-period
 * return, volatility, Sharpe ratio and maximum drawdown. Pure.
 */

/**
 * Compound annual growth rate.
 * @param {number} begin @param {number} end @param {number} years
 * @returns {number}
 */
export function cagr(begin, end, years) {
  if (begin <= 0 || years <= 0) return NaN;
  return Math.pow(end / begin, 1 / years) - 1;
}

/**
 * Holding-period return, including any income.
 * @param {number} begin @param {number} end @param {number} [income]
 * @returns {number}
 */
export function holdingPeriodReturn(begin, end, income = 0) {
  if (begin === 0) return NaN;
  return (end - begin + income) / begin;
}

/**
 * Convert a price series to a per-step simple-return series.
 * @param {ArrayLike<number>} prices
 * @returns {number[]}
 */
export function returnsOf(prices) {
  const out = [];
  for (let i = 1; i < prices.length; i++) {
    out.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }
  return out;
}

/**
 * Volatility: the (sample) standard deviation of a return series.
 * @param {ArrayLike<number>} returns
 * @param {boolean} [population] use population (÷N) instead of sample (÷N−1)
 * @returns {number}
 */
export function volatility(returns, population = false) {
  const n = returns.length;
  if (n < 2) return 0;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += returns[i];
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) variance += (returns[i] - mean) ** 2;
  return Math.sqrt(variance / (population ? n : n - 1));
}

/**
 * Sharpe ratio: mean excess return over its volatility.
 * @param {ArrayLike<number>} returns
 * @param {number} [riskFree] per-step risk-free rate
 * @returns {number}
 */
export function sharpe(returns, riskFree = 0) {
  const n = returns.length;
  if (n === 0) return NaN;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += returns[i];
  mean /= n;
  const vol = volatility(returns);
  return vol === 0 ? NaN : (mean - riskFree) / vol;
}

/**
 * Maximum drawdown of an equity curve: the largest peak-to-trough drop as
 * a positive fraction (0.2 = a 20% drawdown).
 * @param {ArrayLike<number>} values
 * @returns {number}
 */
export function maxDrawdown(values) {
  let peak = -Infinity;
  let maxDd = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] > peak) peak = values[i];
    if (peak > 0) {
      const dd = (peak - values[i]) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

function returnInputs(returns, periodsPerYear = 1) {
  if (!Number.isFinite(periodsPerYear) || periodsPerYear <= 0) throw new RangeError('periodsPerYear must be positive and finite');
  if (!Number.isSafeInteger(returns?.length) || returns.length < 0) throw new TypeError('returns must be array-like');
  for (let i = 0; i < returns.length; i++) if (!Number.isFinite(returns[i]) || returns[i] < -1)
    throw new RangeError('simple returns must be finite and at least -1');
}

/** Compound simple returns to a year of the declared length; empty is NaN.
 * @param {ArrayLike<number>} returns @param {number} periodsPerYear @returns {number} */
export function annualizedReturn(returns, periodsPerYear) {
  returnInputs(returns, periodsPerYear);
  if (!returns.length) return NaN;
  let growth = 1;
  for (let i = 0; i < returns.length; i++) growth *= 1 + returns[i];
  return Math.pow(growth, periodsPerYear / returns.length) - 1;
}

/** Mean excess return / downside RMS over ALL periods, scaled by sqrt(periodsPerYear).
 * Target is per-step. Empty/no downside is NaN, not an infinite score.
 * @param {ArrayLike<number>} returns @param {number} [target] @param {number} [periodsPerYear]
 * @returns {number} */
export function sortino(returns, target = 0, periodsPerYear = 1) {
  returnInputs(returns, periodsPerYear);
  if (!Number.isFinite(target)) throw new TypeError('Sortino target must be finite');
  let excess = 0, downside = 0;
  for (let i = 0; i < returns.length; i++) {
    const value = returns[i] - target;
    excess += value; downside += Math.min(value, 0) ** 2;
  }
  return !returns.length || downside === 0 ? NaN : (excess / returns.length) / Math.sqrt(downside / returns.length) * Math.sqrt(periodsPerYear);
}

/** Annualized compound return / drawdown of equity seeded at one.
 * @param {ArrayLike<number>} returns @param {number} periodsPerYear @returns {number} */
export function calmar(returns, periodsPerYear) {
  returnInputs(returns, periodsPerYear);
  const equity = [1];
  for (let i = 0; i < returns.length; i++) equity.push(equity.at(-1) * (1 + returns[i]));
  const drawdown = maxDrawdown(equity);
  return drawdown === 0 ? NaN : annualizedReturn(returns, periodsPerYear) / drawdown;
}

/** Sample covariance with an aligned benchmark / benchmark sample variance.
 * @param {ArrayLike<number>} returns @param {ArrayLike<number>} benchmark @returns {number} */
export function beta(returns, benchmark) {
  returnInputs(returns); returnInputs(benchmark);
  if (returns.length !== benchmark.length) throw new RangeError('beta requires aligned return series');
  if (returns.length < 2) return NaN;
  let a = 0, b = 0;
  for (let i = 0; i < returns.length; i++) { a += returns[i]; b += benchmark[i]; }
  a /= returns.length; b /= returns.length;
  let covariance = 0, variance = 0;
  for (let i = 0; i < returns.length; i++) {
    covariance += (returns[i] - a) * (benchmark[i] - b); variance += (benchmark[i] - b) ** 2;
  }
  return variance === 0 ? NaN : covariance / variance;
}
