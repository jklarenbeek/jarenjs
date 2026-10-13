//@ts-check
/**
 * @file The treemap chart type: part-of-whole tiles by area, laid out
 * with the squarified algorithm (rows chosen to keep tile aspect ratios
 * near 1). Data shape:
 *
 *   data   = { items: [{ label, value }] }                  // flat
 *   data   = { items: [{ label, children: [{label, value}] }] }  // grouped
 *   data   = { items: [{ label, children: [{ label, children: [...] }] }] }  // deeper
 *   config = { type:'treemap', title?, aspect? }
 *
 * The AST is a flat list of unit-square tiles (`x0..x1`/`y0..y1` in
 * [0,1], `y` growing downward — a treemap has no axes, so reading order
 * wins). Squarification optimizes *rendered* aspect ratios, so the
 * build needs the drawing's width:height ratio — that is `aspect`
 * (default 1.6), carried in the AST so the render maps height from
 * width with the same value.
 *
 * Hierarchies nest up to `MAX_TREEMAP_DEPTH` levels. An item with `children` is a group
 * whose value is its children's sum, and a child may itself be a group.
 * Siblings (leaves and groups alike) squarify against each other, then
 * each group's children squarify inside its rect below a header band
 * that names it — the package→module reading. Groups take a palette
 * color each at the top level and everything beneath one shares its
 * hue, so a subtree reads as one block and its leaves are told apart by
 * the hairline between them. A childless item in a grouped chart becomes
 * a group of one, so no data is dropped either way; a chart with no
 * `children` anywhere lays out exactly as it always has.
 *
 * Two budgets keep a deep tree legible. The naming bands on the way
 * from a top-level group down to any leaf total at most a third of that
 * group's height (a nested group past the budget has no band, and its
 * name is still in every leaf's hover text). And a nested group whose rect covers under
 * `MIN_SUBTREE_AREA` of the map (1%) is too small to read as parts: it
 * collapses into its parent and is laid as the one leaf it sums to.
 * Top-level groups always keep their children. Groups nest at most
 * `MAX_TREEMAP_DEPTH` (64) levels deep; deeper data throws a `CodedError`
 * `CH0001` naming the group's JSON Pointer.
 */

import { svgRoot, textAt, textWidth, coord } from '@jarenjs/view/helpers';
import { clamp01 } from '@jarenjs/core/math';
import { CodedError } from '@jarenjs/core/errors';
import { FS_LABEL, annotateChart, chartTitle, fitLabel } from '../core/cartesian.js';
import { measurableUnit } from '../core/domain.js';
import { CATEGORICAL, seriesColor, inkFor } from '../core/palette.js';
import { normalizeTooltip, valueMark } from '../core/marks.js';

/**
 * @typedef {object} TreemapTileAST
 * @property {string} label
 * @property {number} value
 * @property {number} frac fraction of the total (0..1)
 * @property {number} x0 @property {number} y0
 * @property {number} x1 @property {number} y1
 * @property {string|null} group the group this tile sits directly in (null when flat)
 * @property {string[]} [path] the labels of every group above the tile,
 *  outermost first (empty when flat; its last entry is `group`); absent
 *  in an AST built before groups could nest, which the render reads as
 *  `[group]`
 * @property {number} swatch palette index for the fill: the top-level
 *  group's, shared by everything beneath it
 */
/**
 * @typedef {object} TreemapGroupAST
 * @property {string} label
 * @property {number} value the children's sum (`Infinity` past the largest double)
 * @property {number} frac fraction of the total (0..1)
 * @property {number} x0 @property {number} y0
 * @property {number} x1 @property {number} y1
 * @property {number} header height of the naming band at the group's top
 *  (a fraction of the map height; the children fill what is left; 0 for a
 *  nested group past its top-level group's header budget)
 * @property {number} [depth] 0 for a top-level group, 1 for a group in one,
 *  ...; absent in an AST built before groups could nest
 * @property {number} swatch palette index
 */
/**
 * @typedef {object} TreemapAST
 * @property {'treemap'} type
 * @property {string|null} title
 * @property {number} aspect layout width:height ratio
 * @property {number} total the leaves' sum; `Infinity` when it passes the
 *  largest double, which the fractions do not
 * @property {TreemapTileAST[]} tiles value-descending, grouped when
 *  `groups` is non-empty (descending inside each group, a collapsed
 *  subtree standing as one tile among its siblings)
 * @property {TreemapGroupAST[]} groups every group that was subdivided,
 *  each before the groups inside it; empty for a flat treemap
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
 * The share of the map's area below which a nested group is not
 * subdivided: its parts would be too small to tell apart, so it
 * collapses into its parent and is laid as the one tile it sums to
 * (named by the group, hover text carrying the path). 1%, about a
 * 60×30px rect at the default drawing. A top-level group is never
 * collapsed.
 */
