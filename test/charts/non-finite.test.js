//@ts-check
/**
 * Values a chart cannot draw are dropped, not printed. A pie used to sum
 * its slices raw, so a `NaN`, an `Infinity` or a negative slice put
 * `a: NaN (NaN%)` or `b: 10 (200.0%)` in front of the reader; it now
 * drops every slice whose value is not a finite number of at least zero,
 * the way bar and line drop non-finite values, and the shares are of what
 * is left. A chart whose data spans more than a double can measure
 * (±1e308) used to label a tick `NaN`, or lose its value axis and draw
 * every mark at one edge; each type now clamps the domain it resolved to
 * the widest span a double holds before the ticks are laid. A log axis
 * over data near the largest double rounded its top decade up to
 * `Infinity` and laid decades until the tick array overflowed; it now
 * tops out at 1e308. Finite values can also sum past the largest double:
 * a pie of two such slices totalled `Infinity` and drew both at 0%, a
 * treemap or sankey put its tiles and ribbons at `NaN`, and a streamgraph
 * flattened the column; the parts of a whole are now measured in units of
 * the largest value whenever their sum would overflow, so every share
 * keeps its ratio. A heatmap or map shade and a boxplot quartile between
 * values further apart than a double measures used to read `NaN` or
 * `Infinity`; both are now taken at a scale that fits.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  compileChart, buildPieAST, buildLineAST, buildScatterAST, buildCandlestickAST, buildBoxplotAST,
  buildStreamgraphAST, buildGaugeAST, buildBarAST, buildRadarAST, axisTicksLog,
  buildTreemapAST, buildSankeyAST, buildHeatmapAST, buildMapAST, quantileSorted, SEQUENTIAL,
} from '@jarenjs/charts';

/** @param {any} spec */
const svgOf = (spec) => compileChart(spec).toSvgString();
/** @param {string} svg */
const ticks = (svg) => [...svg.matchAll(/class="chart-tick">([^<]*)</g)].map((m) => m[1]);

describe('pie — a slice that is not a finite number of at least zero is dropped', function () {
  it('NaN, infinite, negative and non-number values leave the shares of what is left', function () {
    for (const bad of [NaN, Infinity, -Infinity, -5, '5', null]) {
      const ast = buildPieAST({ slices: [{ label: 'a', value: /** @type {any} */ (bad) }, { label: 'b', value: 10 }] });
      assert.deepEqual(ast.slices.map((s) => [s.label, s.value, s.frac]), [['b', 10, 1]], String(bad));
      assert.equal(ast.total, 10);
    }
  });

  it('keeps zero slices and the order of the rest', function () {
    const ast = buildPieAST({ slices: [
      { label: 'a', value: 1 }, { label: 'x', value: NaN }, { label: 'z', value: 0 }, { label: 'b', value: 3 },
    ] });
    assert.deepEqual(ast.slices.map((s) => [s.label, s.frac]), [['a', 0.25], ['z', 0], ['b', 0.75]]);
  });

  it('prints no NaN, no Infinity and no share above 100%', function () {
    for (const bad of [NaN, Infinity, -5]) {
      const svg = svgOf({ type: 'pie', slices: [{ label: 'a', value: bad }, { label: 'b', value: 10 }] });
      assert.doesNotMatch(svg, /NaN|Infinity/);
      assert.match(svg, /<title>b: 10 \(100\.0%\)<\/title>/);
      assert.match(svg, />b \(100\.0%\)</);
      assert.doesNotMatch(svg, />a[ :]/);
    }
  });
});

