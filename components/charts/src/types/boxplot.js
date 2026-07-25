//@ts-check
/**
 * @file The boxplot chart type: five-number summaries per category with
 * Tukey whiskers and outlier dots. Data shape (two forms per box):
 *
 *   data   = { boxes: [{ label, values: number[] }                       // raw samples
 *                    | { label, min, q1, med, q3, max, outliers? }] }    // precomputed
 *   config = { type:'boxplot', title?, catLabel?, valLabel? }
 *
 * Raw samples get the standard treatment: quartiles by linear
 * interpolation over the sorted values, whiskers at the most extreme
 * samples inside the 1.5·IQR fences, everything outside them an
 * outlier. Precomputed summaries are trusted as given (their whiskers
 * are the stated min/max). The AST is unit-space: `u` along the
 * category axis, `v` along the value axis.
 */

import { svgRoot, line as svgLine } from '@jarenjs/view/helpers';
import { scaleLinear, scaleBand } from '../core/scale.js';
import { axisTicksLinear, formatTickValue } from '../core/axis.js';
import { cartesianFrame, annotateChart } from '../core/cartesian.js';
import { CATEGORICAL, seriesColor } from '../core/palette.js';

/**
 * @typedef {object} BoxAST
 * @property {string} label
 * @property {number} u0 @property {number} u1
 * @property {number} loV whisker low @property {number} q1V
 * @property {number} medV @property {number} q3V
 * @property {number} hiV whisker high
 * @property {number[]} outliersV
 * @property {{min:number, q1:number, med:number, q3:number, max:number}} stats
 */
/**
 * @typedef {object} BoxplotAST
 * @property {'boxplot'} type
 * @property {string|null} title
 * @property {{ticks: {pos:number,label:string}[], label: string|null}} cat
 * @property {{ticks: {pos:number,label:string}[], label: string|null}} val
 * @property {BoxAST[]} boxes
 * @property {number} count number of categories
 */

/**
 * Quantile of an ascending-sorted sample by linear interpolation.
 * @param {number[]} sorted - Ascending finite samples (non-empty)
 * @param {number} p - Quantile in [0, 1]
 * @returns {number}
 */
