//@ts-check
/**
 * Value marks: the `<title>` every value-carrying mark now emits —
 * including the original five types — and the opt-in pointer bindings a
 * floating-tooltip host consumes.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { compileChart, buildBarAST, buildScatterAST, buildCandlestickAST } from '@jarenjs/charts';
import { createChartComponent, tooltipView } from '@jarenjs/charts/component';
import { renderToString } from '@jarenjs/view';

const FIVE = {
  pie: {
    type: 'pie', title: 'Pets',
    slices: [{ label: 'Dogs', value: 3 }, { label: 'Cats', value: 1 }],
  },
  bar: {
    type: 'bar', categories: ['small', 'large'],
    series: [{ name: 'jaren', values: [1.2, 8.1] }, { name: 'rival', values: [2.5, 30.2] }],
  },
  line: {
    type: 'line',
    series: [{ name: 'a', points: [{ x: 0, y: 1 }, { x: 1, y: 3 }] }],
  },
  scatter: {
    type: 'scatter', points: [{ x: 3, y: 0.5, tone: 'loss' }],
  },
  candlestick: {
    type: 'candlestick',
    candles: [{ t: 1721556000000, open: 100, high: 110, low: 95, close: 108 }],
  },
};

describe('per-mark hover titles', function () {
  it('a pie slice names its label, value and share', function () {
    assert.match(compileChart(FIVE.pie).toSvgString(), /<title>Dogs: 3 \(75\.0%\)<\/title>/);
  });

  it('a bar names its series, category and exact value', function () {
    const svg = compileChart(FIVE.bar).toSvgString();
    assert.match(svg, /<title>jaren — small: 1\.2<\/title>/);
    assert.match(svg, /<title>rival — large: 30\.2<\/title>/);
  });

  it('a single-series bar drops the series name from its title', function () {
    const svg = compileChart({
      type: 'bar', categories: ['only'], series: [{ name: 's', values: [4] }],
    }).toSvgString();
    assert.match(svg, /<title>only: 4<\/title>/);
  });

  it('a line names the series once, on its group — not once per vertex', function () {
    const svg = compileChart(FIVE.line).toSvgString();
    assert.equal((svg.match(/<title>a<\/title>/g) ?? []).length, 1);
  });

  it('an unnamed line series emits no empty title', function () {
    const svg = compileChart({ type: 'line', series: [{ points: [{ x: 0, y: 1 }] }] }).toSvgString();
    assert.doesNotMatch(svg, /<title><\/title>/);
  });

  it('a scatter dot names its raw sample (unreadable from a log pixel)', function () {
    assert.match(compileChart(FIVE.scatter).toSvgString(), /<title>\(3, 0\.5\)<\/title>/);
  });

  it('a candle names its open time and its four prices', function () {
    assert.match(compileChart(FIVE.candlestick).toSvgString(),
      /<title>10:00:00 O 100 H 110 L 95 C 108<\/title>/);
  });

  it('the ASTs carry what the titles report', function () {
    const bar = buildBarAST(
      { categories: ['a'], series: [{ name: 's', values: [7] }] }, { type: 'bar' });
    assert.equal(bar.bars[0].label, 'a');
    assert.equal(bar.bars[0].name, 's');
    assert.equal(bar.bars[0].value, 7);
    const scatter = buildScatterAST({ points: [{ x: 2, y: 9 }] }, { type: 'scatter' });
    assert.equal(scatter.points[0].x, 2);
    assert.equal(scatter.points[0].y, 9);
    const candles = buildCandlestickAST(
      { candles: [{ t: 0, open: 1, high: 4, low: 0.5, close: 2 }] }, {});
    assert.equal(candles.candles[0].high, 4);
    assert.equal(candles.candles[0].close, 2);
  });

  it('mermaid keeps its byte-stable pie: titles are opt-out', async function () {
    const { renderMermaid } = await import('@jarenjs/mermaid');
    const svg = renderToString(renderMermaid('pie title Pets\n  "Dogs" : 3\n  "Cats" : 1'));
    assert.match(svg, /mm-pie-slice/);
    assert.doesNotMatch(svg, /<title>Dogs/);
  });
});

describe('tooltip bindings', function () {
  const TOOLTIP = { action: 'chartHover', leaveAction: 'chartLeave' };

  /** Every `on` binding in a vnode tree, depth first. */
  function bindings(vnode, out = []) {
    if (!Array.isArray(vnode)) return out;
    const props = typeof vnode[1] === 'object' && vnode[1] !== null ? vnode[1] : null;
    if (props?.on !== undefined) out.push(props.on);
    for (let i = 2; i < vnode.length; i++) bindings(vnode[i], out);
    return out;
  }

  it('off by default: no chart emits an `on` prop', function () {
    for (const config of Object.values(FIVE))
      assert.deepEqual(bindings(compileChart(config).toVnode()), []);
  });

  it('every value mark carries enter and leave bindings when asked', function () {
    const v = compileChart(FIVE.bar, undefined, { tooltip: TOOLTIP }).toVnode();
    const found = bindings(v);
    assert.equal(found.length, 4); // one per bar
    assert.deepEqual(found[0], {
      pointerenter: {
        action: 'chartHover',
        with: { text: 'jaren — small: 1.2', type: 'bar', label: 'small', series: 'jaren', value: 1.2 },
        event: ['clientX', 'clientY'],
      },
      pointerleave: { action: 'chartLeave' },
    });
  });

  it('bindings never reach the serialized SVG', function () {
    const bound = compileChart(FIVE.pie, undefined, { tooltip: TOOLTIP }).toSvgString();
    assert.equal(bound, compileChart(FIVE.pie).toSvgString());
  });

  it('every type with a value mark can be bound', function () {
    const configs = [
      FIVE.pie, FIVE.bar, FIVE.line, FIVE.scatter, FIVE.candlestick,
      { type: 'radar', axes: ['a', 'b', 'c'], series: [{ name: 's', values: [1, 2, 3] }] },
      { type: 'gauge', value: 40 },
      { type: 'boxplot', boxes: [{ label: 'b', values: [1, 2, 3, 4] }] },
      { type: 'heatmap', xLabels: ['x'], yLabels: ['y'], values: [[2]] },
      { type: 'treemap', items: [{ label: 't', value: 5 }] },
      { type: 'streamgraph', series: [{ name: 's', values: [1, 2] }] },
      { type: 'sankey', links: [{ source: 'a', target: 'b', value: 2 }] },
    ];
    for (const config of configs) {
      const found = bindings(compileChart(config, undefined, { tooltip: TOOLTIP }).toVnode());
      assert.ok(found.length > 0, `${config.type} emitted no bindings`);
      for (const on of found)
        assert.equal(typeof on.pointerenter.with.text, 'string');
    }
  });

  it('custom event names and requested fields ride through', function () {
    const [on] = bindings(compileChart(FIVE.pie, undefined, {
      tooltip: { action: 'hover', enter: 'click', event: ['shiftKey'] },
    }).toVnode());
    assert.deepEqual(Object.keys(on), ['click']);
    assert.deepEqual(on.click.event, ['shiftKey']);
  });

  it('a spec naming no action degrades to titles only', function () {
    for (const tooltip of [null, 'hover', 42, {}, { action: '' }, { leaveAction: 'x' }])
      assert.deepEqual(bindings(compileChart(FIVE.pie, undefined, { tooltip }).toVnode()), []);
  });

  it('the component threads its tooltip into charts and sessions', function () {
    const charts = createChartComponent({ tooltip: TOOLTIP });
    assert.ok(bindings(charts.view(FIVE.bar)).length > 0);
    const session = charts.createSession({ type: 'line' }, {
      takeChanges: () => [], getData: () => FIVE.line,
    });
    assert.ok(bindings(session.tick().vnode).length > 0);
  });
});

describe('the floating-tooltip host', function () {
  it('positions the box at the pointer coordinates the binding carried', function () {
    assert.deepEqual(tooltipView({ text: 'a: 1', x: 120, y: 40 }), [
      'div',
      { class: 'chart-tooltip', role: 'status', style: { left: '120px', top: '40px' } },
      'a: 1',
    ]);
  });

  it('renders nothing without a text (the leave action\'s state)', function () {
    for (const tip of [null, undefined, 'text', {}, { text: '' }, { text: 7 }])
      assert.equal(tooltipView(tip), null);
  });

  it('non-finite coordinates fall back to the viewport origin', function () {
    assert.deepEqual(tooltipView({ text: 'x' })[1].style, { left: '0px', top: '0px' });
  });
});
