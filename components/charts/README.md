# @jarenjs/charts

**Headless charts** for the jaren suite: a chart definition plus its
data compiled to a **geometry-free AST** and rendered as **pure-vnode
SVG** through [`@jarenjs/view`](../../packages/view) — no `innerHTML`,
no browser, no third-party chart library. Twelve types: `pie` (with a
donut variant), `bar` (grouped/stacked, vertical/horizontal,
linear/log), `line` (linear/time/log, the streaming-critical type),
`scatter` (log axes, win/loss tones, reference line), `candlestick`
(OHLC on a time axis), `radar`, `gauge`, `boxplot` (raw samples or
five-number summaries, Tukey whiskers), `heatmap` (sequential blue
ramp, linear or log), `treemap` (squarified), `streamgraph`
(silhouette baseline) and `sankey` (layered flows, cycle-safe). Like
[`@jarenjs/mermaid`](../mermaid), it ships in **two layers**: a pure
engine (definition + data ⇄ AST ⇄ vnode) that knows only the vnode
shape, and a visual component that packages it for an `@jarenjs/app`
host.

## A chart in one glance

```js
import { compileChart } from '@jarenjs/charts';

const compiled = compileChart({
  type: 'pie',
  title: 'Pets',
  slices: [
    { label: 'Dogs', value: 40 },
    { label: 'Cats', value: 25 },
    { label: 'Birds', value: 10 },
  ],
});

compiled.ast;           // geometry-free: fractions and angles, no pixels
compiled.toVnode();     // ['svg', { viewBox, … }, …] — a pure-vnode SVG
compiled.toSvgString(); // standalone SVG text (SSR), colors baked in
```

`config` carries the type and presentation fields; the data fields
(`slices`, …) default to the same object, so one self-contained
definition document works — while streaming callers pass live data as a
separate second argument: `compileChart(config, adapter.getData())`.

## The component (for `@jarenjs/app` hosts)

```js
import { createChartComponent } from '@jarenjs/charts/component';

const charts = createChartComponent({ theme: 'host' });
createApp(appDoc, {
  viewModel: (state) => ({ ...state, chart: charts.view(state.config, state.data) }),
});
```

`view()` memoizes on the **data object's identity** (a WeakMap): the
same `(config, data)` pair returns a reference-equal vnode, so an
unchanged chart patches in O(1); a fresh streaming snapshot re-renders.

## The definition shapes

Every type reads its data from the definition document (or the
separate `data` argument). The type-specific fields, briefly:

| type | data fields |
|---|---|
| `pie` | `slices: [{label, value}]`; `donut: true` or a hole fraction in (0, 1) |
| `bar` | `categories`, `series: [{name, values}]`; `stacked`, `log`, `orient` |
| `line` | `series: [{name, points: [{x, y}]}]`; `x: 'time'`, `log`, `markers` |
| `scatter` | `points: [{x, y, tone?}]`; `xLog`/`yLog`, `refY`/`refLabel` |
| `candlestick` | `candles: [{t, open, high, low, close}]` |
| `radar` | `axes: string[]`, `series: [{name, values}]`; `max` pins the domain |
| `gauge` | `value`; `min`/`max` (0..100 default), `unit`, `tone` |
| `boxplot` | `boxes: [{label, values}]` raw, or `{label, min, q1, med, q3, max, outliers?}` |
| `heatmap` | `xLabels`, `yLabels`, `values[yi][xi]` (row-major from the top); `log` |
| `treemap` | `items: [{label, value}]`; `aspect` (default 1.6) |
| `streamgraph` | `series: [{name, values}]`, optional numeric `xs` |
| `sankey` | `links: [{source, target, value}]` by name or index; `nodes` optional |

The full contract is `schemas/chart-definition.schema.json`.

## Scales, axes, palette

The core primitives are exported for reuse; scales are pure
`domain -> (value) => [0,1]` closures and axes generate nice-number
ticks (`1/2/5 × 10^k`) or log decades:

```js
import {
  scaleLinear, scaleLog, scaleBand, scaleTime,
  axisTicksLinear, axisTicksLog, CATEGORICAL, SEQUENTIAL,
} from '@jarenjs/charts';
```

The categorical palette is a concrete constant in the suite's anchor
order (blue first, amber second, teal third — no pink, no purple, per
the repo's DESIGN.md), and `SEQUENTIAL` is its magnitude counterpart:
a single-hue blue ramp, light→dark, sampled continuously by
`sequentialColor(t)` (the heatmap's cell fill). The semantic tokens
(text/grid/axis, win/loss) resolve through the shared `resolveTheme`
kernel and can be host-linked with `theme: 'host'`, so charts follow
the site's light/dark flip live without a re-render.

## Streaming (the adapter)

`@jarenjs/charts/stream-adapter` turns the unified reader events of
[`@jarenjs/josl`](../../packages/josl)'s streaming readers into chart
data — it consumes **events, never a reader**, so this package has no
parser dependency and any event source with the same `pair` shape
works:

```js
import { createJsonxStreamReader } from '@jarenjs/josl/jsonx-stream';
import { createStreamAdapter } from '@jarenjs/charts/stream-adapter';
import { compileChart } from '@jarenjs/charts';

const adapter = createStreamAdapter('line', {
  recordPath: ['run'],          // records live at {"run": [...]} / [[run]]
  xField: 'i', yField: 'ops', seriesField: 'suite',
  maxPoints: 200,               // ring-buffer eviction
});
const reader = createJsonxStreamReader({ mode: 'json', onEvent: adapter.onEvent });

for await (const chunk of feed) {          // chunks may split ANY token
  reader.feed(chunk);
  render(compileChart({ type: 'line' }, adapter.getData()).toVnode());
}
reader.end();
adapter.endDocument();
```

Two record boundaries cover the two streaming shapes: `'path'` (one
large document arriving in chunks — records close when the event path
leaves them) and `'document'` (many small complete documents, e.g. one
WebSocket message each — `endDocument()` closes the record;
`abortDocument()` discards a malformed one). Accumulators: `line`,
`bar` (live counts/sums) and `candlestick` (keyed by open time;
re-delivered keys replace their candle — exchange kline semantics).

## Mermaid interop

`@jarenjs/mermaid` delegates its `pie` diagrams here (the arrow is
mermaid → charts, never the reverse); the
`@jarenjs/charts/transforms/mermaid-adapter` transform maps a mermaid
pie AST onto `compileChart` inputs.

## Validation

`schemas/chart-definition.schema.json` describes the definition
document; validate untrusted definitions with `@jarenjs/validate`
before compiling.
