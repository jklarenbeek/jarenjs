//@ts-check
/**
 * @file The pie chart type, split into the geometry-free AST build and
 * the SVG render (the two-stage contract every chart type follows).
 * This is the extraction of the mermaid pie: `@jarenjs/mermaid` now
 * delegates its `pie` diagrams here, passing its own class names,
 * palette and theme through `render` options so its output is unchanged
 * — charts never imports mermaid (the dependency arrow is one-way).
 */

import { svgRoot, rect, group, textAt, num, polarPoint, textWidth } from '@jarenjs/view/helpers';
import { CATEGORICAL } from '../core/palette.js';
import { normalizeTooltip, markProps } from '../core/marks.js';

/**
 * @typedef {object} PieSliceAST
 * @property {string} label
 * @property {number} value
 * @property {number} frac fraction of the total (0..1)
 * @property {number} start start angle (radians, 12 o'clock = -π/2)
 * @property {number} end end angle (radians)
 */
/**
 * @typedef {object} PieAST
 * @property {'pie'} type
 * @property {string|null} title
 * @property {number} total
 * @property {number|null} inner donut hole radius as a fraction of the outer radius (null = solid pie)
 * @property {PieSliceAST[]} slices
 */

/**
 * Build the geometry-free pie AST: labels/values → fractions and
 * accumulated start/end angles, starting at 12 o'clock. `config.donut`
 * turns the pie into a donut: `true` uses the default hole fraction,
 * a number in (0, 1) sets it directly.
 * @param {{slices?: {label: string, value: number}[]}} data
 * @param {{title?: string|null, donut?: boolean|number}} [config]
 * @returns {PieAST}
 */
export function buildPieAST(data, config = {}) {
  const input = data?.slices ?? [];
  const total = input.reduce((s, x) => s + x.value, 0) || 1;
  const slices = [];
  let angle = -Math.PI / 2;
  for (let i = 0; i < input.length; i++) {
    const frac = input[i].value / total;
    const next = angle + frac * Math.PI * 2;
    slices.push({
      label: input[i].label,
      value: input[i].value,
      frac,
      start: angle,
      end: next,
    });
    angle = next;
  }
  const donut = config.donut;
  const inner = donut === true ? 0.55
    : typeof donut === 'number' && donut > 0 && donut < 1 ? donut
      : null;
  return {
    type: 'pie',
    title: config.title ?? null,
    total,
    inner,
    slices,
  };
}

/**
 * @typedef {object} PieRenderOptions
 * @property {string} [rootClass] the root `<svg>` class
 * @property {string} [keyPrefix] vnode key prefix (`<prefix><hash>`)
 * @property {string} [sliceClass] class per slice `<path>`
 * @property {string} [legendClass] class per legend `<g>`
 * @property {readonly string[]} [palette] slice colors
 * @property {string} [textColor] title/legend text fill
 * @property {string} [sliceStroke] slice separator stroke
 * @property {boolean} [titles] per-slice hover `<title>` (default true).
 *  `@jarenjs/mermaid` turns it off: a mermaid pie is a *diagram*, and
 *  its emitted SVG is a byte-stable contract that hover text would
 *  break — the delegation exists to share geometry, not to change what
 *  mermaid renders.
 * @property {import('../core/marks.js').ChartTooltipSpec} [tooltip]
 *  pointer bindings for a floating-tooltip host
 */

/**
 * Render a pie AST to a pure-vnode SVG: angles → arc paths, plus a
 * swatch legend with percentages and an optional title. With
 * `ast.inner === null` (no `donut` in the config) the slice path is
 * emitted by the same wedge template as before the donut variant
 * existed — solid-pie output is byte-stable, which is what keeps the
 * mermaid delegation byte-identical; the annular geometry lives
 * entirely in the other branch. Every slice carries a label/value
 * `<title>` unless `options.titles` is false (mermaid's opt-out).
 * @param {PieAST} ast
 * @param {{tokens: Record<string,string>, cssVars: Record<string,string>}} theme
 * @param {string} hash content hash for the vnode key
 * @param {PieRenderOptions} [options]
 * @returns {any} an SVG vnode
 */
export function renderPieAST(ast, theme, hash, options = {}) {
  const rootClass = options.rootClass ?? 'chart chart-svg chart-pie';
  const keyPrefix = options.keyPrefix ?? 'pie-';
  const sliceClass = options.sliceClass ?? 'chart-pie-slice';
  const legendClass = options.legendClass ?? 'chart-pie-legend';
  const palette = options.palette ?? CATEGORICAL;
  const textColor = options.textColor ?? theme.tokens.text;
  const sliceStroke = options.sliceStroke ?? theme.tokens.sliceStroke;
  const titles = options.titles !== false;
  const tooltip = normalizeTooltip(options.tooltip);
  const fs = 14;
  const R = 130;
  const cx = R + 20;
  const cy = R + 40;
  const inner = ast.inner ?? null;
  const r = inner === null ? 0 : R * inner;
  const slices = [];
  for (let i = 0; i < ast.slices.length; i++) {
    const s = ast.slices[i];
    const { x: x1, y: y1 } = polarPoint(cx, cy, R, s.start);
    const { x: x2, y: y2 } = polarPoint(cx, cy, R, s.end);
    const large = s.frac > 0.5 ? 1 : 0;
    const color = palette[i % palette.length];
    const i1 = polarPoint(cx, cy, r, s.start);
    const i2 = polarPoint(cx, cy, r, s.end);
    const d = inner === null
      ? `M${num(cx)},${num(cy)} L${num(x1)},${num(y1)} A${R},${R} 0 ${large} 1 ${num(x2)},${num(y2)} Z`
      : `M${num(i1.x)},${num(i1.y)} `
        + `L${num(x1)},${num(y1)} A${R},${R} 0 ${large} 1 ${num(x2)},${num(y2)} `
        + `L${num(i2.x)},${num(i2.y)} `
        + `A${num(r)},${num(r)} 0 ${large} 0 ${num(i1.x)},${num(i1.y)} Z`;
    const text = `${s.label}: ${s.value} (${(s.frac * 100).toFixed(1)}%)`;
    const props = markProps(
      { d, fill: color, stroke: sliceStroke, 'stroke-width': 1, class: sliceClass },
      tooltip, text, { type: 'pie', label: s.label, value: s.value });
    slices.push(titles ? ['path', props, ['title', {}, text]] : ['path', props]);
  }

  // Legend.
  const legendX = 2 * R + 50;
  let legendW = 120;
  const legend = ast.slices.map((s, i) => {
    const y = 40 + i * 24;
    const label = `${s.label} (${(s.frac * 100).toFixed(1)}%)`;
    legendW = Math.max(legendW, textWidth(label, fs) + 30);
    return group({ class: legendClass }, [
      rect(legendX, y, 14, 14, { fill: palette[i % palette.length] }),
      textAt(legendX + 20, y + 12, label, fs, { fill: textColor }),
    ]);
  });

  const children = [];
  if (ast.title) {
    children.push(textAt(cx, 24, ast.title, fs + 2, { 'font-weight': 'bold', 'text-anchor': 'middle', fill: textColor }));
  }
  children.push(...slices, ...legend);
  const width = legendX + legendW + 20;
  const height = 2 * R + 70;
  return svgRoot(rootClass, width, height, theme, children, keyPrefix + hash);
}