describe('line — a span wider than a double labels no NaN tick', function () {
  it('on the value axis', function () {
    const svg = svgOf({ type: 'line', series: [{ name: 'a', points: [{ x: 0, y: -1e308 }, { x: 1, y: 1e308 }] }] });
    assert.doesNotMatch(svg, /NaN|Infinity/);
    assert.ok(ticks(svg).length >= 3, `ticks: ${ticks(svg).join(', ')}`);
  });

  it('on the x axis', function () {
    const svg = svgOf({ type: 'line', series: [{ name: 'a', points: [{ x: -1e308, y: 0 }, { x: 1e308, y: 1 }] }] });
    assert.doesNotMatch(svg, /NaN|Infinity/);
  });

  it('leaves an ordinary domain exactly as it was', function () {
    const svg = svgOf({ type: 'line', series: [{ name: 'a', points: [{ x: 0, y: 0 }, { x: 10, y: 100 }] }] });
    assert.deepEqual(ticks(svg), ['0', '20', '40', '60', '80', '100', '0', '2', '4', '6', '8', '10']);
  });

  it('under a step or a pinned domain policy, which widen the clamped span again', function () {
    const wide = { name: 'a', points: [{ x: 0, y: -1e308 }, { x: 1, y: 1e308 }] };
    const near = { name: 'a', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };
    for (const [domain, series] of /** @type {const} */ ([
      [{ y: 'step' }, wide], [{ y: { min: -1e308, max: 1e308 } }, near],
    ])) {
      const svg = svgOf({ type: 'line', domain, series: [series] });
      assert.doesNotMatch(svg, /NaN|Infinity/, JSON.stringify(domain));
      assert.deepEqual(labels(buildLineAST({ series: [series] }, { domain }).y), WIDE);
    }
  });
});

const H = 1e308;
const M = Number.MAX_VALUE;
/** The ticks every overflowing domain is laid over once it is clamped to ±`Number.MAX_VALUE / 2`. */
const WIDE = ['-5e+298G', '0', '5e+298G'];
/** @param {{ticks: {label: string}[]}} axis */
const labels = (axis) => axis.ticks.map((t) => t.label);

describe('every other type that lays ticks over its data — a span wider than a double', function () {
  it('scatter, on both axes, pinning the points to the plot\'s corners', function () {
    const points = [{ x: -H, y: -H }, { x: H, y: H }];
    assert.doesNotMatch(svgOf({ type: 'scatter', points }), /NaN|Infinity/);
    const ast = buildScatterAST({ points });
    assert.deepEqual([labels(ast.x), labels(ast.y)], [WIDE, WIDE]);
    assert.deepEqual(ast.points.map((p) => [p.u, p.v]), [[0, 0], [1, 1]]);
  });

  it('candlestick, on the price axis, under a step policy and on the time axis', function () {
    const wide = [{ t: 0, open: -H, high: H, low: -H, close: H }, { t: 1, open: 1, high: 2, low: 0, close: 1 }];
    for (const config of [{}, { domain: { y: 'step' } }]) {
      assert.doesNotMatch(svgOf({ type: 'candlestick', candles: wide, ...config }), /NaN|Infinity/);
      const ast = buildCandlestickAST({ candles: wide }, config);
      assert.deepEqual(labels(ast.y), WIDE, JSON.stringify(config));
      assert.deepEqual([ast.candles[0].lowV, ast.candles[0].highV, ast.candles[1].openV], [0, 1, 0.5]);
    }
    const spread = [{ t: -H, open: 0, high: 1, low: 0, close: 1 }, { t: H, open: 1, high: 2, low: 0, close: 1 }];
    assert.doesNotMatch(svgOf({ type: 'candlestick', candles: spread }), /NaN|Infinity/);
    assert.deepEqual(buildCandlestickAST({ candles: spread }).candles.map((c) => c.u), [0, 1]);
  });

  it('boxplot, on the value axis', function () {
    const boxes = [{ label: 'g', values: [-H, 0, H] }];
    assert.doesNotMatch(svgOf({ type: 'boxplot', boxes }), /NaN|Infinity/);
    const ast = buildBoxplotAST({ boxes });
    assert.deepEqual(labels(ast.val), WIDE);
    assert.deepEqual([ast.boxes[0].loV, ast.boxes[0].medV, ast.boxes[0].hiV], [0, 0.5, 1]);
  });

  it('streamgraph, on its numeric x axis', function () {
    const data = { xs: [-H, 0, H], series: [{ name: 's', values: [1, 2, 3] }] };
    assert.doesNotMatch(svgOf({ type: 'streamgraph', ...data }), /NaN|Infinity/);
    const ast = buildStreamgraphAST(data);
    assert.deepEqual(labels(ast.x), WIDE);
    assert.deepEqual(ast.layers[0].points.map((p) => p.u), [0, 0.5, 1]);
  });

  it('gauge, over a configured range', function () {
    assert.doesNotMatch(svgOf({ type: 'gauge', value: 0, min: -H, max: H }), /NaN|Infinity/);
    const ast = buildGaugeAST({ value: 0 }, { min: -H, max: H });
    assert.deepEqual([ast.frac, ast.ticks.map((t) => t.label)], [0.5, WIDE]);
  });

  it('bar, whose rounded-up top or stacked total passes the largest double', function () {
    const categories = ['a', 'b'];
    for (const [series, config] of /** @type {const} */ ([
      [[{ name: 's', values: [M, 1] }], {}],
      [[{ name: 's', values: [H, 1] }, { name: 't', values: [H, 1] }], { stacked: true }],
    ])) {
      assert.doesNotMatch(svgOf({ type: 'bar', categories, series, ...config }), /NaN|Infinity/);
      const ast = buildBarAST({ categories, series }, config);
      assert.deepEqual(labels(ast.val), ['0', '2e+298G', '4e+298G', '6e+298G', '8e+298G'], JSON.stringify(config));
      assert.equal(ast.bars[0].v1, 1);
    }
  });

  it('radar, whose rounded-up outer ring passes the largest double', function () {
    const data = { axes: ['x', 'y', 'z'], series: [{ name: 's', values: [M, 1, 2] }] };
    assert.doesNotMatch(svgOf({ type: 'radar', ...data }), /NaN|Infinity/);
    const ast = buildRadarAST(data);
    assert.deepEqual(ast.rings.map((r) => r.label), ['2e+298G', '4e+298G', '6e+298G', '8e+298G']);
    assert.equal(ast.series[0].points[0]?.r, 1);
  });
});

