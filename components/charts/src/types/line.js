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
 *              markers?, xLabel?, yLabel?, domain? }
 *
 * `config.domain` declares a domain-stability policy (`core/domain.js`)
 * so most streaming ticks keep the scales still: a quantized sliding
 * `x` window (samples older than it become null vertices), pinned or
 * step-quantized `y` bounds. The AST records the resolved domain so a
 * later build — or the incremental session — can detect "unchanged".
 *
 * The extremes scan, domain resolution and scale construction are
 * exported (`scanLineExtremes` / `resolveLineDomains` / `lineScales`)
 * because the incremental session must make the SAME decisions from
 * the same numbers — one implementation, no drift. Each series
 * renders as one `<g class="chart-series">` (path, then marker dots),
 * so a session — and the view patcher — can treat a series as one
 * replaceable unit; `buildLineRender` is the render variant that also
 * returns that per-series geometry.
 */

import { svgRoot, path as svgPath, circle, polylinePath } from '@jarenjs/view/helpers';
import { scaleLinear, scaleLog, scaleTime } from '../core/scale.js';
import { axisTicksLinear, axisTicksLog, formatTickValue, formatTimeTick } from '../core/axis.js';
import { cartesianFrame, annotateChart } from '../core/cartesian.js';
import {
  normalizeDomainPolicy, resolveWindowX, resolveStepY, resolveStepYLog, resolvePinnedY,
} from '../core/domain.js';
import { CATEGORICAL, seriesColor } from '../core/palette.js';

/**
 * @typedef {object} LineAST
 * @property {'line'} type
 * @property {string|null} title
 * @property {{ticks: {pos:number,label:string}[], label: string|null}} x
 * @property {{ticks: {pos:number,label:string}[], label: string|null}} y
 * @property {{x: [number, number], y: [number, number]}} domain resolved scale bounds
 * @property {{name: string, swatch: number}[]|null} legend
 * @property {{name: string, points: ({u:number,v:number}|null)[]}[]} series
 * @property {boolean} markers
 */

/**
 * Scan the data extremes the domain resolution needs: raw x bounds
 * over every finite sample, y bounds over the samples a window keeps
 * (windowed-out samples must not pin the value axis). Under `log`,
 * non-positive y values never join the y extremes (they still extend
 * x, as unplottable vertices on a real time axis do).
 * @param {{points: any[]}[]} input series with array points
 * @param {import('../core/domain.js').DomainPolicy} policy
 * @param {boolean} log
 * @returns {{x0:number, x1:number, y0:number, y1:number}}
 */
export function scanLineExtremes(input, policy, log) {
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
  if (policy.window !== null) {
    const [wLo] = resolveWindowX(x1, policy.window, policy.slide);
    y0 = Infinity;
    y1 = -Infinity;
    for (const s of input) {
      for (const p of s.points) {
        const px = numOf(p?.x);
        const py = numOf(p?.y);
        if (!Number.isFinite(px) || !Number.isFinite(py) || px < wLo) continue;
        if (log && py <= 0) continue;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
      }
    }
  }
  return { x0, x1, y0, y1 };
}

/**
 * Resolve the scale domains (and their tick values) from the scanned
 * extremes under the domain policy — the single place the line type
 * decides its bounds; the incremental session compares the result
 * against the AST's recorded domain to detect a still frame.
 * @param {{x0:number, x1:number, y0:number, y1:number}} ext
 * @param {import('../core/domain.js').DomainPolicy} policy
 * @param {boolean} time
 * @param {boolean} log
 * @returns {{x: [number,number], y: [number,number], xDrop: number|null,
 *   xTickValues: number[], yTickValues: number[]}}
 */
export function resolveLineDomains(ext, policy, time, log) {
  let { x0, x1, y0, y1 } = ext;
  let xDrop = null;
  if (policy.window !== null) {
    const [wLo, wHi] = resolveWindowX(x1, policy.window, policy.slide);
    xDrop = wLo;
    x0 = wLo;
    x1 = wHi;
  }
  if (!Number.isFinite(x0)) { x0 = 0; x1 = 1; }
  if (!Number.isFinite(y0)) { y0 = log ? 0.1 : 0; y1 = log ? 1 : 1; }

  let yTickValues;
  let yLo;
  let yHi;
  if (log) {
    if (policy.step) [yLo, yHi] = resolveStepYLog(y0, y1);
    else if (policy.pin !== null) [yLo, yHi] = resolvePinnedY(y0, y1, policy.pin, true);
    else { yLo = y0; yHi = y1; }
    if (yHi === yLo) yHi = yLo * 10;
    yTickValues = axisTicksLog(yLo, yHi);
  }
  else if (policy.step || policy.pin !== null) {
    [yLo, yHi] = policy.step ? resolveStepY(y0, y1) : resolvePinnedY(y0, y1, policy.pin, false);
    if (yHi === yLo) yHi = yLo + 1;
    yTickValues = axisTicksLinear(yLo, yHi, 5);
  }
  else {
    yTickValues = axisTicksLinear(y0, y1, 5);
    const lo = Math.min(y0, yTickValues[0] ?? y0);
    const hi = Math.max(y1, yTickValues[yTickValues.length - 1] ?? y1);
    yLo = lo;
    yHi = hi === lo ? lo + 1 : hi;
  }
  return {
    x: [x0, x1],
    y: [yLo, yHi],
    xDrop,
    xTickValues: axisTicksLinear(x0, x1, time ? 4 : 5),
    yTickValues,
  };
}

