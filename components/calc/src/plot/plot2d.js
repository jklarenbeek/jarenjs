//@ts-check
/**
 * @file The x·y plotter (design decision D8). `plot2d` compiles `f(x)`
 * ONCE, samples the domain into `Float64Array` buffers, maps them to the
 * viewport with a standard linear remap, and emits axes/grid/ticks plus one
 * `<path>` polyline per series — breaking the path on NaN/±Inf and at
 * asymptote jumps. The intermediate **scene** is geometry-as-plain-JSON
 * (deterministic → golden-geometry tests); `scene2dToVnode` turns it into
 * pure-vnode SVG.
 */

import { parseExpression } from '../parser/index.js';
import { compileExpr } from '../compile.js';
import { defaultEnv } from '../env.js';
import { createTheme } from '../theme.js';
import { svgRoot, line, path, textAt, polylinePath, mapRange } from '../render/svg.js';
import { hashContent } from '../utils.js';

const DEFAULTS = {
  width: 480,
  height: 320,
  samples: 240,
  padding: { left: 40, right: 12, top: 12, bottom: 24 },
  domain: [-10, 10],
  variable: 'x',
};

/**
 * Pick a "nice" tick step near `raw` (1/2/5 × 10^k).
 * @param {number} raw
 * @returns {number}
 */
function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = Math.pow(10, exp);
  const f = raw / base;
  const nice = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  return nice * base;
}

/**
 * Evenly-spaced "nice" ticks spanning [min, max].
 * @param {number} min @param {number} max @param {number} count
 * @returns {number[]}
 */
function niceTicks(min, max, count) {
  if (!(max > min)) return [min];
  const step = niceStep((max - min) / count);
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + step * 1e-9; v += step) {
    ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return ticks;
}

/**
 * @typedef {object} Plot2dConfig
 * @property {string|string[]} [expr] one or more source expressions
 * @property {[number,number]} [domain]
 * @property {[number,number]} [range] omit for auto-range
 * @property {number} [samples]
 * @property {number} [width] @property {number} [height]
 * @property {string} [variable] independent variable name (default 'x')
 * @property {any} [scope] extra variables in scope
 * @property {any} [env] evaluation environment (default float)
 * @property {any} [theme]
 */

/**
 * Build the geometry-as-JSON scene.
 * @param {string|string[]|Plot2dConfig} exprOrConfig
 * @param {Plot2dConfig} [options]
 * @returns {any}
 */
