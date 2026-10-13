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
| `radar` | `axes: string[]`, `series: [{name, values}]`; `max` pins the domain, `labelEvery` the spoke-label stride |
| `gauge` | `value`; `min`/`max` (0..100 default), `unit`, `tone` |
| `boxplot` | `boxes: [{label, values}]` raw, or `{label, min, q1, med, q3, max, outliers?}` |
| `heatmap` | `xLabels`, `yLabels`, `values[yi][xi]` (row-major from the top); `log` |
| `treemap` | `items: [{label, value}]` or `[{label, children: [{label, value}]}]`; `aspect` (default 1.6) |
| `streamgraph` | `series: [{name, values}]`, optional numeric `xs` |
| `sankey` | `links: [{source, target, value}]` by name or index; `nodes` optional |

**Time axes.** An `x: 'time'` axis (and every `candlestick`) accepts epoch milliseconds, a `Date`, or an **RFC 3339 string** — a date in a JSON document plots without being pre-converted, and a bare `2026-07-27` reads as UTC midnight. A *numeric* string still does not coerce: accepting `"5"` where the config asked for a number is a type confusion, not a date.

The chart-definition schema admits the same spellings, so a definition that is checked before it is compiled (the play `charts` engine does) is not refused for a date. A line point's `x` and a candle's `t` are a number or an RFC 3339 full-date or date-time string; the patterns check the calendar (month lengths, leap years) and the clock, because a validator does not assert `format` by default. What the renderer cannot place stays refused: a numeric string, a time without a date, a date-time without an offset, a month 13. Every other member (a `y`, a scatter `x`, an OHLC price) is a number. One spelling the renderer reads is outside the schema: a leap second written with a non-zero offset (`23:59:60Z` and `23:59:60+00:00` are admitted). *Upgrade: a definition with `x: "2026-07-27"` or `t: "2026-07-27T10:00:00Z"` used to fail schema validation, with `compileChart` accepting it; it now validates. The `@jarenjs/linq/charts` pen types the same two members as `number | string`; every value accepted before is accepted unchanged.*

Ticks land on calendar boundaries rather than on the 1/2/5 ladder, because a quantity axis and a clock have different nice numbers — the ladder puts ticks 50 seconds or 8.64 days apart, which no reader converts back into a time. Steps come from a clock/calendar ladder (1/5/15/30 seconds and minutes, 1/3/6/12 hours, 1/2 days, 1/2 weeks, 1/3/6 months, years, then whole years on the 1/2/5 × 10^k ladder above that), each tick lands on a multiple of its own step, and the label granularity follows the step, so an axis never repeats one string on every tick:

```javascript
axisTicksTime(Date.UTC(2024, 0, 1), Date.UTC(2027, 0, 1));  // → 2024, 2025, 2026, 2027
axisTicksTime(Date.UTC(2026, 6, 27, 0), Date.UTC(2026, 6, 27, 6));  // → 00:00 … 06:00
axisTicksTime(Date.UTC(1970, 0, 1), Date.UTC(5000, 0, 1));  // → 2000, 3000, 4000, 5000
```

`axisTicksTime`, `niceTimeStep`, `axisTicksLinear` and `niceStep` are the kernel's (`@jarenjs/core/dates`, `@jarenjs/core/math`) and are re-exported here as part of this module's tick vocabulary: a timeline that is not a chart wants the same boundaries, and a second copy of either ladder would be a second set of answers.

The full contract is `schemas/chart-definition.schema.json`.

