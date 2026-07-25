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

import { svgRoot } from '@jarenjs/view/helpers';
import { formatTickValue } from '../core/axis.js';
import { cartesianFrame, annotateChart } from '../core/cartesian.js';
import { SEQUENTIAL, sequentialColor } from '../core/palette.js';

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

  let min = Infinity;
  let max = -Infinity;
  for (let yi = 0; yi < yLabels.length; yi++) {
    const row = values[yi];
    if (!Array.isArray(row)) continue;
    for (let xi = 0; xi < xLabels.length; xi++) {
      const v = row[xi];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      if (log && v <= 0) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  const domain = Number.isFinite(min) ? { min, max } : null;
  const span = domain === null ? 0
    : log ? Math.log10(max) - Math.log10(min)
      : max - min;

  const xStep = xLabels.length === 0 ? 1 : 1 / xLabels.length;
  const yStep = yLabels.length === 0 ? 1 : 1 / yLabels.length;
  const cells = [];
  if (domain !== null) {
    for (let yi = 0; yi < yLabels.length; yi++) {
      const row = values[yi];
      if (!Array.isArray(row)) continue;
      for (let xi = 0; xi < xLabels.length; xi++) {
        const v = row[xi];
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        if (log && v <= 0) continue;
        const t = span === 0 ? 0.5
          : log ? (Math.log10(v) - Math.log10(min)) / span
            : (v - min) / span;
        cells.push({
          xi, yi,
          u0: xi * xStep,
          u1: (xi + 1) * xStep,
          // yLabels[0] is the top row; v = 0 sits at the plot bottom.
          v0: 1 - (yi + 1) * yStep,
          v1: 1 - yi * yStep,
          t: clamp01(t),
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

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Render a heatmap AST to a pure-vnode SVG: inset cell rects colored by
 * the sequential ramp, a labeled min→max ramp key in the legend slot,
 * and a `<title>` per cell with the exact value.
 * @param {HeatmapAST} ast
 * @param {{tokens: Record<string,string>, cssVars: Record<string,string>}} theme
 * @param {string} hash
 * @param {{rootClass?: string, keyPrefix?: string, ramp?: readonly string[], width?: number}} [options]
 * @returns {any}
 */
export function renderHeatmapAST(ast, theme, hash, options = {}) {
  const ramp = options.ramp ?? SEQUENTIAL;
  // The ramp key rides the frame's legend mechanism: five sequential
  // stops as swatches, the extent values as the end labels.
  const rampStops = [0, 0.25, 0.5, 0.75, 1].map((t) => sequentialColor(t, ramp));
  const legend = ast.domain === null ? null : rampStops.map((_, i) => ({
    name: i === 0 ? formatTickValue(ast.domain.min)
      : i === rampStops.length - 1 ? formatTickValue(ast.domain.max) : '',
    swatch: i,
  }));
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
  const inset = 1;
  for (const cell of ast.cells) {
    const x = plot.x + cell.u0 * plot.w + inset;
    const y = plot.y + (1 - cell.v1) * plot.h + inset;
    const w = (cell.u1 - cell.u0) * plot.w - 2 * inset;
    const h = (cell.v1 - cell.v0) * plot.h - 2 * inset;
    children.push(['rect', {
      x: round2(x), y: round2(y),
      width: round2(Math.max(0.5, w)), height: round2(Math.max(0.5, h)),
      fill: sequentialColor(cell.t, ramp), class: 'chart-heat-cell',
    }, ['title', {},
      `${ast.xLabels[cell.xi]} × ${ast.yLabels[cell.yi]}: ${formatTickValue(cell.value)}`]]);
  }
  const svg = svgRoot(options.rootClass ?? 'chart chart-svg chart-heatmap-chart',
    frame.width, frame.height, theme, children, (options.keyPrefix ?? 'heat-') + hash);
  return annotateChart(svg, ast.title);
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
