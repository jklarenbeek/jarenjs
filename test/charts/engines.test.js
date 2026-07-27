//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compileChart, buildBarAST, buildLineAST, buildScatterAST,
  buildCandlestickAST, chartTypes,
} from '@jarenjs/charts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const golden = (name) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

/** The fixed inputs behind the golden SVGs (regenerate the fixtures
 * deliberately when a render change is intended). */
const GOLDEN_CONFIGS = {
  'bar.golden.svg': {
    type: 'bar', title: 'Grouped bars', valLabel: 'ms/op',
    categories: ['small', 'medium', 'large'],
    series: [
      { name: 'jaren', values: [1.2, 3.4, 8.1] },
      { name: 'rival', values: [2.5, 9.8, 30.2] },
    ],
  },
  'bar-log-h.golden.svg': {
    type: 'bar', title: 'Log bars', log: true, orient: 'h', valLabel: 'ns/op (log)',
    categories: ['q1', 'q2'],
    series: [{ name: 'jaren', values: [94, 178] }, { name: 'json-p3', values: [706, 802] }],
  },
  'line.golden.svg': {
    type: 'line', title: 'Two series', markers: true, xLabel: 'x', yLabel: 'y',
    series: [
      { name: 'a', points: [{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 2 }] },
      { name: 'b', points: [{ x: 0, y: 2 }, { x: 1, y: null }, { x: 2, y: 4 }] },
    ],
  },
  'scatter.golden.svg': {
    type: 'scatter', title: 'Ratio cloud', yLog: true, refY: 1, refLabel: '1x',
    points: [
      { x: 1, y: 220, tone: 'win' }, { x: 2, y: 10, tone: 'win' },
      { x: 3, y: 0.5, tone: 'loss' },
    ],
  },
  'candlestick.golden.svg': {
    type: 'candlestick', title: 'OHLC fixture', yLabel: 'USDT',
    candles: [
      { t: 1721556000000, open: 100, high: 110, low: 95, close: 108 },
      { t: 1721556060000, open: 108, high: 112, low: 104, close: 105 },
      { t: 1721556120000, open: 105, high: 109, low: 103, close: 109 },
    ],
  },
  'donut.golden.svg': {
    type: 'pie', title: 'Donut fixture', donut: true,
    slices: [{ label: 'a', value: 3 }, { label: 'b', value: 2 }, { label: 'c', value: 1 }],
  },
  'radar.golden.svg': {
    type: 'radar', title: 'Radar fixture', max: 10,
    axes: ['speed', 'size', 'a11y', 'docs', 'tests'],
    series: [
      { name: 'jaren', values: [9, 8, 7, 8, 9] },
      { name: 'rival', values: [6, 9, 5, 4, 7] },
    ],
  },
  'gauge.golden.svg': {
    type: 'gauge', title: 'Gauge fixture', value: 87.4, unit: '%', tone: 'win',
  },
  'boxplot.golden.svg': {
    type: 'boxplot', title: 'Boxplot fixture', valLabel: 'ms',
    boxes: [
      { label: 'jaren', values: [1, 2, 2, 3, 3, 3, 4, 4, 5, 6, 14] },
      { label: 'rival', min: 4, q1: 7, med: 9, q3: 12, max: 15, outliers: [30] },
    ],
  },
  'heatmap.golden.svg': {
    type: 'heatmap', title: 'Heatmap fixture', log: true,
    xLabels: ['4 books', '100 books', '1000 books'],
    yLabels: ['singular', 'filter', 'join'],
    values: [[220, 80, 12], [90, 30, 6], [15, 4, 1.2]],
  },
  'treemap.golden.svg': {
    type: 'treemap', title: 'Treemap fixture',
    items: [
      { label: 'validate', value: 42 }, { label: 'json', value: 25 },
      { label: 'view', value: 18 }, { label: 'md', value: 15 },
    ],
  },
  'streamgraph.golden.svg': {
    type: 'streamgraph', title: 'Streamgraph fixture', xLabel: 't',
    xs: [0, 1, 2, 3],
    series: [
      { name: 'a', values: [2, 4, 3, 5] },
      { name: 'b', values: [1, 2, 4, 2] },
    ],
  },
  'sankey.golden.svg': {
    type: 'sankey', title: 'Sankey fixture',
    links: [
      { source: 'search', target: 'home', value: 40 },
      { source: 'social', target: 'home', value: 15 },
      { source: 'home', target: 'docs', value: 30 },
      { source: 'home', target: 'playground', value: 20 },
    ],
  },
  'map.golden.svg': {
    type: 'map', title: 'Map fixture', value: 'pop',
    features: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { name: 'North', pop: 1700 },
          geometry: { type: 'Polygon', coordinates: [[[3, 52], [7, 52], [7, 54], [3, 54], [3, 52]]] },
        },
        {
          type: 'Feature',
          properties: { name: 'South', pop: 380 },
          // an exterior ring with a hole, so the golden pins `evenodd`
          geometry: {
            type: 'Polygon',
            coordinates: [
              [[3, 50], [7, 50], [7, 52], [3, 52], [3, 50]],
              [[4, 50.5], [5, 50.5], [5, 51], [4, 51], [4, 50.5]],
            ],
          },
        },
        {
          type: 'Feature',
          properties: { name: 'Coast' },
          geometry: { type: 'LineString', coordinates: [[3, 50], [3, 52], [3.5, 54]] },
        },
      ],
    },
    points: [{ at: [4.9, 52.37], label: 'Amsterdam' }],
  },
};

