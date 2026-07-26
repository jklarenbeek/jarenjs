//@ts-check
/**
 * @file The treemap chart type: part-of-whole tiles by area, laid out
 * with the squarified algorithm (rows chosen to keep tile aspect ratios
 * near 1). Data shape:
 *
 *   data   = { items: [{ label, value }] }                  // flat
 *   data   = { items: [{ label, children: [{label, value}] }] }  // grouped
 *   config = { type:'treemap', title?, aspect? }
 *
 * The AST is a flat list of unit-square tiles (`x0..x1`/`y0..y1` in
 * [0,1], `y` growing downward — a treemap has no axes, so reading order
 * wins). Squarification optimizes *rendered* aspect ratios, so the
 * build needs the drawing's width:height ratio — that is `aspect`
 * (default 1.6), carried in the AST so the render maps height from
 * width with the same value.
 *
 * One level of grouping is supported: an item with `children` is a
 * group whose value is its children's sum. Groups squarify against each
 * other, then each group's children squarify inside its rect below a
 * header band that names it — the package→module reading. Groups take a
 * palette color each, so a group is one hue and its children are told
 * apart by the hairline between them. A childless item in a grouped
 * chart becomes a group of one, so no data is dropped either way; a
 * chart with no `children` anywhere lays out exactly as it always has.
 */

import { svgRoot, textAt, textWidth, coord } from '@jarenjs/view/helpers';
import { clamp01 } from '@jarenjs/core/math';
import { FS_LABEL, annotateChart, chartTitle, fitLabel } from '../core/cartesian.js';
import { CATEGORICAL, seriesColor, inkFor } from '../core/palette.js';
import { normalizeTooltip, valueMark } from '../core/marks.js';

/**
 * @typedef {object} TreemapTileAST
 * @property {string} label
 * @property {number} value
 * @property {number} frac fraction of the total (0..1)
 * @property {number} x0 @property {number} y0
 * @property {number} x1 @property {number} y1
 * @property {string|null} group the group this tile belongs to (null when flat)
 * @property {number} swatch palette index for the fill
 */
/**
 * @typedef {object} TreemapGroupAST
 * @property {string} label
 * @property {number} value the children's sum
 * @property {number} frac fraction of the total (0..1)
 * @property {number} x0 @property {number} y0
 * @property {number} x1 @property {number} y1
 * @property {number} header height of the naming band at the group's top
 *  (a fraction of the map height; the children fill what is left)
 * @property {number} swatch palette index
 */
/**
 * @typedef {object} TreemapAST
 * @property {'treemap'} type
 * @property {string|null} title
 * @property {number} aspect layout width:height ratio
 * @property {number} total
 * @property {TreemapTileAST[]} tiles value-descending, grouped when
 *  `groups` is non-empty (descending inside each group)
 * @property {TreemapGroupAST[]} groups empty for a flat treemap
 */

/**
 * The naming band at a group's top, as a fraction of the map height —
 * at the default 560×340 drawing, ~20px, room for a 12px label. It is
 * a fraction because the build has no pixels: a short group's band is
 * capped at a third of its own height, and the render leaves a band
 * that ends up too small for the text empty rather than overprinting
 * it (the group's name is still in every child's hover text).
 */
const HEADER_FRAC = 0.06;

/**
 * Build the geometry-free treemap AST.
 * @param {any} data
 * @param {any} [config]
 * @returns {TreemapAST}
 */
export function buildTreemapAST(data, config = {}) {
  const aspect = typeof config.aspect === 'number' && Number.isFinite(config.aspect) && config.aspect > 0
    ? config.aspect : 1.6;
  const items = data?.items ?? [];
  const grouped = items.some((item) => Array.isArray(item?.children));
  return grouped
    ? buildGrouped(items, aspect, config)
    : buildFlat(leavesOf(items), aspect, config);
}

