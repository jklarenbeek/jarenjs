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
 *              markers?, xLabel?, yLabel?, y2?: { series, label? },
 *              domain?, sampling?, dateNames?, timeFormats? }
 *
 * `config.y2` names the series that read a second value axis on the
 * right edge: its domain is scanned over those series only, it lays
 * its own ticks and label, and it draws no gridlines (the left axis
 * owns them). The x axis, `log` and a `'step'` y policy apply to both
 * axes; a pinned `domain.y` is in the left axis's units and pins only
 * it. A chart none of whose series `y2` names is the one-axis chart.
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
import { CodedError } from '@jarenjs/core/errors';
import { scaleLinear, scaleLog, scaleTime } from '../core/scale.js';
import {
  axisTicksLinear, axisTicksLog, axisTicksTime, niceTimeStep,
  formatTickValues, compileTimeTickFormat,
} from '../core/axis.js';
import { cartesianFrame, annotateChart } from '../core/cartesian.js';
import { numOf } from '../core/stream-adapter.js';
import {
  normalizeDomainPolicy, resolveWindowX, resolveStepY, resolveStepYLog, resolvePinnedY,
  measurableSpan, measurableDecades,
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
 * @property {{ticks: {pos:number,label:string}[], label: string|null}} [y2] the right
 *  value axis, present only when a series reads it
 * @property {{x: [number, number], y: [number, number], y2?: [number, number]}} domain
 *  resolved scale bounds
 * @property {{name: string, swatch: number, axis?: 'right'}[]|null} legend
 * @property {{name: string, points: ({u:number,v:number}|null)[], axis?: 'right'}[]} series
 *  `axis` is present (`'right'`) only on a series that reads the right axis
 * @property {boolean} markers
 * @property {{method: 'lttb'|'minmax', target: number, sourceCount: number,
 *   renderedCount: number}|null} sampling what the downsampler did, or
 *  `null` when every source point is drawn
 */

/**
 * The series names `config.y2` assigns to the right value axis, or
 * `null` when the definition declares no right axis. A name no series
 * carries is kept, not refused: a live feed delivers its series one at
 * a time, and the right axis appears with the first series it names.
 * @param {any} config the line definition
 * @returns {Set<string>|null}
 * @throws {CodedError} `CH0002` when `y2` is not `{ series: string[],
 *  label?: string|null }`, naming the member's JSON Pointer
 */
export function rightAxisSeries(config) {
  const y2 = config?.y2;
  if (y2 === undefined || y2 === null) return null;
  const refuse = (at, what) => new CodedError('ChartError', 'CH0002',
    `a line chart's y2 is { series: string[], label?: string }: ${what}`, at);
  if (typeof y2 !== 'object' || Array.isArray(y2)) throw refuse('/y2', 'y2 is not an object');
  if (!Array.isArray(y2.series)) throw refuse('/y2/series', 'series is not an array of series names');
  for (let i = 0; i < y2.series.length; i++) {
    if (typeof y2.series[i] !== 'string') throw refuse(`/y2/series/${i}`, 'a series name is not a string');
  }
  if (y2.label !== undefined && y2.label !== null && typeof y2.label !== 'string')
    throw refuse('/y2/label', 'label is not a string');
  return new Set(y2.series);
}

/**
 * Whether a series reads the right axis.
 * @param {{name?: any}} s @param {Set<string>|null} right
 * @returns {boolean}
 */
export function readsRightAxis(s, right) {
  return right !== null && right.has(String(s.name ?? ''));
}

/**
 * @typedef {{x0:number, x1:number, y0:number, y1:number, r0?:number, r1?:number}} LineExtremes
 * `y0`/`y1` bound the left axis's series, `r0`/`r1` (present exactly when
 * a series reads the right axis) the right axis's
 */

/**
 * Scan the data extremes the domain resolution needs: raw x bounds
 * over every finite sample, y bounds over the samples a window keeps
 * (windowed-out samples must not pin the value axis), per value axis.
 * Under `log`, non-positive y values never join the y extremes (they
 * still extend x, as unplottable vertices on a real time axis do).
 * @param {{name?: any, points: any[]}[]} input series with array points
 * @param {import('../core/domain.js').DomainPolicy} policy
 * @param {boolean} log
 * @param {Set<string>|null} right the right axis's series names
 * @returns {LineExtremes}
 */
export function scanLineExtremes(input, policy, log, right) {
  let x0 = Infinity;
  let x1 = -Infinity;
  // [left, right] value bounds
  const lo = [Infinity, Infinity];
  const hi = [-Infinity, -Infinity];
  let anyRight = false;
  for (const s of input) {
    const a = readsRightAxis(s, right) ? 1 : 0;
    if (a === 1) anyRight = true;
    for (const p of s.points) {
      const px = numOf(p?.x);
      const py = numOf(p?.y);
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (log && py <= 0) continue;
      if (py < lo[a]) lo[a] = py;
      if (py > hi[a]) hi[a] = py;
    }
  }
  if (policy.window !== null) {
    const [wLo] = resolveWindowX(x1, policy.window, policy.slide);
    lo[0] = lo[1] = Infinity;
    hi[0] = hi[1] = -Infinity;
    for (const s of input) {
      const a = readsRightAxis(s, right) ? 1 : 0;
      for (const p of s.points) {
        const px = numOf(p?.x);
        const py = numOf(p?.y);
        if (!Number.isFinite(px) || !Number.isFinite(py) || px < wLo) continue;
        if (log && py <= 0) continue;
        if (py < lo[a]) lo[a] = py;
        if (py > hi[a]) hi[a] = py;
      }
    }
  }
  return anyRight
    ? { x0, x1, y0: lo[0], y1: hi[0], r0: lo[1], r1: hi[1] }
    : { x0, x1, y0: lo[0], y1: hi[0] };
}

/**
 * Resolve one value axis's bounds and tick values from its scanned
 * extremes: a `'step'` policy quantizes, a pin (left axis only) pins,
 * otherwise the bounds widen to the nice ticks around the data.
 * @param {number} y0 @param {number} y1 scanned extremes (Infinity when empty)
 * @param {boolean} step @param {{min: number|null, max: number|null}|null} pin
 * @param {boolean} log
 * @returns {{domain: [number, number], ticks: number[]}}
 */
function resolveValueAxis(y0, y1, step, pin, log) {
  if (!Number.isFinite(y0)) { y0 = log ? 0.1 : 0; y1 = log ? 1 : 1; }
  [y0, y1] = measurableSpan(y0, y1);
  let ticks;
  let yLo;
  let yHi;
  if (log) {
    if (step) [yLo, yHi] = resolveStepYLog(y0, y1);
    else if (pin !== null) [yLo, yHi] = resolvePinnedY(y0, y1, pin, true);
    else { yLo = y0; yHi = y1; }
    if (yHi === yLo) yHi = yLo * 10;
    [yLo, yHi] = measurableDecades(yLo, yHi);
    ticks = axisTicksLog(yLo, yHi);
  }
  else if (step || pin !== null) {
    [yLo, yHi] = step ? resolveStepY(y0, y1) : resolvePinnedY(y0, y1, pin, false);
    if (yHi === yLo) yHi = yLo + 1;
    ticks = axisTicksLinear(yLo, yHi, 5);
  }
  else {
    ticks = axisTicksLinear(y0, y1, 5);
    const lo = Math.min(y0, ticks[0] ?? y0);
    const hi = Math.max(y1, ticks[ticks.length - 1] ?? y1);
    yLo = lo;
    yHi = hi === lo ? lo + 1 : hi;
  }
  return { domain: [yLo, yHi], ticks };
}

/**
 * Resolve the scale domains (and their tick values) from the scanned
 * extremes under the domain policy — the single place the line type
 * decides its bounds; the incremental session compares the result
 * against the AST's recorded domain to detect a still frame. `y2` and
 * `y2TickValues` are present exactly when the extremes carry a right
 * axis.
 * @param {LineExtremes} ext
 * @param {import('../core/domain.js').DomainPolicy} policy
 * @param {boolean} time
 * @param {boolean} log
 * @returns {{x: [number,number], y: [number,number], xDrop: number|null,
 *   xTickValues: number[], xTickStep: number|null, yTickValues: number[],
 *   y2?: [number,number], y2TickValues?: number[]}}
 */
export function resolveLineDomains(ext, policy, time, log) {
  let { x0, x1 } = ext;
  let xDrop = null;
  if (policy.window !== null) {
    const [wLo, wHi] = resolveWindowX(x1, policy.window, policy.slide);
    xDrop = wLo;
    x0 = wLo;
    x1 = wHi;
  }
  if (!Number.isFinite(x0)) { x0 = 0; x1 = 1; }
  [x0, x1] = measurableSpan(x0, x1);
  const left = resolveValueAxis(ext.y0, ext.y1, policy.step, policy.pin, log);
  const domains = {
    x: /** @type {[number, number]} */ ([x0, x1]),
    y: left.domain,
    xDrop,
    xTickValues: time ? axisTicksTime(x0, x1, 4) : axisTicksLinear(x0, x1, 5),
    // the step the ticks were chosen on, so the labels can match it
    xTickStep: time ? niceTimeStep(x1 - x0, 4) : null,
    yTickValues: left.ticks,
  };
  if (ext.r0 === undefined || ext.r1 === undefined) return domains;
  // a pin is in the left axis's units, so the right axis never reads it
  const right = resolveValueAxis(ext.r0, ext.r1, policy.step, null, log);
  return { ...domains, y2: right.domain, y2TickValues: right.ticks };
}

/**
 * Unit scales over a resolved domain — the same closures the build
 * uses, reconstructable by the session from the AST's domain alone.
 * `y2Scale` maps the right axis, and is the left one's when there is
 * none.
 * @param {{x: [number,number], y: [number,number], y2?: [number,number]}} domains
 * @param {boolean} time
 * @param {boolean} log
 * @returns {{xScale: (v:number)=>number, yScale: (v:number)=>number,
 *   y2Scale: (v:number)=>number}}
 */
export function lineScales(domains, time, log) {
  const value = (d) => log ? scaleLog(d[0], d[1]) : scaleLinear(d[0], d[1]);
  const yScale = value(domains.y);
  return {
    xScale: time ? scaleTime(domains.x[0], domains.x[1]) : scaleLinear(domains.x[0], domains.x[1]),
    yScale,
    y2Scale: domains.y2 === undefined ? yScale : value(domains.y2),
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
  const right = rightAxisSeries(config);
  const domains = resolveLineDomains(scanLineExtremes(input, policy, log, right), policy, time, log);
  return buildLineASTResolved(input, config, domains);
}

/** Build from the same resolved domains a session already used for its frame decision.
 * Internal to the chart engine; public builds always scan their own input.
 * @param {{name?: string, points: any[]}[]} input @param {any} config
 * @param {ReturnType<typeof resolveLineDomains>} domains @returns {LineAST} */
export function buildLineASTResolved(input, config, domains) {
  const time = config.x === 'time';
  const log = config.log === true;
  const { xScale, yScale, y2Scale } = lineScales(domains, time, log);
  const right = rightAxisSeries(config);
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
    const onRight = readsRightAxis(s, right);
    const sScale = onRight ? y2Scale : yScale;
    sourceCount += s.points.length;
    const sampled = sampler === null ? null
      : sampleLineSeries(s.points, sampler, time, log, domains.xDrop, xScale, sScale);
    const points = sampled === null
      ? s.points.map((p) => lineVertex(p, domains.xDrop, xScale, sScale))
      : sampled.vertices;
    if (sampled !== null) reduced = true;
    renderedCount += points.length;
    const name = String(s.name ?? '');
    return onRight ? { name, points, axis: /** @type {const} */ ('right') } : { name, points };
  });
  const ticksOf = (values, scale) => {
    const labels = formatTickValues(values);
    return values.map((v, i) => ({ pos: clamp01(scale(v)), label: labels[i] }));
  };
  const xLabels = timeLabel !== null ? null : formatTickValues(domains.xTickValues);

  /** @type {LineAST} */
  const ast = {
    type: 'line',
    title: config.title ?? null,
    x: {
      ticks: domains.xTickValues.map((v, i) => ({
        pos: clamp01(xScale(v)),
        label: xLabels === null ? timeLabel(v, domains.xTickStep) : xLabels[i],
      })),
      label: config.xLabel ?? null,
    },
    y: {
      ticks: ticksOf(domains.yTickValues, yScale),
      label: config.yLabel ?? null,
    },
    domain: { x: domains.x, y: domains.y },
    legend: series.length > 1
      ? series.map((s, i) => s.axis === 'right' ? { name: s.name, swatch: i, axis: s.axis } : { name: s.name, swatch: i })
      : null,
    series,
    markers: config.markers === true,
    sampling: !reduced || sampler === null ? null : {
      method: sampler.method, target: sampler.target, sourceCount, renderedCount,
    },
  };
  if (domains.y2 !== undefined && domains.y2TickValues !== undefined) {
    ast.y2 = { ticks: ticksOf(domains.y2TickValues, y2Scale), label: config.y2?.label ?? null };
    ast.domain.y2 = domains.y2;
  }
  return ast;
}

