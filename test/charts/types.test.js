//@ts-check
/**
 * AST and render tests for the chart types added after the first five
 * (radar, gauge, boxplot, heatmap, treemap, streamgraph, sankey, map) plus
 * their shared invariants: geometry-free unit-space ASTs, hostile-input
 * tolerance, per-mark hover titles.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  compileChart,
  buildLineAST, buildCandlestickAST,
  buildRadarAST, buildGaugeAST,
  buildBoxplotAST, quantileSorted, buildHeatmapAST,
  buildTreemapAST, renderTreemapAST, createTheme, buildStreamgraphAST, buildSankeyAST, buildMapAST,
  SEQUENTIAL, inkFor,
} from '@jarenjs/charts';
import { projectMercator } from '@jarenjs/core/geo';
import { renderToString } from '@jarenjs/view';

describe('radar AST', function () {
  it('spreads axes over the circle from 12 o\'clock and scales to a nice top', function () {
    const ast = buildRadarAST(
      { axes: ['a', 'b', 'c', 'd'], series: [{ name: 's', values: [1, 2, 3, 4] }] },
      { type: 'radar' });
    assert.equal(ast.axes.length, 4);
    assert.equal(ast.axes[0].angle, -Math.PI / 2);
    assert.ok(Math.abs(ast.axes[1].angle - 0) < 1e-9);
    assert.equal(ast.top, 4);
    assert.equal(ast.series[0].points[3].r, 1);
    assert.equal(ast.legend, null);
  });

  it('config.max pins the domain; values beyond it clamp', function () {
    const ast = buildRadarAST(
      { axes: ['a'], series: [{ name: 's', values: [20] }] },
      { type: 'radar', max: 10 });
    assert.equal(ast.top, 10);
    assert.equal(ast.series[0].points[0].r, 1);
  });

  it('non-finite and negative samples become null vertices', function () {
    const ast = buildRadarAST(
      { axes: ['a', 'b', 'c'], series: [{ name: 's', values: [1, null, -2] }] },
      { type: 'radar' });
    assert.notEqual(ast.series[0].points[0], null);
    assert.equal(ast.series[0].points[1], null);
    assert.equal(ast.series[0].points[2], null);
  });

  it('survives empty input and renders without NaN', function () {
    const ast = buildRadarAST({}, { type: 'radar' });
    assert.deepEqual(ast.axes, []);
    assert.deepEqual(ast.series, []);
    const svg = compileChart({ type: 'radar' }).toSvgString();
    assert.ok(!svg.includes('NaN'));
  });

  it('renders one titled polygon per series plus ring chrome', function () {
    const svg = compileChart({
      type: 'radar', axes: ['x', 'y', 'z'],
      series: [{ name: 'one', values: [1, 2, 3] }, { name: 'two', values: [3, 2, 1] }],
    }).toSvgString();
    assert.equal((svg.match(/chart-radar-series/g) ?? []).length, 2);
    assert.match(svg, /<title>one<\/title>/);
    assert.match(svg, /chart-grid/);
    assert.ok(!svg.includes('NaN'));
  });

  it('falls back to ring circles below three axes', function () {
    const svg = compileChart({
      type: 'radar', axes: ['solo'], series: [{ name: 's', values: [1] }],
    }).toSvgString();
    assert.match(svg, /<circle[^>]*class="chart-grid"/);
  });

  it('labels every axis up to a dozen, then thins to a stride', function () {
    const axesOf = (n) => Array.from({ length: n }, (_, i) => `axis${i}`);
    assert.equal(buildRadarAST({ axes: axesOf(12) }, {}).labelEvery, 1);
    assert.equal(buildRadarAST({ axes: axesOf(13) }, {}).labelEvery, 2);
    assert.equal(buildRadarAST({ axes: axesOf(24) }, {}).labelEvery, 2);
    assert.equal(buildRadarAST({ axes: axesOf(30) }, {}).labelEvery, 3);
    const many = buildRadarAST({ axes: axesOf(30) }, {});
    assert.equal(many.axes.filter((a) => a.labeled).length, 10);
    assert.equal(many.axes[0].labeled, true);
    assert.equal(many.axes[1].labeled, false);
  });

  it('config.labelEvery overrides the derived stride', function () {
    const ast = buildRadarAST({ axes: ['a', 'b', 'c', 'd'] }, { labelEvery: 2 });
    assert.deepEqual(ast.axes.map((a) => a.labeled), [true, false, true, false]);
    // hostile strides fall back to the derived one
    for (const labelEvery of [0, -1, 1.5, 'two', null])
      assert.equal(buildRadarAST({ axes: ['a', 'b'] }, { labelEvery }).labelEvery, 1);
  });

  it('a thinned axis keeps its name as spoke hover text', function () {
    const axes = Array.from({ length: 20 }, (_, i) => `axis${i}`);
    const svg = compileChart({
      type: 'radar', axes, series: [{ name: 's', values: axes.map(() => 1) }],
    }).toSvgString();
    assert.match(svg, /class="chart-axis"><title>axis1<\/title>/); // thinned away, still named
    assert.match(svg, /class="chart-axis-label">axis0</); // drawn as a label
    assert.doesNotMatch(svg, /class="chart-axis-label">axis1</);
    assert.equal((svg.match(/class="chart-axis-label"/g) ?? []).length, 10);
    assert.ok(!svg.includes('NaN'));
  });
});

describe('gauge AST', function () {
  it('clamps the fill fraction into the domain', function () {
    assert.equal(buildGaugeAST({ value: 50 }, { type: 'gauge' }).frac, 0.5);
    assert.equal(buildGaugeAST({ value: 250 }, { type: 'gauge' }).frac, 1);
    assert.equal(buildGaugeAST({ value: -5 }, { type: 'gauge' }).frac, 0);
  });

  it('honors a custom domain and guards a degenerate one', function () {
    const ast = buildGaugeAST({ value: 3 }, { type: 'gauge', min: 2, max: 4 });
    assert.equal(ast.frac, 0.5);
    const degenerate = buildGaugeAST({ value: 5 }, { type: 'gauge', min: 5, max: 5 });
    assert.equal(degenerate.max, 6);
    assert.ok(Number.isFinite(degenerate.frac));
  });

  it('guards a non-numeric value and keeps ticks in range', function () {
    const ast = buildGaugeAST({}, { type: 'gauge' });
    assert.equal(ast.value, 0);
    assert.ok(ast.ticks.length > 0);
    for (const tick of ast.ticks)
      assert.ok(tick.frac >= 0 && tick.frac <= 1);
  });

  it('renders track, fill, and the headline value with its unit', function () {
    const svg = compileChart({ type: 'gauge', value: 87.4, unit: '%', tone: 'win' }).toSvgString();
    assert.match(svg, /chart-gauge-track/);
    assert.match(svg, /chart-gauge-fill/);
    assert.match(svg, /87\.4 %/);
    assert.match(svg, /stroke="#16a34a"/); // the win tone colors the fill
    assert.ok(!svg.includes('NaN'));
  });

  it('a zero fill draws the track only', function () {
    const svg = compileChart({ type: 'gauge', value: 0 }).toSvgString();
    assert.doesNotMatch(svg, /chart-gauge-fill/);
  });
});

describe('boxplot AST', function () {
  it('interpolates quartiles over sorted samples', function () {
    assert.equal(quantileSorted([1, 2, 3, 4, 5], 0.5), 3);
    assert.equal(quantileSorted([1, 2, 3, 4], 0.5), 2.5);
    assert.equal(quantileSorted([1, 2, 3, 4, 5], 0.25), 2);
    assert.equal(quantileSorted([10], 0.75), 10);
  });

  it('computes Tukey whiskers and outliers from raw values', function () {
    const ast = buildBoxplotAST(
      { boxes: [{ label: 'a', values: [1, 2, 2, 3, 3, 3, 4, 4, 5, 6, 100] }] },
      { type: 'boxplot' });
    const box = ast.boxes[0];
    assert.equal(box.stats.med, 3);
    assert.equal(box.stats.max, 100);
    assert.equal(box.outliersV.length, 1); // 100 sits far outside the 1.5·IQR fence
    assert.ok(box.hiV < 1); // the whisker stops at the last inlier, not the outlier
    assert.ok(box.loV <= box.q1V && box.q1V <= box.medV
      && box.medV <= box.q3V && box.q3V <= box.hiV);
  });

  it('trusts a precomputed five-number summary as given', function () {
    const ast = buildBoxplotAST(
      { boxes: [{ label: 's', min: 2, q1: 5, med: 7, q3: 10, max: 14, outliers: [20] }] },
      { type: 'boxplot' });
    const box = ast.boxes[0];
    assert.equal(box.stats.q1, 5);
    assert.equal(box.outliersV.length, 1);
  });

  it('drops empty and malformed boxes, survives no data', function () {
    const ast = buildBoxplotAST(
      { boxes: [{ label: 'x', values: [NaN] }, { label: 'y', min: 1, q1: 2 }] },
      { type: 'boxplot' });
    assert.deepEqual(ast.boxes, []);
    assert.ok(Array.isArray(buildBoxplotAST({}, {}).boxes));
  });

  it('renders whiskers, a titled box, the median line and outlier dots', function () {
    const svg = compileChart({
      type: 'boxplot',
      boxes: [{ label: 'a', values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 40] }],
    }).toSvgString();
    assert.match(svg, /chart-box-whisker/);
    assert.match(svg, /chart-box-median/);
    assert.match(svg, /<title>a — min 1, q1 [^<]*max 40<\/title>/);
    assert.match(svg, /chart-dot/);
    assert.ok(!svg.includes('NaN'));
  });
});

describe('heatmap AST', function () {
  const DATA = {
    xLabels: ['c1', 'c2'],
    yLabels: ['r1', 'r2'],
    values: [[1, 2], [3, 4]],
  };

  it('normalizes cell magnitudes over the finite extent', function () {
    const ast = buildHeatmapAST(DATA, { type: 'heatmap' });
    assert.equal(ast.cells.length, 4);
    assert.deepEqual(ast.domain, { min: 1, max: 4 });
    assert.equal(ast.cells[0].t, 0);
    assert.equal(ast.cells[3].t, 1);
  });

  it('reads rows top-down: the first row owns the top band', function () {
    const ast = buildHeatmapAST(DATA, { type: 'heatmap' });
    const first = ast.cells[0];
    assert.equal(first.yi, 0);
    assert.equal(first.v1, 1); // top of the plot
    assert.equal(ast.y.ticks[0].pos, 0.75);
  });

  it('log mode normalizes in decades and drops non-positive cells', function () {
    const ast = buildHeatmapAST(
      { xLabels: ['a', 'b', 'c'], yLabels: ['r'], values: [[1, 100, 0]] },
      { type: 'heatmap', log: true });
    assert.equal(ast.cells.length, 2);
    assert.equal(ast.cells[0].t, 0);
    assert.equal(ast.cells[1].t, 1);
  });

  it('skips non-finite cells and survives empty or ragged input', function () {
    const ast = buildHeatmapAST(
      { xLabels: ['a', 'b'], yLabels: ['r1', 'r2'], values: [[NaN, 5]] },
      { type: 'heatmap' });
    assert.equal(ast.cells.length, 1);
    assert.equal(ast.cells[0].t, 0.5); // a single value sits mid-ramp
    assert.equal(buildHeatmapAST({}, {}).domain, null);
    assert.ok(!compileChart({ type: 'heatmap' }).toSvgString().includes('NaN'));
  });

  it('renders ramp-colored cells with value titles and the ramp key', function () {
    const svg = compileChart({ type: 'heatmap', ...DATA }).toSvgString();
    assert.match(svg, /chart-heat-cell/);
    assert.match(svg, /<title>c1 × r1: 1<\/title>/);
    assert.match(svg, new RegExp(`fill="${SEQUENTIAL[0]}"`)); // t=0 end of the ramp
    assert.match(svg, new RegExp(`fill="${SEQUENTIAL[SEQUENTIAL.length - 1]}"`)); // t=1 end
    assert.match(svg, /chart-swatch/); // the legend-slot ramp key
    assert.ok(!svg.includes('NaN'));
  });
});

describe('treemap AST', function () {
  it('tiles cover the unit square with value-descending fractions', function () {
    const ast = buildTreemapAST(
      { items: [{ label: 'b', value: 1 }, { label: 'a', value: 3 }] },
      { type: 'treemap' });
    assert.equal(ast.tiles[0].label, 'a'); // sorted descending
    assert.equal(ast.tiles[0].frac, 0.75);
    let area = 0;
    for (const tile of ast.tiles) {
      assert.ok(tile.x0 >= 0 && tile.x1 <= 1 && tile.y0 >= 0 && tile.y1 <= 1);
      area += (tile.x1 - tile.x0) * (tile.y1 - tile.y0);
    }
    assert.ok(Math.abs(area - 1) < 1e-9);
  });

  it('tile area is proportional to value under the layout aspect', function () {
    const ast = buildTreemapAST(
      { items: [{ label: 'a', value: 6 }, { label: 'b', value: 2 }, { label: 'c', value: 2 }] },
      { type: 'treemap' });
    const areaOf = (tile) => (tile.x1 - tile.x0) * (tile.y1 - tile.y0);
    assert.ok(Math.abs(areaOf(ast.tiles[0]) - 0.6) < 1e-9);
    assert.ok(Math.abs(areaOf(ast.tiles[1]) - 0.2) < 1e-9);
  });

  it('squarified rows keep aspect ratios sane over many items', function () {
    const items = Array.from({ length: 20 }, (_, i) => ({ label: `i${i}`, value: 21 - i }));
    const ast = buildTreemapAST({ items }, { type: 'treemap', aspect: 1.6 });
    for (const tile of ast.tiles) {
      const w = (tile.x1 - tile.x0) * 1.6;
      const h = tile.y1 - tile.y0;
      const ratio = Math.max(w / h, h / w);
      assert.ok(ratio < 4, `tile ${tile.label} aspect ${ratio}`);
    }
  });

  it('drops non-positive and non-finite values, survives empty input', function () {
    const ast = buildTreemapAST(
      { items: [{ label: 'x', value: 0 }, { label: 'y', value: NaN }] },
      { type: 'treemap' });
    assert.deepEqual(ast.tiles, []);
    assert.equal(ast.total, 0);
    assert.ok(!compileChart({ type: 'treemap' }).toSvgString().includes('NaN'));
  });

  it('renders titled tiles and in-tile labels with luminance-picked ink', function () {
    const svg = compileChart({
      type: 'treemap',
      items: [{ label: 'large', value: 90 }, { label: 'small', value: 10 }],
    }).toSvgString();
    assert.match(svg, /chart-treemap-tile/);
    assert.match(svg, /<title>large: 90 \(90\.0%\)<\/title>/);
    assert.match(svg, /chart-treemap-label/);
    assert.ok(!svg.includes('NaN'));
  });

  it('one hierarchy level: groups squarify, children squarify inside them', function () {
    const ast = buildTreemapAST({
      items: [
        { label: 'validate', children: [{ label: 'keywords', value: 30 }, { label: 'compile', value: 20 }] },
        { label: 'json', children: [{ label: 'path', value: 25 }, { label: 'pointer', value: 5 }] },
      ],
    }, { type: 'treemap' });
    assert.equal(ast.total, 80);
    assert.deepEqual(ast.groups.map((g) => [g.label, g.value]), [['validate', 50], ['json', 30]]);
    let groupArea = 0;
    for (const group of ast.groups) groupArea += (group.x1 - group.x0) * (group.y1 - group.y0);
    assert.ok(Math.abs(groupArea - 1) < 1e-9);
    for (const tile of ast.tiles) {
      const group = ast.groups.find((g) => g.label === tile.group);
      assert.ok(tile.x0 >= group.x0 - 1e-9 && tile.x1 <= group.x1 + 1e-9);
      // children start below the group's naming band
      assert.ok(tile.y0 >= group.y0 + group.header - 1e-9 && tile.y1 <= group.y1 + 1e-9);
    }
    // tiles are proportional WITHIN their group (the header is the group's)
    const group = ast.groups[0];
    const inner = (group.x1 - group.x0) * (group.y1 - group.y0 - group.header);
    const kids = ast.tiles.filter((t) => t.group === 'validate');
    assert.ok(Math.abs((kids[0].x1 - kids[0].x0) * (kids[0].y1 - kids[0].y0) / inner - 30 / 50) < 1e-9);
  });

  it('a group takes one hue; a childless item becomes a group of one', function () {
    const ast = buildTreemapAST({
      items: [
        { label: 'pkg', children: [{ label: 'a', value: 2 }, { label: 'b', value: 1 }] },
        { label: 'loose', value: 4 },
      ],
    }, { type: 'treemap' });
    assert.deepEqual(ast.tiles.map((t) => [t.group, t.label, t.swatch]),
      [['loose', 'loose', 0], ['pkg', 'a', 1], ['pkg', 'b', 1]]);
  });

  it('renders group names and titles that spell out the path', function () {
    const svg = compileChart({
      type: 'treemap', title: 'Nested',
      items: [{ label: 'validate', children: [{ label: 'keywords', value: 30 }, { label: 'compile', value: 20 }] }],
    }).toSvgString();
    assert.match(svg, /chart-treemap-group/);
    assert.match(svg, />validate \(100\.0%\)</);
    assert.match(svg, /<title>validate \/ keywords: 30 \(60\.0%\)<\/title>/);
    assert.ok(!svg.includes('NaN'));
  });

  it('a flat treemap keeps its old shape: no groups, no seams', function () {
    const ast = buildTreemapAST({ items: [{ label: 'a', value: 1 }] }, { type: 'treemap' });
    assert.deepEqual(ast.groups, []);
    assert.equal(ast.tiles[0].group, null);
    assert.doesNotMatch(compileChart({ type: 'treemap', items: [{ label: 'a', value: 1 }] }).toSvgString(),
      /chart-treemap-tile[^>]*stroke=/);
  });

  describe('deeper nesting', function () {
    const r6 = (n) => Math.round(n * 1e6) / 1e6;
    const rect = (o) => [o.x0, o.y0, o.x1, o.y1].map(r6);
    const groupsOf = (ast) => ast.groups.map((g) => [g.label, g.depth, g.value, r6(g.frac), rect(g), r6(g.header), g.swatch]);
    const tilesOf = (ast) => ast.tiles.map((t) => [t.path.join('/'), t.group, t.label, t.value, r6(t.frac), rect(t), t.swatch]);
    /** A group chain `n` deep: each level holds a leaf of 1 beside the next level. */
    const chain = (n) => {
      let node = { label: `L${n - 1}`, children: [{ label: 'leaf', value: 1 }] };
      for (let i = n - 2; i >= 0; i--) node = { label: `L${i}`, children: [{ label: `k${i}`, value: 1 }, node] };
      return node;
    };

    it('a group inside a group is laid out, not dropped: exact layout', function () {
      const ast = buildTreemapAST({
        items: [
          {
            label: 'a', children: [
              { label: 'a1', children: [{ label: 'x', value: 6 }, { label: 'y', value: 2 }] },
              { label: 'a2', value: 4 },
            ],
          },
          { label: 'b', value: 8 },
        ],
      }, { type: 'treemap', aspect: 1 });
      assert.equal(ast.total, 20);
      assert.deepEqual(groupsOf(ast), [
        ['a', 0, 12, 0.6, [0, 0, 1, 0.6], 0.06, 0],
        ['a1', 1, 8, 0.4, [0, 0.06, 0.666667, 0.6], 0.06, 0],
        ['b', 0, 8, 0.4, [0, 0.6, 1, 1], 0.06, 1],
      ]);
      // a1 (8) outweighs the leaf a2 (4), so it is laid first; its leaves
      // start below its own band and the whole subtree keeps a's hue
      assert.deepEqual(tilesOf(ast), [
        ['a/a1', 'a1', 'x', 6, 0.3, [0, 0.12, 0.5, 0.6], 0],
        ['a/a1', 'a1', 'y', 2, 0.1, [0.5, 0.12, 0.666667, 0.6], 0],
        ['a', 'a', 'a2', 4, 0.2, [0.666667, 0.06, 1, 0.6], 0],
        ['b', 'b', 'b', 8, 0.4, [0, 0.66, 1, 1], 1],
      ]);
    });

    it('the tiles of every depth tile the leaves: areas follow values, rects stay inside their groups', function () {
      const ast = buildTreemapAST({
        items: [
          { label: 'p', children: [{ label: 'q', children: [{ label: 'r', children: [{ label: 'l1', value: 5 }, { label: 'l2', value: 3 }] }, { label: 'l3', value: 4 }] }, { label: 'l4', value: 8 }] },
          { label: 'l5', value: 10 },
        ],
      }, { type: 'treemap', aspect: 1.6 });
      assert.equal(ast.total, 30);
      assert.deepEqual(ast.groups.map((g) => [g.label, g.depth]), [['p', 0], ['q', 1], ['r', 2], ['l5', 0]]);
      assert.deepEqual(ast.tiles.map((t) => [t.path.join('/'), t.label]), [
        ['p/q/r', 'l1'], ['p/q/r', 'l2'], ['p/q', 'l3'], ['p', 'l4'], ['l5', 'l5'],
      ]);
      const area = (o) => (o.x1 - o.x0) * (o.y1 - o.y0);
      let leafArea = 0;
      for (const tile of ast.tiles) {
        leafArea += area(tile);
        assert.ok(Math.abs(tile.frac - tile.value / 30) < 1e-12, tile.label);
      }
      // the bands are the only area the leaves do not cover
      let bands = 0;
      for (const g of ast.groups) bands += (g.x1 - g.x0) * g.header;
      assert.ok(Math.abs(leafArea + bands - 1) < 1e-9, `${leafArea} + ${bands}`);
      for (const tile of ast.tiles) {
        for (const label of tile.path) {
          const g = ast.groups.find((x) => x.label === label);
          assert.ok(tile.x0 >= g.x0 - 1e-9 && tile.x1 <= g.x1 + 1e-9 && tile.y0 >= g.y0 + g.header - 1e-9 && tile.y1 <= g.y1 + 1e-9,
            `${tile.label} escapes ${label}`);
        }
      }
    });

    it('hover text and group names spell out the path', function () {
      const svg = compileChart({
        type: 'treemap', aspect: 1.6,
        items: [{ label: 'a', children: [{ label: 'b', children: [{ label: 'c', value: 3 }, { label: 'd', value: 1 }] }, { label: 'e', value: 4 }] }],
      }).toSvgString();
      assert.match(svg, /<title>a \/ b \/ c: 3 \(37\.5%\)<\/title>/);
      assert.match(svg, /<title>a \/ e: 4 \(50\.0%\)<\/title>/);
      assert.match(svg, />a \(100\.0%\)</);
      assert.match(svg, />b \(50\.0%\)</);
      assert.ok(!svg.includes('NaN'));
    });

    it('a nested group under 1% of the map collapses into its parent as one tile', function () {
      const small = buildTreemapAST({
        items: [{
          label: 'a', children: [
            { label: 'a1', children: [{ label: 'x', value: 1 }, { label: 'y', value: 1 }] },
            { label: 'a2', value: 198 },
          ],
        }],
      }, { type: 'treemap', aspect: 1 });
      assert.deepEqual(groupsOf(small), [['a', 0, 200, 1, [0, 0, 1, 1], 0.06, 0]]);
      assert.deepEqual(tilesOf(small), [
        ['a', 'a', 'a2', 198, 0.99, [0, 0.06, 0.99, 1], 0],
        ['a', 'a', 'a1', 2, 0.01, [0.99, 0.06, 1, 1], 0],
      ]);
      // twice the weight puts it over the line: it keeps its band and its parts
      const kept = buildTreemapAST({
        items: [{
          label: 'a', children: [
            { label: 'a1', children: [{ label: 'x', value: 2 }, { label: 'y', value: 2 }] },
            { label: 'a2', value: 196 },
          ],
        }],
      }, { type: 'treemap', aspect: 1 });
      assert.deepEqual(groupsOf(kept), [
        ['a', 0, 200, 1, [0, 0, 1, 1], 0.06, 0],
        ['a1', 1, 4, 0.02, [0.98, 0.06, 1, 1], 0.06, 0],
      ]);
      assert.deepEqual(tilesOf(kept).map((t) => t.slice(0, 5)), [
        ['a', 'a', 'a2', 196, 0.98],
        ['a/a1', 'a1', 'x', 2, 0.01],
        ['a/a1', 'a1', 'y', 2, 0.01],
      ]);
    });

    it('a top-level group keeps its children however small it is', function () {
      const ast = buildTreemapAST({
        items: [{ label: 'big', value: 1000 }, { label: 'tiny', children: [{ label: 'x', value: 1 }, { label: 'y', value: 1 }] }],
      }, { type: 'treemap', aspect: 1 });
      assert.deepEqual(ast.groups.map((g) => g.label), ['big', 'tiny']);
      assert.deepEqual(ast.tiles.map((t) => t.label), ['big', 'x', 'y']);
    });

    it('the bands from a top-level group to any leaf total at most a third of its height', function () {
      const ast = buildTreemapAST({ items: [chain(8)] }, { type: 'treemap', aspect: 1 });
      assert.deepEqual(ast.groups.map((g) => [g.label, g.depth, r6(g.header), r6(g.y0)]), [
        ['L0', 0, 0.06, 0], ['L1', 1, 0.06, 0.06], ['L2', 2, 0.06, 0.12], ['L3', 3, 0.06, 0.18],
        ['L4', 4, 0.06, 0.24],
        // the budget runs out: what is left of the third, then no band at all
        ['L5', 5, 0.033333, 0.3], ['L6', 6, 0, 0.333333], ['L7', 7, 0, 0.333333],
      ]);
      const top = ast.groups[0];
      const spine = ast.groups.reduce((sum, g) => sum + g.header, 0);
      assert.ok(Math.abs(spine - (top.y1 - top.y0) / 3) < 1e-12, String(spine));
      const leaf = ast.tiles.find((t) => t.label === 'leaf');
      assert.ok(leaf && leaf.y1 - leaf.y0 > 0.3, 'the deepest leaf still has a body');
      // a nested group past the budget draws no band text
      const svg = compileChart({ type: 'treemap', items: [chain(8)] }).toSvgString();
      assert.equal((svg.match(/chart-treemap-group/g) ?? []).length, 5);
    });

    it('a short nested group never gives more than a third of its height to its band', function () {
      const ast = buildTreemapAST({
        items: [{ label: 'a', children: [{ label: 'b', children: [{ label: 'c', value: 1 }, { label: 'd', value: 1 }] }, { label: 'e', value: 30 }] }],
      }, { type: 'treemap', aspect: 1 });
      const b = ast.groups.find((g) => g.label === 'b');
      assert.ok(b && b.header <= (b.y1 - b.y0) / 3 + 1e-12);
    });

    it('drops what holds no leaf at any depth, and ignores a value on a group', function () {
      const ast = buildTreemapAST({
        items: [
          { label: 'g', value: 99, children: [{ label: 'empty', children: [] }, { label: 'dead', children: [{ label: 'z', value: 0 }, { label: 'n', value: NaN }] }, { label: 'ok', value: 2 }] },
          { label: 'void', children: [{ label: 'dead', children: [] }] },
        ],
      }, { type: 'treemap', aspect: 1 });
      assert.deepEqual(ast.groups.map((g) => [g.label, g.value]), [['g', 2]]);
      assert.deepEqual(ast.tiles.map((t) => [t.path.join('/'), t.label, t.value]), [['g', 'ok', 2]]);
      assert.equal(ast.total, 2);
    });

    it('groups nest 64 levels deep; one more is refused by name, at any size, with its pointer', function () {
      const ast = buildTreemapAST({ items: [chain(64)] }, { type: 'treemap', aspect: 1 });
      assert.equal(ast.total, 64);
      assert.equal(ast.groups[0].label, 'L0');
      assert.equal(Math.max(...ast.groups.map((g) => g.depth)), ast.groups.length - 1);
      assert.ok(ast.groups.length > 50);
      // the text a chart carries stays bounded: a path is at most 64 labels
      assert.ok(ast.tiles.every((t) => t.path.length <= 64));
      const svg = compileChart({ type: 'treemap', items: [chain(64)] }).toSvgString();
      assert.ok(svg.length < 40000, `svg is ${svg.length} bytes`);
      const pointer = (n) => `/items/0${'/children/1'.repeat(n)}`;
      for (const n of [65, 8000]) {
        for (const run of [
          () => buildTreemapAST({ items: [chain(n)] }),
          () => compileChart({ type: 'treemap', items: [chain(n)] }),
        ]) {
          assert.throws(run, (err) => {
            assert.equal(err.name, 'ChartError');
            assert.equal(err.code, 'CH0001');
            assert.equal(err.reason, 'a treemap nests groups at most 64 deep');
            assert.equal(err.docPath, pointer(64));
            return true;
          });
        }
      }
      // the same bound for a top-level sibling after others
      assert.throws(() => buildTreemapAST({ items: [{ label: 'x', value: 1 }, chain(65)] }),
        (err) => err.code === 'CH0001' && err.docPath === `/items/1${'/children/1'.repeat(64)}`);
    });

    it('an AST without path and depth still renders, reading the path as [group]', function () {
      const config = {
        type: 'treemap', aspect: 1.6,
        items: [{ label: 'pkg', children: [{ label: 'a', value: 3 }, { label: 'b', value: 1 }] }],
      };
      const ast = buildTreemapAST(config, config);
      const old = {
        ...ast,
        tiles: ast.tiles.map((tile) => Object.fromEntries(Object.entries(tile).filter(([key]) => key !== 'path'))),
        groups: ast.groups.map((group) => Object.fromEntries(Object.entries(group).filter(([key]) => key !== 'depth'))),
      };
      const theme = createTheme();
      const svg = renderToString(renderTreemapAST(/** @type {any} */ (old), theme, 'h'));
      assert.equal(svg, renderToString(renderTreemapAST(ast, theme, 'h')));
      assert.match(svg, /<title>pkg \/ a: 3 \(75\.0%\)<\/title>/);
    });

    it('an item with an empty children list is a leaf when it has a value, as it always was', function () {
      const ast = buildTreemapAST({
        items: [{
          label: 'g', children: [
            { label: 'c', value: 5, children: [] },
            { label: 'd', value: 2 },
            { label: 'e', children: [] },
          ],
        }],
      }, { type: 'treemap', aspect: 1 });
      assert.equal(ast.total, 7);
      assert.deepEqual(ast.groups.map((g) => g.label), ['g']);
      assert.deepEqual(ast.tiles.map((t) => [t.path.join('/'), t.label, t.value]), [['g', 'c', 5], ['g', 'd', 2]]);
      // at the top level an empty group has always been dropped, value or not
      const top = buildTreemapAST({
        items: [{ label: 'x', value: 4, children: [] }, { label: 'y', children: [{ label: 'z', value: 1 }] }],
      }, { type: 'treemap' });
      assert.deepEqual(top.groups.map((g) => g.label), ['y']);
      assert.equal(top.total, 1);
    });

    it('items without labels are named by the empty string at every level', function () {
      const ast = buildTreemapAST({
        items: [{ children: [{ children: [{ value: 1 }, { label: 'k', value: 1 }] }, { value: 2 }] }, { value: 4 }],
      }, { type: 'treemap', aspect: 1 });
      assert.deepEqual(ast.groups.map((g) => [g.label, g.depth]), [['', 0], ['', 1], ['', 0]]);
      assert.deepEqual(ast.tiles.map((t) => [t.path.join('/'), t.label, t.value]),
        [['/', '', 1], ['/', 'k', 1], ['', '', 2], ['', '', 4]]);
    });

    it('the 1% line sits at 1% of the map: just under collapses, at it and over it subdivide', function () {
      // a2 is 100 and the group g is w, in a top group whose body is 94% of
      // the map; these three weights give g a rect of 0.009999999999999998,
      // 0.01 and 0.010000000000000002 of the map
      const lay = (w) => buildTreemapAST({
        items: [{
          label: 'a', children: [
            { label: 'g', children: [{ label: 'x', value: w / 2 }, { label: 'y', value: w / 2 }] },
            { label: 'r', value: 100 },
          ],
        }],
      }, { type: 'treemap', aspect: 1 });
      assert.deepEqual(lay(1.075268817204301).groups.map((g) => g.label), ['a']);
      assert.deepEqual(lay(1.0752688172043015).groups.map((g) => g.label), ['a', 'g']);
      assert.deepEqual(lay(1.0752688172043017).groups.map((g) => g.label), ['a', 'g']);
      assert.deepEqual(lay(1.075268817204301).tiles.map((t) => t.label), ['r', 'g']);
    });

    it('overflowing leaves keep the ratios of their values at depth', function () {
      const M = Number.MAX_VALUE;
      const ast = buildTreemapAST({
        items: [{ label: 'g', children: [{ label: 'h', children: [{ label: 'a', value: M }, { label: 'b', value: M / 2 }] }, { label: 'c', value: M / 2 }] }],
      }, { type: 'treemap' });
      assert.deepEqual(ast.tiles.map((t) => [t.label, t.frac]), [['a', 0.5], ['b', 0.25], ['c', 0.25]]);
      assert.equal(ast.total, Infinity);
    });
  });

  it('inkFor flips between dark and light ink at the luminance threshold', function () {
    assert.equal(inkFor('#f59e0b'), '#1f2020'); // amber is light
    assert.equal(inkFor('#1e40af'), '#ffffff'); // deep blue is dark
  });
});

