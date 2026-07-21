//@ts-check
/**
 * @file `@jarenjs/charts` — headless charts. This is the **engine**:
 * pure functions over data — definition + data ⇄ geometry-free AST ⇄
 * pure-vnode SVG — that know only the `@jarenjs/view` vnode shape. It
 * imports nothing from the component layer, `@jarenjs/app`, or the DOM
 * (the two-layer component rule).
 *
 * The pipeline mirrors `@jarenjs/mermaid`:
 *
 *   {config, data} ──build{Type}AST──▶ geometry-free AST (abstract
 *                                       fractions/angles, no pixels)
 *                      │
 *                      ▼
 *                render{Type}AST ──▶ pure-vnode SVG (toVnode /
 *                                     toSvgString via compileChart)
 */

export { compileChart, chartTypes } from './core/chart.js';
export { scaleLinear, scaleLog, scaleOrdinal, scaleBand, scaleTime } from './core/scale.js';
export {
  niceStep, axisTicksLinear, axisTicksLog, axisTicksOrdinal,
  formatTickValue, formatTimeTick,
} from './core/axis.js';
export { CATEGORICAL, seriesColor, createTheme, THEMES, HOST_VARS } from './core/palette.js';
export { buildPieAST, renderPieAST } from './types/pie.js';
export { buildBarAST, renderBarAST } from './types/bar.js';
export { buildLineAST, renderLineAST } from './types/line.js';
export { buildScatterAST, renderScatterAST } from './types/scatter.js';
export { buildCandlestickAST, renderCandlestickAST } from './types/candlestick.js';
export { createStreamAdapter } from './core/stream-adapter.js';
