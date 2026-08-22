---
package: "@jarenjs/charts"
card:
  title: Charts
  blurb: >-
    Headless SVG charts from JSON/JSONX/JOSL definitions: geometry-free
    ASTs, thirteen chart types from pie to GeoJSON maps, schema-validated,
    and a stream adapter that builds charts live from the incremental
    readers — replay a document chunk by chunk, or go live on real market
    data.
  perf: >-
    incremental ticks that stay flat as the series grows
engines:
  - key: charts
    suite: charts
---

Headless charts: `@jarenjs/charts` compiles a definition document plus its data
into a geometry-free AST (fractions, angles, unit coordinates — no pixels) and
renders pure-vnode SVG through `@jarenjs/view`. Thirteen types — pie (and
donut), bar, line, scatter, candlestick, radar, gauge, boxplot, heatmap,
treemap, streamgraph, sankey, map (GeoJSON in Web Mercator, shaded by a feature
property) — themed by host-linked tokens; the Benchmarks page charts and the
mermaid pie are this engine.

```js
import { compileChart } from '@jarenjs/charts';
const compiled = compileChart({ type: 'pie', title: 'Pets',
  slices: [{ label: 'Dogs', value: 40 }, { label: 'Cats', value: 25 }] });
compiled.ast;           // geometry-free JSON
compiled.toSvgString(); // standalone SVG
```

The stream adapter turns the josl readers’ unified events into live chart data:
records assemble as their fields arrive (path mode for one big document in
chunks, document mode for many small messages), with ring-buffer eviction and
identity-keyed memo re-renders. The Charts page’s live Binance feed is this
code path.

> **Try it** — Play’s Charts engine compiles definitions in JSON, JSONX or JOSL
> and renders pure-vnode SVG. The streaming half — a chart building chunk by
> chunk, and the live Binance feed — is the Charts page. [Open
> Play](#/play?engine=charts)
