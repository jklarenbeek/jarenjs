//@ts-check
/**
 * The line chart's right value axis (`y2`): a series it names is scanned,
 * scaled and labelled on its own axis, a chart none of whose series it
 * names is the one-axis chart byte for byte, a malformed `y2` is refused
 * `CH0002`, and the incremental session stays byte-equal to a wholesale
 * compile while traffic moves either axis.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

import {
  compileChart, createChartSession, buildLineAST, renderLineAST, createTheme,
} from '@jarenjs/charts';
import { createStreamAdapter } from '@jarenjs/charts/stream-adapter';
import { createJsonxStreamReader } from '@jarenjs/josl';
import { renderToString } from '@jarenjs/view';
import { JarenValidator } from '@jarenjs/validate';
import { mulberry32 } from '@jarenjs/core/random';

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const BTC = [81612.5, 81630.1, 81598.4, 81655.0, 81640.2, 81671.9, 81620.3, 81688.8];
const ETH = [2521.4, 2516.9, 2519.2, 2510.6, 2512.0, 2508.3, 2515.7, 2511.1];
/** Two series shaped like the live miniTicker feed: price levels far apart, small moves. */
const FEED = {
  series: [
    { name: 'BTCUSDT', points: BTC.map((y, i) => ({ x: T0 + i * 2000, y })) },
    { name: 'ETHUSDT', points: ETH.map((y, i) => ({ x: T0 + i * 2000, y })) },
  ],
};
const TWO_AXES = {
  type: 'line', x: 'time', yLabel: 'BTCUSDT (USDT)',
  y2: { series: ['ETHUSDT'], label: 'ETHUSDT (USDT)' },
};

/** @param {{points: ({v: number}|null)[]}} s */
function vSpan(s) {
  const vs = s.points.map((p) => p?.v ?? NaN);
  return [Math.min(...vs), Math.max(...vs)];
}

