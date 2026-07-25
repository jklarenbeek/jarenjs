//@ts-check
/**
 * @file The radar chart type: N named axes as spokes from a shared
 * center, one polygon per series over a common 0..top value domain.
 * Data shape:
 *
 *   data   = { axes: string[], series: [{ name, values: number[] }] }
 *   config = { type:'radar', title?, max? }
 *
 * The AST stays polar and geometry-free: axis angles in radians
 * (12 o'clock = -π/2, clockwise), ring and vertex radii as fractions of
 * the (unknown) outer radius. Non-finite or negative samples become
 * `null` vertices — the polygon simply skips them, mirroring how the
 * line type breaks its path on unplottable samples.
 */

import { svgRoot, rect, line as svgLine, textAt, textWidth, num } from '@jarenjs/view/helpers';
import { axisTicksLinear, niceStep, formatTickValue } from '../core/axis.js';
import { FS_TICK, FS_LABEL, annotateChart } from '../core/cartesian.js';
import { CATEGORICAL, seriesColor } from '../core/palette.js';

/**
 * @typedef {object} RadarAST
 * @property {'radar'} type
 * @property {string|null} title
 * @property {number} top value at the outer ring
 * @property {{label: string, angle: number}[]} axes
 * @property {{r: number, label: string}[]} rings tick fractions (0..1]
 * @property {{name: string, points: ({angle: number, r: number}|null)[]}[]} series
 * @property {{name: string, swatch: number}[]|null} legend
 */

/**
 * Build the geometry-free radar AST.
 * @param {any} data
 * @param {any} [config]
 * @returns {RadarAST}
 */
