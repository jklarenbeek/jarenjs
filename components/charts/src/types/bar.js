//@ts-check
/**
 * @file The bar chart type: grouped or stacked, vertical or horizontal,
 * linear or log value axis. Data shape:
 *
 *   data   = { categories: string[],
 *              series: [{ name, values: number[],
 *                         tone?: 'win'|'loss', tones?: (('win'|'loss'|null)[]) }] }
 *   config = { type:'bar', title?, stacked?, log?, orient?: 'v'|'h',
 *              catLabel?, valLabel? }
 *
 * The AST is orientation-agnostic: `u` runs along the category axis,
 * `v` along the value axis; the render maps them to x/y per `orient`.
 * Category lookups are hoisted out of the series loop (index-driven,
 * never `categories.indexOf` per cell — that is O(n²) for wide charts).
 */

import { svgRoot } from '@jarenjs/view/helpers';
import { scaleLinear, scaleLog, scaleBand } from '../core/scale.js';
import { axisTicksLinear, axisTicksLog, niceStep, formatTickValue } from '../core/axis.js';
import { cartesianFrame, toneColor, annotateChart } from '../core/cartesian.js';
import { CATEGORICAL } from '../core/palette.js';

/**
 * @typedef {object} BarAST
 * @property {'bar'} type
 * @property {string|null} title
 * @property {'v'|'h'} orient
 * @property {{ticks: {pos:number,label:string}[], label: string|null}} cat
 * @property {{ticks: {pos:number,label:string}[], label: string|null}} val
 * @property {{name: string, swatch: number}[]|null} legend
 * @property {{u0:number,u1:number,v0:number,v1:number,series:number,tone:'win'|'loss'|null}[]} bars
 * @property {number} count number of categories
 */

/**
 * Build the geometry-free bar AST.
 * @param {any} data
 * @param {any} [config]
 * @returns {BarAST}
 */
export function buildBarAST(data, config = {}) {
  const categories = data?.categories ?? [];
  const series = (data?.series ?? []).filter((s) => Array.isArray(s.values));
  const stacked = config.stacked === true;
  const log = config.log === true;

  // value domain over drawn values (stacked: per-category totals)
  let maxVal = 0;
  let minPos = Infinity;
  for (let ci = 0; ci < categories.length; ci++) {
    let sum = 0;
    for (const s of series) {
      const v = s.values[ci];
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue;
      sum += v;
      if (!stacked && v > maxVal) maxVal = v;
      if (v < minPos) minPos = v;
    }
    if (stacked && sum > maxVal) maxVal = sum;
  }
  if (maxVal === 0) maxVal = 1;
  if (!Number.isFinite(minPos)) minPos = log ? 0.1 : 0;

  let scale;
  let valTicks;
  if (log) {
    const lo = Math.pow(10, Math.floor(Math.log10(minPos)));
    const hi = Math.pow(10, Math.ceil(Math.log10(maxVal)));
    scale = scaleLog(lo, hi === lo ? lo * 10 : hi);
    valTicks = axisTicksLog(lo, hi === lo ? lo * 10 : hi);
  }
  else {
    const step = niceStep(maxVal, 5);
    const top = step * Math.ceil(maxVal / step);
    scale = scaleLinear(0, top);
    valTicks = axisTicksLinear(0, top, 5);
  }

  const band = scaleBand(categories, 0.25);
  const groups = stacked ? 1 : Math.max(1, series.length);
  const sub = band.bandwidth / groups;
  const bars = [];
  const running = stacked ? new Array(categories.length).fill(0) : null;
  for (let si = 0; si < series.length; si++) {
    const s = series[si];
    for (let ci = 0; ci < categories.length; ci++) {
      const v = s.values[ci];
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue;
      const start = band(categories[ci]);
      let u0;
      let u1;
      let v0;
      let v1;
      if (stacked) {
        u0 = start;
        u1 = start + band.bandwidth;
        const base = running[ci];
        running[ci] = base + v;
        v0 = base === 0 ? 0 : clamp01(scale(base));
        v1 = clamp01(scale(running[ci]));
      }
      else {
        u0 = start + si * sub + sub * 0.06;
        u1 = start + (si + 1) * sub - sub * 0.06;
        v0 = 0;
        v1 = clamp01(scale(v));
      }
      bars.push({
        u0, u1, v0, v1,
        series: si,
        tone: s.tones?.[ci] ?? s.tone ?? null,
      });
    }
  }

  return {
    type: 'bar',
    title: config.title ?? null,
    orient: config.orient === 'h' ? 'h' : 'v',
    cat: {
      ticks: categories.map((label) => ({ pos: band(label) + band.bandwidth / 2, label: String(label) })),
      label: config.catLabel ?? null,
    },
    val: {
      ticks: valTicks.map((v) => ({ pos: clamp01(scale(v)), label: formatTickValue(v) })),
      label: config.valLabel ?? null,
    },
    legend: series.length > 1 ? series.map((s, i) => ({ name: s.name, swatch: i })) : null,
    bars,
    count: categories.length,
  };
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Render a bar AST to a pure-vnode SVG.
 * @param {BarAST} ast
 * @param {{tokens: Record<string,string>, cssVars: Record<string,string>}} theme
 * @param {string} hash
 * @param {{rootClass?: string, keyPrefix?: string, palette?: readonly string[], width?: number}} [options]
 * @returns {any}
 */
export function renderBarAST(ast, theme, hash, options = {}) {
  const palette = options.palette ?? CATEGORICAL;
  const horizontal = ast.orient === 'h';
  const frame = cartesianFrame({
    title: ast.title,
    legend: ast.legend,
    xAxis: horizontal ? ast.val : { ...ast.cat, ticks: ast.cat.ticks },
    yAxis: horizontal ? { ...ast.cat, ticks: ast.cat.ticks.map(flipPos) } : ast.val,
    grid: horizontal ? 'x' : 'y',
    width: options.width,
    plotHeight: horizontal ? Math.max(80, ast.count * 28) : undefined,
    palette,
    theme,
  });
  const { plot } = frame;
  const children = frame.children;
  for (const bar of ast.bars) {
    const fill = toneColor(theme, bar.tone, bar.series, palette);
    let x; let y; let w; let h;
    if (horizontal) {
      x = plot.x + bar.v0 * plot.w;
      w = (bar.v1 - bar.v0) * plot.w;
      y = plot.y + bar.u0 * plot.h;
      h = (bar.u1 - bar.u0) * plot.h;
    }
    else {
      x = plot.x + bar.u0 * plot.w;
      w = (bar.u1 - bar.u0) * plot.w;
      y = plot.y + (1 - bar.v1) * plot.h;
      h = (bar.v1 - bar.v0) * plot.h;
    }
    children.push(['rect', {
      x: round2(x), y: round2(y), width: round2(Math.max(0.5, w)), height: round2(Math.max(0.5, h)),
      fill, class: 'chart-bar',
    }]);
  }
  const svg = svgRoot(options.rootClass ?? 'chart chart-svg chart-bar-chart',
    frame.width, frame.height, theme, children, (options.keyPrefix ?? 'bar-') + hash);
  return annotateChart(svg, ast.title);
}

/** In horizontal orientation the first category reads at the top. */
function flipPos(tick) {
  return { pos: 1 - tick.pos, label: tick.label };
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