describe('line chart — right value axis', function () {
  it('one shared axis flattens two series at levels far apart (the reason for y2)', function () {
    const ast = compileChart({ type: 'line', x: 'time' }, FEED).ast;
    assert.deepEqual(ast.domain.y, [2508.3, 81688.8]);
    const [btcLo, btcHi] = vSpan(ast.series[0]);
    const [ethLo, ethHi] = vSpan(ast.series[1]);
    assert.ok(btcHi - btcLo < 0.002 && ethHi - ethLo < 0.001);
  });

  it('each series spans the whole plot height on its own axis', function () {
    const ast = compileChart(TWO_AXES, FEED).ast;
    assert.deepEqual(ast.domain, {
      x: [1791979200000, 1791979214000], y: [81598.4, 81688.8], y2: [2508.3, 2521.4],
    });
    assert.deepEqual(vSpan(ast.series[0]), [0, 1]);
    assert.deepEqual(vSpan(ast.series[1]), [0, 1]);
    assert.equal(ast.series[0].axis, undefined);
    assert.equal(ast.series[1].axis, 'right');
    assert.equal(ast.y.label, 'BTCUSDT (USDT)');
    assert.equal(ast.y2?.label, 'ETHUSDT (USDT)');
    assert.deepEqual(ast.y2?.ticks.map((t) => t.pos.toFixed(4)),
      ['0.1298', '0.2824', '0.4351', '0.5878', '0.7405', '0.8931']);
    assert.deepEqual(ast.legend, [
      { name: 'BTCUSDT', swatch: 0 }, { name: 'ETHUSDT', swatch: 1, axis: 'right' },
    ]);
  });

  it('draws the right axis: ticks, axis line and label on the right edge, gridlines from the left only', function () {
    const svg = compileChart(TWO_AXES, FEED).toSvgString();
    const ast = compileChart(TWO_AXES, FEED).ast;
    assert.equal((svg.match(/class="chart-grid"/g) ?? []).length, ast.y.ticks.length);
    const rightTicks = svg.match(/<text x="(\d+)"[^>]*text-anchor="start"[^>]*class="chart-tick">/g) ?? [];
    assert.equal(rightTicks.length, ast.y2?.ticks.length);
    // the plot ends where the right margin begins; ticks sit 6px past it
    const plotRight = Number(/<line x1="[\d.]+" y1="[\d.]+" x2="([\d.]+)"[^>]*class="chart-grid"/.exec(svg)?.[1]);
    assert.ok(rightTicks.every((t) => t.startsWith(`<text x="${plotRight + 6}"`)));
    // the right margin holds the widest right tick label ('2.520k') and the axis label: 560 - 494
    assert.equal(plotRight, 494);
    // the legend row rises clear of the right axis's top tick label (16px above the plot, not 10)
    const plotTop = Number(/<line x1="[\d.]+" y1="([\d.]+)"[^>]*class="chart-axis"/.exec(svg)?.[1]);
    assert.ok([...svg.matchAll(/<rect x="[\d.]+" y="([\d.]+)"[^>]*class="chart-swatch"/g)]
      .every((m) => Number(m[1]) === plotTop - 16));
    assert.equal((svg.match(/class="chart-axis"/g) ?? []).length, 3);
    assert.match(svg, /transform="rotate\(90\) translate\([\d.]+ -548\)" class="chart-axis-label">ETHUSDT \(USDT\)</);
    assert.match(svg, /transform="rotate\(-90\)[^"]*" class="chart-axis-label">BTCUSDT \(USDT\)</);
    assert.match(svg, /class="chart-tick">ETHUSDT \(right axis\)</);
    assert.match(svg, /<title>ETHUSDT \(right axis\)<\/title>/);
    assert.match(svg, /<title>BTCUSDT<\/title>/);
    // every new element draws in the theme's tokens, never a raw colour of its own
    const light = createTheme('default').tokens;
    const dark = createTheme('dark').tokens;
    const darkSvg = compileChart(TWO_AXES, FEED, { theme: 'dark' }).toSvgString();
    const label = (muted) => new RegExp(`fill="${muted}" text-anchor="middle" transform="rotate\\(90\\)`);
    assert.notEqual(light.muted, dark.muted);
    assert.match(svg, label(light.muted));
    assert.match(darkSvg, label(dark.muted));
    assert.match(darkSvg, new RegExp(`x="${plotRight + 6}"[^>]*fill="${dark.muted}"`));
  });

  it('a series hover binding names the axis it reads', function () {
    const vnode = compileChart(TWO_AXES, FEED, { tooltip: { action: 'hover' } }).toVnode();
    const groups = vnode.filter((c) => Array.isArray(c) && c[1]?.class === 'chart-series');
    assert.deepEqual(groups.map((g) => g[1].on.pointerenter.with), [
      { text: 'BTCUSDT', type: 'line', series: 'BTCUSDT' },
      { text: 'ETHUSDT (right axis)', type: 'line', series: 'ETHUSDT', axis: 'right' },
    ]);
  });

  it('a chart none of whose series y2 names is the one-axis chart, byte for byte', function () {
    const theme = createTheme();
    for (const y2 of [{ series: [] }, { series: ['SOLUSDT'], label: 'SOL' }, null]) {
      const plain = buildLineAST(FEED, { type: 'line', x: 'time', yLabel: 'USDT' });
      const named = buildLineAST(FEED, { type: 'line', x: 'time', yLabel: 'USDT', y2 });
      assert.deepEqual(named, plain);
      assert.equal(renderToString(renderLineAST(named, theme, 'h')),
        renderToString(renderLineAST(plain, theme, 'h')));
    }
  });

  it('a pinned y domain pins the left axis only; step and log apply to both', function () {
    const y2 = { series: ['ETHUSDT'] };
    assert.deepEqual(buildLineAST(FEED, { type: 'line', y2, domain: { y: { min: 0, max: 100000 } } }).domain.y2,
      [2508.3, 2521.4]);
    assert.deepEqual(buildLineAST(FEED, { type: 'line', y2, domain: { y: 'step' } }).domain,
      { x: [1791979200000, 1791979214000], y: [81580, 81700], y2: [2505, 2525] });
    // a window drops older samples from both axes' scans
    const windowed = buildLineAST(FEED, { type: 'line', x: 'time', y2, domain: { x: { window: 6000, slide: 2000 } } });
    assert.deepEqual(windowed.domain,
      { x: [1791979208000, 1791979214000], y: [81620.3, 81688.8], y2: [2508.3, 2515.7] });
    const log = buildLineAST(FEED, { type: 'line', log: true, y2 });
    assert.deepEqual(log.y2?.ticks.map((t) => t.label), ['2.51k', '2.52k']);
    assert.deepEqual(vSpan(log.series[1]), [0, 1]);
  });

  it('a right series alone draws an empty left axis and its own right one', function () {
    const ast = buildLineAST({ series: [FEED.series[1]] }, TWO_AXES);
    assert.deepEqual(ast.domain.y, [0, 1]);
    assert.deepEqual(ast.domain.y2, [2508.3, 2521.4]);
    assert.equal(ast.legend, null);
  });

  it('refuses a malformed y2 with CH0002 naming the member', function () {
    const cases = [
      [{ y2: 'ETHUSDT' }, '/y2'],
      [{ y2: ['ETHUSDT'] }, '/y2'],
      [{ y2: {} }, '/y2/series'],
      [{ y2: { series: 'ETHUSDT' } }, '/y2/series'],
      [{ y2: { series: ['ETHUSDT', 7] } }, '/y2/series/1'],
      [{ y2: { series: [], label: 5 } }, '/y2/label'],
    ];
    for (const [extra, at] of cases) {
      assert.throws(() => compileChart({ type: 'line', ...extra }, FEED),
        (err) => err.code === 'CH0002' && err.docPath === at, JSON.stringify(extra));
      assert.throws(() => createChartSession({ type: 'line', ...extra }, { takeChanges: () => [], getData: () => FEED }),
        (err) => err.code === 'CH0002', JSON.stringify(extra));
    }
  });

  it('the definition schema admits y2 and refuses what the build refuses', function () {
    const url = new URL('../../components/charts/schemas/chart-definition.schema.json', import.meta.url);
    const validate = new JarenValidator().compile(JSON.parse(fs.readFileSync(url, 'utf8')));
    assert.equal(validate({ ...TWO_AXES, ...FEED }), true);
    assert.equal(validate({ type: 'line', y2: { series: ['a'], label: null } }), true);
    for (const y2 of ['ETHUSDT', {}, { series: 'a' }, { series: [7] }, { series: [], label: 5 }])
      assert.equal(validate({ type: 'line', y2 }), false, JSON.stringify(y2));
  });
});