describe('streamgraph AST', function () {
  it('stacks around a silhouette baseline (symmetric outline)', function () {
    const ast = buildStreamgraphAST(
      { series: [{ name: 'a', values: [2, 4] }, { name: 'b', values: [2, 4] }] },
      { type: 'streamgraph' });
    const [a, b] = ast.layers;
    // Both samples center on 0: outline sits symmetric around v=0.5.
    assert.ok(Math.abs((a.points[1].lo + b.points[1].hi) / 2 - 0.5) < 1e-9);
    assert.equal(a.points[1].hi, b.points[1].lo); // layers touch
    assert.equal(a.points[0].u, 0);
    assert.equal(a.points[1].u, 1);
  });

  it('the widest stack spans the full unit range', function () {
    const ast = buildStreamgraphAST(
      { series: [{ name: 'a', values: [1, 10] }] },
      { type: 'streamgraph' });
    assert.equal(ast.layers[0].points[1].lo, 0);
    assert.equal(ast.layers[0].points[1].hi, 1);
  });

  it('negative and non-finite samples read as zero thickness', function () {
    const ast = buildStreamgraphAST(
      { series: [{ name: 'a', values: [-5, NaN, 3] }] },
      { type: 'streamgraph' });
    assert.equal(ast.layers[0].points[0].lo, ast.layers[0].points[0].hi);
    assert.equal(ast.layers[0].points[1].lo, ast.layers[0].points[1].hi);
  });

  it('numeric xs place samples on a real x axis', function () {
    const ast = buildStreamgraphAST(
      { xs: [0, 10, 40], series: [{ name: 'a', values: [1, 2, 3] }] },
      { type: 'streamgraph' });
    assert.equal(ast.layers[0].points[1].u, 0.25);
    assert.ok(ast.x.ticks.length > 0);
  });

  it('survives empty input and renders closed band paths with titles', function () {
    assert.deepEqual(buildStreamgraphAST({}, {}).layers, []);
    const svg = compileChart({
      type: 'streamgraph',
      series: [{ name: 'a', values: [1, 2, 1] }, { name: 'b', values: [2, 1, 2] }],
    }).toSvgString();
    assert.equal((svg.match(/chart-stream-band/g) ?? []).length, 2);
    assert.match(svg, /<title>a<\/title>/);
    assert.match(svg, / Z"/);
    assert.ok(!svg.includes('NaN'));
  });
});

describe('sankey AST', function () {
  const LINKS = [
    { source: 'in1', target: 'mid', value: 3 },
    { source: 'in2', target: 'mid', value: 1 },
    { source: 'mid', target: 'out', value: 4 },
  ];

  it('collects nodes from links and layers by longest path', function () {
    const ast = buildSankeyAST({ links: LINKS }, { type: 'sankey' });
    const byName = Object.fromEntries(ast.nodes.map((n) => [n.name, n]));
    assert.equal(byName.in1.layer, 0);
    assert.equal(byName.mid.layer, 1);
    assert.equal(byName.out.layer, 2);
    assert.equal(byName.in1.x0, 0);
    assert.ok(Math.abs(byName.out.x1 - 1) < 1e-9);
  });

  it('sizes nodes by throughput and links by value on one scale', function () {
    const ast = buildSankeyAST({ links: LINKS }, { type: 'sankey' });
    const byName = Object.fromEntries(ast.nodes.map((n) => [n.name, n]));
    const h = (n) => n.y1 - n.y0;
    assert.ok(Math.abs(h(byName.in1) - 3 * h(byName.in2) / 1) < 1e-9);
    assert.ok(Math.abs(h(byName.mid) - h(byName.out)) < 1e-9);
    const link = ast.links[0];
    assert.ok(Math.abs((link.sy1 - link.sy0) - h(byName.in1)) < 1e-9);
  });

  it('ribbon slots stack down the node faces without overlap', function () {
    const ast = buildSankeyAST({ links: LINKS }, { type: 'sankey' });
    const intoMid = ast.links.filter((l) => ast.nodes[l.target].name === 'mid');
    assert.equal(intoMid.length, 2);
    assert.ok(Math.abs(intoMid[0].ty1 - intoMid[1].ty0) < 1e-9);
  });

  it('drops self-links, cycle-closers and non-positive values', function () {
    const ast = buildSankeyAST({
      links: [
        { source: 'a', target: 'b', value: 2 },
        { source: 'b', target: 'a', value: 1 }, // closes a cycle
        { source: 'a', target: 'a', value: 1 }, // self
        { source: 'a', target: 'b', value: 0 }, // non-positive
        { source: 'a', target: 'b', value: NaN },
      ],
    }, { type: 'sankey' });
    assert.equal(ast.links.length, 1);
    assert.equal(ast.links[0].value, 2);
  });

  it('accepts explicit node lists with index-addressed links', function () {
    const ast = buildSankeyAST({
      nodes: ['x', { name: 'y' }],
      links: [{ source: 0, target: 1, value: 5 }],
    }, { type: 'sankey' });
    assert.equal(ast.links.length, 1);
    assert.equal(ast.nodes[ast.links[0].target].name, 'y');
  });

  it('reorders a layer to uncross its ribbons', function () {
    // as declared, a→y and b→x cross; barycenter ordering swaps x and y
    const ast = buildSankeyAST({
      nodes: ['a', 'b', 'x', 'y'],
      links: [{ source: 'a', target: 'y', value: 5 }, { source: 'b', target: 'x', value: 5 }],
    }, { type: 'sankey' });
    assert.deepEqual(ast.nodes.map((n) => n.name), ['a', 'b', 'y', 'x']);
    for (const link of ast.links)
      assert.ok(Math.abs(link.sy0 - link.ty0) < 1e-9, 'each ribbon runs straight across');
  });

  it('an already-uncrossed graph keeps its input order', function () {
    const ast = buildSankeyAST({ links: LINKS }, { type: 'sankey' });
    assert.deepEqual(ast.nodes.map((n) => n.name), ['in1', 'in2', 'mid', 'out']);
  });

  it('ribbons stack down a face by where they land, not by input order', function () {
    // the link to the LOWER target is declared first; it must sit lower
    const ast = buildSankeyAST({
      nodes: ['h', 'up', 'down'],
      links: [{ source: 'h', target: 'down', value: 1 }, { source: 'h', target: 'up', value: 1 }],
    }, { type: 'sankey' });
    const [toDown, toUp] = ast.links;
    assert.equal(ast.nodes[toUp.target].name, 'up');
    assert.ok(toUp.sy0 < toDown.sy0);
  });

  it('survives empty input and renders nodes, ribbons and flow titles', function () {
    assert.deepEqual(buildSankeyAST({}, {}).links, []);
    const svg = compileChart({ type: 'sankey', links: LINKS }).toSvgString();
    assert.match(svg, /chart-sankey-node/);
    assert.match(svg, /chart-sankey-link/);
    assert.match(svg, /<title>in1 → mid: 3<\/title>/);
    assert.match(svg, /chart-sankey-label/);
    assert.ok(!svg.includes('NaN'));
  });
});

describe('line domain policies', function () {
  const rising = Array.from({ length: 100 }, (_, i) => ({ x: i, y: 50 + 5 * Math.sin(i / 5) + i * 0.05 }));

  it('every build resolves and records its domain', function () {
    const ast = buildLineAST({ series: [{ name: 'a', points: [{ x: 0, y: 1 }, { x: 2, y: 3 }] }] }, { type: 'line' });
    assert.deepEqual(ast.domain.x, [0, 2]);
    assert.ok(ast.domain.y[0] <= 1 && ast.domain.y[1] >= 3);
  });

  it('pinned y bounds clamp out-of-range samples to the plot edge', function () {
    const ast = buildLineAST(
      { series: [{ name: 'a', points: [{ x: 0, y: -5 }, { x: 1, y: 5 }, { x: 2, y: 20 }] }] },
      { type: 'line', domain: { y: { min: 0, max: 10 } } });
    assert.deepEqual(ast.domain.y, [0, 10]);
    assert.equal(ast.series[0].points[0].v, 0);
    assert.equal(ast.series[0].points[1].v, 0.5);
    assert.equal(ast.series[0].points[2].v, 1);
  });

  it('a pin pair that closes the domain falls back to the data extremes', function () {
    const ast = buildLineAST(
      { series: [{ name: 'a', points: [{ x: 0, y: 1 }, { x: 1, y: 9 }] }] },
      { type: 'line', domain: { y: { min: 10, max: 10 } } });
    assert.deepEqual(ast.domain.y, [1, 9]);
  });

  it('the x window drops older samples and quantizes its end to the slide', function () {
    const pts = Array.from({ length: 101 }, (_, i) => ({ x: i, y: 1 }));
    const ast = buildLineAST(
      { series: [{ name: 'a', points: pts }] },
      { type: 'line', domain: { x: { window: 40, slide: 10 } } });
    assert.deepEqual(ast.domain.x, [60, 100]);
    assert.equal(ast.series[0].points[59], null); // x=59 sits before the window
    assert.notEqual(ast.series[0].points[60], null);
    assert.equal(ast.series[0].points[100].u, 1);
  });

  it('windowed-out samples do not pin the y extremes', function () {
    const ast = buildLineAST(
      { series: [{ name: 'a', points: [{ x: 0, y: 1000 }, { x: 95, y: 5 }, { x: 100, y: 10 }] }] },
      { type: 'line', domain: { x: { window: 40, slide: 10 } } });
    assert.ok(ast.domain.y[1] < 1000);
  });

  it("y 'step' quantizes to nice multiples; log 'step' to decades", function () {
    const ast = buildLineAST(
      { series: [{ name: 'a', points: [{ x: 0, y: 47 }, { x: 1, y: 61 }] }] },
      { type: 'line', domain: { y: 'step' } });
    const [lo, hi] = ast.domain.y;
    assert.ok(lo <= 47 && hi >= 61);
    const step = (hi - lo) / Math.round((hi - lo) / 5);
    assert.ok(Number.isFinite(step)); // quantized bounds, not raw extremes
    assert.notDeepEqual(ast.domain.y, [47, 61]);
    const logAst = buildLineAST(
      { series: [{ name: 'a', points: [{ x: 0, y: 3 }, { x: 1, y: 700 }] }] },
      { type: 'line', log: true, domain: { y: 'step' } });
    assert.deepEqual(logAst.domain.y, [1, 1000]);
  });

  it('a non-positive pin under log is ignored, never a broken scale', function () {
    const ast = buildLineAST(
      { series: [{ name: 'a', points: [{ x: 0, y: 5 }, { x: 1, y: 50 }] }] },
      { type: 'line', log: true, domain: { y: { min: -10, max: 100 } } });
    assert.equal(ast.domain.y[0], 5);
    assert.equal(ast.domain.y[1], 100);
  });

  it('the combined policy keeps the steady-state domain still (the stability contract)', function () {
    const domainOf = (k, domain) => JSON.stringify(buildLineAST(
      { series: [{ name: 'a', points: rising.slice(0, k) }] },
      { type: 'line', domain }).domain);
    let policyChanges = 0;
    let bareChanges = 0;
    let prevPolicy = null;
    let prevBare = null;
    for (let k = 51; k <= 100; k++) {
      const withPolicy = domainOf(k, { y: 'step', x: { window: 40, slide: 10 } });
      const bare = domainOf(k, undefined);
      if (prevPolicy !== null && withPolicy !== prevPolicy) policyChanges++;
      if (prevBare !== null && bare !== prevBare) bareChanges++;
      prevPolicy = withPolicy;
      prevBare = bare;
    }
    assert.ok(policyChanges <= 8, `steady-state domain changed ${policyChanges} times`);
    assert.ok(bareChanges > 40, 'without a policy the domain moves nearly every append');
  });

  it('hostile domain configs resolve to no policy', function () {
    for (const domain of [42, 'window', { x: { window: -1 } }, { y: { min: NaN } }, { y: 'stepp' }]) {
      const ast = buildLineAST(
        { series: [{ name: 'a', points: [{ x: 0, y: 1 }, { x: 1, y: 2 }] }] },
        { type: 'line', domain });
      assert.deepEqual(ast.domain.x, [0, 1]);
    }
  });
});

describe('candlestick domain policies', function () {
  const CANDLES = Array.from({ length: 10 }, (_, i) => ({
    t: i * 60_000, open: 100 + i, high: 105 + i, low: 95 + i, close: 102 + i,
  }));

  it('records its resolved domain on every build', function () {
    const ast = buildCandlestickAST({ candles: CANDLES }, { type: 'candlestick' });
    assert.equal(ast.domain.x[0], 0);
    assert.equal(ast.domain.x[1], 9 * 60_000);
    assert.ok(ast.domain.y[0] <= 95 && ast.domain.y[1] >= 114);
  });

  it('the x window drops out-of-window candles entirely', function () {
    const ast = buildCandlestickAST({ candles: CANDLES },
      { type: 'candlestick', domain: { x: { window: 240_000, slide: 60_000 } } });
    assert.equal(ast.candles.length, 5); // t = 300k..540k inclusive
    assert.deepEqual(ast.domain.x, [300_000, 540_000]);
  });

  it('dropped candles do not pin the y extremes', function () {
    const spiked = [{ t: 0, open: 1, high: 10_000, low: 1, close: 2 }, ...CANDLES.slice(1)];
    const ast = buildCandlestickAST({ candles: spiked },
      { type: 'candlestick', domain: { x: { window: 240_000, slide: 60_000 } } });
    assert.ok(ast.domain.y[1] < 10_000);
  });

  it("pinned and 'step' y bounds resolve like the line type", function () {
    const pinned = buildCandlestickAST({ candles: CANDLES },
      { type: 'candlestick', domain: { y: { min: 90, max: 120 } } });
    assert.deepEqual(pinned.domain.y, [90, 120]);
    const stepped = buildCandlestickAST({ candles: CANDLES },
      { type: 'candlestick', domain: { y: 'step' } });
    assert.ok(stepped.domain.y[0] <= 95 && stepped.domain.y[1] >= 114);
    assert.notDeepEqual(stepped.domain.y, [95, 114]);
  });
});

describe('map AST', function () {
  /** Two adjacent squares and a marker, in the North Sea for realism. */
  const REGIONS = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { name: 'North', pop: 100 },
        geometry: { type: 'Polygon', coordinates: [[[3, 52], [7, 52], [7, 54], [3, 54], [3, 52]]] },
      },
      {
        type: 'Feature',
        properties: { name: 'South', pop: 10_000 },
        geometry: { type: 'Polygon', coordinates: [[[3, 50], [7, 50], [7, 52], [3, 52], [3, 50]]] },
      },
    ],
  };

  const everyPosition = (ast) => ast.shapes.flatMap(
    (s) => [...s.rings.flat(), ...s.lines.flat(), ...s.dots]);

  it('is geometry-free unit space: no pixels anywhere', function () {
    const ast = buildMapAST({ features: REGIONS }, { type: 'map' });
    assert.equal(ast.shapes.length, 2);
    for (const [u, v] of everyPosition(ast)) {
      assert.ok(u >= 0 && u <= 1, `u ${u} out of unit range`);
      assert.ok(v >= 0 && v <= 1, `v ${v} out of unit range`);
    }
    assert.deepEqual(ast.bbox, [3, 50, 7, 54]);
  });

  it('normalizes the shading property across the features that carry one', function () {
    const ast = buildMapAST({ features: REGIONS }, { type: 'map', value: 'pop' });
    assert.deepEqual(ast.domain, { min: 100, max: 10_000 });
    assert.equal(ast.shapes[0].t, 0);
    assert.equal(ast.shapes[1].t, 1);
    // log spreads the two decades evenly instead of pinning the small one to zero
    const log = buildMapAST({ features: REGIONS }, { type: 'map', value: 'pop', log: true });
    assert.equal(log.shapes[0].t, 0);
    assert.equal(log.shapes[1].t, 1);
    const mid = buildMapAST({
      features: {
        type: 'FeatureCollection',
        features: [
          ...REGIONS.features,
          {
            type: 'Feature',
            properties: { name: 'Mid', pop: 1000 },
            geometry: { type: 'Point', coordinates: [5, 51] },
          },
        ],
      },
    }, { type: 'map', value: 'pop', log: true });
    assert.equal(mid.shapes[2].t, 0.5);
  });

  it('leaves a feature with no value unshaded rather than dropping it', function () {
    const ast = buildMapAST({
      features: [
        REGIONS.features[0],
        { type: 'Feature', properties: { name: 'Unknown' }, geometry: REGIONS.features[1].geometry },
      ],
    }, { type: 'map', value: 'pop' });
    assert.equal(ast.shapes.length, 2);
    assert.equal(ast.shapes[1].t, null);
    assert.equal(ast.shapes[1].value, null);
    assert.equal(ast.shapes[1].rings.length, 1, 'it still draws');
  });

  it('keeps holes as their own rings and walks every geometry type', function () {
    const ast = buildMapAST({
      features: [
        {
          type: 'Feature',
          properties: { name: 'holed' },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
              [[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]],
            ],
          },
        },
        {
          type: 'Feature',
          properties: { name: 'mixed' },
          geometry: {
            type: 'GeometryCollection',
            geometries: [
              { type: 'MultiPoint', coordinates: [[0, 0], [1, 1]] },
              { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]]] },
              { type: 'MultiPolygon', coordinates: [[[[2, 2], [3, 2], [3, 3], [2, 2]]]] },
            ],
          },
        },
      ],
    }, { type: 'map', simplify: false });
    assert.equal(ast.shapes[0].rings.length, 2);
    assert.deepEqual(ast.shapes[1].dots.length, 2);
    assert.equal(ast.shapes[1].lines.length, 1);
    assert.equal(ast.shapes[1].rings.length, 1);
  });

  it('folds the points convenience list into the same shape list', function () {
    const ast = buildMapAST(
      { features: REGIONS, points: [{ at: [4.9, 52.37], label: 'Amsterdam', value: 900 }] },
      { type: 'map', value: 'pop' });
    assert.equal(ast.shapes.length, 3);
    assert.equal(ast.shapes[2].label, 'Amsterdam');
    assert.equal(ast.shapes[2].dots.length, 1);
    assert.equal(ast.shapes[2].value, 900);
  });

  it('simplifies away the vertices that would land on the same pixel', function () {
    // a 200-vertex "coastline" that is really a straight line
    const coordinates = Array.from({ length: 200 }, (_, i) => [3 + i * 0.02, 52 + (i % 2) * 1e-6]);
    const data = { features: [{ type: 'LineString', coordinates }] };
    const simplified = buildMapAST(data, { type: 'map' });
    const verbatim = buildMapAST(data, { type: 'map', simplify: false });
    assert.equal(verbatim.vertices.drawn, 200);
    assert.equal(simplified.vertices.source, 200);
    assert.ok(simplified.vertices.drawn < 10,
      `a straight line should collapse, kept ${simplified.vertices.drawn}`);
    // and the endpoints are exactly where they were
    assert.deepEqual(simplified.shapes[0].lines[0][0], verbatim.shapes[0].lines[0][0]);
  });

  it('survives hostile input without throwing or emitting NaN', function () {
    const hostile = {
      features: {
        type: 'FeatureCollection',
        features: [
          null, 42, 'nope',
          { type: 'Feature', properties: null, geometry: null },
          { type: 'Feature', properties: {}, geometry: { type: 'Sphere', coordinates: [1, 2] } },
          { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: 'ring' } },
          { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: ['a', 'b'] } },
          { type: 'Feature', properties: { name: 'ok', pop: 'lots' }, geometry: { type: 'Point', coordinates: [5, 52] } },
        ],
      },
      points: [null, { at: 'here' }, { at: [Infinity, 0] }, { at: [4, 52] }],
    };
    const ast = buildMapAST(hostile, { type: 'map', value: 'pop' });
    assert.equal(ast.domain, null, 'no feature carried a numeric value');
    assert.equal(ast.shapes.length, 2, 'the two real positions survive');
    for (const [u, v] of everyPosition(ast))
      assert.ok(Number.isFinite(u) && Number.isFinite(v));
    assert.ok(!compileChart({ type: 'map' }).toSvgString().includes('NaN'));
    assert.ok(!compileChart({ type: 'map', ...hostile }).toSvgString().includes('NaN'));
  });

  it('accepts a bare FeatureCollection as the whole data document', function () {
    const ast = buildMapAST(REGIONS, { type: 'map' });
    assert.equal(ast.shapes.length, 2);
    assert.equal(buildMapAST([REGIONS.features[0].geometry], { type: 'map' }).shapes.length, 1);
  });
});

