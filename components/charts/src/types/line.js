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
 *              markers?, xLabel?, yLabel?, domain?, sampling?,
 *              dateNames?, timeFormats? }
 *
 * A time axis labels its ticks through a labeller compiled once per
 * build (`compileTimeTickFormat`) from the definition's optional
 * `dateNames` record and `timeFormats` patterns, so a localized axis
 * costs five compilations per render and none per label, and a
 * definition without them labels exactly as `formatTimeTick` does.
 *
 * `config.sampling` (`core/sampling.js`) decides how many of those
 * points are drawn: above two thousand a time line is reduced through
 * `@jarenjs/core/series`'s downsampler by default, and the AST reports
 * what that cost under `sampling`. The domain is always scanned from
 * every source point, so what a reader is told about the range does not
 * depend on what fitted on the line.
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

import { svgRoot, path as svgPath, circle, polylinePath, coord } from '@jarenjs/view/helpers';
import { clamp01 } from '@jarenjs/core/math';
import { scaleLinear, scaleLog, scaleTime } from '../core/scale.js';
import {
  axisTicksLinear, axisTicksLog, axisTicksTime, niceTimeStep,
  formatTickValue, compileTimeTickFormat,
} from '../core/axis.js';
import { cartesianFrame, annotateChart } from '../core/cartesian.js';
import { numOf } from '../core/stream-adapter.js';
import {
  normalizeDomainPolicy, resolveWindowX, resolveStepY, resolveStepYLog, resolvePinnedY,
} from '../core/domain.js';
import { CATEGORICAL, seriesColor } from '../core/palette.js';
import { normalizeTooltip, markProps } from '../core/marks.js';
import { normalizeSampling, sampleLineSeries } from '../core/sampling.js';

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
 * @property {{method: 'lttb'|'minmax', target: number, sourceCount: number,
 *   renderedCount: number}|null} sampling what the downsampler did, or
 *  `null` when every source point is drawn
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
    xTickValues: time ? axisTicksTime(x0, x1, 4) : axisTicksLinear(x0, x1, 5),
    // the step the ticks were chosen on, so the labels can match it
    xTickStep: time ? niceTimeStep(x1 - x0, 4) : null,
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
  return buildLineASTResolved(input, config, domains);
}

/** Build from the same resolved domains a session already used for its frame decision.
 * Internal to the chart engine; public builds always scan their own input.
 * @param {{name?: string, points: any[]}[]} input @param {any} config
 * @param {ReturnType<typeof resolveLineDomains>} domains @returns {LineAST} */
export function buildLineASTResolved(input, config, domains) {
  const time = config.x === 'time';
  const log = config.log === true;
  const { xScale, yScale } = lineScales(domains, time, log);
  const timeLabel = time
    ? compileTimeTickFormat({ dateNames: config.dateNames, timeFormats: config.timeFormats })
    : null;

  // Sampling chooses which points are DRAWN; it never moves a domain,
  // which is scanned from every source point above. A series the policy
  // leaves alone is mapped exactly as it always was.
  const sampler = normalizeSampling(config.sampling);
  let sourceCount = 0;
  let renderedCount = 0;
  let reduced = false;
  const series = input.map((s) => {
    sourceCount += s.points.length;
    const sampled = sampler === null ? null
      : sampleLineSeries(s.points, sampler, time, log, domains.xDrop, xScale, yScale);
    const points = sampled === null
      ? s.points.map((p) => lineVertex(p, domains.xDrop, xScale, yScale))
      : sampled.vertices;
    if (sampled !== null) reduced = true;
    renderedCount += points.length;
    return { name: String(s.name ?? ''), points };
  });

  return {
    type: 'line',
    title: config.title ?? null,
    x: {
      ticks: domains.xTickValues.map((v) => ({
        pos: clamp01(xScale(v)),
        label: timeLabel !== null ? timeLabel(v, domains.xTickStep) : formatTickValue(v),
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
    sampling: !reduced || sampler === null ? null : {
      method: sampler.method, target: sampler.target, sourceCount, renderedCount,
    },
  };
}

/**
 * @typedef {object} LineSeriesRender
 * @property {any} group the series' `<g>` vnode
 * @property {string} d the polyline path data
 * @property {boolean} pen true when the last vertex was drawable (the
 *  next appended token is an `L`, not an `M`)
 * @property {any[]} dots marker circle vnodes (empty when markers off)
 * @property {string} color the series color
 * @property {string} name the series name (its hover text)
 */

/**
 * The children of one series `<g>`: the hover `<title>`, the polyline
 * path (when it has one), then the marker dots. The series — not the
 * individual sample — is the value mark here: a live line carries tens
 * of thousands of vertices, and a `<title>` per vertex would put a
 * label allocation on the streaming path for text no reader can aim at.
 * Shared with the incremental session, which rebuilds these children in
 * place, so the two cannot drift.
 * @param {string} name @param {string} d @param {any[]} dots @param {string} color
 * @returns {any[]}
 */
export function lineSeriesChildren(name, d, dots, color) {
  const children = [];
  if (name !== '') children.push(['title', {}, name]);
  if (d !== '')
    children.push(svgPath(d, { stroke: color, 'stroke-width': 2, fill: 'none', class: 'chart-line' }));
  children.push(...dots);
  return children;
}

/**
 * Render one series as its `<g>` group.
 * @param {{name?: string, points: ({u:number,v:number}|null)[]}} s
 * @param {number} si series index
 * @param {{x:number,y:number,w:number,h:number}} plot
 * @param {readonly string[]} palette
 * @param {boolean} markers
 * @param {import('../core/marks.js').ChartTooltip|null} [tooltip]
 * @returns {LineSeriesRender}
 */
export function lineSeriesRender(s, si, plot, palette, markers, tooltip = null) {
  const color = seriesColor(si, palette);
  const name = String(s.name ?? '');
  const pixels = s.points.map((p) => p === null ? null : {
    x: coord(plot.x + p.u * plot.w),
    y: coord(plot.y + (1 - p.v) * plot.h),
  });
  const d = polylinePath(pixels);
  const dots = [];
  if (markers) {
    for (const p of pixels) {
      if (p !== null) dots.push(circle(p.x, p.y, 2.5, { fill: color, class: 'chart-dot' }));
    }
  }
  const props = markProps({ key: `ls${si}`, class: 'chart-series' },
    tooltip, name, { type: 'line', series: name });
  return {
    group: ['g', props, ...lineSeriesChildren(name, d, dots, color)],
    d,
    pen: s.points.length !== 0 && s.points[s.points.length - 1] !== null,
    dots,
    color,
    name,
  };
}

/**
 * Render a line AST and return the svg WITH the geometry a session
 * needs to patch it incrementally: the plot rect, how many chrome
 * children precede the series groups, and each series' render parts.
 * @param {LineAST} ast
 * @param {{tokens: Record<string,string>, cssVars: Record<string,string>}} theme
 * @param {string} hash
 * @param {{rootClass?: string, keyPrefix?: string, palette?: readonly string[], width?: number,
 *   tooltip?: import('../core/marks.js').ChartTooltipSpec}} [options]
 * @returns {{svg: any, plot: {x:number,y:number,w:number,h:number},
 *   chromeLen: number, series: LineSeriesRender[]}}
 */
export function buildLineRender(ast, theme, hash, options = {}) {
  const palette = options.palette ?? CATEGORICAL;
  const tooltip = normalizeTooltip(options.tooltip);
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
    const parts = lineSeriesRender(ast.series[si], si, plot, palette, ast.markers, tooltip);
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
