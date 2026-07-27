//@ts-check
/**
 * @file The shared cartesian chrome: plot frame, axes, grid, legend and
 * title, rendered from an AST's tick lists. Chart types append their
 * marks inside the returned plot rect. All positions arrive in unit
 * space (`pos`/`u`/`v` in [0,1], `v = 0` at the domain minimum, drawn
 * at the plot bottom); pixel mapping happens only here and in the
 * callers' mark loops.
 */

import { line as svgLine, textAt, textWidth, num } from '@jarenjs/view/helpers';
import { seriesColor } from './palette.js';

export const FS_TICK = 11;
export const FS_LABEL = 12;
export const FS_TITLE = 15;

/**
 * Resolve a mark color: semantic tone first, series palette otherwise.
 * @param {{tokens: Record<string,string>}} theme
 * @param {'win'|'loss'|null|undefined} tone
 * @param {number} i series index
 * @param {readonly string[]} [palette]
 * @returns {string}
 */
export function toneColor(theme, tone, i, palette) {
  if (tone === 'win') return theme.tokens.win;
  if (tone === 'loss') return theme.tokens.loss;
  return seriesColor(i, palette);
}

/**
 * Truncate a label so it fits `maxWidth` at `fontSize`, appending an
 * ellipsis when anything was cut.
 * @param {string} label
 * @param {number} maxWidth
 * @param {number} fontSize
 * @returns {string}
 */
export function fitLabel(label, maxWidth, fontSize) {
  if (textWidth(label, fontSize) <= maxWidth) return label;
  let end = label.length;
  while (end > 1 && textWidth(label.slice(0, end) + '…', fontSize) > maxWidth)
    end--;
  return label.slice(0, end) + '…';
}

/**
 * The chart title `<text>`: bold, centred on `x`, carrying the
 * `chart-title` class the chart stylesheet hooks. Every chart type places
 * its own title — the anchor point and size are part of each type's
 * layout — so those stay the caller's, and only the styling is shared.
 * @param {number} x anchor (the title centres on it)
 * @param {number} y baseline
 * @param {string} text
 * @param {number} fontSize
 * @param {Record<string,string>} tokens the resolved theme tokens
 * @returns {any}
 */
export function chartTitle(x, y, text, fontSize, tokens) {
  return textAt(x, y, text, fontSize,
    { 'font-weight': 'bold', 'text-anchor': 'middle', fill: tokens.text, class: 'chart-title' });
}

/**
 * @typedef {{name: string, swatch?: number, tone?: 'win'|'loss'|null}} LegendEntry
 */

/**
 * The legend swatch row, laid out right-to-left from `right` so the last
 * entry ends at the plot's right edge. Returns the vnodes rather than
 * drawing, so a chart with no cartesian frame at all (the map) can place
 * the same row itself.
 * @param {LegendEntry[]} legend
 * @param {number} right the x the row ends at
 * @param {number} y the swatches' top edge
 * @param {{tokens: Record<string,string>}} theme
 * @param {readonly string[]} [palette]
 * @returns {any[]}
 */
export function legendRow(legend, right, y, theme, palette) {
  let x = right;
  const entries = [];
  for (let i = legend.length - 1; i >= 0; i--) {
    const entry = legend[i];
    const label = entry.name;
    const w = Math.ceil(textWidth(label, FS_TICK));
    x -= w + 4;
    entries.push(textAt(x + 14, y + 9, label, FS_TICK, { fill: theme.tokens.muted, class: 'chart-tick' }));
    x -= 14;
    entries.push(['rect', {
      x: num(x), y: num(y), width: 10, height: 10,
      fill: toneColor(theme, entry.tone, entry.swatch ?? i, palette),
      class: 'chart-swatch',
    }]);
    x -= 14;
  }
  return entries;
}

/**
 * @typedef {{ticks: {pos: number, label: string}[], label?: string|null}} AxisAST
 */

/**
 * Compute the plot frame and render the chart chrome.
 * @param {object} params
 * @param {string|null} [params.title]
 * @param {{name: string, swatch?: number, tone?: 'win'|'loss'|null}[]|null} [params.legend]
 * @param {AxisAST} [params.xAxis] ticks along the bottom edge
 * @param {AxisAST} [params.yAxis] ticks along the left edge
 * @param {'x'|'y'|'xy'|'none'} [params.grid] which tick sets draw grid lines
 * @param {number} [params.width]
 * @param {number} [params.plotHeight]
 * @param {readonly string[]} [params.palette]
 * @param {{tokens: Record<string,string>}} params.theme
 * @returns {{width: number, height: number, plot: {x:number,y:number,w:number,h:number}, children: any[]}}
 */
