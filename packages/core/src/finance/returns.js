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