**Values a chart cannot draw are dropped, not printed.** Bar and line skip
a non-finite value, and a bar chart skips a zero (a bar of no length) and, on a
`log` axis, a value of zero or less (a log axis has no zero and no side below it);
a negative value on a linear axis hangs below a zero baseline that sits inside the
plot, and a stacked chart stacks positives up and negatives down, apart; a pie drops every slice whose value is not a finite
number of at least zero, so the shares are of what is left — such a slice
used to be summed into the total and printed as `a: NaN (NaN%)` or as a
share above 100%. A domain wider than a double can measure — data at
±1e308, a pinned or `'step'` domain over it, a bar or radar top rounded
up past `Number.MAX_VALUE`, a stacked total that overflows — is clamped
to ±`Number.MAX_VALUE / 2` by every type that lays ticks over its values
(line, scatter, candlestick, boxplot, streamgraph, gauge, bar, radar),
and marks beyond the clamp pin to the plot's edge; such a domain used to
label a `NaN` tick, or lose its value axis and draw every mark at one
edge. Totals beyond 1.79e308 are shown by proportion: a pie, treemap,
sankey or streamgraph whose values sum past `Number.MAX_VALUE` measures
them in units of the largest, so every slice, tile, ribbon and band
keeps its share and only the AST's `total` reads `Infinity`; such a sum
used to shrink every slice to 0%, flatten a streamgraph column and put
tiles and ribbons at `NaN`. A log axis tops out at 1e308: rounding data
near the largest double up a decade used to lay decades toward
`Infinity` until the tick array overflowed, and `axisTicksLog` now
refuses an infinite bound with a `RangeError` at once.

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
the repo's docs/DESIGN.md), and `SEQUENTIAL` is its magnitude counterpart:
a single-hue blue ramp, light→dark, sampled continuously by
`sequentialColor(t)` (the heatmap's cell fill). The semantic tokens
(text/grid/axis, win/loss) resolve through the shared `resolveTheme`
kernel and can be host-linked with `theme: 'host'`, so charts follow
the site's light/dark flip live without a re-render.

### A time axis in a language

A time axis labels its ticks by the granularity of the step they were
laid on — `HH:mm:ss`, `HH:mm`, `yyyy-MM-dd`, `yyyy-MM`, `yyyy` (the
`TIME_TICK_FORMATS` constant). Those are numeric, so nothing on a
default axis is mistranslated and nothing on it needs a language. A
`line` (with `x: 'time'`) or `candlestick` definition that wants month
or weekday names carries two flat members beside `x` and `xLabel`:
`timeFormats`, LDML patterns keyed by step granularity (`second`,
`minute`, `day`, `month`, `year`; an omitted member keeps its default),
and `dateNames`, the same `DateNames` record the Mermaid Gantt takes —
exactly what `@jarenjs/locales`' `compileDateLocale(pack).names`
produces:

```js
import { compileChart } from '@jarenjs/charts';
import { compileDateLocale, nl } from '@jarenjs/locales';

const chart = compileChart({
  type: 'line', x: 'time',
  dateNames: compileDateLocale(nl).names,
  timeFormats: { day: 'EEEE d MMMM' },
  series: [{ name: 'a', points: [
    { x: '2026-07-20', y: 1 }, { x: '2026-07-24', y: 3 }, { x: '2026-07-29', y: 2 },
  ] }],
});
chart.toSvgString(); // the ticks read 'maandag 20 juli', 'woensdag 22 juli', 'vrijdag 24 juli', …
```

Both members are data: they serialise with the definition, validate
against the schema, and two charts on one page carry two records
without touching each other. The five patterns are compiled **once per
build** (`compileTimeTickFormat`, exported for a caller labelling its
own axis), never per label, so a two-hundred-tick axis costs five
compilations; a definition with neither member compiles nothing at all
and labels exactly as `formatTimeTick` does.

**Without a record a name token is a compile error, not a silent English
fallback.** This engine ships no month or weekday names of its own, so
`timeFormats: { day: 'EEEE d MMMM' }` with no `dateNames` throws a
`TypeError` naming the member and the way out — the same rule, in the
same words, as the Gantt's `axisFormat %B`. A numeric pattern needs no
record. No ambient locale is ever read: the record is supplied or
absent, never inferred.

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
`abortDocument()` discards a malformed one). Six accumulators:

| type | what a record contributes | fields |
|---|---|---|
| `line` | a point on a series, ring-buffer evicted | `xField`, `yField`, `seriesField` |
| `bar` | +1 (or `+yField`) on a category | `xField`, `yField?` |
| `heatmap` | the same, under two grouping keys | `xField` (column), `seriesField` (row), `yField?` |
| `gauge` | the latest reading; nothing is kept | `yField` |
| `candlestick` | a candle keyed by open time; a re-delivered key replaces it (exchange kline semantics) | `xField`, `openField`… |
| `map` | a whole GeoJSON Feature, projected and simplified on arrival | `labelField?`, `valueField?`, `simplify?`, `aspect?` |

A heatmap cell nobody measured stays `null` rather than `0` — the
surface shows through, which is the honest rendering of "no
measurement" — and a gauge with no reading yet is `null`, not zero.

The `map` accumulator is the odd one out: its record is not flat pair
fields but a complete Feature, consumed from the reader's `object-end`
events at `recordPath + [index]` (default `['features']`) — pair the
reader with `detach: ['features', '*']` so the document root retains
nothing and the accumulator's reduced set is the only retention. Each
feature's geometry is simplified **on arrival** to the vertices a
drawing of the current extent could distinguish, so memory is bounded
by the drawn detail rather than the source detail. The projection
cannot be fitted before the last feature has been seen, so the design
is refit-on-growth: the running bbox sets the tolerance, and when it
grows enough to double it, the kept features are coarsened once against
the new extent (never re-read — early features can only be finer than
needed, not wrong). `simplify: false` keeps every vertex, which unbounds
memory again; `test/charts/map-stream.test.js` pins the reduction, the
refit and the change-feed replay.

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
Line sources containing series without an array of `points` also rebuild
on changes: compilation filters those series, so source change indices
no longer match the rendered series indices.

