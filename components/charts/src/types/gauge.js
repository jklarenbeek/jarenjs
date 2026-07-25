//@ts-check
/**
 * @file The gauge chart type: a single value on a semicircular dial —
 * the "how full is it" headline mark. Data shape:
 *
 *   data   = { value: number }
 *   config = { type:'gauge', title?, min?, max?, unit?, tone? }
 *
 * The domain is `[min, max]` (0..100 when unset); the AST carries the
 * clamped fill fraction and tick fractions only — the dial radius and
 * stroke widths are render decisions. `tone` colors the fill through
 * the semantic win/loss pair; the default is the first categorical
 * anchor (the brand blue).
 */

import {
  svgRoot, path as svgPath, line as svgLine, textAt, coord, anchorForAngle,
} from '@jarenjs/view/helpers';
import { clamp01 } from '@jarenjs/core/math';
import { axisTicksLinear, formatTickValue } from '../core/axis.js';
import { FS_TICK, toneColor, annotateChart, chartTitle } from '../core/cartesian.js';
import { CATEGORICAL } from '../core/palette.js';

/**
 * @typedef {object} GaugeAST
 * @property {'gauge'} type
 * @property {string|null} title
 * @property {number} value
 * @property {string|null} unit
 * @property {number} min @property {number} max
 * @property {number} frac clamped fill fraction (0..1)
 * @property {{frac: number, label: string}[]} ticks
 * @property {'win'|'loss'|null} tone
 */

/**
 * Build the geometry-free gauge AST.
 * @param {any} data
 * @param {any} [config]
 * @returns {GaugeAST}
 */
export function buildGaugeAST(data, config = {}) {
  const raw = data?.value;
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  let min = typeof config.min === 'number' && Number.isFinite(config.min) ? config.min : 0;
  let max = typeof config.max === 'number' && Number.isFinite(config.max) ? config.max : 100;
  if (max <= min) max = min + 1;
  const frac = clamp01((value - min) / (max - min));
  const ticks = axisTicksLinear(min, max, 4).map((v) => ({
    frac: clamp01((v - min) / (max - min)),
    label: formatTickValue(v),
  }));
  return {
    type: 'gauge',
    title: config.title ?? null,
    value,
    unit: config.unit ?? null,
    min,
    max,
    frac,
    ticks,
    tone: config.tone === 'win' || config.tone === 'loss' ? config.tone : null,
  };
}

/**
 * Render a gauge AST to a pure-vnode SVG: a semicircular track, the
 * value arc over it, outward tick marks with labels, and the value as
 * the headline figure in the dial's mouth.
 * @param {GaugeAST} ast
 * @param {{tokens: Record<string,string>, cssVars: Record<string,string>}} theme
 * @param {string} hash
 * @param {{rootClass?: string, keyPrefix?: string, palette?: readonly string[]}} [options]
 * @returns {any}
 */
export function renderGaugeAST(ast, theme, hash, options = {}) {
  const t = theme.tokens;
  const palette = options.palette ?? CATEGORICAL;
  const R = 110;
  const stroke = 18;
  const pad = 46;
  const cx = pad + R;
  const top = ast.title ? 40 : 16;
  const cy = top + R + stroke / 2;
  const children = [];

  if (ast.title) {
    children.push(chartTitle(cx, 24, ast.title, 15, t));
  }

  // Dial angles run π (left) → 2π (right); the fill sweeps clockwise.
  const angleAt = (frac) => Math.PI + frac * Math.PI;
  const pointAt = (frac, r) => {
    const a = angleAt(frac);
    return [coord(cx + r * Math.cos(a)), coord(cy + r * Math.sin(a))];
  };
  const arcPath = (f0, f1) => {
    const [x0, y0] = pointAt(f0, R);
    const [x1, y1] = pointAt(f1, R);
    return `M${x0},${y0} A${R},${R} 0 0 1 ${x1},${y1}`;
  };

  children.push(svgPath(arcPath(0, 1),
    { fill: 'none', stroke: t.grid, 'stroke-width': stroke, class: 'chart-gauge-track' }));
  if (ast.frac > 0) {
    children.push(svgPath(arcPath(0, ast.frac),
      { fill: 'none', stroke: toneColor(theme, ast.tone, 0, palette), 'stroke-width': stroke, class: 'chart-gauge-fill' }));
  }

  for (const tick of ast.ticks) {
    const [x0, y0] = pointAt(tick.frac, R + stroke / 2 + 2);
    const [x1, y1] = pointAt(tick.frac, R + stroke / 2 + 8);
    children.push(svgLine(x0, y0, x1, y1, { stroke: t.axis, 'stroke-width': 1, class: 'chart-axis' }));
    const [lx, ly] = pointAt(tick.frac, R + stroke / 2 + 12);
    const anchor = anchorForAngle(angleAt(tick.frac));
    children.push(textAt(lx, ly + (anchor === 'middle' ? -2 : 4), tick.label, FS_TICK,
      { 'text-anchor': anchor, fill: t.muted, class: 'chart-tick' }));
  }

  // The headline figure inside the dial's mouth.
  const valueText = formatTickValue(ast.value) + (ast.unit ? ` ${ast.unit}` : '');
  children.push(textAt(cx, cy - 8, valueText, 30,
    { 'font-weight': 'bold', 'text-anchor': 'middle', fill: t.text, class: 'chart-gauge-value' }));

  const width = 2 * (pad + R);
  const height = cy + 24;
  const svg = svgRoot(options.rootClass ?? 'chart chart-svg chart-gauge-chart',
    width, height, theme, children, (options.keyPrefix ?? 'gauge-') + hash);
  return annotateChart(svg, ast.title ?? valueText);
}
