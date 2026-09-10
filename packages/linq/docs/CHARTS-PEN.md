# The chart pen

> `./charts` — chart-definition documents for every chart kind. **Read it when**
> you want typed chart data and presentation options that `compileChart` consumes.

## 1. What it writes

Import the kind you need from `@jarenjs/linq/charts`. Each factory starts a
public chart definition with its literal `type`. Fluent methods replace one
member; `options()` replaces several. `.schema` is an independent, deeply
frozen JSON document, and `JSON.stringify(builder)` serializes that document.

The pen imports no chart renderer. Its declarations and known member vocabulary
are derived from the public chart grammar with `@jarenjs/emit`. Run
`node scripts/generate-chart-pen.js` after a grammar change; the drift gate
compares both generated files with that grammar.

## 2. The mapping table

The factory determines the available methods and their argument types. Every
method below preserves that discriminator and replaces a previous value.
Nested series and axis fragments use the shapes shared by the public grammar.

| Method | Emits | Type | Status |
|---|---|---|---|
| `pie(options?)`, `bar(options?)`, `line(options?)`, `scatter(options?)` | the named `type` and options | corresponding chart | native |
| `candlestick(options?)`, `radar(options?)`, `gauge(options?)`, `boxplot(options?)` | the named `type` and options | corresponding chart | native |
| `heatmap(options?)`, `treemap(options?)`, `streamgraph(options?)`, `sankey(options?)`, `map(options?)` | the named `type` and options | corresponding chart | native |
| `.options(object)` | supplied known members | same kind | native |
| `.title(text)`, `.stream(spec)` | `title`, `stream` | same kind | native |
| `.donut(value)`, `.slices(values)` | pie members | pie | native |
| `.stacked(value)`, `.orient(value)`, `.categories(values)` | bar members | bar | native |
| `.log(value)`, `.catLabel(text)`, `.valLabel(text)` | members on kinds that declare them | same kind | native |
| `.series(values)` | the kind's series shape | same kind | native |
| `.x(value)`, `.markers(value)`, `.sampling(value)` | line members | line | native |
| `.xLabel(text)`, `.yLabel(text)`, `.domain(spec)`, `.dateNames(names)`, `.timeFormats(formats)` | axis members on their declared kinds | same kind | native |
| `.xLog(value)`, `.yLog(value)`, `.refY(value)`, `.refLabel(text)` | scatter members | scatter | native |
| `.points(values)`, `.candles(values)` | the kind's point/candle data | same kind | native |
| `.axes(values)`, `.max(value)`, `.min(value)` | radar/gauge members | same kind | native |
| `.value(value)`, `.unit(text)`, `.tone(value)` | gauge values; map `value` is a property name | same kind | native |
| `.boxes(values)`, `.xLabels(values)`, `.yLabels(values)`, `.values(values)` | boxplot/heatmap members | same kind | native |
| `.aspect(value)`, `.items(values)`, `.xs(values)` | treemap/map/streamgraph members | same kind | native |
| `.nodes(values)`, `.links(values)` | sankey members | sankey | native |
| `.label(text)`, `.simplify(value)`, `.features(values)` | map members | map | native |
| `from(document)` | raw document, including extensions | declared chart shape | native |
| `.schema`, `.toJSON()` | frozen public document | chart definition | native |

## 3. Worked examples

```js
import { bar } from '@jarenjs/linq/charts';
export const chart = bar().categories(['A', 'B'])
  .series([{ name: 'Sales', values: [3, 5] }]).title('Sales');
```
```json
{"type":"bar","categories":["A","B"],"series":[{"name":"Sales","values":[3,5]}],"title":"Sales"}
```

Pass `chart.schema` to `compileChart` from `@jarenjs/charts`, then call
`toVnode()` or `toSvgString()` on the compiled result. Streaming consumers may
omit data members and supply data through the chart engine's separate argument.

## 4. Refusals

| Code | Condition |
|---|---|
| `JL0101` | a non-JSON value, non-plain option map, unknown kind or option, or a fluent member on a kind that does not declare it |

Numeric ranges and relationships among data members remain the chart grammar's
and renderer's responsibility. For extension fields use `from(document)`.

## 5. The types

`ChartBuilder` is the exported runtime class. `ChartPen<K>` adds precisely the
methods permitted by kind `K`; `ChartKind`, `ChartDefinitions`, `ChartOptions`
and the individual chart/fragment interfaces are types only. A bar series takes
`values`; a line series takes `points`. A gauge's `value` is numeric, while a
map's `value` names a feature property. `.options()` preserves the kind too.

The runtime tests enumerate every schema kind and top-level member, validate
each emitted document and compare its AST and SVG with the hand-written input.
The consumer type pins reject cross-kind methods and malformed series values.

## 6. What it cannot spell

Functions, engine instances and callbacks are not JSON chart definitions.
The pen does not compile geometry, validate longitude ranges, supply themes or
render tooltips; those responsibilities remain in the chart engine.

## 7. Cost

The isolated chart pen costs **<!--fact:bundle.charts-->15,582<!--/fact--> bytes**.
The tree-shaking gate refuses chart engine, other target engine and chain
modules in this bundle, and checks that the chain and schema pen do not import it.
