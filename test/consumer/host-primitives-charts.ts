import { financeCharts } from '@jarenjs/charts/transforms/finance-adapter';
import { compileChart } from '@jarenjs/charts';
const result = financeCharts([], { periodsPerYear: 252 });
const risk: number = result.risk.annualizedReturn;
for (const pair of Object.values(result.charts)) compileChart(pair.config, pair.data);
void risk;
