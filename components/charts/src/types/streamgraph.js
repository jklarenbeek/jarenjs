//@ts-check
/**
 * @file The streamgraph chart type: stacked series as flowing bands
 * around a silhouette baseline (the stack centered on its running
 * total, so the outline stays symmetric). Data shape:
 *
 *   data   = { series: [{ name, values: number[] }], xs?: number[] }
 *   config = { type:'streamgraph', title?, xLabel? }
 *
 * `values` align by index across series; `xs` optionally places the
 * samples on a numeric x axis (index positions otherwise). Negative
 * and non-finite samples read as 0 — a streamgraph stacks
 * non-negative magnitudes. The y axis is deliberately unlabeled:
 * silhouette offsets make absolute y positions meaningless; band
 * thickness is the encoding, and each band carries its name as hover
 * text.
 */

import { svgRoot } from '@jarenjs/view/helpers';
import { scaleLinear } from '../core/scale.js';
import { axisTicksLinear, formatTickValue } from '../core/axis.js';
import { cartesianFrame, annotateChart } from '../core/cartesian.js';
import { CATEGORICAL, seriesColor } from '../core/palette.js';

/**
 * @typedef {object} StreamgraphAST
 * @property {'streamgraph'} type
 * @property {string|null} title
 * @property {{ticks: {pos:number,label:string}[], label: string|null}} x
 * @property {{name: string, swatch: number}[]|null} legend
 * @property {{name: string, points: {u:number, lo:number, hi:number}[]}[]} layers
 */

/**
 * Build the geometry-free streamgraph AST.
 * @param {any} data
 * @param {any} [config]
 * @returns {StreamgraphAST}
 */
export function buildStreamgraphAST(data, config = {}) {
  const input = (data?.series ?? []).filter((s) => Array.isArray(s.values));
  const count = Math.max(0, ...input.map((s) => s.values.length));
  const xs = Array.isArray(data?.xs) && data.xs.every((v) => typeof v === 'number' && Number.isFinite(v))
    && data.xs.length >= count && count > 0
    ? data.xs.slice(0, count)
    : null;

  const at = (s, k) => {
    const v = s.values[k];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
  };

  // Silhouette baseline: the stack at sample k is centered on 0.
  let yMin = Infinity;
  let yMax = -Infinity;
  const stacked = [];
  for (let k = 0; k < count; k++) {
    let total = 0;
    for (const s of input) total += at(s, k);
    let running = -total / 2;
    const column = [];
    for (const s of input) {
      const v = at(s, k);
      column.push([running, running + v]);
      running += v;
    }
    stacked.push(column);
    if (-total / 2 < yMin) yMin = -total / 2;
    if (total / 2 > yMax) yMax = total / 2;
  }
  if (!Number.isFinite(yMin)) { yMin = 0; yMax = 1; }
  const yScale = scaleLinear(yMin, yMax === yMin ? yMin + 1 : yMax);

  const uOf = xs !== null
    ? scaleLinear(Math.min(...xs), Math.max(...xs) === Math.min(...xs) ? Math.min(...xs) + 1 : Math.max(...xs))
    : null;
  const uAt = (k) => xs !== null ? clamp01(uOf(xs[k]))
    : count <= 1 ? 0.5 : k / (count - 1);

  const layers = input.map((s, si) => ({
    name: String(s.name ?? ''),
    points: stacked.map((column, k) => ({
      u: uAt(k),
      lo: clamp01(yScale(column[si][0])),
      hi: clamp01(yScale(column[si][1])),
    })),
  }));

  const tickValues = xs !== null
    ? axisTicksLinear(Math.min(...xs), Math.max(...xs), 5)
    : axisTicksLinear(0, Math.max(0, count - 1), Math.min(5, Math.max(1, count - 1)));
  const ticks = tickValues.map((v) => ({
    pos: xs !== null ? clamp01(uOf(v)) : count <= 1 ? 0.5 : clamp01(v / (count - 1)),
    label: formatTickValue(v),
  }));

  return {
    type: 'streamgraph',
    title: config.title ?? null,
    x: { ticks, label: config.xLabel ?? null },
    legend: layers.length > 1 ? layers.map((l, i) => ({ name: l.name, swatch: i })) : null,
    layers,
  };
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Render a streamgraph AST to a pure-vnode SVG: one closed band path
 * per layer (top edge forward, bottom edge back), separated by the
 * slice-stroke hairline the pie uses between touching fills.
 * @param {StreamgraphAST} ast
 * @param {{tokens: Record<string,string>, cssVars: Record<string,string>}} theme
 * @param {string} hash
 * @param {{rootClass?: string, keyPrefix?: string, palette?: readonly string[], width?: number}} [options]
 * @returns {any}
 */
export function renderStreamgraphAST(ast, theme, hash, options = {}) {
  const palette = options.palette ?? CATEGORICAL;
  const frame = cartesianFrame({
    title: ast.title,
    legend: ast.legend,
    xAxis: ast.x,
    yAxis: { ticks: [] },
    grid: 'none',
    width: options.width,
    palette,
    theme,
  });
  const { plot } = frame;
  const children = frame.children;
  for (let si = 0; si < ast.layers.length; si++) {
    const layer = ast.layers[si];
    if (layer.points.length === 0) continue;
    const px = (p) => round2(plot.x + p.u * plot.w);
    const py = (v) => round2(plot.y + (1 - v) * plot.h);
    let d = '';
    for (let k = 0; k < layer.points.length; k++) {
      const p = layer.points[k];
      d += `${k === 0 ? 'M' : 'L'}${px(p)},${py(p.hi)} `;
    }
    for (let k = layer.points.length - 1; k >= 0; k--) {
      const p = layer.points[k];
      d += `L${px(p)},${py(p.lo)} `;
    }
    children.push(['path', {
      d: d.trimEnd() + ' Z',
      fill: seriesColor(si, palette),
      stroke: theme.tokens.sliceStroke, 'stroke-width': 1,
      class: 'chart-stream-band',
    }, ['title', {}, layer.name]]);
  }
  const svg = svgRoot(options.rootClass ?? 'chart chart-svg chart-streamgraph-chart',
    frame.width, frame.height, theme, children, (options.keyPrefix ?? 'stream-') + hash);
  return annotateChart(svg, ast.title);
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
