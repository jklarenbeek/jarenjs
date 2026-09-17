//@ts-check
/**
 * @file Technical / trading indicators over a price or OHLC
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

/** Validate the declared array domain without normalizing caller data. */
function indicatorInputs(period, ...inputs) {
  if (!Number.isSafeInteger(period) || period < 1) throw new RangeError('indicator period must be a positive integer');
  const n = inputs[0]?.length;
  if (!Number.isSafeInteger(n) || n < 0 || inputs.some(values => values?.length !== n))
    throw new TypeError('indicator inputs must have equal lengths');
  for (const values of inputs) for (let i = 0; i < n; i++)
    if (!Number.isFinite(values[i])) throw new TypeError('indicator inputs must be finite numbers');
  return n;
}

function ohlc(period, high, low, close) {
  const n = indicatorInputs(period, high, low, close);
  for (let i = 0; i < n; i++) if (high[i] < low[i] || close[i] < low[i] || close[i] > high[i])
    throw new RangeError('OHLC close must lie between low and high');
  return n;
}

function volumes(volume) {
  for (let i = 0; i < volume.length; i++) if (volume[i] < 0) throw new RangeError('volume must be nonnegative');
}

/**
 * Wilder directional indicators and ADX. DI starts at period; ADX at
 * 2*period-1. Seed the smoothed sums with period-1 transitions (TA-Lib).
 * @param {ArrayLike<number>} high @param {ArrayLike<number>} low @param {ArrayLike<number>} close
 * @param {number} [period]
 * @returns {{ adx: Array<number|null>, plusDI: Array<number|null>, minusDI: Array<number|null> }}
 */
export function adx(high, low, close, period = 14) {
  const n = ohlc(period, high, low, close);
  if (period < 2) throw new RangeError('ADX requires period >= 2');
  const out = new Array(n).fill(null), plusDI = new Array(n).fill(null), minusDI = new Array(n).fill(null);
  let tr = 0, plus = 0, minus = 0, sumDx = 0, average = 0;
  for (let i = 1; i < n; i++) {
    const up = high[i] - high[i - 1], down = low[i - 1] - low[i];
    const p = up > 0 && up > down ? up : 0, m = down > 0 && down > up ? down : 0;
    const range = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
    if (i < period) { tr += range; plus += p; minus += m; continue; }
    tr = tr - tr / period + range;
    plus = plus - plus / period + p; minus = minus - minus / period + m;
    plusDI[i] = tr === 0 ? 0 : 100 * (plus / tr);
    minusDI[i] = tr === 0 ? 0 : 100 * (minus / tr);
    const total = plusDI[i] + minusDI[i];
    const dx = total === 0 ? 0 : 100 * Math.abs(plusDI[i] - minusDI[i]) / total;
    if (i < 2 * period) {
      sumDx += dx;
      if (i === 2 * period - 1) { average = sumDx / period; out[i] = average; }
    }
    else { average = (average * (period - 1) + dx) / period; out[i] = average; }
  }
  return { adx: out, plusDI, minusDI };
}

/** Commodity channel index; flat windows return zero.
 * @param {ArrayLike<number>} high @param {ArrayLike<number>} low @param {ArrayLike<number>} close
 * @param {number} [period] @returns {Array<number|null>} */
export function cci(high, low, close, period = 20) {
  const n = ohlc(period, high, low, close), out = new Array(n).fill(null);
  const typical = Array.from({ length: n }, (_, i) => (high[i] + low[i] + close[i]) / 3);
  const averages = sma(typical, period);
  for (let i = period - 1; i < n; i++) {
    let deviation = 0;
    for (let j = i - period + 1; j <= i; j++) deviation += Math.abs(typical[j] - averages[i]);
    out[i] = deviation === 0 ? 0 : (typical[i] - averages[i]) / (0.015 * deviation / period);
  }
  return out;
}

/** Cumulative typical-price VWAP, reset before each true session flag.
 * Zero cumulative volume is null. The first row always begins a session.
 * @param {ArrayLike<number>} high @param {ArrayLike<number>} low @param {ArrayLike<number>} close
 * @param {ArrayLike<number>} volume @param {ArrayLike<boolean>} [sessions]
 * @returns {Array<number|null>} */
export function vwap(high, low, close, volume, sessions) {
  const n = ohlc(1, high, low, close); indicatorInputs(1, close, volume); volumes(volume);
  if (sessions !== undefined && (sessions.length !== n || Array.from(sessions).some(value => typeof value !== 'boolean')))
    throw new TypeError('VWAP sessions must be aligned boolean reset flags');
  let total = 0, weighted = 0;
  return Array.from({ length: n }, (_, i) => {
    if (sessions?.[i]) { total = 0; weighted = 0; }
    total += volume[i]; weighted += ((high[i] + low[i] + close[i]) / 3) * volume[i];
    return total === 0 ? null : weighted / total;
  });
}

/** On-balance volume seeded with the first volume; equal closes add zero.
 * @param {ArrayLike<number>} close @param {ArrayLike<number>} volume @returns {number[]} */
export function obv(close, volume) {
  const n = indicatorInputs(1, close, volume); volumes(volume);
  let value = n ? volume[0] : 0;
  return Array.from({ length: n }, (_, i) => {
    if (i) value += Math.sign(close[i] - close[i - 1]) * volume[i];
    return value;
  });
}

/** Current volume divided by the mean of the preceding period, excluding current.
 * @param {ArrayLike<number>} volume @param {number} [period] @returns {Array<number|null>} */
export function volumeRatio(volume, period = 20) {
  const n = indicatorInputs(period, volume); volumes(volume);
  const averages = sma(volume, period), out = new Array(n).fill(null);
  for (let i = period; i < n; i++) out[i] = averages[i - 1] === 0 ? null : volume[i] / averages[i - 1];
  return out;
}

/** The existing fast stochastic K/D convention, plus J = 3K - 2D.
 * @param {ArrayLike<number>} high @param {ArrayLike<number>} low @param {ArrayLike<number>} close
 * @param {number} [kPeriod] @param {number} [dPeriod]
 * @returns {{ k: Array<number|null>, d: Array<number|null>, j: Array<number|null> }} */
export function kdj(high, low, close, kPeriod = 14, dPeriod = 3) {
  ohlc(kPeriod, high, low, close); indicatorInputs(dPeriod, close);
  const { k, d } = stochastic(high, low, close, kPeriod, dPeriod);
  return { k, d, j: k.map((value, i) => value === null || d[i] === null ? null : 3 * value - 2 * d[i]) };
}

/** Williams %R in [-100, 0]; flat windows return zero.
 * @param {ArrayLike<number>} high @param {ArrayLike<number>} low @param {ArrayLike<number>} close
 * @param {number} [period] @returns {Array<number|null>} */
export function williamsR(high, low, close, period = 14) {
  ohlc(period, high, low, close);
  return stochastic(high, low, close, period, 1).k.map(value => value === null ? null : value - 100);
}
