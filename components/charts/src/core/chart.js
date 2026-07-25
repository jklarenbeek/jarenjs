//@ts-check
/**
 * @file `compileChart` — the type dispatcher. Compiles a chart
 * definition plus its data into a bundle of cached projections
 * (the `compileMermaid` shape): the geometry-free AST, a pure-vnode
 * SVG, and a standalone SVG string.
 *
 * Memoization strategy (deliberate, see the component layer): identity
 * of the *data object* is the cache key, held in a WeakMap by
 * `createChartComponent` — never `hashContent(object)`, which would
 * stringify every object to `"[object Object]"` and collide
 * universally. `hashContent` is used only on the stable-stringified
 * config to derive the root vnode key.
 */

import { renderToString } from '@jarenjs/view';
import { hashContent } from '@jarenjs/core/string';
import { stableStringify } from '@jarenjs/core/object';

import { createTheme } from './palette.js';
import { buildPieAST, renderPieAST } from '../types/pie.js';
import { buildBarAST, renderBarAST } from '../types/bar.js';
import { buildLineAST, renderLineAST } from '../types/line.js';
import { buildScatterAST, renderScatterAST } from '../types/scatter.js';
import { buildCandlestickAST, renderCandlestickAST } from '../types/candlestick.js';
import { buildRadarAST, renderRadarAST } from '../types/radar.js';
import { buildGaugeAST, renderGaugeAST } from '../types/gauge.js';
import { buildBoxplotAST, renderBoxplotAST } from '../types/boxplot.js';
import { buildHeatmapAST, renderHeatmapAST } from '../types/heatmap.js';
import { buildTreemapAST, renderTreemapAST } from '../types/treemap.js';
import { buildStreamgraphAST, renderStreamgraphAST } from '../types/streamgraph.js';
import { buildSankeyAST, renderSankeyAST } from '../types/sankey.js';

/** @type {Record<string, {build: (data: any, config: any) => any, render: (ast: any, theme: any, hash: string, options?: any) => any}>} */
const TYPES = {
  pie: { build: buildPieAST, render: renderPieAST },
  bar: { build: buildBarAST, render: renderBarAST },
  line: { build: buildLineAST, render: renderLineAST },
  scatter: { build: buildScatterAST, render: renderScatterAST },
  candlestick: { build: buildCandlestickAST, render: renderCandlestickAST },
  radar: { build: buildRadarAST, render: renderRadarAST },
  gauge: { build: buildGaugeAST, render: renderGaugeAST },
  boxplot: { build: buildBoxplotAST, render: renderBoxplotAST },
  heatmap: { build: buildHeatmapAST, render: renderHeatmapAST },
  treemap: { build: buildTreemapAST, render: renderTreemapAST },
  streamgraph: { build: buildStreamgraphAST, render: renderStreamgraphAST },
  sankey: { build: buildSankeyAST, render: renderSankeyAST },
};

/**
 * The chart types the dispatcher knows.
 * @returns {string[]}
 */
export function chartTypes() {
  return Object.keys(TYPES);
}

/**
 * @typedef {object} CompiledChart
 * @property {any} ast the geometry-free AST
 * @property {() => any} toVnode cached pure-vnode SVG
 * @property {() => string} toSvgString cached standalone SVG string (SSR)
 */

/**
 * Compile a chart definition. `config` carries the type and
 * presentation fields; `data` carries the series/slices and defaults to
 * the config object itself, so a single self-contained definition
 * document works while streaming callers pass live data separately.
 *
 * @param {{type: string, title?: string, [k: string]: any}} config
 * @param {any} [data]
 * @param {{theme?: any}} [options]
 * @returns {CompiledChart}
 * @throws {TypeError} On an unknown chart type
 */
export function compileChart(config, data = config, options = {}) {
  const def = TYPES[config?.type];
  if (def === undefined)
    throw new TypeError(`unknown chart type '${config?.type}'`);
  const ast = def.build(data, config);
  const theme = createTheme(options.theme);
  const hash = hashContent(stableStringify(config) ?? '');
  let vnode;
  let svg;
  return {
    ast,
    toVnode() {
      if (vnode === undefined) vnode = def.render(ast, theme, hash);
      return vnode;
    },
    toSvgString() {
      if (svg === undefined) svg = renderToString(this.toVnode());
      return svg;
    },
  };
}