describe('a log axis near the largest double tops out at 1e308', function () {
  // 1, 10, … 1e308: the 309 decades a log axis from 1 can lay
  it('bar, scatter and line round their top decade up no further than a double holds', function () {
    const bar = buildBarAST({ categories: ['a', 'b'], series: [{ name: 's', values: [M, 1] }] }, { log: true });
    assert.equal(bar.val.ticks.length, 309);
    assert.deepEqual([bar.val.ticks.at(-1)?.label, bar.bars[0].v1], ['1e+299G', 1]);
    const scatter = buildScatterAST({ points: [{ x: 1, y: 1 }, { x: M, y: M }] }, { xLog: true, yLog: true });
    assert.deepEqual(scatter.points.map((p) => [p.u, p.v]), [[0, 0], [1, 1]]);
    assert.equal(scatter.y.ticks.length, 309);
    const line = buildLineAST({ series: [{ name: 'a', points: [{ x: 0, y: 1 }, { x: 1, y: M }] }] },
      { log: true, domain: { y: 'step' } });
    assert.deepEqual([line.domain.y, line.y.ticks.length], [[1, 1e308], 309]);
  });

  it('a degenerate log domain at the top widens one decade down, not up', function () {
    for (const config of [{ log: true }, { log: true, domain: { y: 'step' } }]) {
      const line = buildLineAST({ series: [{ name: 'a', points: [{ x: 0, y: 1.5e308 }, { x: 1, y: 1.5e308 }] }] }, config);
      assert.deepEqual([line.domain.y, labels(line.y)], [[1e307, 1e308], ['1e+298G', '1e+299G']], JSON.stringify(config));
    }
    assert.doesNotMatch(svgOf({ type: 'scatter', yLog: true, points: [{ x: 0, y: 1e308 }, { x: 1, y: 1e308 }] }), /NaN|Infinity/);
  });

  it('axisTicksLog refuses an infinite bound instead of laying decades toward it', function () {
    assert.throws(() => axisTicksLog(1, Infinity), /^RangeError: axisTicksLog domain must be positive and finite, got \[1, Infinity\]$/);
    assert.deepEqual(axisTicksLog(1, 1000), [1, 10, 100, 1000]);
  });
});

