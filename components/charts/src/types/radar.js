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

import {
  svgRoot, rect, line as svgLine, textAt, textWidth, num, coord, polarPoint, anchorForAngle,
} from '@jarenjs/view/helpers';
import { clamp01 } from '@jarenjs/core/math';
import { axisTicksLinear, niceStep, formatTickValue } from '../core/axis.js';
import { FS_TICK, FS_LABEL, annotateChart, chartTitle } from '../core/cartesian.js';
import { CATEGORICAL, seriesColor } from '../core/palette.js';
import { normalizeTooltip, valueMark } from '../core/marks.js';

/**
 * @typedef {object} RadarAST
 * @property {'radar'} type
 * @property {string|null} title
 * @property {number} top value at the outer ring
 * @property {{label: string, angle: number, labeled: boolean}[]} axes
 * @property {number} labelEvery spoke-label stride (1 = label every axis)
 * @property {{r: number, label: string}[]} rings tick fractions (0..1]
 * @property {{name: string, points: ({angle: number, r: number}|null)[]}[]} series
 * @property {{name: string, swatch: number}[]|null} legend
 */

/**
 * Build the geometry-free radar AST.
 * `config.labelEvery` overrides the spoke-label stride; by default it
 * is derived from the axis count (see {@link radarLabelEvery}).
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

  const labelEvery = Number.isInteger(config.labelEvery) && config.labelEvery > 0
    ? config.labelEvery
    : radarLabelEvery(n);

  return {
    type: 'radar',
    title: config.title ?? null,
    top,
    axes: axes.map((label, i) => ({ label, angle: angleOf(i), labeled: i % labelEvery === 0 })),
    labelEvery,
    rings,
    series,
    legend: series.length > 1 ? series.map((s, i) => ({ name: s.name, swatch: i })) : null,
  };
}

/**
 * How many axes apart the spoke labels stand. A radar's labels sit on
 * a circle, so their room shrinks as the axis count grows while the
 * radius stays fixed — past a dozen axes the text collides. The stride
 * keeps at most {@link LABEL_BUDGET} labels drawn, whatever the axis
 * count; every spoke is still drawn, and every axis is still named by
 * the `<title>` on its spoke, so thinning costs no information.
 * @param {number} axisCount
 * @returns {number} a stride ≥ 1
 */
function radarLabelEvery(axisCount) {
  return axisCount <= LABEL_BUDGET ? 1 : Math.ceil(axisCount / LABEL_BUDGET);
}

/** The most spoke labels a fixed-radius radar reads cleanly with. */
const LABEL_BUDGET = 12;

/**
 * Render a radar AST to a pure-vnode SVG: ring polygons and spokes for
 * the scale, one translucent polygon with vertex dots per series, a
 * swatch legend on the right.
 * @param {RadarAST} ast
 * @param {{tokens: Record<string,string>, cssVars: Record<string,string>}} theme
 * @param {string} hash
 * @param {{rootClass?: string, keyPrefix?: string, palette?: readonly string[],
 *   tooltip?: import('../core/marks.js').ChartTooltipSpec}} [options]
 * @returns {any}
 */
export function renderRadarAST(ast, theme, hash, options = {}) {
  const t = theme.tokens;
  const palette = options.palette ?? CATEGORICAL;
  const tooltip = normalizeTooltip(options.tooltip);
  const R = 120;
  // Only drawn labels claim margin; a thinned radar is not padded for
  // text it does not render.
  const labelPad = Math.ceil(Math.max(40,
    ...ast.axes.filter((a) => a.labeled).map((a) => textWidth(a.label, FS_LABEL) + 12)));
  const cx = labelPad + R;
  const top = (ast.title ? 40 : 20) + FS_LABEL;
  const cy = top + R;
  const children = [];

  if (ast.title) {
    children.push(chartTitle(cx, 24, ast.title, FS_LABEL + 3, t));
  }

  const px = (angle, r) => coord(polarPoint(cx, cy, R * r, angle).x);
  const py = (angle, r) => coord(polarPoint(cx, cy, R * r, angle).y);
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
        cx: num(cx), cy: num(cy), r: coord(R * ring.r),
        fill: 'none', stroke: t.grid, 'stroke-width': 1, class: 'chart-grid',
      }]);
    }
    children.push(textAt(cx + 4, py(-Math.PI / 2, ring.r) + FS_TICK, ring.label, FS_TICK,
      { fill: t.muted, class: 'chart-tick' }));
  }
  for (const axis of ast.axes) {
    const spoke = svgLine(cx, cy, px(axis.angle, 1), py(axis.angle, 1),
      { stroke: t.axis, 'stroke-width': 1, class: 'chart-axis' });
    // A spoke whose label was thinned away carries the name as hover
    // text instead, so the thinning hides text, never information.
    children.push(axis.labeled ? spoke : [...spoke, ['title', {}, axis.label]]);
    if (!axis.labeled) continue;
    const anchor = anchorForAngle(axis.angle);
    const c = Math.cos(axis.angle);
    const s = Math.sin(axis.angle);
    const dy = s > 0.3 ? FS_LABEL : s < -0.3 ? -4 : 4;
    children.push(textAt(
      coord(cx + (R + 8) * c), coord(cy + (R + 8) * s + dy),
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
    children.push(valueMark('polygon', {
      points: pts.join(' '),
      fill: color, 'fill-opacity': 0.15,
      stroke: color, 'stroke-width': 2, class: 'chart-radar-series',
    }, tooltip, s.name, { type: 'radar', series: s.name }));
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
