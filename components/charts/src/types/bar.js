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

import { svgRoot, coord } from '@jarenjs/view/helpers';
import { clamp01 } from '@jarenjs/core/math';
import { scaleLinear, scaleLog, scaleBand } from '../core/scale.js';
import { axisTicksLinear, axisTicksLog, niceStep, formatTickValues } from '../core/axis.js';
import { cartesianFrame, toneColor, annotateChart } from '../core/cartesian.js';
import { measurableSpan, measurableDecades } from '../core/domain.js';
import { CATEGORICAL } from '../core/palette.js';
import { normalizeTooltip, valueMark } from '../core/marks.js';

/**
 * @typedef {object} BarAST
 * @property {'bar'} type
 * @property {string|null} title
 * @property {'v'|'h'} orient
 * @property {{ticks: {pos:number,label:string}[], label: string|null}} cat
 * @property {{ticks: {pos:number,label:string}[], label: string|null}} val
 * @property {{name: string, swatch: number}[]|null} legend
 * @property {BarMarkAST[]} bars
 * @property {number} count number of categories
 * @property {[number, number]} domain resolved value-axis bounds
 */
/**
 * @typedef {object} BarMarkAST
 * @property {number} u0 @property {number} u1 category-axis band
 * @property {number} v0 the value-axis end the bar rises from (the zero
 *   baseline, or the bar beneath it in a stack of the same sign)
 * @property {number} v1 the value-axis end the value reaches; below `v0`
 *   for a negative value
 * @property {number} series series index
 * @property {'win'|'loss'|null} tone
 * @property {string} label the category this bar stands in
 * @property {string} name the series name
 * @property {number} value the drawn value (hover text reports it exactly)
 */

/**
 * Whether a value draws a bar: a finite number other than zero, and on a
 * log axis a positive one (a log axis has no zero and no side below it).
 * @param {any} v @param {boolean} log
 * @returns {boolean}
 */
export function barDrawable(v, log) {
  return typeof v === 'number' && Number.isFinite(v) && (log ? v > 0 : v !== 0);
}

/**
 * Scan the drawn values for the extremes the value axis is resolved
 * from: the largest bar above zero and the deepest below it (a stacked
 * chart's per-category positive and negative totals, each sign stacked
 * apart), and the smallest positive value a log axis needs for its
 * bottom decade.
 *
 * Exported because the incremental session must reach the same bounds
 * decision from the same numbers — one implementation, no drift.
 * @param {any} data
 * @param {boolean} stacked @param {boolean} log
 * @returns {{maxVal: number, minVal: number, minPos: number}}
 */
export function scanBarExtremes(data, stacked, log) {
  const categories = data?.categories ?? [];
  const series = (data?.series ?? []).filter((s) => Array.isArray(s.values));
  let maxVal = 0;
  let minVal = 0;
  let minPos = Infinity;
  for (let ci = 0; ci < categories.length; ci++) {
    let up = 0;
    let down = 0;
    for (const s of series) {
      const v = s.values[ci];
      if (!barDrawable(v, log)) continue;
      if (v > 0) {
        up += v;
        if (!stacked && v > maxVal) maxVal = v;
        if (v < minPos) minPos = v;
      }
      else {
        down += v;
        if (!stacked && v < minVal) minVal = v;
      }
    }
    if (stacked && up > maxVal) maxVal = up;
    if (stacked && down < minVal) minVal = down;
  }
  if (maxVal === 0 && minVal === 0) maxVal = 1;
  if (!Number.isFinite(minPos)) minPos = log ? 0.1 : 0;
  return { maxVal, minVal, minPos };
}

/**
 * Resolve the value-axis bounds and tick values from the scanned
 * extremes: nice-number bounds that always contain zero (a zero base
 * when nothing is negative), or whole decades under `log`. The AST records the bounds so a later build — or the session —
 * can detect "unchanged". A top rounded up past what a double holds is
 * clamped (`measurableSpan`, `measurableDecades`).
 * @param {{maxVal: number, minVal: number, minPos: number}} ext
 * @param {boolean} log
 * @returns {{domain: [number, number], tickValues: number[]}}
 */