export function buildRadarAST(data, config = {}) {
  const axes = (data?.axes ?? []).map((a) => String(a));
  const input = (data?.series ?? []).filter((s) => Array.isArray(s.values));
  const n = axes.length;

  let maxVal = 0;
  for (const s of input) {
    for (let i = 0; i < n; i++) {
      const v = s.values[i];
      if (typeof v === 'number' && Number.isFinite(v) && v > maxVal) maxVal = v;
    }
  }
  let top;
  if (typeof config.max === 'number' && Number.isFinite(config.max) && config.max > 0) {
    top = config.max;
  }
  else {
    if (maxVal === 0) maxVal = 1;
    const step = niceStep(maxVal, 4);
    top = step * Math.ceil(maxVal / step);
  }

  const angleOf = (i) => -Math.PI / 2 + (i / Math.max(1, n)) * Math.PI * 2;
  const rings = axisTicksLinear(0, top, 4)
    .filter((v) => v > 0)
    .map((v) => ({ r: clamp01(v / top), label: formatTickValue(v) }));

  const series = input.map((s) => ({
    name: String(s.name ?? ''),
    points: axes.map((_, i) => {
      const v = s.values[i];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
      return { angle: angleOf(i), r: clamp01(v / top) };
    }),
  }));

  return {
    type: 'radar',
    title: config.title ?? null,
    top,
    axes: axes.map((label, i) => ({ label, angle: angleOf(i) })),
    rings,
    series,
    legend: series.length > 1 ? series.map((s, i) => ({ name: s.name, swatch: i })) : null,
  };
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Render a radar AST to a pure-vnode SVG: ring polygons and spokes for
 * the scale, one translucent polygon with vertex dots per series, a
 * swatch legend on the right.
 * @param {RadarAST} ast
 * @param {{tokens: Record<string,string>, cssVars: Record<string,string>}} theme
 * @param {string} hash
 * @param {{rootClass?: string, keyPrefix?: string, palette?: readonly string[]}} [options]
 * @returns {any}
 */
export function renderRadarAST(ast, theme, hash, options = {}) {
  const t = theme.tokens;
  const palette = options.palette ?? CATEGORICAL;
  const R = 120;
  const labelPad = Math.ceil(Math.max(40, ...ast.axes.map((a) => textWidth(a.label, FS_LABEL) + 12)));
  const cx = labelPad + R;
  const top = (ast.title ? 40 : 20) + FS_LABEL;
  const cy = top + R;
  const children = [];

  if (ast.title) {
    children.push(textAt(cx, 24, ast.title, FS_LABEL + 3,
      { 'font-weight': 'bold', 'text-anchor': 'middle', fill: t.text, class: 'chart-title' }));
  }

  const px = (angle, r) => round2(cx + R * r * Math.cos(angle));
  const py = (angle, r) => round2(cy + R * r * Math.sin(angle));
  const ringPoints = (r) => ast.axes.map((a) => `${px(a.angle, r)},${py(a.angle, r)}`).join(' ');

  // Scale chrome: concentric ring polygons, one spoke per axis.
  for (const ring of ast.rings) {
    if (ast.axes.length >= 3) {
      children.push(['polygon', {
        points: ringPoints(ring.r),
        fill: 'none', stroke: t.grid, 'stroke-width': 1, class: 'chart-grid',
      }]);
    }
    else {
      children.push(['circle', {
        cx: num(cx), cy: num(cy), r: round2(R * ring.r),
        fill: 'none', stroke: t.grid, 'stroke-width': 1, class: 'chart-grid',
      }]);
    }
    children.push(textAt(cx + 4, py(-Math.PI / 2, ring.r) + FS_TICK, ring.label, FS_TICK,
      { fill: t.muted, class: 'chart-tick' }));
  }
  for (const axis of ast.axes) {
    children.push(svgLine(cx, cy, px(axis.angle, 1), py(axis.angle, 1),
      { stroke: t.axis, 'stroke-width': 1, class: 'chart-axis' }));
    const c = Math.cos(axis.angle);
    const anchor = c > 0.3 ? 'start' : c < -0.3 ? 'end' : 'middle';
    const s = Math.sin(axis.angle);
    const dy = s > 0.3 ? FS_LABEL : s < -0.3 ? -4 : 4;
    children.push(textAt(
      round2(cx + (R + 8) * c), round2(cy + (R + 8) * s + dy),
      axis.label, FS_LABEL,
      { 'text-anchor': anchor, fill: t.muted, class: 'chart-axis-label' }));
  }

  // One polygon per series (unplottable vertices skipped), vertex dots.
  for (let si = 0; si < ast.series.length; si++) {
    const s = ast.series[si];
    const color = seriesColor(si, palette);
    const pts = [];
    for (const p of s.points) {
      if (p !== null) pts.push(`${px(p.angle, p.r)},${py(p.angle, p.r)}`);
    }
    if (pts.length === 0) continue;
    children.push(['polygon', {
      points: pts.join(' '),
      fill: color, 'fill-opacity': 0.15,
      stroke: color, 'stroke-width': 2, class: 'chart-radar-series',
    }, ['title', {}, s.name]]);
    for (const p of s.points) {
      if (p !== null) {
        children.push(['circle', {
          cx: px(p.angle, p.r), cy: py(p.angle, p.r), r: 2.5,
          fill: color, class: 'chart-dot',
        }]);
      }
    }
  }

  // Legend column on the right, the pie legend pattern.
  const legendX = cx + R + labelPad + 10;
  let legendW = 0;
  if (ast.legend !== null) {
    for (let i = 0; i < ast.legend.length; i++) {
      const entry = ast.legend[i];
      const y = top + i * 24;
      legendW = Math.max(legendW, Math.ceil(textWidth(entry.name, FS_LABEL)) + 30);
      children.push(rect(legendX, y, 14, 14, { fill: seriesColor(entry.swatch, palette), class: 'chart-swatch' }));
      children.push(textAt(legendX + 20, y + 12, entry.name, FS_LABEL, { fill: t.text, class: 'chart-tick' }));
    }
  }

  const width = legendX + legendW + (ast.legend !== null ? 20 : 0);
  const height = cy + R + FS_LABEL + 20;
  const svg = svgRoot(options.rootClass ?? 'chart chart-svg chart-radar-chart',
    width, height, theme, children, (options.keyPrefix ?? 'radar-') + hash);
  return annotateChart(svg, ast.title);
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