export function quantileSorted(sorted, p) {
  const at = (sorted.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

/**
 * Five-number summary + Tukey fences for one box.
 * @param {any} box
 * @returns {{min:number, q1:number, med:number, q3:number, max:number, lo:number, hi:number, outliers:number[]}|null}
 */
function summarize(box) {
  if (Array.isArray(box?.values)) {
    const sorted = box.values
      .filter((v) => typeof v === 'number' && Number.isFinite(v))
      .sort((a, b) => a - b);
    if (sorted.length === 0) return null;
    const q1 = quantileSorted(sorted, 0.25);
    const med = quantileSorted(sorted, 0.5);
    const q3 = quantileSorted(sorted, 0.75);
    const iqr = q3 - q1;
    const loFence = q1 - 1.5 * iqr;
    const hiFence = q3 + 1.5 * iqr;
    const inside = sorted.filter((v) => v >= loFence && v <= hiFence);
    return {
      min: sorted[0],
      q1, med, q3,
      max: sorted[sorted.length - 1],
      lo: inside.length !== 0 ? inside[0] : q1,
      hi: inside.length !== 0 ? inside[inside.length - 1] : q3,
      outliers: sorted.filter((v) => v < loFence || v > hiFence),
    };
  }
  const fields = [box?.min, box?.q1, box?.med, box?.q3, box?.max];
  if (!fields.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const outliers = (box.outliers ?? []).filter((v) => typeof v === 'number' && Number.isFinite(v));
  return {
    min: box.min, q1: box.q1, med: box.med, q3: box.q3, max: box.max,
    lo: box.min, hi: box.max, outliers,
  };
}

/**
 * Build the geometry-free boxplot AST.
 * @param {any} data
 * @param {any} [config]
 * @returns {BoxplotAST}
 */
export function buildBoxplotAST(data, config = {}) {
  const input = (data?.boxes ?? [])
    .map((box) => ({ label: String(box?.label ?? ''), stats: summarize(box) }))
    .filter((box) => box.stats !== null);

  let lo = Infinity;
  let hi = -Infinity;
  for (const { stats } of input) {
    const min = Math.min(stats.lo, ...stats.outliers);
    const max = Math.max(stats.hi, ...stats.outliers);
    if (min < lo) lo = min;
    if (max > hi) hi = max;
  }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  const ticks = axisTicksLinear(lo, hi, 5);
  const sLo = Math.min(lo, ticks[0] ?? lo);
  const sHi = Math.max(hi, ticks[ticks.length - 1] ?? hi);
  const scale = scaleLinear(sLo, sHi === sLo ? sLo + 1 : sHi);

  const labels = input.map((box) => box.label);
  const band = scaleBand(labels, 0.35);
  const boxes = input.map((box, i) => {
    const start = i * band.step + (band.step - band.bandwidth) / 2;
    const s = box.stats;
    return {
      label: box.label,
      u0: start,
      u1: start + band.bandwidth,
      loV: clamp01(scale(s.lo)),
      q1V: clamp01(scale(s.q1)),
      medV: clamp01(scale(s.med)),
      q3V: clamp01(scale(s.q3)),
      hiV: clamp01(scale(s.hi)),
      outliersV: s.outliers.map((v) => clamp01(scale(v))),
      stats: { min: s.min, q1: s.q1, med: s.med, q3: s.q3, max: s.max },
    };
  });

  return {
    type: 'boxplot',
    title: config.title ?? null,
    cat: {
      ticks: labels.map((label, i) => ({ pos: (i + 0.5) * band.step, label })),
      label: config.catLabel ?? null,
    },
    val: {
      ticks: ticks.map((v) => ({ pos: clamp01(scale(v)), label: formatTickValue(v) })),
      label: config.valLabel ?? null,
    },
    boxes,
    count: boxes.length,
  };
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Render a boxplot AST to a pure-vnode SVG: capped whiskers, a
 * translucent box with a full-strength median line, outlier dots, and
 * a summary `<title>` per box.
 * @param {BoxplotAST} ast
 * @param {{tokens: Record<string,string>, cssVars: Record<string,string>}} theme
 * @param {string} hash
 * @param {{rootClass?: string, keyPrefix?: string, palette?: readonly string[], width?: number}} [options]
 * @returns {any}
 */
export function renderBoxplotAST(ast, theme, hash, options = {}) {
  const t = theme.tokens;
  const palette = options.palette ?? CATEGORICAL;
  const color = seriesColor(0, palette);
  const frame = cartesianFrame({
    title: ast.title,
    legend: null,
    xAxis: ast.cat,
    yAxis: ast.val,
    grid: 'y',
    width: options.width,
    palette,
    theme,
  });
  const { plot } = frame;
  const children = frame.children;
  for (const box of ast.boxes) {
    const x0 = plot.x + box.u0 * plot.w;
    const x1 = plot.x + box.u1 * plot.w;
    const cx = (x0 + x1) / 2;
    const capW = (x1 - x0) * 0.5;
    const y = (v) => plot.y + (1 - v) * plot.h;
    const whisker = { stroke: t.axis, 'stroke-width': 1, class: 'chart-box-whisker' };
    children.push(svgLine(round2(cx), round2(y(box.loV)), round2(cx), round2(y(box.q1V)), whisker));
    children.push(svgLine(round2(cx), round2(y(box.q3V)), round2(cx), round2(y(box.hiV)), whisker));
    children.push(svgLine(round2(cx - capW / 2), round2(y(box.loV)), round2(cx + capW / 2), round2(y(box.loV)), whisker));
    children.push(svgLine(round2(cx - capW / 2), round2(y(box.hiV)), round2(cx + capW / 2), round2(y(box.hiV)), whisker));
    const s = box.stats;
    children.push(['rect', {
      x: round2(x0), y: round2(y(box.q3V)),
      width: round2(x1 - x0), height: round2(Math.max(1, y(box.q1V) - y(box.q3V))),
      fill: color, 'fill-opacity': 0.35, stroke: color, 'stroke-width': 1.5,
      class: 'chart-box',
    }, ['title', {},
      `${box.label} — min ${formatTickValue(s.min)}, q1 ${formatTickValue(s.q1)}, `
      + `median ${formatTickValue(s.med)}, q3 ${formatTickValue(s.q3)}, max ${formatTickValue(s.max)}`]]);
    children.push(svgLine(round2(x0), round2(y(box.medV)), round2(x1), round2(y(box.medV)),
      { stroke: color, 'stroke-width': 2, class: 'chart-box-median' }));
    for (const v of box.outliersV) {
      children.push(['circle', {
        cx: round2(cx), cy: round2(y(v)), r: 2.5,
        fill: color, 'fill-opacity': 0.75, class: 'chart-dot',
      }]);
    }
  }
  const svg = svgRoot(options.rootClass ?? 'chart chart-svg chart-boxplot-chart',
    frame.width, frame.height, theme, children, (options.keyPrefix ?? 'box-') + hash);
  return annotateChart(svg, ast.title);
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
