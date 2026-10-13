//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { JarenValidator } from '@jarenjs/validate';
import { compileChart } from '@jarenjs/charts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, '..', '..', 'components', 'charts', 'schemas', 'chart-definition.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

/** Every fixture config the charts tests use, validated (dogfooding). */
const FIXTURES = [
  { type: 'pie', title: 'Pets', slices: [{ label: 'Dogs', value: 3 }, { label: 'Cats', value: 1 }] },
  { type: 'pie', slices: [{ label: 'x', value: 1 }] },
  { type: 'pie', title: null, slices: [] },
  { type: 'pie', title: 'Memo' },
  { type: 'pie', donut: true, slices: [{ label: 'a', value: 1 }] },
  { type: 'pie', donut: 0.4, slices: [{ label: 'a', value: 1 }] },
  { type: 'radar', max: 10, axes: ['a', 'b', 'c'], series: [{ name: 's', values: [1, null, 3] }] },
  { type: 'gauge', value: 87.4, min: 0, max: 100, unit: '%', tone: 'win' },
  {
    type: 'boxplot', valLabel: 'ms', boxes: [
      { label: 'raw', values: [1, 2, 3] },
      { label: 'summary', min: 1, q1: 2, med: 3, q3: 4, max: 5, outliers: [9] },
    ],
  },
  {
    type: 'heatmap', log: true, xLabels: ['x1'], yLabels: ['y1', 'y2'],
    values: [[1], [null]],
  },
  { type: 'treemap', aspect: 1.6, items: [{ label: 'a', value: 2 }] },
  { type: 'streamgraph', xs: [0, 1], series: [{ name: 'a', values: [1, 2] }] },
  {
    type: 'sankey', nodes: ['a', { name: 'b' }],
    links: [{ source: 'a', target: 1, value: 3 }],
  },
  {
    type: 'map', value: 'pop', label: 'name', log: true, simplify: false,
    features: {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { name: 'a', pop: 10 },
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      }],
    },
    points: [{ at: [4.9, 52.37, 12], label: 'Amsterdam', value: 900 }],
  },
  { type: 'map', features: [], simplify: 0.001, aspect: 2 },
];

describe('the chart-definition JSON Schema', function () {
  const validate = new JarenValidator().compile(schema);

  it('accepts every fixture config', function () {
    for (const config of FIXTURES) {
      assert.equal(validate(config), true,
        `schema rejected ${JSON.stringify(config)}`);
    }
  });

  it('rejects an unknown type and malformed slices', function () {
    assert.equal(validate({ type: 'sparkline' }), false);
    assert.equal(validate({}), false);
    assert.equal(validate({ type: 'pie', slices: [{ label: 'a' }] }), false);
    assert.equal(validate({ type: 'pie', slices: [{ label: 'a', value: -1 }] }), false);
  });

  it('rejects malformed new-type documents', function () {
    // a numeric donut must be a fraction strictly inside (0, 1)
    assert.equal(validate({ type: 'pie', donut: 1.5, slices: [] }), false);
    assert.equal(validate({ type: 'radar', max: 0 }), false);
    assert.equal(validate({ type: 'gauge', value: 'high' }), false);
    // a box needs raw values or the full five-number summary
    assert.equal(validate({ type: 'boxplot', boxes: [{ label: 'x' }] }), false);
    assert.equal(validate({ type: 'boxplot', boxes: [{ label: 'x', min: 1, q1: 2 }] }), false);
    assert.equal(validate({ type: 'heatmap', values: [[1], 'row'] }), false);
    assert.equal(validate({ type: 'treemap', items: [{ label: 'a', value: 0 }] }), false);
    assert.equal(validate({ type: 'streamgraph', xs: ['monday'] }), false);
    assert.equal(validate({ type: 'sankey', links: [{ source: 'a', target: 'b' }] }), false);
    assert.equal(validate({ type: 'sankey', links: [{ source: 'a', target: 'b', value: 0 }] }), false);
    // a marker needs a position, and the position has to be on the planet
    assert.equal(validate({ type: 'map', points: [{ label: 'nowhere' }] }), false);
    assert.equal(validate({ type: 'map', points: [{ at: [4.9] }] }), false);
    assert.equal(validate({ type: 'map', points: [{ at: [4.9, 91] }] }), false);
    assert.equal(validate({ type: 'map', points: [{ at: [181, 52] }] }), false);
    assert.equal(validate({ type: 'map', simplify: -1 }), false);
  });
});

/**
 * Which of `values` the renderer plots on a line's x axis, in order: one
 * chart carrying every value as a point, a point the renderer cannot place
 * comes back `null`.
 * @param {any[]} values
 * @returns {boolean[]}
 */
function plottedAsLineX(values) {
  const { ast } = compileChart({
    type: 'line', x: 'time', sampling: false,
    series: [{ name: 's', points: values.map((x) => ({ x, y: 1 })) }],
  });
  return ast.series[0].points.map((p) => p !== null);
}

/**
 * Which of `values` the renderer plots as a candle's `t`: the candle that
 * survives carries its index in `open`, so the survivors name themselves.
 * @param {any[]} values
 * @returns {boolean[]}
 */
function plottedAsCandleT(values) {
  const { ast } = compileChart({
    type: 'candlestick',
    candles: values.map((t, i) => ({ t, open: i, high: values.length, low: -1, close: 0 })),
  });
  const plotted = new Set(ast.candles.map((c) => c.open));
  return values.map((_, i) => plotted.has(i));
}

const lineWith = (x) => ({ type: 'line', x: 'time', series: [{ name: 's', points: [{ x, y: 1 }] }] });
const candleWith = (t) => ({ type: 'candlestick', candles: [{ t, open: 1, high: 2, low: 0, close: 1 }] });