export function buildScene2d(exprOrConfig, options = {}) {
  /** @type {Plot2dConfig} */
  const cfg = typeof exprOrConfig === 'string' || Array.isArray(exprOrConfig)
    ? { ...options, expr: exprOrConfig }
    : { ...options, ...exprOrConfig };

  const width = cfg.width ?? DEFAULTS.width;
  const height = cfg.height ?? DEFAULTS.height;
  const pad = DEFAULTS.padding;
  const plot = { left: pad.left, right: width - pad.right, top: pad.top, bottom: height - pad.bottom };
  const [xmin, xmax] = cfg.domain ?? DEFAULTS.domain;
  const samples = Math.max(2, cfg.samples ?? DEFAULTS.samples);
  const varName = cfg.variable ?? DEFAULTS.variable;
  const env = cfg.env ?? defaultEnv();
  const exprs = Array.isArray(cfg.expr) ? cfg.expr : (cfg.expr != null ? [cfg.expr] : []);

  // sample each series into typed-array buffers (compile once)
  const xs = new Float64Array(samples);
  for (let i = 0; i < samples; i++) xs[i] = mapRange(i, 0, samples - 1, xmin, xmax);

  const rawSeries = [];
  for (const src of exprs) {
    let fn;
    try {
      fn = compileExpr(parseExpression(String(src)), { env });
    }
    catch {
      rawSeries.push({ source: String(src), ys: null });
      continue;
    }
    const ys = new Float64Array(samples);
    const scope = { ...(cfg.scope ?? {}) };
    for (let i = 0; i < samples; i++) {
      scope[varName] = xs[i];
      const v = +fn(scope);
      ys[i] = v;
    }
    rawSeries.push({ source: String(src), ys });
  }

  // auto-range from finite samples
  let [ymin, ymax] = cfg.range ?? [Infinity, -Infinity];
  if (cfg.range === undefined) {
    for (const s of rawSeries) {
      if (s.ys === null) continue;
      for (let i = 0; i < samples; i++) {
        const y = s.ys[i];
        if (Number.isFinite(y)) { if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
      }
    }
    if (!(ymax > ymin)) { ymin = -1; ymax = 1; }
    const margin = (ymax - ymin) * 0.08;
    ymin -= margin; ymax += margin;
  }

  const toScreen = (x, y) => ({
    x: mapRange(x, xmin, xmax, plot.left, plot.right),
    y: mapRange(y, ymin, ymax, plot.bottom, plot.top),
  });

  // build screen-space points, breaking on non-finite and asymptote jumps
  const series = rawSeries.map((s) => {
    if (s.ys === null) return { source: s.source, points: [], error: true };
    const points = [];
    let prevY = null;
    for (let i = 0; i < samples; i++) {
      const y = s.ys[i];
      if (!Number.isFinite(y)) { points.push(null); prevY = null; continue; }
      const p = toScreen(xs[i], y);
      if (prevY !== null && Math.abs(p.y - prevY) > (plot.bottom - plot.top)) {
        points.push(null); // discontinuity: full-height jump
      }
      points.push(p);
      prevY = p.y;
    }
    return { source: s.source, points, error: false };
  });

  const xticks = niceTicks(xmin, xmax, 8).map((v) => ({ value: v, x: mapRange(v, xmin, xmax, plot.left, plot.right) }));
  const yticks = niceTicks(ymin, ymax, 6).map((v) => ({ value: v, y: mapRange(v, ymin, ymax, plot.bottom, plot.top) }));
  const axisX = (0 >= ymin && 0 <= ymax) ? mapRange(0, ymin, ymax, plot.bottom, plot.top) : null;
  const axisY = (0 >= xmin && 0 <= xmax) ? mapRange(0, xmin, xmax, plot.left, plot.right) : null;

  return {
    kind: '2d',
    width, height, plot,
    domain: [xmin, xmax], range: [ymin, ymax],
    series, xticks, yticks,
    axes: { x: axisX, y: axisY },
  };
}

/**
 * Render a 2D scene into a pure-vnode SVG.
 * @param {any} scene @param {{ theme?: any }} [options]
 * @returns {any}
 */
export function scene2dToVnode(scene, options = {}) {
  const theme = createTheme(options.theme ?? 'default');
  const t = theme.tokens;
  const children = [];

  // grid
  for (const tick of scene.xticks) {
    children.push(line(tick.x, scene.plot.top, tick.x, scene.plot.bottom, { stroke: t.grid, 'stroke-width': 1, class: 'calc-grid' }));
  }
  for (const tick of scene.yticks) {
    children.push(line(scene.plot.left, tick.y, scene.plot.right, tick.y, { stroke: t.grid, 'stroke-width': 1, class: 'calc-grid' }));
  }
  // axes
  if (scene.axes.x !== null) {
    children.push(line(scene.plot.left, scene.axes.x, scene.plot.right, scene.axes.x, { stroke: t.axis, 'stroke-width': 1.5, class: 'calc-axis' }));
  }
  if (scene.axes.y !== null) {
    children.push(line(scene.axes.y, scene.plot.top, scene.axes.y, scene.plot.bottom, { stroke: t.axis, 'stroke-width': 1.5, class: 'calc-axis' }));
  }
  // tick labels
  for (const tick of scene.xticks) {
    children.push(textAt(tick.x, scene.plot.bottom + 14, formatTick(tick.value), 10, { fill: t.text, 'text-anchor': 'middle', class: 'calc-tick' }));
  }
  for (const tick of scene.yticks) {
    children.push(textAt(scene.plot.left - 4, tick.y + 3, formatTick(tick.value), 10, { fill: t.text, 'text-anchor': 'end', class: 'calc-tick' }));
  }
  // series polylines
  const colors = [t.series1, t.series2, t.series3];
  scene.series.forEach((s, i) => {
    const d = polylinePath(s.points);
    if (d) children.push(path(d, { stroke: colors[i % colors.length], 'stroke-width': 2, fill: 'none', class: 'calc-series' }));
  });

  const key = 'p2:' + hashContent(JSON.stringify({ d: scene.domain, r: scene.range, s: scene.series.map((s) => s.source) }));
  return svgRoot(scene.width, scene.height, theme, children, key);
}

/** @param {number} v */
function formatTick(v) {
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e4 || a < 1e-3) return v.toExponential(0);
  return String(Math.round(v * 1000) / 1000);
}

/**
 * Compile → sample → SVG vnode in one call.
 * @param {string|string[]|Plot2dConfig} exprOrConfig
 * @param {Plot2dConfig} [options]
 * @returns {any}
 */
export function plot2d(exprOrConfig, options = {}) {
  const scene = buildScene2d(exprOrConfig, options);
  return scene2dToVnode(scene, { theme: options.theme });
}