/** The positive-valued `{label, value}` leaves of a list, descending. */
function leavesOf(items) {
  return items
    .filter((item) => typeof item?.value === 'number' && Number.isFinite(item.value) && item.value > 0)
    .map((item) => ({ label: String(item.label ?? ''), value: item.value }))
    .sort((a, b) => b.value - a.value);
}

/** A flat treemap: every leaf squarified against every other. */
function buildFlat(input, aspect, config) {
  const total = input.reduce((s, item) => s + item.value, 0);
  const tiles = [];
  if (total > 0) {
    // Squarify in aspect-scaled space (width = aspect, height = 1, area
    // = aspect) so the optimized ratios are the ratios the reader sees.
    const rects = squarify(input.map((item) => (item.value / total) * aspect), 0, 0, aspect, 1);
    for (let i = 0; i < input.length; i++) {
      tiles.push({
        label: input[i].label,
        value: input[i].value,
        frac: input[i].value / total,
        ...unitRect(rects[i], aspect),
        group: null,
        swatch: i,
      });
    }
  }
  return { type: 'treemap', title: config.title ?? null, aspect, total, tiles, groups: [] };
}

/**
 * A grouped treemap: groups squarified against each other, each
 * group's children squarified below its header band.
 */
function buildGrouped(items, aspect, config) {
  const input = [];
  for (const item of items) {
    // a childless item is a group of one, so nothing is dropped
    const children = Array.isArray(item?.children) ? leavesOf(item.children) : leavesOf([item]);
    if (children.length === 0) continue;
    input.push({
      label: String(item?.label ?? ''),
      children,
      value: children.reduce((s, c) => s + c.value, 0),
    });
  }
  input.sort((a, b) => b.value - a.value);
  const total = input.reduce((s, g) => s + g.value, 0);

  const tiles = [];
  const groups = [];
  if (total > 0) {
    const rects = squarify(input.map((g) => (g.value / total) * aspect), 0, 0, aspect, 1);
    for (let gi = 0; gi < input.length; gi++) {
      const group = input[gi];
      const rect = rects[gi];
      const height = rect.y1 - rect.y0;
      // never eat more than a third of a short group's own height
      const header = Math.min(HEADER_FRAC, height / 3);
      const inner = { x0: rect.x0, y0: rect.y0 + header, x1: rect.x1, y1: rect.y1 };
      groups.push({
        label: group.label,
        value: group.value,
        frac: group.value / total,
        ...unitRect(rect, aspect),
        header,
        swatch: gi,
      });
      const area = (inner.x1 - inner.x0) * (inner.y1 - inner.y0);
      const childRects = squarify(
        group.children.map((c) => (c.value / group.value) * area),
        inner.x0, inner.y0, inner.x1 - inner.x0, inner.y1 - inner.y0);
      for (let ci = 0; ci < group.children.length; ci++) {
        tiles.push({
          label: group.children[ci].label,
          value: group.children[ci].value,
          frac: group.children[ci].value / total,
          ...unitRect(childRects[ci], aspect),
          group: group.label,
          swatch: gi,
        });
      }
    }
  }
  return { type: 'treemap', title: config.title ?? null, aspect, total, tiles, groups };
}

/**
 * Squarify `areas` (summing to `w * h`) into the rect at `x, y` in
 * aspect-scaled space, returning one rect per area in input order.
 * @param {number[]} areas @param {number} x @param {number} y
 * @param {number} w @param {number} h
 * @returns {{x0:number,y0:number,x1:number,y1:number}[]}
 */
function squarify(areas, x, y, w, h) {
  const rects = [];
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
      rects.push(w <= h
        ? { x0: x + offset, y0: y, x1: x + offset + length, y1: y + thickness }
        : { x0: x, y0: y + offset, x1: x + thickness, y1: y + offset + length });
      offset += length;
    }
    if (w <= h) { y += thickness; h -= thickness; }
    else { x += thickness; w -= thickness; }
    start = end;
  }
  return rects;
}