const MIN_SUBTREE_AREA = 0.01;

/**
 * The most levels of groups a treemap nests (a top-level group is the
 * first). Deeper data is refused by name, `CH0001`, rather than laid
 * out: no drawing can show it (the collapse and header budgets already
 * stop a subtree being subdivided long before) and every tile's hover
 * text repeats the path of groups above it, so the text a chart
 * carries grows with this bound.
 */
const MAX_TREEMAP_DEPTH = 64;

/**
 * Build the geometry-free treemap AST. Leaves that sum past the largest
 * double are laid out in the unit `measurableUnit` picks over all of
 * them, so tiles and groups keep the proportions of their values.
 * @param {any} data
 * @param {any} [config]
 * @returns {TreemapAST}
 * @throws {CodedError} `CH0001` when groups nest more than 64 levels deep
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

/** The `{label, value}` leaf of an item, or null when its value is not a positive finite number. */
function leafOf(item) {
  return typeof item?.value === 'number' && Number.isFinite(item.value) && item.value > 0
    ? { label: String(item.label ?? ''), value: item.value }
    : null;
}

/** The positive-valued `{label, value}` leaves of a list, descending. */
function leavesOf(items) {
  return items
    .map(leafOf)
    .filter((leaf) => leaf !== null)
    .sort((a, b) => b.value - a.value);
}

/** A flat treemap: every leaf squarified against every other. */
function buildFlat(input, aspect, config) {
  const unit = measurableUnit(input.map((item) => item.value));
  const sum = input.reduce((s, item) => s + item.value / unit, 0);
  const tiles = [];
  if (sum > 0) {
    // Squarify in aspect-scaled space (width = aspect, height = 1, area
    // = aspect) so the optimized ratios are the ratios the reader sees.
    const rects = squarify(input.map((item) => (item.value / unit / sum) * aspect), 0, 0, aspect, 1);
    for (let i = 0; i < input.length; i++) {
      tiles.push({
        label: input[i].label,
        value: input[i].value,
        frac: input[i].value / unit / sum,
        ...unitRect(rects[i], aspect),
        group: null,
        swatch: i,
      });
    }
  }
  return { type: 'treemap', title: config.title ?? null, aspect, total: sum * unit, tiles, groups: [] };
}

/**
 * A grouped treemap: siblings squarified against each other at every
 * level, each group's children squarified below its header band.
 */
function buildGrouped(items, aspect, config) {
  const { top, order, values } = readGroups(items);
  // one unit over every leaf, so the groups' sums compare
  const unit = measurableUnit(values);
  settle(order, unit);
  const groups = top.filter((g) => g.kids.length > 0).sort((a, b) => b.s - a.s);
  const sum = groups.reduce((s, g) => s + g.s, 0);
  const ctx = { aspect, unit, sum, tiles: [], groups: [] };
  if (sum > 0) {
    const rects = squarify(groups.map((g) => (g.s / sum) * aspect), 0, 0, aspect, 1);
    for (let gi = 0; gi < groups.length; gi++) placeGroups(ctx, groups[gi], rects[gi], gi);
  }
  return { type: 'treemap', title: config.title ?? null, aspect, total: sum * unit, tiles: ctx.tiles, groups: ctx.groups };
}

/**
 * The hierarchy as `{label, kids, s}` groups and `{label, value}`
 * leaves. A work list rather than recursion: a hierarchy's depth is the
 * caller's, and a deep one must not exhaust the stack. `order` lists
 * every group, each before the groups inside it; `values` every leaf's.
 * An item is a group when it has a `children` array, except that a
 * nested one with no children at all is a leaf when its own value is a
 * positive number; a group's own `value` is ignored.
 * @throws {CodedError} CH0001 when groups nest more than `MAX_TREEMAP_DEPTH` deep
 */
function readGroups(items) {
  const top = [];
  const order = [];
  const values = [];
  const work = [];
  const groupOf = (item, up, at) => {
    const group = { label: String(item?.label ?? ''), kids: [], s: 0, up, at, depth: up === null ? 0 : up.depth + 1 };
    if (group.depth >= MAX_TREEMAP_DEPTH)
      throw new CodedError('ChartError', 'CH0001',
        `a treemap nests groups at most ${MAX_TREEMAP_DEPTH} deep`, pointerOf(group));
    order.push(group);
    return group;
  };
  const add = (into, item, up, at) => {
    if (Array.isArray(item?.children) && (up === null || item.children.length > 0)) {
      const group = groupOf(item, up, at);
      into.push(group);
      work.push({ src: item.children, group });
      return;
    }
    const leaf = leafOf(item);
    if (leaf) { into.push(leaf); values.push(leaf.value); }
  };
  for (let at = 0; at < items.length; at++) {
    const item = items[at];
    if (Array.isArray(item?.children)) add(top, item, null, at);
    else {
      // a childless item is a group of one, so nothing is dropped
      const group = groupOf(item, null, at);
      top.push(group);
      add(group.kids, item, group, 0);
    }
  }
  while (work.length > 0) {
    const { src, group } = /** @type {any} */ (work.pop());
    for (let at = 0; at < src.length; at++) add(group.kids, src[at], group, at);
  }
  return { top, order, values };
}

