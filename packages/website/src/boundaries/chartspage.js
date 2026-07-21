//@ts-check
/**
 * The /charts page boundary: the showcase surface for @jarenjs/charts.
 * Static demos — one per chart type, each a definition document
 * compiled through the real engine with its source alongside — plus
 * the live half: the Binance feed (boundaries/binance.js) targeting
 * this page. Everything renders through the generic 'ui' node rules.
 */

import { createChartComponent } from '@jarenjs/charts/component';
import { chart, code, details, callout } from '../lib/nodes.js';

/** Host-linked, memoized projections (module-stable configs → stable vnodes). */
const charts = createChartComponent({ theme: 'host' });

/** One self-contained definition document per chart type. */
const DEMOS = [
  {
    key: 'pie',
    blurb: 'The type the mermaid engine delegates here — fractions and angles in the AST, arcs only at render.',
    config: {
      type: 'pie',
      title: 'Suite time by package',
      slices: [
        { label: 'validate', value: 42 },
        { label: 'json', value: 25 },
        { label: 'view', value: 18 },
        { label: 'md', value: 15 },
      ],
    },
  },
  {
    key: 'bar',
    blurb: 'Grouped or stacked, vertical or horizontal, linear or log — this one is the benchmarks-page shape.',
    config: {
      type: 'bar',
      title: 'Parse profile — ms per document (log)',
      log: true,
      valLabel: 'ms/op (log)',
      categories: ['~2 kB', '~40 kB', '~90 kB'],
      series: [
        { name: 'jaren', values: [0.11, 2.3, 10.7] },
        { name: 'rival', values: [0.43, 6.1, 38.4] },
      ],
    },
  },
  {
    key: 'line',
    blurb: 'The streaming-critical type: a live feed recompiles it per snapshot in ~170 µs at 100 points × 5 series.',
    config: {
      type: 'line',
      title: 'Throughput over a run',
      markers: true,
      xLabel: 'iteration',
      yLabel: 'ops/s',
      series: [
        { name: 'validate', points: Array.from({ length: 16 }, (_, i) => ({ x: i + 1, y: 62 + Math.round(Math.sin(i / 2) * 9 + i * 2) })) },
        { name: 'jsonpath', points: Array.from({ length: 16 }, (_, i) => ({ x: i + 1, y: 45 + Math.round(Math.cos(i / 3) * 7 + i * 2) })) },
      ],
    },
  },
  {
    key: 'scatter',
    blurb: 'Per-point win/loss tones and a reference line — the shape of the validate suite\'s ratio cloud.',
    config: {
      type: 'scatter',
      title: 'Speed ratio per test (log)',
      yLog: true,
      refY: 1,
      refLabel: '1× (parity)',
      xLabel: 'tests, fastest first',
      yLabel: 'ratio (log)',
      points: Array.from({ length: 60 }, (_, i) => {
        const ratio = Math.max(0.4, 220 * Math.exp(-i / 9) * (1 + ((i * 37) % 10) / 30));
        return { x: i + 1, y: Number(ratio.toFixed(2)), tone: ratio >= 1 ? 'win' : 'loss' };
      }),
    },
  },
  {
    key: 'candlestick',
    blurb: 'OHLC on a time axis with the win/loss pair — the Binance kline consumer, working offline from any fixture.',
    config: {
      type: 'candlestick',
      title: 'BTCUSDT — 1m candles (fixture)',
      yLabel: 'USDT',
      candles: Array.from({ length: 14 }, (_, i) => {
        const base = 64000 + Math.round(Math.sin(i / 2) * 220 + i * 18);
        const close = base + (((i * 13) % 7) - 3) * 35;
        return {
          t: 1721556000000 + i * 60_000,
          open: base,
          high: Math.max(base, close) + 40,
          low: Math.min(base, close) - 55,
          close,
        };
      }),
    },
  },
];

/** @type {any[]|null} built once — configs are constants */
let demoNodes = null;

/** The static demo nodes (chart + its definition source, per type). */
export function chartsPageDemos() {
  if (demoNodes === null) {
    demoNodes = DEMOS.flatMap((demo) => [
      { kind: 'p', text: demo.blurb },
      chart(null, charts.view(demo.config)),
      details(`The ${demo.key} definition (JSON — paste it into the playground)`, [
        code(null, JSON.stringify(demo.config, null, 2)),
      ]),
    ]);
  }
  return demoNodes;
}

/** The streaming pointer under the demos. */
export function chartsPageStreamingCallout() {
  return callout('Streaming is the point',
    'Every chart re-renders from a stream adapter fed by the incremental JOSL/JSONX readers — records join a chart the moment their fields complete. The playground Charts engine replays a document chunk by chunk to show it.',
    '#/playground?engine=charts', 'Open the Charts playground');
}
