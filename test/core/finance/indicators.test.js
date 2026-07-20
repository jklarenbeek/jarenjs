import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sma, ema, wma, macd, rsi, bollinger, stochastic, atr, roc,
  cagr, holdingPeriodReturn, returnsOf, volatility, sharpe, maxDrawdown,
} from '@jarenjs/core/finance';

const close = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) <= eps, `${a} !~= ${b}`);

describe('#finance indicators (A-fin)', function () {
  const series = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it('sma aligned with nulls in warm-up', () => {
    const s = sma(series, 3);
    assert.equal(s.length, series.length);
    assert.equal(s[0], null);
    assert.equal(s[1], null);
    close(s[2], 2);
    close(s[3], 3);
    close(s[9], 9);
  });

  it('ema seeded by sma', () => {
    const e = ema(series, 3);
    assert.equal(e[1], null);
    close(e[2], 2);            // seed = mean(1,2,3)
    close(e[3], 3);           // 4*0.5 + 2*0.5
  });

  it('wma weights recent more', () => {
    const w = wma([1, 2, 3], 3);
    close(w[2], (1 * 1 + 2 * 2 + 3 * 3) / 6);
  });

  it('macd returns three aligned arrays', () => {
    const m = macd(Array.from({ length: 40 }, (_, i) => i + 1));
    assert.equal(m.macd.length, 40);
    assert.equal(m.signal.length, 40);
    assert.equal(m.histogram.length, 40);
    assert.equal(m.macd[0], null);
  });

  it('rsi of a monotonic rise is 100', () => {
    const r = rsi(series, 4);
    close(r[series.length - 1], 100, 1e-6);
  });

  it('bollinger bands straddle the middle', () => {
    const b = bollinger(series, 5, 2);
    const i = series.length - 1;
    assert.ok(b.upper[i] > b.middle[i] && b.middle[i] > b.lower[i]);
  });

  it('stochastic %K in [0,100]', () => {
    const high = series.map((v) => v + 1);
    const low = series.map((v) => v - 1);
    const st = stochastic(high, low, series, 5, 3);
    const k = st.k[series.length - 1];
    assert.ok(k >= 0 && k <= 100);
  });

  it('atr is positive after warm-up', () => {
    const high = series.map((v) => v + 1);
    const low = series.map((v) => v - 1);
    const a = atr(high, low, series, 3);
    assert.ok(a[series.length - 1] > 0);
  });

  it('roc percent', () => {
    const r = roc([10, 11, 12, 13], 1);
    close(r[1], 10);
  });
});

describe('#finance returns (A-fin)', function () {
  it('cagr', () => {
    close(cagr(1000, 2000, 10), Math.pow(2, 0.1) - 1, 1e-9);
  });
  it('holding-period return with income', () => {
    close(holdingPeriodReturn(100, 110, 5), 0.15, 1e-9);
  });
  it('volatility + sharpe', () => {
    const rets = returnsOf([100, 110, 121, 133.1]);   // ~constant 10%
    close(volatility(rets), 0, 1e-6);
    // known series: mean 0, sample stddev 1 → sharpe 0
    close(sharpe([-1, 0, 1]), 0, 1e-9);
    close(volatility([-1, 0, 1]), 1, 1e-9);
  });
  it('max drawdown', () => {
    close(maxDrawdown([100, 120, 80, 90, 60, 100]), 0.5, 1e-9);
  });
});