export function resolveBarDomains(ext, log) {
  if (log) {
    const lo = Math.pow(10, Math.floor(Math.log10(ext.minPos)));
    const raw = Math.pow(10, Math.ceil(Math.log10(ext.maxVal)));
    const domain = measurableDecades(lo, raw === lo ? lo * 10 : raw);
    return { domain, tickValues: axisTicksLog(domain[0], domain[1]) };
  }
  // a stacked total can overflow to Infinity: it tops out at the largest double
  const max = Math.min(ext.maxVal, Number.MAX_VALUE);
  const min = Math.max(ext.minVal, -Number.MAX_VALUE);
  const step = niceStep(Number.isFinite(max - min) ? max - min : Number.MAX_VALUE, 5);
  const lo = min === 0 ? 0 : step * Math.floor(min / step);
  const domain = measurableSpan(lo, step * Math.ceil(max / step));
  return { domain, tickValues: axisTicksLinear(domain[0], domain[1], 5) };
}

/**
 * The value scale over a resolved domain — reconstructable by the
 * session from the AST's domain alone.
 * @param {[number, number]} domain @param {boolean} log
 * @returns {(v: number) => number}
 */
export function barScale(domain, log) {
  return log ? scaleLog(domain[0], domain[1]) : scaleLinear(domain[0], domain[1]);
}

/**
 * Where the zero baseline sits on the value axis, as a unit position:
 * the bottom of the plot for a domain that starts at zero or a log axis,
 * inside it for a domain that crosses zero.
 * @param {(v: number) => number} scale @param {boolean} log
 * @returns {number}
 */
export function barBaseline(scale, log) {
  return log ? 0 : clamp01(scale(0));
}

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

  const domains = resolveBarDomains(scanBarExtremes(data, stacked, log), log);
  const scale = barScale(domains.domain, log);
  const valTicks = domains.tickValues;
  const valLabels = formatTickValues(valTicks);

  const band = scaleBand(categories, 0.25);
  const groups = stacked ? 1 : Math.max(1, series.length);
  const sub = band.bandwidth / groups;
  const bars = [];
  const base0 = barBaseline(scale, log);
  // each sign stacks apart: positives upward from zero, negatives downward
  const up = stacked ? new Array(categories.length).fill(0) : null;
  const down = stacked ? new Array(categories.length).fill(0) : null;
  for (let si = 0; si < series.length; si++) {
    const s = series[si];
    for (let ci = 0; ci < categories.length; ci++) {
      const v = s.values[ci];
      if (!barDrawable(v, log)) continue;
      const start = band.start(ci);
      let u0;
      let u1;
      let v0;
      let v1;
      if (stacked) {
        u0 = start;
        u1 = start + band.bandwidth;
        const run = v > 0 ? up : down;
        const base = run[ci];
        run[ci] = base + v;
        v0 = base === 0 ? base0 : clamp01(scale(base));
        v1 = clamp01(scale(run[ci]));
      }
      else {
        u0 = start + si * sub + sub * 0.06;
        u1 = start + (si + 1) * sub - sub * 0.06;
        v0 = base0;
        v1 = clamp01(scale(v));
      }
      bars.push({
        u0, u1, v0, v1,
        series: si,
        tone: s.tones?.[ci] ?? s.tone ?? null,
        label: String(categories[ci]),
        name: String(s.name ?? ''),
        value: v,
      });
    }
  }

  return {
    type: 'bar',
    title: config.title ?? null,
    orient: config.orient === 'h' ? 'h' : 'v',
    cat: {
      ticks: categories.map((label, ci) => ({ pos: band.start(ci) + band.bandwidth / 2, label: String(label) })),
      label: config.catLabel ?? null,
    },
    val: {
      ticks: valTicks.map((v, i) => ({ pos: clamp01(scale(v)), label: valLabels[i] })),
      label: config.valLabel ?? null,
    },
    legend: series.length > 1 ? series.map((s, i) => ({ name: s.name, swatch: i })) : null,
    bars,
    count: categories.length,
    domain: domains.domain,
  };
}