describe('the chart-definition JSON Schema on a time coordinate', function () {
  const validate = new JarenValidator().compile(schema);

  it('should accept the RFC 3339 dates and date-times the renderer plots, to the instant it reads', function () {
    const cases = [
      ['2026-07-27', 1785110400000],
      ['2026-07-27T10:00:00Z', 1785146400000],
      ['2026-07-27T10:00:00.5+02:00', 1785139200500],
      ['2026-07-27t10:00:00z', 1785146400000],
      ['2026-07-27 10:00:00Z', 1785146400000],
      ['2024-02-29', 1709164800000],
      ['2026-07-27T23:59:60Z', 1785196800000],
    ];
    for (const [text, ms] of cases) {
      assert.equal(validate(lineWith(text)), true, `line x ${text}`);
      assert.equal(validate(candleWith(text)), true, `candle t ${text}`);
      const line = compileChart(lineWith(text)).ast;
      assert.equal(line.series[0].points[0] !== null, true, `line x ${text} plots`);
      assert.deepEqual(line.domain.x[0], ms, `line x ${text} reads as ${ms}`);
      assert.equal(compileChart(candleWith(text)).ast.candles[0].t, ms, `candle t ${text}`);
    }
    assert.equal(validate(lineWith(1785110400000)), true);
    assert.equal(validate(candleWith(1785110400000)), true);
  });

  it('should refuse what the renderer drops from a time coordinate', function () {
    const refused = [
      '5', 'abc', '', ' 2026-07-27', '+2026-07-27', '2026-7-27', '2026-07-27Z',
      '2026-02-30', '2026-02-29', '2100-02-29', '2026-13-01', '2026-00-10', '2026-04-31',
      '2026-07-27T10:00:00', '2026-07-27T10:00Z', '10:00:00Z', '2026-07-27T24:00:00Z',
      '2026-07-27T10:00:61Z', '2026-07-27T10:00:60Z', '2026-07-27T10:00:00+24:00',
      '2026-07-27T10:00:00+0200', '2026-07-27T10:00:00.Z', '2026-07-27T10:00:00Zjunk',
      '2026-07-27TT10:00:00Z', '2026-07-27x10:00:00Z',
      // the year is exactly four digits
      '12026-07-27', '02026-07-27', '20260-07-27T10:00:00Z', '026-07-27', '-0001-01-01', '+12026-07-27',
    ];
    assert.deepEqual(plottedAsLineX(refused), refused.map(() => false));
    assert.deepEqual(plottedAsCandleT(refused), refused.map(() => false));
    for (const text of refused) {
      assert.equal(validate(lineWith(text)), false, `line x ${JSON.stringify(text)}`);
      assert.equal(validate(candleWith(text)), false, `candle t ${JSON.stringify(text)}`);
    }
    for (const other of [null, true, {}, [], [1]]) {
      assert.equal(validate(lineWith(other)), false);
      assert.equal(validate(candleWith(other)), false);
    }
  });

  it('should agree with the renderer on every string of a boundary grid, both ways', function () {
    const years = ['0000', '0001', '0004', '0100', '0400', '1900', '2000', '2023', '2024', '2026', '2100', '9999'];
    const strings = [];
    for (const year of years) {
      for (let month = 0; month <= 13; ++month) {
        for (const day of [0, 1, 28, 29, 30, 31, 32]) {
          strings.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
        }
      }
    }
    const separators = ['T', 't', ' ', '\t', '_', 'x', ''];
    const times = [];
    for (const hh of ['00', '23', '24', '25']) {
      for (const mm of ['00', '59', '60']) {
        for (const ss of ['00', '59', '60', '61']) {
          for (const frac of ['', '.5', '.', '.123456789012']) {
            for (const zone of ['Z', 'z', '+00:00', '-00:00', '+23:59', '-23:59', '+24:00', '+23:60', '+0100', '']) {
              times.push(`${hh}:${mm}:${ss}${frac}${zone}`);
            }
          }
        }
      }
    }
    for (const date of ['2026-07-27', '2024-02-29', '2023-02-29', '2026-12-31']) {
      for (const sep of separators) for (const time of times) strings.push(date + sep + time);
    }
    const asLine = plottedAsLineX(strings);
    const asCandle = plottedAsCandleT(strings);
    // a leap second spelled with a non-zero offset is read by the renderer
    // (it lands on the UTC 23:59:60) but is not expressible as a pattern
    const offsetLeap = /[Tt \t]\d\d:\d\d:60(?:\.\d+)?[+-](?!00:00$)\d\d:\d\d$/;
    let plotted = 0;
    for (let i = 0; i < strings.length; ++i) {
      const text = strings[i];
      assert.equal(asLine[i], asCandle[i], `renderer disagrees with itself on ${JSON.stringify(text)}`);
      const expected = asLine[i] && !offsetLeap.test(text);
      if (asLine[i]) ++plotted;
      assert.equal(validate(lineWith(text)), expected, `line x ${JSON.stringify(text)}`);
      assert.equal(validate(candleWith(text)), expected, `candle t ${JSON.stringify(text)}`);
    }
    assert.ok(plotted > 2000, `the grid has to plot a real share of its strings, got ${plotted}`);
  });

  it('should keep every other member numeric', function () {
    const day = '2026-07-27';
    assert.equal(validate({ type: 'line', series: [{ name: 's', points: [{ x: 1, y: day }] }] }), false);
    assert.equal(validate({ type: 'scatter', points: [{ x: day, y: 1 }] }), false);
    assert.equal(validate({ type: 'candlestick', candles: [{ t: 1, open: day, high: 2, low: 0, close: 1 }] }), false);
    assert.equal(validate({ type: 'streamgraph', xs: [day] }), false);
    assert.equal(validate({ type: 'line', domain: { x: day } }), false);
  });
});