/** The hover text and legend name suffix of a series that reads the right axis. */
const RIGHT_AXIS_MARK = ' (right axis)';

/**
 * @typedef {object} LineSeriesRender
 * @property {any} group the series' `<g>` vnode
 * @property {string} d the polyline path data
 * @property {boolean} pen true when the last vertex was drawable (the
 *  next appended token is an `L`, not an `M`)
 * @property {any[]} dots marker circle vnodes (empty when markers off)
 * @property {string} color the series color
 * @property {string} name the series' hover text: its name, marked
 *  `(right axis)` when it reads the right axis
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
 * @param {{name?: string, points: ({u:number,v:number}|null)[], axis?: 'right'}} s
 * @param {number} si series index
 * @param {{x:number,y:number,w:number,h:number}} plot
 * @param {readonly string[]} palette
 * @param {boolean} markers
 * @param {import('../core/marks.js').ChartTooltip|null} [tooltip]
 * @returns {LineSeriesRender}
 */
export function lineSeriesRender(s, si, plot, palette, markers, tooltip = null) {
  const color = seriesColor(si, palette);
  const series = String(s.name ?? '');
  const right = s.axis === 'right';
  const name = right && series !== '' ? series + RIGHT_AXIS_MARK : series;
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
    tooltip, name, right ? { type: 'line', series, axis: 'right' } : { type: 'line', series: name });
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
    legend: ast.y2 === undefined || ast.legend === null ? ast.legend
      : ast.legend.map((e) => e.axis === 'right' ? { ...e, name: e.name + RIGHT_AXIS_MARK } : e),
    xAxis: ast.x,
    yAxis: ast.y,
    y2Axis: ast.y2,
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
