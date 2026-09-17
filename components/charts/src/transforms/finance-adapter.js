//@ts-check
/** OHLC/volume samples to ordinary chart pairs and explicit-period risk summaries. */
import { adx, cci, vwap, obv, volumeRatio, kdj, williamsR,
  returnsOf, annualizedReturn, sortino, calmar, beta } from '@jarenjs/core/finance';

/**
 * Each indicator keeps its own units/chart. Warm-up points are omitted;
 * input timestamps are copied, never inferred from a market calendar.
 * @param {readonly { t: number, high: number, low: number, close: number, volume: number }[]} samples
 * @param {{ periodsPerYear: number, period?: number, signalPeriod?: number,
 *   sessions?: boolean[], target?: number, benchmark?: ArrayLike<number> }} options
 */
export function financeCharts(samples, options) {
  if (samples.some(row => !Number.isFinite(row.t) || !(row.close > 0)))
    throw new TypeError('financial charts need finite timestamps and positive closes');
  const high = samples.map(row => row.high), low = samples.map(row => row.low);
  const close = samples.map(row => row.close), volume = samples.map(row => row.volume);
  const period = options.period ?? 14, directional = adx(high, low, close, period);
  const stochastic = kdj(high, low, close, period, options.signalPeriod ?? 3);
  const indicators = { ADX: directional.adx, '+DI': directional.plusDI, '-DI': directional.minusDI,
    CCI: cci(high, low, close, period), VWAP: vwap(high, low, close, volume, options.sessions),
    OBV: obv(close, volume), 'Volume ratio': volumeRatio(volume, period),
    K: stochastic.k, D: stochastic.d, J: stochastic.j, 'Williams R': williamsR(high, low, close, period) };
  const charts = Object.fromEntries(Object.entries(indicators).map(([name, values]) => [name, {
    config: { type: 'line', title: name }, data: { series: [{ name,
      points: values.flatMap((value, i) => value === null ? [] : [{ x: samples[i].t, y: value }]) }] },
  }]));
  const returns = returnsOf(close);
  const risk = { annualizedReturn: annualizedReturn(returns, options.periodsPerYear),
    sortino: sortino(returns, options.target ?? 0, options.periodsPerYear),
    calmar: calmar(returns, options.periodsPerYear),
    ...(options.benchmark === undefined ? {} : { beta: beta(returns, options.benchmark) }) };
  return { charts, risk };
}
