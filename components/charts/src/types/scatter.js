//@ts-check
/**
 * @file The scatter chart type: points over numeric or log axes,
 * per-point semantic tone (win/loss), and an optional horizontal
 * reference line (e.g. ratio = 1). Data shape:
 *
 *   data   = { points: [{x, y, tone?: 'win'|'loss'}] }
 *   config = { type:'scatter', title?, xLog?, yLog?, refY?, refLabel?,
 *              xLabel?, yLabel? }
 */

import { svgRoot, line as svgLine, circle, textAt, coord } from '@jarenjs/view/helpers';
import { clamp01 } from '@jarenjs/core/math';
import { scaleLinear, scaleLog } from '../core/scale.js';
import { axisTicksLinear, axisTicksLog, formatTickValue } from '../core/axis.js';
import { cartesianFrame, toneColor, annotateChart, FS_TICK } from '../core/cartesian.js';
import { CATEGORICAL } from '../core/palette.js';

/**
 * @typedef {object} ScatterAST
 * @property {'scatter'} type
 * @property {string|null} title
 * @property {{ticks: {pos:number,label:string}[], label: string|null}} x
 * @property {{ticks: {pos:number,label:string}[], label: string|null}} y
 * @property {{u:number,v:number,tone:'win'|'loss'|null}[]} points
 * @property {{v: number, label: string|null}|null} ref
 */

/**
 * Build the geometry-free scatter AST.
 * @param {any} data
 * @param {any} [config]
 * @returns {ScatterAST}
 */
export function buildScatterAST(data, config = {}) {
  const input = data?.points ?? [];
  const xLog = config.xLog === true;
  const yLog = config.yLog === true;

  const xs = [];
  const ys = [];
  for (const p of input) {
    if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;
    if (xLog && p.x <= 0) continue;
    if (yLog && p.y <= 0) continue;
    xs.push(p.x);
    ys.push(p.y);
  }
  if (typeof config.refY === 'number' && Number.isFinite(config.refY)
    && (!yLog || config.refY > 0)) {
    ys.push(config.refY);
  }
  const [xScale, xTicks] = axisFor(xs, xLog);
  const [yScale, yTicks] = axisFor(ys, yLog);

  const points = [];
  for (const p of input) {
    if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;
    const u = xScale(p.x);
    const v = yScale(p.y);
    if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
    points.push({ u: clamp01(u), v: clamp01(v), tone: p.tone ?? null });
  }

  const ref = typeof config.refY === 'number' && Number.isFinite(yScale(config.refY))
    ? { v: clamp01(yScale(config.refY)), label: config.refLabel ?? null }
    : null;

  return {
    type: 'scatter',
    title: config.title ?? null,
    x: { ticks: xTicks.map((v) => ({ pos: clamp01(xScale(v)), label: formatTickValue(v) })), label: config.xLabel ?? null },
    y: { ticks: yTicks.map((v) => ({ pos: clamp01(yScale(v)), label: formatTickValue(v) })), label: config.yLabel ?? null },
    points,
    ref,
  };
}

function axisFor(values, log) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) { lo = log ? 0.1 : 0; hi = 1; }
  if (log) {
    const d0 = Math.pow(10, Math.floor(Math.log10(lo)));
    const d1 = Math.pow(10, Math.ceil(Math.log10(hi)));
    const top = d1 === d0 ? d0 * 10 : d1;
    return [scaleLog(d0, top), axisTicksLog(d0, top)];
  }
  const ticks = axisTicksLinear(lo, hi, 5);
  const min = Math.min(lo, ticks[0] ?? lo);
  const max = Math.max(hi, ticks[ticks.length - 1] ?? hi);
  return [scaleLinear(min, max === min ? min + 1 : max), ticks];
}

/**
 * Render a scatter AST to a pure-vnode SVG.
 * @param {ScatterAST} ast
 * @param {{tokens: Record<string,string>, cssVars: Record<string,string>}} theme
 * @param {string} hash
 * @param {{rootClass?: string, keyPrefix?: string, palette?: readonly string[], width?: number}} [options]
 * @returns {any}
 */
export function renderScatterAST(ast, theme, hash, options = {}) {
  const palette = options.palette ?? CATEGORICAL;
  const frame = cartesianFrame({
    title: ast.title,
    legend: null,
    xAxis: ast.x,
    yAxis: ast.y,
    grid: 'y',
    width: options.width,
    palette,
    theme,
  });
  const { plot } = frame;
  const children = frame.children;
  if (ast.ref !== null) {
    const y = coord(plot.y + (1 - ast.ref.v) * plot.h);
    children.push(svgLine(plot.x, y, plot.x + plot.w, y,
      { stroke: theme.tokens.muted, 'stroke-width': 1, 'stroke-dasharray': '4 3', class: 'chart-ref' }));
    if (ast.ref.label) {
      children.push(textAt(plot.x + plot.w, y - 5, ast.ref.label, FS_TICK,
        { 'text-anchor': 'end', fill: theme.tokens.muted, class: 'chart-tick' }));
    }
  }
  for (const p of ast.points) {
    children.push(circle(
      coord(plot.x + p.u * plot.w),
      coord(plot.y + (1 - p.v) * plot.h),
      3,
      { fill: toneColor(theme, p.tone, 0, palette), 'fill-opacity': 0.75, class: 'chart-dot' }));
  }
  const svg = svgRoot(options.rootClass ?? 'chart chart-svg chart-scatter-chart',
    frame.width, frame.height, theme, children, (options.keyPrefix ?? 'scatter-') + hash);
  return annotateChart(svg, ast.title);
}