/**
 * Unit scales over a resolved domain — the same closures the build
 * uses, reconstructable by the session from the AST's domain alone.
 * @param {{x: [number,number], y: [number,number]}} domains
 * @param {boolean} time
 * @param {boolean} log
 * @returns {{xScale: (v:number)=>number, yScale: (v:number)=>number}}
 */
export function lineScales(domains, time, log) {
  return {
    xScale: time ? scaleTime(domains.x[0], domains.x[1]) : scaleLinear(domains.x[0], domains.x[1]),
    yScale: log ? scaleLog(domains.y[0], domains.y[1]) : scaleLinear(domains.y[0], domains.y[1]),
  };
}

/**
 * Map one sample onto a unit vertex (or null for an unplottable one) —
 * the per-point half of the build, shared with the session.
 * @param {any} p the `{x, y}` sample
 * @param {number|null} xDrop window low bound (drop older samples)
 * @param {(v:number)=>number} xScale @param {(v:number)=>number} yScale
 * @returns {{u:number, v:number}|null}
 */
export function lineVertex(p, xDrop, xScale, yScale) {
  const px = numOf(p?.x);
  const py = numOf(p?.y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
  if (xDrop !== null && px < xDrop) return null;
  const v = yScale(py);
  return Number.isFinite(v) ? { u: xScale(px), v: clamp01(v) } : null;
}

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
  const policy = normalizeDomainPolicy(config.domain);
  const domains = resolveLineDomains(scanLineExtremes(input, policy, log), policy, time, log);
  const { xScale, yScale } = lineScales(domains, time, log);

  const series = input.map((s) => ({
    name: String(s.name ?? ''),
    points: s.points.map((p) => lineVertex(p, domains.xDrop, xScale, yScale)),
  }));

  return {
    type: 'line',
    title: config.title ?? null,
    x: {
      ticks: domains.xTickValues.map((v) => ({
        pos: clamp01(xScale(v)),
        label: time ? formatTimeTick(v) : formatTickValue(v),
      })),
      label: config.xLabel ?? null,
    },
    y: {
      ticks: domains.yTickValues.map((v) => ({ pos: clamp01(yScale(v)), label: formatTickValue(v) })),
      label: config.yLabel ?? null,
    },
    domain: { x: domains.x, y: domains.y },
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
 * @typedef {object} LineSeriesRender
 * @property {any} group the series' `<g>` vnode
 * @property {string} d the polyline path data
 * @property {boolean} pen true when the last vertex was drawable (the
 *  next appended token is an `L`, not an `M`)
 * @property {any[]} dots marker circle vnodes (empty when markers off)
 * @property {string} color the series color
 */

/**
 * Render one series as its `<g>` group: the polyline path (when it has
 * one) followed by its marker dots.
 * @param {{points: ({u:number,v:number}|null)[]}} s
 * @param {number} si series index
 * @param {{x:number,y:number,w:number,h:number}} plot
 * @param {readonly string[]} palette
 * @param {boolean} markers
 * @returns {LineSeriesRender}
 */
export function lineSeriesRender(s, si, plot, palette, markers) {
  const color = seriesColor(si, palette);
  const pixels = s.points.map((p) => p === null ? null : {
    x: round2(plot.x + p.u * plot.w),
    y: round2(plot.y + (1 - p.v) * plot.h),
  });
  const d = polylinePath(pixels);
  const dots = [];
  if (markers) {
    for (const p of pixels) {
      if (p !== null) dots.push(circle(p.x, p.y, 2.5, { fill: color, class: 'chart-dot' }));
    }
  }
  const children = d !== ''
    ? [svgPath(d, { stroke: color, 'stroke-width': 2, fill: 'none', class: 'chart-line' }), ...dots]
    : [...dots];
  return {
    group: ['g', { key: `ls${si}`, class: 'chart-series' }, ...children],
    d,
    pen: s.points.length !== 0 && s.points[s.points.length - 1] !== null,
    dots,
    color,
  };
}

/**
 * Render a line AST and return the svg WITH the geometry a session
 * needs to patch it incrementally: the plot rect, how many chrome
 * children precede the series groups, and each series' render parts.
 * @param {LineAST} ast
 * @param {{tokens: Record<string,string>, cssVars: Record<string,string>}} theme
 * @param {string} hash
 * @param {{rootClass?: string, keyPrefix?: string, palette?: readonly string[], width?: number}} [options]
 * @returns {{svg: any, plot: {x:number,y:number,w:number,h:number},
 *   chromeLen: number, series: LineSeriesRender[]}}
 */
export function buildLineRender(ast, theme, hash, options = {}) {
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
  const chromeLen = frame.children.length;
  const children = frame.children;
  const series = [];
  for (let si = 0; si < ast.series.length; si++) {
    const parts = lineSeriesRender(ast.series[si], si, plot, palette, ast.markers);
    series.push(parts);
    children.push(parts.group);
  }
  const svg = svgRoot(options.rootClass ?? 'chart chart-svg chart-line-chart',
    frame.width, frame.height, theme, children, (options.keyPrefix ?? 'line-') + hash);
  annotateChart(svg, ast.title);
  return { svg, plot, chromeLen, series };
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
  return buildLineRender(ast, theme, hash, options).svg;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
