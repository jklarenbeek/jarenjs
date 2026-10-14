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

import { svgRoot, line as svgLine, textAt, coord } from '@jarenjs/view/helpers';
import { clamp01 } from '@jarenjs/core/math';
import { scaleLinear, scaleLog } from '../core/scale.js';
import { axisTicksLinear, axisTicksLog, formatTickValues } from '../core/axis.js';
import { cartesianFrame, toneColor, annotateChart, FS_TICK } from '../core/cartesian.js';
import { measurableSpan, measurableDecades } from '../core/domain.js';
import { CATEGORICAL } from '../core/palette.js';
import { normalizeTooltip, valueMark } from '../core/marks.js';

/**
 * @typedef {object} ScatterAST
 * @property {'scatter'} type
 * @property {string|null} title
 * @property {{ticks: {pos:number,label:string}[], label: string|null}} x
 * @property {{ticks: {pos:number,label:string}[], label: string|null}} y
 * @property {{u:number,v:number,tone:'win'|'loss'|null,x:number,y:number}[]} points
 *  unit position plus the raw sample the hover text reports
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
  /** A value an axis can place: finite, and positive on a log axis. */
  const placeable = (/** @type {any} */ v, /** @type {boolean} */ log) => Number.isFinite(v) && (!log || v > 0);

  const xs = [];
  const ys = [];
  for (const p of input) {
    if (!placeable(p?.x, xLog) || !placeable(p?.y, yLog)) continue;
    xs.push(p.x);
    ys.push(p.y);
  }
  const refY = typeof config.refY === 'number' && placeable(config.refY, yLog) ? config.refY : null;
  if (refY !== null) ys.push(refY);
  const [xScale, xTicks] = axisFor(xs, xLog);
  const [yScale, yTicks] = axisFor(ys, yLog);

  // every placeable sample is drawn; one beyond a clamped domain pins to the edge
  const points = [];
  for (const p of input) {
    if (!placeable(p?.x, xLog) || !placeable(p?.y, yLog)) continue;
    points.push({ u: clamp01(xScale(p.x)), v: clamp01(yScale(p.y)), tone: p.tone ?? null, x: p.x, y: p.y });
  }

  const ref = refY !== null ? { v: clamp01(yScale(refY)), label: config.refLabel ?? null } : null;
  const xLabels = formatTickValues(xTicks);
  const yLabels = formatTickValues(yTicks);

  return {
    type: 'scatter',
    title: config.title ?? null,
    x: { ticks: xTicks.map((v, i) => ({ pos: clamp01(xScale(v)), label: xLabels[i] })), label: config.xLabel ?? null },
    y: { ticks: yTicks.map((v, i) => ({ pos: clamp01(yScale(v)), label: yLabels[i] })), label: config.yLabel ?? null },
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
    let d0 = Math.pow(10, Math.floor(Math.log10(lo)));
    const d1 = Math.pow(10, Math.ceil(Math.log10(hi)));
    let top = d1 === d0 ? d0 * 10 : d1;
    [d0, top] = measurableDecades(d0, top);
    return [scaleLog(d0, top), axisTicksLog(d0, top)];
  }
  [lo, hi] = measurableSpan(lo, hi);
  const ticks = axisTicksLinear(lo, hi, 5);
  const min = Math.min(lo, ticks[0] ?? lo);
  const max = Math.max(hi, ticks[ticks.length - 1] ?? hi);
  return [scaleLinear(min, max === min ? min + 1 : max), ticks];
}

/**
 * Render a scatter AST to a pure-vnode SVG. Each dot carries its raw
 * `(x, y)` as a `<title>`: on a log axis a pixel position is not
 * readable back to a value, so the hover text is the only honest way to
 * name the sample.
 * @param {ScatterAST} ast
 * @param {{tokens: Record<string,string>, cssVars: Record<string,string>}} theme
 * @param {string} hash
 * @param {{rootClass?: string, keyPrefix?: string, palette?: readonly string[], width?: number,
 *   tooltip?: import('../core/marks.js').ChartTooltipSpec}} [options]
 * @returns {any}
 */
export function renderScatterAST(ast, theme, hash, options = {}) {
  const palette = options.palette ?? CATEGORICAL;
  const tooltip = normalizeTooltip(options.tooltip);
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
    children.push(valueMark('circle', {
      cx: coord(plot.x + p.u * plot.w),
      cy: coord(plot.y + (1 - p.v) * plot.h),
      r: 3,
      fill: toneColor(theme, p.tone, 0, palette), 'fill-opacity': 0.75, class: 'chart-dot',
    }, tooltip, `(${p.x}, ${p.y})`, { type: 'scatter', x: p.x, y: p.y, tone: p.tone }));
  }
  const svg = svgRoot(options.rootClass ?? 'chart chart-svg chart-scatter-chart',
    frame.width, frame.height, theme, children, (options.keyPrefix ?? 'scatter-') + hash);
  return annotateChart(svg, ast.title);
}