describe('engine golden SVGs', function () {
  for (const [file, config] of Object.entries(GOLDEN_CONFIGS)) {
    it(`${config.type} render matches ${file}`, function () {
      assert.equal(compileChart(config).toSvgString(), golden(file));
    });
  }

  it('the dispatcher knows every type', function () {
    assert.deepEqual(chartTypes(), [
      'pie', 'bar', 'line', 'scatter', 'candlestick',
      'radar', 'gauge', 'boxplot', 'heatmap', 'treemap', 'streamgraph', 'sankey', 'map',
    ]);
  });
});

describe('bar AST', function () {
  it('is geometry-free unit space with per-series grouped bands', function () {
    const ast = buildBarAST(
      { categories: ['a', 'b'], series: [{ name: 's1', values: [5, 10] }, { name: 's2', values: [10, 20] }] },
      { type: 'bar' });
    assert.equal(ast.bars.length, 4);
    for (const bar of ast.bars) {
      assert.ok(bar.u0 >= 0 && bar.u1 <= 1 && bar.u0 < bar.u1);
      assert.ok(bar.v0 === 0 && bar.v1 > 0 && bar.v1 <= 1);
    }
    // s1[a]=5 is a quarter of the linear top (20)
    assert.equal(ast.bars[0].v1, 0.25);
    assert.equal(ast.legend.length, 2);
  });

  it('guards empty series and zero values', function () {
    const empty = buildBarAST({ categories: [], series: [] }, { type: 'bar' });
    assert.deepEqual(empty.bars, []);
    assert.equal(empty.legend, null);
    const zeros = buildBarAST({ categories: ['a'], series: [{ name: 's', values: [0] }] }, { type: 'bar' });
    assert.deepEqual(zeros.bars, []); // nothing drawable, no NaN
  });

  it('stacks values cumulatively when stacked', function () {
    const ast = buildBarAST(
      { categories: ['a'], series: [{ name: 's1', values: [5] }, { name: 's2', values: [5] }] },
      { type: 'bar', stacked: true });
    assert.equal(ast.bars[0].v0, 0);
    assert.equal(ast.bars[0].v1, 0.5);
    assert.equal(ast.bars[1].v0, 0.5);
    assert.equal(ast.bars[1].v1, 1);
  });

  it('hoists category positions (100 categories build fast and correct)', function () {
    const categories = Array.from({ length: 100 }, (_, i) => `c${i}`);
    const series = Array.from({ length: 5 }, (_, s) => ({
      name: `s${s}`, values: categories.map((_, i) => i + 1),
    }));
    const ast = buildBarAST({ categories, series }, { type: 'bar' });
    assert.equal(ast.bars.length, 500);
    assert.equal(ast.count, 100);
  });
});

