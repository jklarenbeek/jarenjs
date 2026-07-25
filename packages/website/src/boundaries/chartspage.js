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
  {
    key: 'donut',
    blurb: 'The pie with a hole: donut: true (or a hole fraction) turns the slices annular — same AST, same legend.',
    config: {
      type: 'pie',
      donut: true,
      title: 'Bundle size by layer',
      slices: [
        { label: 'engine', value: 34 },
        { label: 'component', value: 12 },
        { label: 'streaming', value: 9 },
        { label: 'schemas', value: 5 },
      ],
    },
  },
  {
    key: 'radar',
    blurb: 'N named axes as spokes, one translucent polygon per series over a shared 0..max domain — unplottable samples just skip their vertex.',
    config: {
      type: 'radar',
      title: 'Suite profile',
      max: 10,
      axes: ['speed', 'size', 'coverage', 'docs', 'streaming'],
      series: [
        { name: 'jaren', values: [9, 8, 8, 7, 9] },
        { name: 'rival', values: [6, 9, 5, 6, 3] },
      ],
    },
  },
  {
    key: 'gauge',
    blurb: 'One value on a semicircular dial — the headline mark, with the win/loss pair available for the fill.',
    config: {
      type: 'gauge',
      title: 'Statement coverage',
      value: 94.6,
      unit: '%',
      tone: 'win',
    },
  },
  {
    key: 'boxplot',
    blurb: 'Five-number summaries with Tukey whiskers and outlier dots — raw sample arrays are summarized for you, precomputed summaries are trusted as given.',
    config: {
      type: 'boxplot',
      title: 'Latency spread per engine',
      valLabel: 'ms',
      boxes: [
        { label: 'jaren', values: [1.1, 1.4, 1.4, 1.8, 2.0, 2.2, 2.4, 2.9, 3.1, 3.8, 9.5] },
        { label: 'rival A', values: [3.2, 4.1, 4.6, 5.0, 5.2, 5.9, 6.4, 7.2, 8.1, 9.0, 21.4] },
        { label: 'rival B', min: 2.5, q1: 4.8, med: 6.1, q3: 8.9, max: 12.0, outliers: [18.2] },
      ],
    },
  },
  {
    key: 'heatmap',
    blurb: 'The scenario-matrix reading: a category × category grid on the sequential blue ramp (log-normalized here), every cell carrying its exact value as hover text.',
    config: {
      type: 'heatmap',
      title: 'Speed ratio by scenario × scale (log)',
      log: true,
      xLabels: ['4 books', '100 books', '1000 books'],
      yLabels: ['singular', 'filter', 'join', 'group'],
      values: [[220, 80, 12], [90, 30, 6], [15, 4, 1.2], [8, 2.5, 0.9]],
    },
  },
  {
    key: 'treemap',
    blurb: 'Part-of-whole by area, squarified so tiles stay near-square — labels render inside every tile they fit, with ink picked by fill luminance.',
    config: {
      type: 'treemap',
      title: 'Suite time by package',
      items: [
        { label: 'validate', value: 42 },
        { label: 'json', value: 25 },
        { label: 'view', value: 18 },
        { label: 'md', value: 15 },
        { label: 'mermaid', value: 11 },
        { label: 'charts', value: 8 },
        { label: 'josl', value: 5 },
        { label: 'ai', value: 3 },
      ],
    },
  },
  {
    key: 'streamgraph',
    blurb: 'Stacked series flowing around a silhouette baseline — band thickness is the encoding, so the y axis stays deliberately unlabeled.',
    config: {
      type: 'streamgraph',
      title: 'Requests by route over a day',
      xLabel: 'hour',
      xs: Array.from({ length: 24 }, (_, i) => i),
      series: [
        { name: 'home', values: Array.from({ length: 24 }, (_, i) => 20 + Math.round(15 * Math.sin(i / 3) * 10) / 10) },
        { name: 'docs', values: Array.from({ length: 24 }, (_, i) => 12 + Math.round(9 * Math.cos(i / 4) * 10) / 10) },
        { name: 'playground', values: Array.from({ length: 24 }, (_, i) => 8 + Math.round(7 * Math.sin(i / 2 + 1) * 10) / 10) },
      ],
    },
  },
  {
    key: 'sankey',
    blurb: 'Value-proportional flows between layered nodes — nodes appear from the links alone, cycles are dropped, every ribbon names its flow on hover.',
    config: {
      type: 'sankey',
      title: 'Where visits go',
      links: [
        { source: 'search', target: 'home', value: 40 },
        { source: 'social', target: 'home', value: 15 },
        { source: 'home', target: 'docs', value: 30 },
        { source: 'home', target: 'playground', value: 20 },
        { source: 'docs', target: 'playground', value: 12 },
        { source: 'docs', target: 'github', value: 8 },
        { source: 'playground', target: 'github', value: 10 },
      ],
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
