//@ts-check
/**
 * A chart of any size draws. Three builders spread an array into an
 * argument list — a boxplot's outliers into `Math.min`/`Math.max`, a
 * streamgraph's x values likewise, a pie's slices into `push` — and an
 * argument list has a limit, so a box with 240,000 outliers, a streamgraph
 * of 140,000 samples and a pie of 100,000 slices threw "Maximum call stack
 * size exceeded" instead of drawing.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { compileChart } from '@jarenjs/charts';

describe('charts — data past the length of an argument list', function () {
  it('draws a boxplot whose box has 240,000 outliers', () => {
    // three quarters of the values are 0, so the box is flat and every other value is an outlier
    const values = Array(760000).fill(0).concat(Array.from({ length: 240000 }, (_, i) => i + 1));
    const chart = compileChart({ type: 'boxplot', boxes: [{ label: 'x', values }] });
    assert.equal(chart.ast.boxes[0].outliersV.length, 240000);
    assert.equal(chart.ast.boxes[0].stats.max, 240000);
    assert.equal(chart.ast.val.ticks.at(-1)?.label, '200k');
  });

  it('draws a streamgraph of 140,000 samples on its x values', () => {
    const xs = Array.from({ length: 140000 }, (_, i) => i);
    const chart = compileChart({ type: 'streamgraph', xs, series: [{ name: 'a', values: xs.map(() => 1) }] });
    const points = chart.ast.layers[0].points;
    assert.equal(points.length, 140000);
    assert.equal(points[0].u, 0);
    assert.equal(points[139999].u, 1);
    assert.match(chart.toSvgString(), /^<svg/);
  });

  it('draws a pie of 100,000 slices', () => {
    const slices = Array.from({ length: 100000 }, (_, i) => ({ label: `s${i}`, value: 1 }));
    assert.match(compileChart({ type: 'pie', slices }).toSvgString(), /^<svg/);
  });
});
