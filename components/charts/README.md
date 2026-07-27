# @jarenjs/charts

**Headless charts** for the jaren suite: a chart definition plus its
data compiled to a **geometry-free AST** and rendered as **pure-vnode
SVG** through [`@jarenjs/view`](../../packages/view) — no `innerHTML`,
no browser, no third-party chart library. Thirteen types: `pie` (with a
donut variant), `bar` (grouped/stacked, vertical/horizontal,
linear/log), `line` (linear/time/log, the streaming-critical type),
`scatter` (log axes, win/loss tones, reference line), `candlestick`
(OHLC on a time axis), `radar`, `gauge`, `boxplot` (raw samples or
five-number summaries, Tukey whiskers), `heatmap` (sequential blue
ramp, linear or log), `treemap` (squarified), `streamgraph`
(silhouette baseline), `sankey` (layered flows, cycle-safe) and `map`
(GeoJSON in Web Mercator, shaded by a feature property). Like
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

**Time axes.** An `x: 'time'` axis (and every `candlestick`) accepts epoch milliseconds, a `Date`, or an **RFC 3339 string** — a date in a JSON document plots without being pre-converted, and a bare `2026-07-27` reads as UTC midnight. A *numeric* string still does not coerce: accepting `"5"` where the config asked for a number is a type confusion, not a date.

Ticks land on calendar boundaries rather than on the 1/2/5 ladder, because a quantity axis and a clock have different nice numbers — the ladder puts ticks 50 seconds or 8.64 days apart, which no reader converts back into a time. Steps come from a clock/calendar ladder (1/5/15/30 seconds and minutes, 1/3/6/12 hours, 1/2 days, 1/2 weeks, 1/3/6 months, years), and the label granularity follows the step, so an axis never repeats one string on every tick:

```javascript
axisTicksTime(Date.UTC(2024, 0, 1), Date.UTC(2027, 0, 1));  // → 2024, 2025, 2026, 2027
axisTicksTime(Date.UTC(2026, 6, 27, 0), Date.UTC(2026, 6, 27, 6));  // → 00:00 … 06:00
```
| `radar` | `axes: string[]`, `series: [{name, values}]`; `max` pins the domain, `labelEvery` the spoke-label stride |
| `gauge` | `value`; `min`/`max` (0..100 default), `unit`, `tone` |
| `boxplot` | `boxes: [{label, values}]` raw, or `{label, min, q1, med, q3, max, outliers?}` |
| `heatmap` | `xLabels`, `yLabels`, `values[yi][xi]` (row-major from the top); `log` |
| `treemap` | `items: [{label, value}]` or `[{label, children: [{label, value}]}]`; `aspect` (default 1.6) |
| `streamgraph` | `series: [{name, values}]`, optional numeric `xs` |
| `sankey` | `links: [{source, target, value}]` by name or index; `nodes` optional |

The full contract is `schemas/chart-definition.schema.json`.

## Hover text and tooltips

Every value-carrying mark — slice, bar, dot, candle, cell, tile,
ribbon, band, series — renders a `<title>` child naming it and its
exact value. That is native hover text: it works in a static
`toSvgString()` document with no script, no CSS and no app, so it is
always on. Marks report the datum, not the axis's rounded tick scale,
which is the only way to read a value back off a log axis.

For a positioned, styled tooltip instead, ask for **bindings**:

```js
const compiled = compileChart(config, data, {
  tooltip: { action: 'chartHover', leaveAction: 'chartLeave' },
});
```

Each mark then carries an `on` binding (VIEW-FORMAT §4) naming that
action, with the mark's descriptor as the payload and the pointer's
`clientX`/`clientY` requested as `$event` fields. Bindings are plain
JSON built at render time — the engine names an action, it never calls
one — and `renderToString` drops `on`, so the SSR bytes do not change.
The `@jarenjs/app` half is three lines and a projection:

```js
const charts = createChartComponent({ theme: 'host', tooltip: { action: 'chartHover', leaveAction: 'chartLeave' } });
// action chartHover: { "tip": { "text": "$payload.text", "x": "$event.clientX", "y": "$event.clientY" } }
// action chartLeave: { "tip": null }
// viewModel:         (state) => ({ ...state, tip: tooltipView(state.tip) })
```

