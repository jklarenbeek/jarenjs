//@ts-check
/**
 * @file The heatmap chart type: a category × category matrix of
 * magnitudes on the sequential blue ramp — the alternative reading of
 * the benchmark scenario matrices that ship as grouped bars. Data
 * shape:
 *
 *   data   = { xLabels: string[], yLabels: string[],
 *              values: number[][] }               // values[yi][xi], row-major
 *   config = { type:'heatmap', title?, xLabel?, yLabel?, log? }
 *
 * The AST is unit-space cell bands plus a normalized magnitude `t` per
 * cell; the color (the sequential ramp), the cell inset and the ramp
 * legend are render decisions. Rows read top-down: `yLabels[0]` is the
 * top row. Non-finite cells (and non-positive ones under `log`) are
 * simply absent — the surface shows through, which is the honest
 * rendering of "no measurement".
 */

import { svgRoot, coord } from '@jarenjs/view/helpers';
import { clamp01 } from '@jarenjs/core/math';
import { scaleLinear, scaleLog } from '../core/scale.js';
import { formatTickValue } from '../core/axis.js';
import { cartesianFrame, annotateChart, rampLegend } from '../core/cartesian.js';
import { SEQUENTIAL, sequentialColor } from '../core/palette.js';
import { normalizeTooltip, valueMark } from '../core/marks.js';

/**
 * @typedef {object} HeatCellAST
 * @property {number} xi @property {number} yi
 * @property {number} u0 @property {number} u1
 * @property {number} v0 @property {number} v1
 * @property {number} t normalized magnitude (0..1)
 * @property {number} value
 */
/**
 * @typedef {object} HeatmapAST
 * @property {'heatmap'} type
 * @property {string|null} title
 * @property {string[]} xLabels @property {string[]} yLabels
 * @property {{ticks: {pos:number,label:string}[], label: string|null}} x
 * @property {{ticks: {pos:number,label:string}[], label: string|null}} y
 * @property {HeatCellAST[]} cells
 * @property {{min: number, max: number}|null} domain finite-value extent (null = no data)
 */

/**
 * Whether a cell value draws a rect: a finite number, and a positive one
 * under `log` (the surface shows through everywhere else).
 * @param {any} v @param {boolean} log
 * @returns {boolean}
 */
export function heatDrawable(v, log) {
  return typeof v === 'number' && Number.isFinite(v) && (!log || v > 0);
}

/**
 * The finite-value extent of a row-major matrix over the first `nx`
 * columns and `ny` rows; `null` when no cell draws. The stillness test
 * of the session and the wholesale build share it, so the two cannot
 * disagree about when the ramp moved.
 * @param {any[]} values @param {number} nx @param {number} ny @param {boolean} log
 * @returns {{min: number, max: number}|null}
 */