export function cartesianFrame(params) {
  const t = params.theme.tokens;
  const width = params.width ?? 560;
  const xAxis = params.xAxis ?? { ticks: [] };
  const yAxis = params.yAxis ?? { ticks: [] };
  const grid = params.grid ?? 'y';
  const legend = params.legend ?? null;
  const yTickW = Math.max(0, ...yAxis.ticks.map((tk) => textWidth(tk.label, FS_TICK)));
  const left = Math.ceil(Math.max(30, Math.min(230, yTickW) + 14)) + (yAxis.label ? 18 : 0);
  const top = (params.title ? 34 : 14) + (legend !== null && legend.length !== 0 ? 22 : 0);
  const right = 16;
  const bottom = 32 + (xAxis.label ? 18 : 0);
  const plotH = params.plotHeight ?? 220;
  const height = top + plotH + bottom;
  const plot = { x: left, y: top, w: width - left - right, h: plotH };
  const children = [];

  if (params.title) {
    children.push(chartTitle(width / 2, 22, params.title, FS_TITLE, t));
  }

  if (legend !== null && legend.length !== 0) {
    children.push(...legendRow(legend, plot.x + plot.w, plot.y - 10, params.theme, params.palette));
  }

  for (const tick of yAxis.ticks) {
    const y = plot.y + (1 - tick.pos) * plot.h;
    if (grid === 'y' || grid === 'xy')
      children.push(svgLine(plot.x, y, plot.x + plot.w, y, { stroke: t.grid, 'stroke-width': 1, class: 'chart-grid' }));
    children.push(textAt(plot.x - 6, y + 4, fitLabel(tick.label, 230, FS_TICK), FS_TICK,
      { 'text-anchor': 'end', fill: t.muted, class: 'chart-tick' }));
  }
  for (const tick of xAxis.ticks) {
    const x = plot.x + tick.pos * plot.w;
    if (grid === 'x' || grid === 'xy')
      children.push(svgLine(x, plot.y, x, plot.y + plot.h, { stroke: t.grid, 'stroke-width': 1, class: 'chart-grid' }));
    children.push(textAt(x, plot.y + plot.h + 16,
      fitLabel(tick.label, Math.max(40, plot.w / Math.max(1, xAxis.ticks.length) - 8), FS_TICK), FS_TICK,
      { 'text-anchor': 'middle', fill: t.muted, class: 'chart-tick' }));
  }

  children.push(svgLine(plot.x, plot.y, plot.x, plot.y + plot.h, { stroke: t.axis, 'stroke-width': 1, class: 'chart-axis' }));
  children.push(svgLine(plot.x, plot.y + plot.h, plot.x + plot.w, plot.y + plot.h, { stroke: t.axis, 'stroke-width': 1, class: 'chart-axis' }));

  if (xAxis.label) {
    children.push(textAt(plot.x + plot.w / 2, height - 8, xAxis.label, FS_LABEL,
      { 'text-anchor': 'middle', fill: t.muted, class: 'chart-axis-label' }));
  }
  if (yAxis.label) {
    children.push(['text', {
      x: 0, y: 0, 'font-size': FS_LABEL, fill: t.muted, 'text-anchor': 'middle',
      transform: `rotate(-90) translate(${num(-(plot.y + plot.h / 2))} 12)`,
      class: 'chart-axis-label',
    }, String(yAxis.label)]);
  }

  return { width, height, plot, children };
}

/**
 * Stamp accessibility onto a finished chart svg vnode: an `aria-label`
 * (the title) and a leading `<title>` child for hover text. `svgRoot`
 * already sets `role="img"`.
 * @param {any} svg the `['svg', props, …]` vnode (mutated in place)
 * @param {string|null|undefined} label
 * @returns {any} the same vnode
 */
export function annotateChart(svg, label) {
  if (label) {
    svg[1]['aria-label'] = String(label);
    svg.splice(2, 0, ['title', {}, String(label)]);
  }
  return svg;
}