Measured (`npm run benchmark:charts`, one appended point):

<!--fact:charts.sessionTable-->
| points × series | session tick | wholesale tick | frames incremental |
|---|---:|---:|---:|
| 100 × 5 | 5.82 µs | 306 µs | 1100 of 1100 |
| 1,000 × 5 | 5.5 µs | 1 ms | 1100 of 1100 |
| 10,000 × 5 | 7.9 µs | 8.41 ms | 1100 of 1100 |
| 10,000 × 5 *(sampled)* | 2.5 ms | 2.52 ms | 0 of 1100 |
<!--/fact-->

The session tick is *flat* in n — it
moves <!--fact:charts.sessionFlatness-->1.4× while the wholesale tick grows 27.4×<!--/fact-->. Supported types: `line` (appends
and ring-buffer evictions), `bar` (live counts and sums), `heatmap`
(live matrix counts and sums) and `candlestick` (keyed kline upserts —
one candle group re-renders). The website's Binance demo runs on it.

The first three rows are lines the **sampler is not choosing the points
of** (see below). A session over a time line above two thousand points
rebuilds every frame by design — one appended reading can change which
vertices the downsampler picks, anywhere on the line — and that rebuild
costs *more* than the wholesale render it replaces, because it scans the
extremes a second time. That is the last row, and it is the price of the
default: a long live line declares `sampling: false`, which is exactly
what the three rows before it are.

A bar chart's stillness test is the nice-number bounds rather than a
declared policy: a count inside them repaints one rect, a count that
pushes the axis past either end rebuilds. A new category rebuilds too — every
band width and position moves with it — and so does a stacked chart,
where one value shifts every bar above it in its category.

| categories | session tick | wholesale tick |
|---|---|---|
| 20 | ~5.7 µs | ~33 µs |
| 200 | ~11 µs | ~137 µs |

A heatmap's stillness test is its ramp: every cell is coloured by where
its magnitude sits between the matrix minimum and maximum, so a count
between the two repaints one rect, while a count that sets or retires
either extreme re-colours every cell and the key, and rebuilds. A new row
or column rebuilds (the grid re-divides), and so does a cell gaining its
first count or losing its last — a rect appears or goes, and every later
child's index moves. Like the bar session, one rect is re-emitted, but the
tick still copies the root's child list and rescans the matrix, so it grows
with the cell count.

Only the *vnode* work is O(1) in the bar table above — one rect re-emitted instead of
all of them. The stillness test still rescans every category (a count
that drops can retire the tallest bar, so extremes cannot be extended)
and the adapter rebuilds its snapshot arrays, so the bar session's tick
does grow with the category count. It grows about 2× where the
wholesale render grows about 4×; the line session's flatness is the
stronger claim, and this is deliberately the weaker one.

## Sampling a big line

A hundred thousand readings on a line five hundred pixels wide is two
hundred readings per column. Something has to choose, and the only
question is whether the choosing is visible.

Above **two thousand source points** a **time** line is reduced through
`downsampleSeries` from `@jarenjs/core/series` — the same kernel a query
and a database call, so a chart cannot disagree with the rest of the
suite about what a gap is or where a series ends. Everything smaller,
and every non-time line, is the AST the previous version built, point
for point.

```js
compileChart({ type: 'line', x: 'time' }, data);                  // LTTB above 2 000
compileChart({ type: 'line', x: 'time', sampling: false }, data); // draw every point
compileChart({ type: 'line', x: 'time', sampling: 'minmax' }, data);
compileChart({ type: 'line', x: 'time',
  sampling: { method: 'lttb', target: 800 } }, data);             // an explicit budget
```

The default budget is a function of the **declared** width
(`sampling: { width, pixelRatio }`, default 560 × 1, clamped to
64…8 192) and never of a measured element — nothing in this package
reads a layout, so an SSR render and a browser render of one definition
are the same bytes. An explicit `target` fixes it outright.

`ast.sampling` reports what happened: `{ method, target, sourceCount,
renderedCount }`, or `null` when every point is drawn. What the sampled
line still promises is the kernel's: every segment's **ends** survive,
every run of gaps keeps a marker and is never bridged, `minmax` keeps
the envelope exactly, and no vertex carries an instant that no reading
had. The domain is scanned from every **source** point, so the axis
reports the data rather than the drawing.

Measured (`npm run benchmark:charts`, one series):

