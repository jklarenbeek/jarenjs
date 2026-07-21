//@ts-check
/**
 * @file The pie chart type, split into the geometry-free AST build and
 * the SVG render (the two-stage contract every chart type follows).
 * This is the extraction of the mermaid pie: `@jarenjs/mermaid` now
 * delegates its `pie` diagrams here, passing its own class names,
 * palette and theme through `render` options so its output is unchanged
 * — charts never imports mermaid (the dependency arrow is one-way).
 */

import { svgRoot, rect, path, group, textAt, num, textWidth } from '@jarenjs/view/helpers';
import { CATEGORICAL } from '../core/palette.js';

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
 * @property {PieSliceAST[]} slices
 */

/**
 * Build the geometry-free pie AST: labels/values → fractions and
 * accumulated start/end angles, starting at 12 o'clock.
 * @param {{slices?: {label: string, value: number}[]}} data
 * @param {{title?: string|null}} [config]
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
  return {
    type: 'pie',
    title: config.title ?? null,
    total,
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
 */

/**
 * Render a pie AST to a pure-vnode SVG: angles → arc paths, plus a
 * swatch legend with percentages and an optional title.
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
  const fs = 14;
  const R = 130;
  const cx = R + 20;
  const cy = R + 40;
  const slices = [];
  for (let i = 0; i < ast.slices.length; i++) {
    const s = ast.slices[i];
    const x1 = cx + R * Math.cos(s.start);
    const y1 = cy + R * Math.sin(s.start);
    const x2 = cx + R * Math.cos(s.end);
    const y2 = cy + R * Math.sin(s.end);
    const large = s.frac > 0.5 ? 1 : 0;
    const color = palette[i % palette.length];
    slices.push(path(
      `M${num(cx)},${num(cy)} L${num(x1)},${num(y1)} A${R},${R} 0 ${large} 1 ${num(x2)},${num(y2)} Z`,
      { fill: color, stroke: sliceStroke, 'stroke-width': 1, class: sliceClass }));
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