`tooltipView` (from `@jarenjs/charts/component`) returns the floating
box positioned at those viewport coordinates; `styles/charts.css`
carries its `.chart-tooltip` rules.

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
`abortDocument()` discards a malformed one). Five accumulators:

| type | what a record contributes | fields |
|---|---|---|
| `line` | a point on a series, ring-buffer evicted | `xField`, `yField`, `seriesField` |
| `bar` | +1 (or `+yField`) on a category | `xField`, `yField?` |
| `heatmap` | the same, under two grouping keys | `xField` (column), `seriesField` (row), `yField?` |
| `gauge` | the latest reading; nothing is kept | `yField` |
| `candlestick` | a candle keyed by open time; a re-delivered key replaces it (exchange kline semantics) | `xField`, `openField`… |

A heatmap cell nobody measured stays `null` rather than `0` — the
surface shows through, which is the honest rendering of "no
measurement" — and a gauge with no reading yet is `null`, not zero.

## Incremental sessions (O(1) ticks)

A snapshot re-render is O(n): every point is re-projected because a
unit-space AST stores positions as *fractions of the domain*, so a
tick that moves the scales legitimately changes every mark. Declare a
**domain policy** and most ticks stop moving them — then
`createChartSession` patches only what changed:

```js
const adapter = createStreamAdapter('line', { …, changes: true });
const session = createChartSession({
  type: 'line',
  domain: { y: 'step', x: { window: 60_000, slide: 15_000 } },
}, adapter);

reader.feed(chunk);
const { vnode, mode } = session.tick();  // 'incremental' | 'rebuilt' | 'unchanged'
```

`{ changes: true }` makes the adapter buffer its mutations as RFC 6902
ops (`takeChanges()`); the session applies them to the previous AST and
rebuilds only the touched series — every other child stays
**reference-equal**, so the patcher skips it in O(1). Domain policies:

| policy | effect |
|---|---|
| `x: { window, slide }` | sliding window whose end is quantized to `slide` — the domain moves once per quantum, not per sample |
| `y: { min, max }` | pinned bounds; out-of-range samples clamp to the plot edge |
| `y: 'step'` | bounds snap outward to nice-number steps (decades under `log`) |

**The fallback is the design, not a failure mode.** When the domain
*does* move — or a new series appears, or the source resets — the
session rebuilds wholesale, because that is the correct rendering of a
frame whose scales moved. `mode` reports which path ran. The
correctness contract is byte equality: every tick's vnode serializes
identically to a wholesale `compileChart()` of the same data, which is
property-tested over thousands of random frames rather than assumed.

Measured (`npm run benchmark:charts`, one appended point):

| points × series | session tick | wholesale tick |
|---|---|---|
| 100 × 5 | ~8 µs | ~319 µs |
| 1 000 × 5 | ~4.6 µs | ~1.03 ms |
| 10 000 × 5 | ~4.2 µs | ~11.3 ms |

The session tick is *flat* in n (10 000 points cost no more than 100)
while the wholesale tick grows 35×. Supported types: `line` (appends
and ring-buffer evictions), `bar` (live counts and sums) and
`candlestick` (keyed kline upserts — one candle group re-renders). The
website's Binance demo runs on it.

A bar chart's stillness test is the nice-number top rather than a
declared policy: a count below it repaints one rect, a count that
pushes the axis higher rebuilds. A new category rebuilds too — every
band width and position moves with it — and so does a stacked chart,
where one value shifts every bar above it in its category.

| categories | session tick | wholesale tick |
|---|---|---|
| 20 | ~5.7 µs | ~33 µs |
| 200 | ~11 µs | ~137 µs |

Only the *vnode* work is O(1) there — one rect re-emitted instead of
all of them. The stillness test still rescans every category (a count
that drops can retire the tallest bar, so extremes cannot be extended)
and the adapter rebuilds its snapshot arrays, so the bar session's tick
does grow with the category count. It grows about 2× where the
wholesale render grows about 4×; the line session's flatness is the
stronger claim, and this is deliberately the weaker one.

## Mermaid interop

`@jarenjs/mermaid` delegates its `pie` diagrams here (the arrow is
mermaid → charts, never the reverse); the
`@jarenjs/charts/transforms/mermaid-adapter` transform maps a mermaid
pie AST onto `compileChart` inputs.

## Validation

`schemas/chart-definition.schema.json` describes the definition
document; validate untrusted definitions with `@jarenjs/validate`
before compiling.
