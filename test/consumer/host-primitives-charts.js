import assert from 'node:assert/strict';
import { compileChart } from '@jarenjs/charts';
import { financeCharts } from '@jarenjs/charts/transforms/finance-adapter';
const samples = Array.from({ length: 30 }, (_, i) => ({ t: i, high: i + 3, low: i + 1, close: i + 2, volume: 10 }));
for (const pair of Object.values(financeCharts(samples, { periodsPerYear: 252 }).charts))
  assert.match(compileChart(pair.config, pair.data).toSvgString(), /^<svg/);