export function scanHeatmapExtent(values, nx, ny, log) {
  let min = Infinity;
  let max = -Infinity;
  for (let yi = 0; yi < ny; yi++) {
    const row = values[yi];
    if (!Array.isArray(row)) continue;
    for (let xi = 0; xi < nx; xi++) {
      const v = row[xi];
      if (!heatDrawable(v, log)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return Number.isFinite(min) ? { min, max } : null;
}

/**
 * The magnitude-to-ramp-position function of a domain (decades under
 * `log`); `null` when there is no data. A domain wider than a double
 * still spreads over the ramp, since the linear scale measures it at
 * half scale.
 * @param {{min: number, max: number}|null} domain @param {boolean} log
 * @returns {((v: number) => number)|null}
 */
export function heatmapShade(domain, log) {
  if (domain === null) return null;
  const scale = log ? scaleLog(domain.min, domain.max) : scaleLinear(domain.min, domain.max);
  return (v) => clamp01(scale(v));
}

/**
 * Build the geometry-free heatmap AST.
 * @param {any} data
 * @param {any} [config]
 * @returns {HeatmapAST}
 */
export function buildHeatmapAST(data, config = {}) {
  const xLabels = (data?.xLabels ?? []).map((l) => String(l));
  const yLabels = (data?.yLabels ?? []).map((l) => String(l));
  const values = Array.isArray(data?.values) ? data.values : [];
  const log = config.log === true;

  const domain = scanHeatmapExtent(values, xLabels.length, yLabels.length, log);
  const shade = heatmapShade(domain, log);

  const xStep = xLabels.length === 0 ? 1 : 1 / xLabels.length;
  const yStep = yLabels.length === 0 ? 1 : 1 / yLabels.length;
  const cells = [];
  if (shade !== null) {
    for (let yi = 0; yi < yLabels.length; yi++) {
      const row = values[yi];
      if (!Array.isArray(row)) continue;
      for (let xi = 0; xi < xLabels.length; xi++) {
        const v = row[xi];
        if (!heatDrawable(v, log)) continue;
        cells.push({
          xi, yi,
          u0: xi * xStep,
          u1: (xi + 1) * xStep,
          // yLabels[0] is the top row; v = 0 sits at the plot bottom.
          v0: 1 - (yi + 1) * yStep,
          v1: 1 - yi * yStep,
          t: shade(v),
          value: v,
        });
      }
    }
  }

  return {
    type: 'heatmap',
    title: config.title ?? null,
    xLabels,
    yLabels,
    x: {
      ticks: xLabels.map((label, xi) => ({ pos: (xi + 0.5) * xStep, label })),
      label: config.xLabel ?? null,
    },
    y: {
      ticks: yLabels.map((label, yi) => ({ pos: 1 - (yi + 0.5) * yStep, label })),
      label: config.yLabel ?? null,
    },
    cells,
    domain,
  };
}

/**
 * One cell's rect: inset, colored by the sequential ramp, carrying its
 * exact value as hover text. Shared by the wholesale render and the
 * session's in-place patch, so the two cannot print a cell differently.
 * @param {HeatCellAST} cell
 * @param {HeatmapAST} ast
 * @param {{x:number,y:number,w:number,h:number}} plot
 * @param {readonly string[]} ramp
 * @param {import('../core/marks.js').ChartTooltipSpec} [tooltip] normalized
 * @returns {any}
 */
export function heatCellRender(cell, ast, plot, ramp, tooltip = null) {
  const inset = 1;
  const x = plot.x + cell.u0 * plot.w + inset;
  const y = plot.y + (1 - cell.v1) * plot.h + inset;
  const w = (cell.u1 - cell.u0) * plot.w - 2 * inset;
  const h = (cell.v1 - cell.v0) * plot.h - 2 * inset;
  return valueMark('rect', {
    x: coord(x), y: coord(y),
    width: coord(Math.max(0.5, w)), height: coord(Math.max(0.5, h)),
    fill: sequentialColor(cell.t, ramp), class: 'chart-heat-cell',
  }, tooltip,
  `${ast.xLabels[cell.xi]} × ${ast.yLabels[cell.yi]}: ${formatTickValue(cell.value)}`,
  {
    type: 'heatmap', x: ast.xLabels[cell.xi], y: ast.yLabels[cell.yi], value: cell.value,
  });
}

/**
 * Render a heatmap AST and return the svg WITH the geometry a session
 * needs to replace one cell in place: the plot rect and how many chrome
 * children precede the cells.
 * @param {HeatmapAST} ast
 * @param {{tokens: Record<string,string>, cssVars: Record<string,string>}} theme
 * @param {string} hash
 * @param {{rootClass?: string, keyPrefix?: string, ramp?: readonly string[], width?: number,
 *   tooltip?: import('../core/marks.js').ChartTooltipSpec}} [options]
 * @returns {{svg: any, plot: {x:number,y:number,w:number,h:number}, chromeLen: number}}
 */
export function buildHeatmapRender(ast, theme, hash, options = {}) {
  const ramp = options.ramp ?? SEQUENTIAL;
  const tooltip = normalizeTooltip(options.tooltip);
  // The ramp key rides the frame's legend mechanism: five sequential
  // stops as swatches, the extent values as the end labels.
  const { stops: rampStops, legend } = rampLegend(ast.domain, ramp);
  const frame = cartesianFrame({
    title: ast.title,
    legend,
    xAxis: ast.x,
    yAxis: ast.y,
    grid: 'none',
    width: options.width,
    plotHeight: Math.max(80, ast.yLabels.length * 26),
    palette: rampStops,
    theme,
  });
  const { plot } = frame;
  const children = frame.children;
  const chromeLen = children.length;
  for (const cell of ast.cells) children.push(heatCellRender(cell, ast, plot, ramp, tooltip));
  const svg = svgRoot(options.rootClass ?? 'chart chart-svg chart-heatmap-chart',
    frame.width, frame.height, theme, children, (options.keyPrefix ?? 'heat-') + hash);
  annotateChart(svg, ast.title);
  return { svg, plot, chromeLen };
}

/**
 * Render a heatmap AST to a pure-vnode SVG: inset cell rects colored by
 * the sequential ramp, a labeled min→max ramp key in the legend slot,
 * and a `<title>` per cell with the exact value.
 * @param {HeatmapAST} ast
 * @param {{tokens: Record<string,string>, cssVars: Record<string,string>}} theme
 * @param {string} hash
 * @param {{rootClass?: string, keyPrefix?: string, ramp?: readonly string[], width?: number,
 *   tooltip?: import('../core/marks.js').ChartTooltipSpec}} [options]
 * @returns {any}
 */
export function renderHeatmapAST(ast, theme, hash, options = {}) {
  return buildHeatmapRender(ast, theme, hash, options).svg;
}