/**
 * Render one bar as its `<rect>` value mark — the replaceable unit the
 * incremental session re-emits when a live count changes.
 * @param {BarMarkAST} bar
 * @param {BarAST} ast
 * @param {{x:number,y:number,w:number,h:number}} plot
 * @param {{tokens: Record<string,string>}} theme
 * @param {readonly string[]} palette
 * @param {import('../core/marks.js').ChartTooltip|null} [tooltip]
 * @returns {any}
 */
export function barMarkRender(bar, ast, plot, theme, palette, tooltip = null) {
  let x; let y; let w; let h;
  if (ast.orient === 'h') {
    x = plot.x + Math.min(bar.v0, bar.v1) * plot.w;
    w = Math.abs(bar.v1 - bar.v0) * plot.w;
    y = plot.y + bar.u0 * plot.h;
    h = (bar.u1 - bar.u0) * plot.h;
  }
  else {
    x = plot.x + bar.u0 * plot.w;
    w = (bar.u1 - bar.u0) * plot.w;
    y = plot.y + (1 - Math.max(bar.v0, bar.v1)) * plot.h;
    h = Math.abs(bar.v1 - bar.v0) * plot.h;
  }
  const text = ast.legend !== null
    ? `${bar.name} — ${bar.label}: ${bar.value}`
    : `${bar.label}: ${bar.value}`;
  return valueMark('rect', {
    x: coord(x), y: coord(y), width: coord(Math.max(0.5, w)), height: coord(Math.max(0.5, h)),
    fill: toneColor(theme, bar.tone, bar.series, palette), class: 'chart-bar',
  }, tooltip, text, { type: 'bar', label: bar.label, series: bar.name, value: bar.value });
}

/**
 * Render a bar AST and return the svg WITH the geometry a session needs
 * to replace one bar in place: the plot rect and how many chrome
 * children precede the bars.
 * @param {BarAST} ast
 * @param {{tokens: Record<string,string>, cssVars: Record<string,string>}} theme
 * @param {string} hash
 * @param {{rootClass?: string, keyPrefix?: string, palette?: readonly string[], width?: number,
 *   tooltip?: import('../core/marks.js').ChartTooltipSpec}} [options]
 * @returns {{svg: any, plot: {x:number,y:number,w:number,h:number}, chromeLen: number}}
 */
export function buildBarRender(ast, theme, hash, options = {}) {
  const palette = options.palette ?? CATEGORICAL;
  const tooltip = normalizeTooltip(options.tooltip);
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
  const chromeLen = children.length;
  for (const bar of ast.bars)
    children.push(barMarkRender(bar, ast, plot, theme, palette, tooltip));
  const svg = svgRoot(options.rootClass ?? 'chart chart-svg chart-bar-chart',
    frame.width, frame.height, theme, children, (options.keyPrefix ?? 'bar-') + hash);
  annotateChart(svg, ast.title);
  return { svg, plot, chromeLen };
}

/**
 * Render a bar AST to a pure-vnode SVG. Each bar rect carries a
 * `<title>` naming its series, category and exact value — the axis
 * shows the rounded tick scale, the hover text shows the datum.
 * @param {BarAST} ast
 * @param {{tokens: Record<string,string>, cssVars: Record<string,string>}} theme
 * @param {string} hash
 * @param {{rootClass?: string, keyPrefix?: string, palette?: readonly string[], width?: number,
 *   tooltip?: import('../core/marks.js').ChartTooltipSpec}} [options]
 * @returns {any}
 */
export function renderBarAST(ast, theme, hash, options = {}) {
  return buildBarRender(ast, theme, hash, options).svg;
}

/** In horizontal orientation the first category reads at the top. */
function flipPos(tick) {
  return { pos: 1 - tick.pos, label: tick.label };
}
