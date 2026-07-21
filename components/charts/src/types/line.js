//@ts-check
/**
 * @file The line chart type: multi-series polylines over a linear or
 * time x axis, linear or log y axis, optional point markers. This is
 * the streaming-critical type — a live feed re-renders it per snapshot
 * — so build and render stay allocation-light (one pass per series,
 * `polylinePath` breaks the line on unplottable samples instead of
 * filtering arrays). Data shape:
 *
 *   data   = { series: [{ name, points: [{x, y}] }] }
 *   config = { type:'line', title?, x?: 'linear'|'time', log?,
 *              markers?, xLabel?, yLabel? }
 */

import { svgRoot, path as svgPath, circle, polylinePath } from '@jarenjs/view/helpers';
import { scaleLinear, scaleLog, scaleTime } from '../core/scale.js';
import { axisTicksLinear, axisTicksLog, formatTickValue, formatTimeTick } from '../core/axis.js';
import { cartesianFrame, annotateChart } from '../core/cartesian.js';
import { CATEGORICAL, seriesColor } from '../core/palette.js';

/**
 * @typedef {object} LineAST
 * @property {'line'} type
 * @property {string|null} title
 * @property {{ticks: {pos:number,label:string}[], label: string|null}} x
 * @property {{ticks: {pos:number,label:string}[], label: string|null}} y
 * @property {{name: string, swatch: number}[]|null} legend
 * @property {{name: string, points: ({u:number,v:number}|null)[]}[]} series
 * @property {boolean} markers
 */

/**
 * Build the geometry-free line AST.
 * @param {any} data
 * @param {any} [config]
 * @returns {LineAST}
 */
export function buildLineAST(data, config = {}) {
  const input = (data?.series ?? []).filter((s) => Array.isArray(s.points));
  const time = config.x === 'time';
  const log = config.log === true;

  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const s of input) {
    for (const p of s.points) {
      const px = numOf(p?.x);
      const py = numOf(p?.y);
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (log && py <= 0) continue;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
    }
  }
  if (!Number.isFinite(x0)) { x0 = 0; x1 = 1; }
  if (!Number.isFinite(y0)) { y0 = log ? 0.1 : 0; y1 = log ? 1 : 1; }

  const xScale = time ? scaleTime(x0, x1) : scaleLinear(x0, x1);
  let yScale;
  let yTickValues;
  if (log) {
    yScale = scaleLog(y0, y1 === y0 ? y0 * 10 : y1);
    yTickValues = axisTicksLog(y0, y1 === y0 ? y0 * 10 : y1);
  }
  else {
    yTickValues = axisTicksLinear(y0, y1, 5);
    const lo = Math.min(y0, yTickValues[0] ?? y0);
    const hi = Math.max(y1, yTickValues[yTickValues.length - 1] ?? y1);
    yScale = scaleLinear(lo, hi === lo ? lo + 1 : hi);
  }
  const xTickValues = axisTicksLinear(x0, x1, time ? 4 : 5);

  const series = input.map((s) => ({
    name: String(s.name ?? ''),
    points: s.points.map((p) => {
      const px = numOf(p?.x);
      const py = numOf(p?.y);
      if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
      const v = yScale(py);
      return Number.isFinite(v) ? { u: xScale(px), v: clamp01(v) } : null;
    }),
  }));

  return {
    type: 'line',
    title: config.title ?? null,
    x: {
      ticks: xTickValues.map((v) => ({
        pos: clamp01(xScale(v)),
        label: time ? formatTimeTick(v) : formatTickValue(v),
      })),
      label: config.xLabel ?? null,
    },
    y: {
      ticks: yTickValues.map((v) => ({ pos: clamp01(yScale(v)), label: formatTickValue(v) })),
      label: config.yLabel ?? null,
    },
    legend: series.length > 1 ? series.map((s, i) => ({ name: s.name, swatch: i })) : null,
    series,
    markers: config.markers === true,
  };
}

function numOf(v) {
  return v instanceof Date ? v.getTime() : v;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Render a line AST to a pure-vnode SVG.
 * @param {LineAST} ast
 * @param {{tokens: Record<string,string>, cssVars: Record<string,string>}} theme
 * @param {string} hash
 * @param {{rootClass?: string, keyPrefix?: string, palette?: readonly string[], width?: number}} [options]
 * @returns {any}
 */
export function renderLineAST(ast, theme, hash, options = {}) {
  const palette = options.palette ?? CATEGORICAL;
  const frame = cartesianFrame({
    title: ast.title,
    legend: ast.legend,
    xAxis: ast.x,
    yAxis: ast.y,
    grid: 'y',
    width: options.width,
    palette,
    theme,
  });
  const { plot } = frame;
  const children = frame.children;
  for (let si = 0; si < ast.series.length; si++) {
    const s = ast.series[si];
    const color = seriesColor(si, palette);
    const pixels = s.points.map((p) => p === null ? null : {
      x: round2(plot.x + p.u * plot.w),
      y: round2(plot.y + (1 - p.v) * plot.h),
    });
    const d = polylinePath(pixels);
    if (d !== '')
      children.push(svgPath(d, { stroke: color, 'stroke-width': 2, fill: 'none', class: 'chart-line' }));
    if (ast.markers) {
      for (const p of pixels) {
        if (p !== null)
          children.push(circle(p.x, p.y, 2.5, { fill: color, class: 'chart-dot' }));
      }
    }
  }
  const svg = svgRoot(options.rootClass ?? 'chart chart-svg chart-line-chart',
    frame.width, frame.height, theme, children, (options.keyPrefix ?? 'line-') + hash);
  return annotateChart(svg, ast.title);
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