function feedDoc(adapter, message) {
  const reader = createJsonxStreamReader({ mode: 'json', onEvent: adapter.onEvent });
  reader.feed(JSON.stringify(message));
  reader.end();
  adapter.endDocument();
}

describe('line session — right value axis', function () {
  const spec = { recordBoundary: 'document', xField: 'x', yField: 'y', seriesField: 's', changes: true };
  const config = { type: 'line', y2: { series: ['eth'], label: 'eth' } };

  function setup(extraSpec = {}) {
    const adapter = createStreamAdapter('line', { ...spec, ...extraSpec });
    const session = createChartSession(config, adapter);
    const step = (/** @type {any[]} */ ...messages) => {
      for (const m of messages) feedDoc(adapter, m);
      const result = session.tick();
      const svg = renderToString(result.vnode);
      assert.equal(svg, renderToString(compileChart(config, adapter.getData()).toVnode()),
        `${result.mode} frame diverged from the wholesale render`);
      if (adapter.getData().series.some((s) => s.name === 'eth'))
        assert.match(svg, /rotate\(90\)[^"]*" class="chart-axis-label">eth</);
      return result;
    };
    return { adapter, step };
  }

  it('patches in place under both domains, and rebuilds when only the right one moves', function () {
    const { step } = setup();
    assert.equal(step({ x: 0, s: 'btc', y: 81600 }, { x: 0, s: 'eth', y: 2500 },
      { x: 1, s: 'btc', y: 81700 }, { x: 1, s: 'eth', y: 2520 }).mode, 'rebuilt');
    const before = step({ x: 1, s: 'eth', y: 2510 });
    assert.equal(before.mode, 'incremental');
    const left = before.vnode.find((c) => Array.isArray(c) && c[1]?.key === 'ls0');
    const after = step({ x: 1, s: 'btc', y: 81650 });
    assert.equal(after.mode, 'incremental');
    assert.notEqual(after.vnode.find((c) => Array.isArray(c) && c[1]?.key === 'ls0'), left);
    const rightBefore = after.vnode.find((c) => Array.isArray(c) && c[1]?.key === 'ls1');
    assert.equal(step({ x: 1, s: 'btc', y: 81610 }).vnode.find((c) => Array.isArray(c) && c[1]?.key === 'ls1'),
      rightBefore, 'a left append leaves the right series untouched');
    // 2600 lies inside the left domain's numbers but beyond the right one's
    const moved = step({ x: 1, s: 'eth', y: 2600 });
    assert.equal(moved.mode, 'rebuilt');
  });

  it('a right-series eviction that retires its extreme rebuilds; one that does not patches', function () {
    const { step } = setup({ maxPoints: 3 });
    step({ x: 0, s: 'btc', y: 81600 }, { x: 1, s: 'btc', y: 81700 },
      { x: 0, s: 'eth', y: 2510 }, { x: 0, s: 'eth', y: 2500 }, { x: 1, s: 'eth', y: 2520 });
    // evicts eth's 2510, which bounds nothing
    assert.equal(step({ x: 1, s: 'eth', y: 2505 }).mode, 'incremental');
    // evicts eth's 2500, the right axis's minimum
    assert.equal(step({ x: 1, s: 'eth', y: 2506 }).mode, 'rebuilt');
  });

  it('stays byte-equal to a wholesale compile under random two-axis traffic', function () {
    for (const extra of [{}, { maxPoints: 12 }]) {
      const { step } = setup(extra);
      const rand = mulberry32(7);
      const modes = { incremental: 0, rebuilt: 0, unchanged: 0 };
      for (let frame = 0; frame < 300; frame++) {
        const messages = [];
        if (rand() > 0.1) {
          const burst = 1 + Math.floor(rand() * 3);
          for (let b = 0; b < burst; b++) {
            const eth = rand() < 0.5;
            const base = eth ? 2500 : 81600;
            messages.push({ x: Math.floor(frame / 4), s: eth ? 'eth' : 'btc', y: base + Math.round(rand() * 2000) / 100 });
          }
        }
        modes[step(...messages).mode]++;
      }
      assert.ok(modes.incremental > 50 && modes.rebuilt > 5, JSON.stringify(modes));
    }
  });
});