/** The JSON Pointer from the chart's data to `group`, as its `items` and `children` indexes. */
function pointerOf(group) {
  const parts = [];
  for (let g = group; g !== null; g = g.up) parts.push(g.up === null ? `items/${g.at}` : `children/${g.at}`);
  return `/${parts.reverse().join('/')}`;
}

/**
 * Size every group in the unit, innermost first (`order` lists a group
 * before the groups inside it, so walking it backwards visits a group
 * after its children): drop the groups no leaf survived in, sort the
 * siblings descending, and sum them in that order.
 */
function settle(order, unit) {
  for (let i = order.length - 1; i >= 0; i--) {
    const group = order[i];
    group.kids = group.kids.filter((kid) => kid.kids === undefined || kid.kids.length > 0);
    for (const kid of group.kids) if (kid.kids === undefined) kid.s = kid.value / unit;
    group.kids.sort((a, b) => b.s - a.s);
    group.s = group.kids.reduce((s, kid) => s + kid.s, 0);
  }
}

/**
 * Lay the group tree below `root` into `rootRect` (aspect-scaled
 * space), depth first, on an explicit stack so a deep hierarchy cannot
 * exhaust the call stack. Each group gets its header band, then its
 * kids squarified in what is left; a nested group too small to
 * subdivide, like a leaf, becomes one tile.
 */
function placeGroups(ctx, root, rootRect, swatch) {
  const { aspect, unit, sum } = ctx;
  /**
   * Open a group: record it and squarify its kids. `budget` is what
   * the bands above it have left of the top-level group's height; the
   * frame carries what is left once this group's own band is taken.
   */
  const open = (group, rect, parent, budget) => {
    // never eat more than a third of a short group's own height, nor more
    // than the top-level group's budget has left
    const header = Math.min(HEADER_FRAC, (rect.y1 - rect.y0) / 3, budget);
    const depth = parent === null ? 0 : parent.depth + 1;
    ctx.groups.push({
      label: group.label,
      value: group.s * unit,
      frac: group.s / sum,
      ...unitRect(rect, aspect),
      header,
      depth,
      swatch,
    });
    const x0 = rect.x0;
    const y0 = rect.y0 + header;
    const w = rect.x1 - rect.x0;
    const h = rect.y1 - y0;
    const rects = squarify(group.kids.map((kid) => (kid.s / group.s) * (w * h)), x0, y0, w, h);
    return { group, rects, index: 0, parent, depth, left: budget - header, path: null };
  };
  const stack = [open(root, rootRect, null, (rootRect.y1 - rootRect.y0) / 3)];
  while (stack.length > 0) {
    const frame = /** @type {any} */ (stack.at(-1));
    if (frame.index === frame.group.kids.length) { stack.pop(); continue; }
    const kid = frame.group.kids[frame.index];
    const rect = frame.rects[frame.index++];
    const nested = kid.kids !== undefined;
    if (nested && (rect.x1 - rect.x0) * (rect.y1 - rect.y0) / aspect >= MIN_SUBTREE_AREA) {
      stack.push(open(kid, rect, frame, frame.left));
      continue;
    }
    ctx.tiles.push({
      label: kid.label,
      value: nested ? kid.s * unit : kid.value,
      frac: kid.s / sum,
      ...unitRect(rect, aspect),
      group: frame.group.label,
      path: pathOf(frame),
      swatch,
    });
  }
}

/** The labels of the groups from the top-level one down to `frame`'s, cached on the frame. */
function pathOf(frame) {
  if (frame.path === null) {
    const labels = [];
    for (let f = frame; f !== null; f = f.parent) labels.push(f.group.label);
    frame.path = labels.reverse();
  }
  return frame.path;
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
    // Lay the row along the shorter side. A row with no area (shares
    // below the smallest double) or no side left to lay it along gets
    // tiles of no size where it would divide by zero.
    const thickness = side > 0 ? sum / side : 0;
    let offset = 0;
    for (let i = start; i < end; i++) {
      const length = thickness > 0 ? areas[i] / thickness : 0;
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
 * A grouped treemap adds each group's name in its header band (where it
 * has one that fits) and a hairline between same-hue siblings — both
 * only when there are groups, so a flat treemap renders exactly as it
 * did before grouping existed; a tile's hover text spells out the path
 * of groups above it.
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
      : `${(tile.path ?? [tile.group]).join(' / ')} / ${tile.label}: ${tile.value} (${share})`,
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
