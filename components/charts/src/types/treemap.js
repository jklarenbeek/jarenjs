//@ts-check
/**
 * @file The treemap chart type: part-of-whole tiles by area, laid out
 * with the squarified algorithm (rows chosen to keep tile aspect ratios
 * near 1). Data shape:
 *
 *   data   = { items: [{ label, value }] }
 *   config = { type:'treemap', title?, aspect? }
 *
 * The AST is a flat list of unit-square tiles (`x0..x1`/`y0..y1` in
 * [0,1], `y` growing downward — a treemap has no axes, so reading order
 * wins). Squarification optimizes *rendered* aspect ratios, so the
 * build needs the drawing's width:height ratio — that is `aspect`
 * (default 1.6), carried in the AST so the render maps height from
 * width with the same value.
 */

import { svgRoot, textAt, textWidth } from '@jarenjs/view/helpers';
import { FS_LABEL, annotateChart } from '../core/cartesian.js';
import { CATEGORICAL, seriesColor, inkFor } from '../core/palette.js';

/**
 * @typedef {object} TreemapTileAST
 * @property {string} label
 * @property {number} value
 * @property {number} frac fraction of the total (0..1)
 * @property {number} x0 @property {number} y0
 * @property {number} x1 @property {number} y1
 */
/**
 * @typedef {object} TreemapAST
 * @property {'treemap'} type
 * @property {string|null} title
 * @property {number} aspect layout width:height ratio
 * @property {number} total
 * @property {TreemapTileAST[]} tiles value-descending
 */

/**
 * Build the geometry-free treemap AST.
 * @param {any} data
 * @param {any} [config]
 * @returns {TreemapAST}
 */
export function buildTreemapAST(data, config = {}) {
  const aspect = typeof config.aspect === 'number' && Number.isFinite(config.aspect) && config.aspect > 0
    ? config.aspect : 1.6;
  const input = (data?.items ?? [])
    .filter((item) => typeof item?.value === 'number' && Number.isFinite(item.value) && item.value > 0)
    .map((item) => ({ label: String(item.label ?? ''), value: item.value }))
    .sort((a, b) => b.value - a.value);
  const total = input.reduce((s, item) => s + item.value, 0);

  const tiles = [];
  if (total > 0) {
    // Squarify in aspect-scaled space (width = aspect, height = 1, area
    // = aspect) so the optimized ratios are the ratios the reader sees.
    const areas = input.map((item) => (item.value / total) * aspect);
    let x = 0;
    let y = 0;
    let w = aspect;
    let h = 1;
    let start = 0;
    while (start < areas.length) {
      // Grow the row while the worst tile aspect ratio keeps improving.
      const side = Math.min(w, h);
      let sum = areas[start];
      let best = worst(areas, start, start + 1, sum, side);
      let end = start + 1;
      while (end < areas.length) {
        const nextSum = sum + areas[end];
        const nextWorst = worst(areas, start, end + 1, nextSum, side);
        if (nextWorst > best) break;
        sum = nextSum;
        best = nextWorst;
        end++;
      }
      // Lay the row along the shorter side.
      const thickness = sum / side;
      let offset = 0;
      for (let i = start; i < end; i++) {
        const length = areas[i] / thickness;
        const tile = w <= h
          ? { x0: x + offset, y0: y, x1: x + offset + length, y1: y + thickness }
          : { x0: x, y0: y + offset, x1: x + thickness, y1: y + offset + length };
        tiles.push({
          label: input[i].label,
          value: input[i].value,
          frac: input[i].value / total,
          // Clamped: row arithmetic can land an epsilon outside [0,1].
          x0: clamp01(tile.x0 / aspect), y0: clamp01(tile.y0),
          x1: clamp01(tile.x1 / aspect), y1: clamp01(tile.y1),
        });
        offset += length;
      }
      if (w <= h) { y += thickness; h -= thickness; }
      else { x += thickness; w -= thickness; }
      start = end;
    }
  }

  return {
    type: 'treemap',
    title: config.title ?? null,
    aspect,
    total,
    tiles,
  };
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Worst (max) tile aspect ratio of the row `areas[start..end)` with
 * total area `sum` laid along a side of length `side`.
 */
function worst(areas, start, end, sum, side) {
  const thickness = sum / side;
  let max = 0;
  for (let i = start; i < end; i++) {
    const length = areas[i] / thickness;
    const ratio = Math.max(length / thickness, thickness / length);
    if (ratio > max) max = ratio;
  }
  return max;
}

/**
 * Render a treemap AST to a pure-vnode SVG: inset tile rects on the
 * categorical palette, labels inside the tiles that fit them (ink
 * picked by fill luminance), and a label+share `<title>` on every tile.
 * @param {TreemapAST} ast
 * @param {{tokens: Record<string,string>, cssVars: Record<string,string>}} theme
 * @param {string} hash
 * @param {{rootClass?: string, keyPrefix?: string, palette?: readonly string[], width?: number}} [options]
 * @returns {any}
 */
export function renderTreemapAST(ast, theme, hash, options = {}) {
  const t = theme.tokens;
  const palette = options.palette ?? CATEGORICAL;
  const width = options.width ?? 560;
  const top = ast.title ? 34 : 8;
  const plotW = width - 16;
  const plotH = plotW / ast.aspect;
  const children = [];

  if (ast.title) {
    children.push(textAt(width / 2, 22, ast.title, 15,
      { 'font-weight': 'bold', 'text-anchor': 'middle', fill: t.text, class: 'chart-title' }));
  }

  const inset = 1;
  for (let i = 0; i < ast.tiles.length; i++) {
    const tile = ast.tiles[i];
    const x = 8 + tile.x0 * plotW + inset;
    const y = top + tile.y0 * plotH + inset;
    const w = (tile.x1 - tile.x0) * plotW - 2 * inset;
    const h = (tile.y1 - tile.y0) * plotH - 2 * inset;
    const fill = seriesColor(i, palette);
    const share = `${(tile.frac * 100).toFixed(1)}%`;
    children.push(['rect', {
      x: round2(x), y: round2(y),
      width: round2(Math.max(0.5, w)), height: round2(Math.max(0.5, h)),
      fill, class: 'chart-treemap-tile',
    }, ['title', {}, `${tile.label}: ${tile.value} (${share})`]]);
    if (h >= FS_LABEL + 8 && textWidth(tile.label, FS_LABEL) <= w - 8) {
      children.push(textAt(round2(x + 4), round2(y + FS_LABEL + 2), tile.label, FS_LABEL,
        { fill: inkFor(fill), class: 'chart-treemap-label' }));
    }
  }

  const height = top + plotH + 8;
  const svg = svgRoot(options.rootClass ?? 'chart chart-svg chart-treemap-chart',
    width, height, theme, children, (options.keyPrefix ?? 'tree-') + hash);
  return annotateChart(svg, ast.title);
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