describe('line AST', function () {
  it('marks unplottable samples null so the path breaks', function () {
    const ast = buildLineAST(
      { series: [{ name: 'a', points: [{ x: 0, y: 1 }, { x: 1, y: null }, { x: 2, y: 3 }] }] },
      { type: 'line' });
    assert.equal(ast.series[0].points[1], null);
    assert.notEqual(ast.series[0].points[0], null);
  });

  it('log y drops non-positive samples instead of NaN', function () {
    const ast = buildLineAST(
      { series: [{ name: 'a', points: [{ x: 0, y: 10 }, { x: 1, y: 0 }, { x: 2, y: 100 }] }] },
      { type: 'line', log: true });
    assert.equal(ast.series[0].points[1], null);
  });

  it('time axis ticks are deterministic UTC clock labels', function () {
    const t0 = Date.UTC(2026, 6, 21, 12, 0, 0);
    const ast = buildLineAST(
      { series: [{ name: 'p', points: [{ x: t0, y: 1 }, { x: t0 + 60_000, y: 2 }] }] },
      { type: 'line', x: 'time' });
    assert.ok(ast.x.ticks.every((tk) => /^\d{2}:\d{2}:\d{2}$/.test(tk.label)));
  });

  it('accepts Date objects as x values', function () {
    const ast = buildLineAST(
      { series: [{ name: 'p', points: [{ x: new Date(0), y: 1 }, { x: new Date(1000), y: 2 }] }] },
      { type: 'line', x: 'time' });
    assert.equal(ast.series[0].points.length, 2);
    assert.equal(ast.series[0].points[0].u, 0);
    assert.equal(ast.series[0].points[1].u, 1);
  });
});

describe('scatter AST', function () {
  it('places the reference line and tones the points', function () {
    const ast = buildScatterAST(
      { points: [{ x: 1, y: 100, tone: 'win' }, { x: 2, y: 0.1, tone: 'loss' }] },
      { type: 'scatter', yLog: true, refY: 1 });
    assert.notEqual(ast.ref, null);
    assert.ok(ast.ref.v > 0 && ast.ref.v < 1);
    assert.equal(ast.points[0].tone, 'win');
    assert.equal(ast.points[1].tone, 'loss');
  });

  it('drops non-finite points', function () {
    const ast = buildScatterAST(
      { points: [{ x: NaN, y: 1 }, { x: 1, y: Infinity }, { x: 1, y: 1 }] },
      { type: 'scatter' });
    assert.equal(ast.points.length, 1);
  });
});

describe('candlestick AST', function () {
  it('maps OHLC onto unit candles with up/down tones', function () {
    const ast = buildCandlestickAST({ candles: [
      { t: 0, open: 10, high: 20, low: 5, close: 15 },
      { t: 60_000, open: 15, high: 16, low: 8, close: 9 },
    ] }, { type: 'candlestick' });
    assert.equal(ast.candles.length, 2);
    assert.equal(ast.candles[0].up, true);
    assert.equal(ast.candles[1].up, false);
    for (const c of ast.candles) {
      assert.ok(c.lowV <= Math.min(c.openV, c.closeV));
      assert.ok(c.highV >= Math.max(c.openV, c.closeV));
      assert.ok(c.u >= 0 && c.u <= 1 && c.w > 0);
    }
  });

  it('drops malformed candles and survives empty input', function () {
    const ast = buildCandlestickAST({ candles: [
      { t: 0, open: NaN, high: 1, low: 0, close: 1 },
      { open: 1, high: 1, low: 1, close: 1 },
    ] }, { type: 'candlestick' });
    assert.deepEqual(ast.candles, []);
    assert.ok(Array.isArray(buildCandlestickAST({}, {}).candles));
  });

  it('accepts Date open times', function () {
    const ast = buildCandlestickAST({ candles: [
      { t: new Date(0), open: 1, high: 2, low: 0.5, close: 1.5 },
      { t: new Date(60_000), open: 1.5, high: 2, low: 1, close: 1.2 },
    ] }, {});
    assert.equal(ast.candles[0].u, 0);
    assert.equal(ast.candles[1].u, 1);
  });
});

describe('accessibility', function () {
  it('charts carry role, aria-label and a <title> child', function () {
    const v = compileChart(GOLDEN_CONFIGS['bar.golden.svg']).toVnode();
    assert.equal(v[1].role, 'img');
    assert.equal(v[1]['aria-label'], 'Grouped bars');
    assert.deepEqual(v[2], ['title', {}, 'Grouped bars']);
  });
});