describe('a sum of finite values past the largest double is drawn by proportion', function () {
  // M and M / 2 are each finite; their sum is not
  /** @param {{x0: number, y0: number, x1: number, y1: number}} r */
  const area = (r) => (r.x1 - r.x0) * (r.y1 - r.y0);
  /** @param {number} actual @param {number} expected @param {string} what */
  const near = (actual, expected, what) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual}, expected ${expected}`);

  it('pie: the slices still turn 360 degrees, in the ratio of their values', function () {
    const slices = [{ label: 'a', value: M }, { label: 'b', value: M / 2 }];
    const ast = buildPieAST({ slices });
    near(ast.slices.reduce((deg, s) => deg + (s.end - s.start) * 180 / Math.PI, 0), 360, 'degrees');
    assert.deepEqual(ast.slices.map((s) => s.frac), [2 / 3, 1 / 3]);
    assert.equal(ast.total, Infinity);
    const svg = svgOf({ type: 'pie', slices });
    assert.doesNotMatch(svg, /NaN|Infinity/);
    assert.match(svg, />a \(66\.7%\)</);
    assert.match(svg, />b \(33\.3%\)</);
  });

  it('treemap: flat tiles, and groups whose children overflow, keep the ratios of their values', function () {
    const flat = buildTreemapAST({ items: [{ label: 'a', value: M }, { label: 'b', value: M / 2 }] });
    assert.deepEqual(flat.tiles.map((t) => [t.label, t.frac]), [['a', 2 / 3], ['b', 1 / 3]]);
    near(area(flat.tiles[0]) / area(flat.tiles[1]), 2, 'a : b');
    near(area(flat.tiles[0]) + area(flat.tiles[1]), 1, 'the unit square');
    const items = [
      { label: 'g', children: [{ label: 'a', value: M }, { label: 'b', value: M / 2 }] },
      { label: 'h', children: [{ label: 'c', value: M / 2 }] },
    ];
    const nested = buildTreemapAST({ items });
    assert.deepEqual(nested.groups.map((g) => [g.label, g.frac]), [['g', 0.75], ['h', 0.25]]);
    assert.deepEqual(nested.tiles.map((t) => [t.label, t.frac]), [['a', 0.5], ['b', 0.25], ['c', 0.25]]);
    near(area(nested.groups[0]) / area(nested.groups[1]), 3, 'g : h');
    near(area(nested.tiles[0]) / area(nested.tiles[1]), 2, 'a : b inside g');
    const svg = svgOf({ type: 'treemap', items });
    assert.doesNotMatch(svg, /NaN|Infinity/);
    assert.match(svg, />g \(75\.0%\)</);
    assert.match(svg, /<title>g \/ a: 1\.7976931348623157e\+308 \(50\.0%\)<\/title>/);
    assert.doesNotMatch(svgOf({ type: 'treemap', items: [{ label: 'a', value: M }, { label: 'b', value: M / 2 }] }),
      /NaN|Infinity/);
    // a leaf whose share falls below the smallest double is laid with no size
    for (const tiny of [[M, M / 2, 1e-20], [123.456, 5e-324]]) {
      const leaves = tiny.map((value, i) => ({ label: `l${i}`, value }));
      const last = buildTreemapAST({ items: leaves }).tiles.at(-1);
      assert.deepEqual([last?.label, area(/** @type {any} */ (last))], [`l${tiny.length - 1}`, 0], String(tiny));
      assert.doesNotMatch(svgOf({ type: 'treemap', items: leaves }), /NaN|Infinity/, String(tiny));
    }
  });

  it('sankey: a layer and a node in-flow past the largest double keep the ratios of their flows', function () {
    const links = [{ source: 'a', target: 'c', value: M }, { source: 'b', target: 'c', value: M / 2 }];
    const ast = buildSankeyAST({ links });
    const h = Object.fromEntries(ast.nodes.map((n) => [n.name, n.y1 - n.y0]));
    assert.ok(h.b > 0, `b is ${h.b} high`);
    near(h.a / h.b, 2, 'a : b');
    near(h.c, h.a + h.b, 'c');
    near(ast.links[0].sy1 - ast.links[0].sy0, h.a, 'the a → c ribbon');
    near(ast.links[1].ty1 - ast.links[1].ty0, h.b, 'the b → c ribbon');
    near(ast.links[0].ty1, ast.links[1].ty0, 'the ribbons stacked down c');
    assert.deepEqual(ast.links.map((l) => l.value), [M, M / 2]);
    assert.doesNotMatch(svgOf({ type: 'sankey', links }), /NaN|Infinity/);
  });

  it('streamgraph: a column past the largest double keeps its bands and their ratio', function () {
    const data = { series: [{ name: 's', values: [M, M / 2] }, { name: 't', values: [M / 2, M / 4] }] };
    const [s, t] = buildStreamgraphAST(data).layers;
    /** @param {{lo: number, hi: number}} p */
    const thick = (p) => p.hi - p.lo;
    assert.deepEqual([s.points[0].lo, t.points[0].hi], [0, 1]);
    near(thick(s.points[0]) / thick(t.points[0]), 2, 's : t');
    near(thick(s.points[1]) / thick(t.points[1]), 2, 's : t in the second column');
    near(thick(s.points[1]) + thick(t.points[1]), 0.5, 'the second column');
    assert.doesNotMatch(svgOf({ type: 'streamgraph', ...data }), /NaN|Infinity/);
  });

  it('heatmap and map: a range of values wider than a double still spreads over the ramp', function () {
    const grid = { xLabels: ['lo', 'mid', 'hi'], yLabels: ['r'], values: [[-H, 0, H]] };
    assert.deepEqual(buildHeatmapAST(grid).cells.map((c) => c.t), [0, 0.5, 1]);
    const svg = svgOf({ type: 'heatmap', ...grid });
    assert.doesNotMatch(svg, /NaN|Infinity/);
    assert.match(svg, new RegExp(`fill="${SEQUENTIAL[0]}" class="chart-heat-cell"><title>lo × r:`));
    assert.match(svg, new RegExp(`fill="${SEQUENTIAL[SEQUENTIAL.length - 1]}" class="chart-heat-cell"><title>hi × r:`));
    const points = [{ at: [0, 0], value: -H }, { at: [1, 1], value: 0 }, { at: [2, 2], value: H }];
    assert.deepEqual(buildMapAST({ points }).shapes.map((s) => s.t), [0, 0.5, 1]);
    assert.doesNotMatch(svgOf({ type: 'map', points }), /NaN|Infinity/);
  });

  it('boxplot: quartiles between samples further apart than a double measures', function () {
    assert.deepEqual([0.25, 0.5, 0.75].map((p) => quantileSorted([-H, H], p)), [-H / 2, 0, H / 2]);
    const boxes = [{ label: 'g', values: [-H, H] }];
    const ast = buildBoxplotAST({ boxes });
    assert.deepEqual(ast.boxes[0].stats, { min: -H, q1: -H / 2, med: 0, q3: H / 2, max: H });
    assert.equal(ast.boxes[0].medV, 0.5);
    const svg = svgOf({ type: 'boxplot', boxes });
    assert.doesNotMatch(svg, /NaN|Infinity/);
    assert.match(svg, /<title>g — min -1e\+308, q1 -5e\+307, median 0, q3 5e\+307, max 1e\+308<\/title>/);
  });
});
