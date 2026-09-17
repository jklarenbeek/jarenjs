import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileChart } from '@jarenjs/charts';
import { financeCharts } from '@jarenjs/charts/transforms/finance-adapter';

test('financial adapter compiles aligned indicator charts and explicit-period risk summaries', () => {
  const samples = Array.from({ length: 40 }, (_, i) => ({ t: i * 1000, high: 11 + i, low: 9 + i, close: 10 + i, volume: 100 + i }));
  const before = structuredClone(samples), result = financeCharts(samples, { periodsPerYear: 252, period: 5, signalPeriod: 3,
    sessions: samples.map((_, i) => i === 20), benchmark: samples.slice(1).map((row, i) => row.close / samples[i].close - 1) });
  assert.equal(Object.keys(result.charts).length, 11);
  for (const pair of Object.values(result.charts)) assert.match(compileChart(pair.config, pair.data).toSvgString(), /^<svg/);
  assert.equal(result.charts.ADX.data.series[0].points[0].x, 9000);
  assert.ok(Math.abs(result.risk.beta - 1) < 1e-12); assert.ok(result.risk.annualizedReturn > 0);
  assert.deepEqual(samples, before);
  assert.throws(() => financeCharts([{ ...samples[0], t: NaN }], { periodsPerYear: 252 }));
  assert.throws(() => financeCharts([{ ...samples[0], close: 0 }], { periodsPerYear: 252 }));
  assert.equal(financeCharts([], { periodsPerYear: 252 }).charts.ADX.data.series[0].points.length, 0);
});