/**
 * An aspect-scaled rect as unit-square coordinates. Clamped: row
 * arithmetic can land an epsilon outside [0,1].
 */
function unitRect(rect, aspect) {
  return {
    x0: clamp01(rect.x0 / aspect), y0: clamp01(rect.y0),
    x1: clamp01(rect.x1 / aspect), y1: clamp01(rect.y1),
  };
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
 * A grouped treemap adds the group's name in its header band and a
 * hairline between same-hue siblings — both only when there are groups,
 * so a flat treemap renders exactly as it did before grouping existed.
 * @param {TreemapAST} ast
 * @param {{tokens: Record<string,string>, cssVars: Record<string,string>}} theme
 * @param {string} hash
 * @param {{rootClass?: string, keyPrefix?: string, palette?: readonly string[], width?: number,
 *   tooltip?: import('../core/marks.js').ChartTooltipSpec}} [options]
 * @returns {any}
 */
export function renderTreemapAST(ast, theme, hash, options = {}) {
  const t = theme.tokens;
  const palette = options.palette ?? CATEGORICAL;
  const tooltip = normalizeTooltip(options.tooltip);
  const width = options.width ?? 560;
  const top = ast.title ? 34 : 8;
  const plotW = width - 16;
  const plotH = plotW / ast.aspect;
  const children = [];

  if (ast.title) {
    children.push(chartTitle(width / 2, 22, ast.title, 15, t));
  }

  const inset = 1;
  const nested = ast.groups.length !== 0;

  for (const group of ast.groups) {
    const y = top + group.y0 * plotH;
    const headerH = group.header * plotH;
    if (headerH < FS_LABEL + 2) continue;
    const label = `${group.label} (${(group.frac * 100).toFixed(1)}%)`;
    const x = 8 + group.x0 * plotW;
    const w = (group.x1 - group.x0) * plotW;
    children.push(textAt(coord(x + 3), coord(y + FS_LABEL), fitLabel(label, w - 6, FS_LABEL), FS_LABEL,
      { fill: t.text, 'font-weight': 'bold', class: 'chart-treemap-group' }));
  }

  for (let i = 0; i < ast.tiles.length; i++) {
    const tile = ast.tiles[i];
    const x = 8 + tile.x0 * plotW + inset;
    const y = top + tile.y0 * plotH + inset;
    const w = (tile.x1 - tile.x0) * plotW - 2 * inset;
    const h = (tile.y1 - tile.y0) * plotH - 2 * inset;
    const fill = seriesColor(tile.swatch, palette);
    const share = `${(tile.frac * 100).toFixed(1)}%`;
    children.push(valueMark('rect', nested
      ? {
        x: coord(x), y: coord(y),
        width: coord(Math.max(0.5, w)), height: coord(Math.max(0.5, h)),
        // siblings share the group's hue, so they need a seam
        fill, stroke: t.sliceStroke, 'stroke-width': 1, class: 'chart-treemap-tile',
      }
      : {
        x: coord(x), y: coord(y),
        width: coord(Math.max(0.5, w)), height: coord(Math.max(0.5, h)),
        fill, class: 'chart-treemap-tile',
      },
    tooltip, tile.group === null
      ? `${tile.label}: ${tile.value} (${share})`
      : `${tile.group} / ${tile.label}: ${tile.value} (${share})`,
    { type: 'treemap', label: tile.label, group: tile.group, value: tile.value }));
    if (h >= FS_LABEL + 8 && textWidth(tile.label, FS_LABEL) <= w - 8) {
      children.push(textAt(coord(x + 4), coord(y + FS_LABEL + 2), tile.label, FS_LABEL,
        { fill: inkFor(fill), class: 'chart-treemap-label' }));
    }
  }

  const height = top + plotH + 8;
  const svg = svgRoot(options.rootClass ?? 'chart chart-svg chart-treemap-chart',
    width, height, theme, children, (options.keyPrefix ?? 'tree-') + hash);
  return annotateChart(svg, ast.title);
}