describe('map render', function () {
  const CONFIG = {
    type: 'map', title: 'Regions', value: 'pop',
    features: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { name: 'North', pop: 100 },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [[3, 52], [7, 52], [7, 54], [3, 54], [3, 52]],
              [[4, 52.5], [5, 52.5], [5, 53], [4, 53], [4, 52.5]],
            ],
          },
        },
        { type: 'Feature', properties: { name: 'Nowhere' }, geometry: { type: 'Point', coordinates: [6, 51] } },
      ],
    },
  };

  it('draws areas with evenodd so holes punch through either winding', function () {
    const svg = compileChart(CONFIG).toSvgString();
    assert.match(svg, /class="chart-map-area"/);
    assert.match(svg, /fill-rule="evenodd"/);
    // both rings are subpaths of one path: two moveto commands, one path
    const area = svg.match(/<path d="([^"]+)"[^>]*class="chart-map-area"/);
    assert.notEqual(area, null);
    assert.equal(area[1].match(/M/g).length, 2);
    assert.equal(area[1].match(/Z/g).length, 2);
  });

  it('gives every mark a hover title and the ramp a legend', function () {
    const svg = compileChart(CONFIG).toSvgString();
    assert.match(svg, /<title>North: 100<\/title>/);
    assert.match(svg, /<title>Nowhere<\/title>/, 'an unshaded mark still names itself');
    assert.match(svg, /class="chart-swatch"/);
    assert.match(svg, /class="chart-map-dot"/);
  });

  it('has no legend when nothing is shaded', function () {
    const svg = compileChart({ ...CONFIG, value: undefined }).toSvgString();
    assert.doesNotMatch(svg, /class="chart-swatch"/);
    assert.match(svg, /class="chart-map-area"/);
  });

  it('draws the projection undistorted', function () {
    // The North polygon spans 4 degrees of longitude and 2 of latitude.
    // That is NOT a 2:1 shape once projected — Mercator stretches
    // latitude — so the check is against the projected extent, which is
    // the whole point of the exercise.
    const NORTH = [3, 52, 7, 54];
    const svg = compileChart(CONFIG).toSvgString();
    const d = svg.match(/<path d="([^"]+)"[^>]*class="chart-map-area"/)[1];
    const xs = [];
    const ys = [];
    for (const [, x, y] of d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)) {
      xs.push(Number(x));
      ys.push(Number(y));
    }
    const drawn = (Math.max(...xs) - Math.min(...xs)) / (Math.max(...ys) - Math.min(...ys));
    const [px0, py1] = projectMercator(NORTH[0], NORTH[1]);
    const [px1, py0] = projectMercator(NORTH[2], NORTH[3]);
    const projected = (px1 - px0) / (py1 - py0);
    assert.ok(Math.abs(drawn - projected) < 0.001,
      `drawn ratio ${drawn} does not match the projected ${projected}`);
    assert.ok(Math.abs(drawn - 2) > 0.5,
      'a distorted map would have drawn the 4-by-2-degree box as 2:1');
  });
});