<!--fact:charts.samplingTable-->
| source points | drawn | method | source → AST | source → svg |
|---:|---:|---|---:|---:|
| 2,000 | 2,000 | none | 77.1 µs → 71.5 µs | 512 µs → 518 µs |
| 20,000 | 560 | lttb | 672 µs → 911 µs | 5.94 ms → 1.06 ms |
| 100,000 | 560 | lttb | 4.08 ms → 5.33 ms | 28.3 ms → 6.61 ms |
<!--/fact-->

Choosing the points costs about what mapping them costs — the sampler
reads every reading either way — so the AST column is a small **loss**.
What it buys is the render — <!--fact:charts.samplingWin-->100,000 points draw as 560 and render 4.3× faster<!--/fact-->. The invariants above are asserted in the benchmark
before a single timing is printed.

**Sampling is not retention.** `createStreamAdapter`'s `maxPoints`
decides what *exists*; sampling decides what is *drawn*, over whatever
exists. Changing one leaves the other untouched, and a chart can switch
method or turn sampling off without the adapter noticing.

## Mermaid interop

`@jarenjs/mermaid` draws a `pie` with the renderer a host hands it, and
this package ships that renderer: `mermaidPieRenderer` from
`@jarenjs/charts/transforms/mermaid-adapter`, charts' own pie with
mermaid's class names, palette and theme. Neither component imports the
other — the host composes them:

```js
import { diagramToVnode } from '@jarenjs/mermaid';
import { mermaidPieRenderer } from '@jarenjs/charts/transforms/mermaid-adapter';

diagramToVnode('pie title Pets\n "Dogs" : 3\n "Cats" : 1', { renderers: { pie: mermaidPieRenderer } });
```

The same module's `mermaidPieToChartAST` maps a mermaid pie AST onto
`compileChart` inputs.

## Validation

`schemas/chart-definition.schema.json` describes the definition
document; validate untrusted definitions with `@jarenjs/validate`
before compiling.

New capability (upgrade notes): `createChartSession` accepts `type: 'heatmap'`
(it threw before), and a `ramp` option (a colour list, light to dark) is read by
both `compileChart` and the heatmap session, so the two stay byte-equal under it.
Answers that changed: a bar chart with a negative value on a linear
axis used to drop it and draw nothing; it now draws the bar from a zero baseline inside
the plot, and the value axis extends below zero to hold it (a chart with no negative
value is unchanged). A bar chart places each bar and tick by its
position in `categories`, where two categories sharing a label (`['a', 'a', 'b']`)
were drawn in one band, one over the other, with the first band empty;
`scaleBand` gained `start(index)` for that. `formatTickValue` carries into the next
unit when rounding reaches 1000 of this one (999,999 reads `1M`, not `1000k`).
Axes built on `axisTicksLinear` keep the tick at either end of a raw domain when
the quotient rounds just short of a whole number (`[0, 0.3]` gains its `0.3`,
`[0.1, 0.7]` its `0.7`); the bar, line, scatter and gauge builders nice the
domain first and are unchanged, while candlestick, boxplot, streamgraph and
radar axes can gain an end tick.

## Exports

Every subpath a consumer can import, derived from the manifest by
`npm run docs:derive` (`npm run docs:check` fails when the two drift):

<!--fact:exports.charts-->
| Import | Kind | Declarations |
|---|---|---|
| `@jarenjs/charts` | JavaScript | declared |
| `@jarenjs/charts/component` | JavaScript | declared |
| `@jarenjs/charts/stream-adapter` | JavaScript | declared |
| `@jarenjs/charts/transforms/mermaid-adapter` | JavaScript | declared |
| `@jarenjs/charts/transforms/benchmark-adapter` | JavaScript | declared |
| `@jarenjs/charts/styles/charts.css` | asset | — |
| `@jarenjs/charts/schemas/chart-definition.schema.json` | schema | — |
| `@jarenjs/charts/package.json` | metadata | — |
| `@jarenjs/charts/transforms/finance-adapter` | JavaScript | declared |
<!--/fact-->

Author definitions in code with the typed [chart pen](../../packages/linq/docs/CHARTS-PEN.md),
then pass its `.schema` directly to `compileChart`.

`@jarenjs/charts/transforms/finance-adapter` exports `financeCharts(samples,
{periodsPerYear, period?, signalPeriod?, sessions?, target?, benchmark?})`.
Each sample supplies `{t, high, low, close, volume}` with a finite timestamp and
positive close. It returns eleven separate named indicator chart pairs and a risk
summary; null warm-up points are omitted and timestamps are preserved. Units are
kept in separate charts. The optional benchmark is a return series aligned to the
price-derived returns. Formula/period conventions are in
[core finance](../../packages/core/docs/FINANCE.md).
