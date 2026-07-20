//@ts-check
/**
 * @file Technical / trading indicators (Part A-fin) over a price or OHLC
 * series. Every function returns an array **aligned** to the input (same
 * length), with `null` in warm-up positions where the indicator is not
 * yet defined. Single-pass where the math allows; `Float64Array` inputs
 * are accepted (array-like reads only).
 */

/**
 * Simple moving average.
 * @param {ArrayLike<number>} values @param {number} period
 * @returns {Array<number|null>}
 */
export function sma(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average (SMA-seeded).
 * @param {ArrayLike<number>} values @param {number} period
 * @returns {Array<number|null>}
 */
export function ema(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (n < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < n; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * Weighted moving average (linear weights 1..period).
 * @param {ArrayLike<number>} values @param {number} period
 * @returns {Array<number|null>}
 */
export function wma(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < n; i++) {
    let acc = 0;
    for (let j = 0; j < period; j++) acc += values[i - period + 1 + j] * (j + 1);
    out[i] = acc / denom;
  }
  return out;
}

/**
 * MACD: line = EMA(fast) − EMA(slow), signal = EMA(line, signalPeriod),
 * histogram = line − signal. Each is an aligned array.
 * @param {ArrayLike<number>} values
 * @param {number} [fast] @param {number} [slow] @param {number} [signalPeriod]
 * @returns {{ macd: Array<number|null>, signal: Array<number|null>, histogram: Array<number|null> }}
 */
export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const ef = ema(values, fast);
  const es = ema(values, slow);
  const line = ef.map((v, i) => (v !== null && es[i] !== null ? v - es[i] : null));
  // signal EMA runs over the defined tail of the MACD line
  const defined = line.filter((v) => v !== null);
  const startIdx = line.findIndex((v) => v !== null);
  const sig = ema(defined, signalPeriod);
  const signal = new Array(values.length).fill(null);
  for (let i = 0; i < sig.length; i++) {
    if (sig[i] !== null) signal[startIdx + i] = sig[i];
  }
  const histogram = line.map((v, i) => (v !== null && signal[i] !== null ? v - signal[i] : null));
  return { macd: line, signal, histogram };
}

/**
 * Relative Strength Index (Wilder's smoothing).
 * @param {ArrayLike<number>} values @param {number} [period]
 * @returns {Array<number|null>}
 */
export function rsi(values, period = 14) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (n <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = values[i] - values[i - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < n; i++) {
    const ch = values[i] - values[i - 1];
    const g = ch >= 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * Bollinger Bands (population standard deviation).
 * @param {ArrayLike<number>} values @param {number} [period] @param {number} [k]
 * @returns {{ middle: Array<number|null>, upper: Array<number|null>, lower: Array<number|null> }}
 */
export function bollinger(values, period = 20, k = 2) {
  const n = values.length;
  const middle = sma(values, period);
  const upper = new Array(n).fill(null);
  const lower = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    const mean = middle[i];
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (values[j] - mean) ** 2;
    const sd = Math.sqrt(variance / period);
    upper[i] = mean + k * sd;
    lower[i] = mean - k * sd;
  }
  return { middle, upper, lower };
}

/**
 * Stochastic oscillator (%K and its %D moving average).
 * @param {ArrayLike<number>} high @param {ArrayLike<number>} low @param {ArrayLike<number>} close
 * @param {number} [kPeriod] @param {number} [dPeriod]
 * @returns {{ k: Array<number|null>, d: Array<number|null> }}
 */
export function stochastic(high, low, close, kPeriod = 14, dPeriod = 3) {
  const n = close.length;
  const k = new Array(n).fill(null);
  for (let i = kPeriod - 1; i < n; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (high[j] > hh) hh = high[j];
      if (low[j] < ll) ll = low[j];
    }
    k[i] = hh === ll ? 100 : (100 * (close[i] - ll)) / (hh - ll);
  }
  const kDefined = k.filter((v) => v !== null);
  const start = k.findIndex((v) => v !== null);
  const dTail = sma(kDefined, dPeriod);
  const d = new Array(n).fill(null);
  for (let i = 0; i < dTail.length; i++) if (dTail[i] !== null) d[start + i] = dTail[i];
  return { k, d };
}

/**
 * Average True Range (Wilder's smoothing).
 * @param {ArrayLike<number>} high @param {ArrayLike<number>} low @param {ArrayLike<number>} close
 * @param {number} [period]
 * @returns {Array<number|null>}
 */
export function atr(high, low, close, period = 14) {
  const n = close.length;
  const out = new Array(n).fill(null);
  if (n <= period) return out;
  const tr = new Array(n);
  tr[0] = high[0] - low[0];
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(
      high[i] - low[i],
      Math.abs(high[i] - close[i - 1]),
      Math.abs(low[i] - close[i - 1]),
    );
  }
  let acc = 0;
  for (let i = 1; i <= period; i++) acc += tr[i];
  let prev = acc / period;
  out[period] = prev;
  for (let i = period + 1; i < n; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/**
 * Rate of change (percent) over `period`.
 * @param {ArrayLike<number>} values @param {number} [period]
 * @returns {Array<number|null>}
 */
export function roc(values, period = 12) {
  const n = values.length;
  const out = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    const base = values[i - period];
    out[i] = base === 0 ? null : (100 * (values[i] - base)) / base;
  }
  return out;
}
