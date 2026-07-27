//@ts-check
/**
 * @file The map chart type: GeoJSON drawn in Web Mercator, optionally
 * shaded by a feature property (a choropleth). Data shape:
 *
 *   data   = { features: <FeatureCollection | Feature[] | Feature>,
 *              points?: [{ at: [lon, lat], label?, value? }] }
 *   config = { type:'map', title?, value?, label?, log?, simplify?, aspect? }
 *
 * `value` names the feature property to shade by and `label` the one to
 * name features by (default `'name'`); `points` is the convenience path
 * for a caller holding a list of places rather than GeoJSON, and folds
 * into the same shape list at build time so the AST has one.
 *
 * The AST is unit-space rings, lines and dots plus a normalized
 * magnitude per shape — the projection and the simplification happen in
 * the build (they are geometry *of the data*, not of the drawing), the
 * colors, the stroke widths and the ramp legend in the render.
 *
 * Two things are worth knowing about the projection. It is Web Mercator
 * because that is what every reader's mental model of a map already is,
 * and it is applied **only here**: nothing measures on the result, and
 * `@jarenjs/core/geo` keeps its area and distance functions on the
 * sphere for exactly that reason. And it is fitted uniformly — the map
 * is centred in whichever axis has room left over rather than stretched
 * to fill the frame, which is the single most common way to make a map
 * look wrong.
 */

import { svgRoot, coord } from '@jarenjs/view/helpers';
import { clamp01 } from '@jarenjs/core/math';
import { bboxOf, bboxUnion, fitMercator, simplifyLine, simplifyRing } from '@jarenjs/core/geo';
import { formatTickValue } from '../core/axis.js';
import { FS_TITLE, annotateChart, chartTitle, legendRow } from '../core/cartesian.js';
import { SEQUENTIAL, sequentialColor } from '../core/palette.js';
import { normalizeTooltip, valueMark } from '../core/marks.js';

/**
 * @typedef {object} MapShapeAST
 * @property {string} label
 * @property {number|null} value the shading property, when the feature had one
 * @property {number|null} t normalized magnitude (0..1), null when unshaded
 * @property {Array<Array<number[]>>} rings polygon rings in unit space,
 *  exterior first then holes; `[u, v]` with v growing downward
 * @property {Array<Array<number[]>>} lines line strings in unit space
 * @property {Array<number[]>} dots point positions in unit space
 */
/**
 * @typedef {object} MapAST
 * @property {'map'} type
 * @property {string|null} title
 * @property {number} aspect layout width:height ratio
 * @property {number[]|null} bbox the geographic extent drawn, `[w,s,e,n]`
 * @property {MapShapeAST[]} shapes
 * @property {{min: number, max: number}|null} domain shading extent (null = unshaded)
 * @property {{source: number, drawn: number}} vertices positions read vs kept
 */

/**
 * Default simplification tolerance, as a fraction of the frame's width.
 * At the default 560px-wide chart this is about a third of a pixel, so
 * the simplification is invisible by construction: it can only remove
 * vertices that would have landed on a neighbour's pixel anyway. A
 * caller drawing much larger passes a smaller number, and `false`
 * switches it off. Exported because the streaming map accumulator
 * simplifies on arrival with the same default.
 */
export const MAP_SIMPLIFY = 0.0006;

/**
 * Build the geometry-free map AST.
 * @param {any} data
 * @param {any} [config]
 * @returns {MapAST}
 */
export function buildMapAST(data, config = {}) {
  const aspect = typeof config.aspect === 'number' && Number.isFinite(config.aspect) && config.aspect > 0
    ? config.aspect : 1.6;
  const valueKey = typeof config.value === 'string' ? config.value : null;
  const labelKey = typeof config.label === 'string' && config.label !== '' ? config.label : 'name';
  const tolerance = config.simplify === false ? 0
    : (typeof config.simplify === 'number' && config.simplify >= 0 ? config.simplify : MAP_SIMPLIFY);
  const log = config.log === true;

  const entries = collectEntries(data, valueKey, labelKey);

  let bbox = null;
  for (const entry of entries) {
    const box = bboxOf(entry.geometry);
    if (box !== null)
      bbox = bbox === null ? box : bboxUnion(bbox, box);
  }

  // the shading extent, over the features that actually carry a value
  let min = Infinity;
  let max = -Infinity;
  for (const entry of entries) {
    const v = entry.value;
    if (v === null || (log && v <= 0)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const domain = Number.isFinite(min) ? { min, max } : null;
  const span = domain === null ? 0
    : log ? Math.log10(max) - Math.log10(min)
      : max - min;

  const shapes = [];
  const counts = { source: 0, drawn: 0 };
  if (bbox !== null) {
    const fit = fitMercator(bbox, aspect);
    for (const entry of entries) {
      const shape = {
        label: entry.label,
        value: entry.value,
        t: entry.value === null || domain === null || (log && entry.value <= 0) ? null
          : span === 0 ? 0.5
            : clamp01(log
              ? (Math.log10(entry.value) - Math.log10(min)) / span
              : (entry.value - min) / span),
        rings: [],
        lines: [],
        dots: [],
      };
      collectParts(entry.geometry, fit, tolerance, shape, counts);
      if (shape.rings.length !== 0 || shape.lines.length !== 0 || shape.dots.length !== 0)
        shapes.push(shape);
    }
  }

  return {
    type: 'map',
    title: config.title ?? null,
    aspect,
    bbox,
    shapes,
    domain,
    vertices: counts,
  };
}

/**
 * Flatten the input into `{label, value, geometry}` entries. Accepts a
 * FeatureCollection, an array of Features or geometries, or a single
 * one; the `points` convenience list becomes Point geometries so
 * everything downstream sees the same thing.
 */
function collectEntries(data, valueKey, labelKey) {
  const entries = [];
  const source = data?.features ?? data;
  const list = Array.isArray(source) ? source
    : source?.type === 'FeatureCollection' ? (source.features ?? [])
      : source === null || source === undefined ? [] : [source];

  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const properties = item.type === 'Feature' ? (item.properties ?? {}) : item;
    const geometry = item.type === 'Feature' ? item.geometry : item;
    if (geometry === null || typeof geometry !== 'object') continue;
    entries.push({
      label: labelOf(properties, labelKey),
      value: valueKey === null ? null : finiteOrNull(properties?.[valueKey]),
      geometry,
    });
  }

  for (const point of data?.points ?? []) {
    if (point === null || typeof point !== 'object') continue;
    const at = Array.isArray(point.at) ? point.at : null;
    if (at === null || typeof at[0] !== 'number' || typeof at[1] !== 'number') continue;
    entries.push({
      label: labelOf(point, labelKey),
      value: finiteOrNull(point.value),
      geometry: { type: 'Point', coordinates: at },
    });
  }
  return entries;
}

function labelOf(properties, labelKey) {
  const named = properties?.[labelKey] ?? properties?.label;
  return named === null || named === undefined ? '' : String(named);
}

function finiteOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Walk a geometry, projecting and simplifying each part into the shape's
 * unit-space lists. Unknown `type` values contribute nothing rather than
 * throwing — a map of half-broken data should draw the half that works.
 */
function collectParts(geometry, fit, tolerance, shape, counts) {
  const { type, coordinates } = geometry;
  if (type === 'GeometryCollection') {
    for (const inner of geometry.geometries ?? []) {
      if (inner !== null && typeof inner === 'object')
        collectParts(inner, fit, tolerance, shape, counts);
    }
    return;
  }
  if (type === 'Point') {
    const dot = project(coordinates, fit);
    if (dot !== null) {
      counts.source++;
      counts.drawn++;
      shape.dots.push(dot);
    }
    return;
  }
  if (type === 'MultiPoint') {
    for (const position of coordinates ?? []) {
      const dot = project(position, fit);
      if (dot !== null) {
        counts.source++;
        counts.drawn++;
        shape.dots.push(dot);
      }
    }
    return;
  }
  if (type === 'LineString') {
    pushLine(coordinates, fit, tolerance, shape, counts);
    return;
  }
  if (type === 'MultiLineString') {
    for (const part of coordinates ?? [])
      pushLine(part, fit, tolerance, shape, counts);
    return;
  }
  if (type === 'Polygon') {
    for (const ring of coordinates ?? [])
      pushRing(ring, fit, tolerance, shape, counts);
    return;
  }
  if (type === 'MultiPolygon') {
    for (const rings of coordinates ?? []) {
      for (const ring of rings ?? [])
        pushRing(ring, fit, tolerance, shape, counts);
    }
  }
}

function project(position, fit) {
  if (!Array.isArray(position)) return null;
  const lon = position[0];
  const lat = position[1];
  if (typeof lon !== 'number' || typeof lat !== 'number'
    || !Number.isFinite(lon) || !Number.isFinite(lat))
    return null;
  return fit(lon, lat);
}

/** Project a run of positions, dropping the ones that are not positions. */
function projectRun(positions, fit, counts) {
  if (!Array.isArray(positions)) return [];
  const out = [];
  for (const position of positions) {
    const p = project(position, fit);
    if (p !== null) {
      counts.source++;
      out.push(p);
    }
  }
  return out;
}

function pushLine(positions, fit, tolerance, shape, counts) {
  const run = projectRun(positions, fit, counts);
  if (run.length < 2) return;
  const drawn = tolerance > 0 ? simplifyLine(run, tolerance) : run;
  counts.drawn += drawn.length;
  shape.lines.push(drawn);
}

function pushRing(positions, fit, tolerance, shape, counts) {
  const run = projectRun(positions, fit, counts);
  if (run.length < 3) return;
  const drawn = tolerance > 0 ? simplifyRing(run, tolerance) : run;
  counts.drawn += drawn.length;
  shape.rings.push(drawn);
}

/**
 * Render a map AST to a pure-vnode SVG: one filled path per shape (all
 * its rings as subpaths, `evenodd` so holes punch through whichever way
 * the producer wound them), stroked paths for lines, dots for points,
 * and a ramp key in the legend slot when the map is shaded.
 * @param {MapAST} ast
 * @param {{tokens: Record<string,string>, cssVars: Record<string,string>}} theme
 * @param {string} hash
 * @param {{rootClass?: string, keyPrefix?: string, ramp?: readonly string[], width?: number,
 *   tooltip?: import('../core/marks.js').ChartTooltipSpec}} [options]
 * @returns {any}
 */
export function renderMapAST(ast, theme, hash, options = {}) {
  const t = theme.tokens;
  const ramp = options.ramp ?? SEQUENTIAL;
  const tooltip = normalizeTooltip(options.tooltip);
  const width = options.width ?? 560;

  // The ramp key rides the frame's legend mechanism, exactly as the
  // heatmap's does: five stops as swatches, the extent as end labels.
  const rampStops = [0, 0.25, 0.5, 0.75, 1].map((v) => sequentialColor(v, ramp));
  const legend = ast.domain === null ? null : rampStops.map((_, i) => ({
    name: i === 0 ? formatTickValue(ast.domain.min)
      : i === rampStops.length - 1 ? formatTickValue(ast.domain.max) : '',
    swatch: i,
  }));

  // A map has no axes, no ticks and no gridlines, so it does not use the
  // cartesian frame — only its title and legend chrome. That also lets
  // the plot sit on an even margin, which a map needs and an axis-bearing
  // plot (whose left margin holds the tick labels) cannot have.
  const pad = 12;
  const plotW = width - 2 * pad;
  const plotH = plotW / ast.aspect;
  const top = (ast.title ? 34 : 14) + (legend === null ? 0 : 22);
  const height = top + plotH + 10;
  const children = [];

  if (ast.title)
    children.push(chartTitle(width / 2, 22, ast.title, FS_TITLE, t));
  if (legend !== null)
    children.push(...legendRow(legend, width - 16, top - 10, theme, rampStops));

  const toX = (u) => coord(pad + u * plotW);
  const toY = (v) => coord(top + v * plotH);
  const unshaded = ast.domain === null ? sequentialColor(0, ramp) : t.grid;

  for (const shape of ast.shapes) {
    const fill = shape.t === null ? unshaded : sequentialColor(shape.t, ramp);
    const hover = shape.value === null
      ? shape.label
      : `${shape.label}: ${formatTickValue(shape.value)}`;
    const descriptor = { type: 'map', label: shape.label, value: shape.value };

    if (shape.rings.length !== 0) {
      let d = '';
      for (const ring of shape.rings) {
        for (let i = 0; i < ring.length; i++)
          d += (i === 0 ? 'M' : 'L') + toX(ring[i][0]) + ' ' + toY(ring[i][1]) + ' ';
        d += 'Z ';
      }
      children.push(valueMark('path', {
        d: d.trim(), fill, 'fill-rule': 'evenodd',
        stroke: t.sliceStroke, 'stroke-width': 0.5,
        'stroke-linejoin': 'round', class: 'chart-map-area',
      }, tooltip, hover, descriptor));
    }
    for (const line of shape.lines) {
      let d = '';
      for (let i = 0; i < line.length; i++)
        d += (i === 0 ? 'M' : 'L') + toX(line[i][0]) + ' ' + toY(line[i][1]) + ' ';
      children.push(valueMark('path', {
        d: d.trim(), fill: 'none',
        stroke: shape.t === null ? t.axis : fill, 'stroke-width': 1.5,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round', class: 'chart-map-line',
      }, tooltip, hover, descriptor));
    }
    for (const dot of shape.dots) {
      // A dot with no value is a *marker* — a city on a population map —
      // which is a different thing from an area with no data, so it takes
      // ink rather than the ramp's "unshaded" grey and stays visible
      // against whatever it sits on.
      children.push(valueMark('circle', {
        cx: toX(dot[0]), cy: toY(dot[1]), r: 3.5,
        fill: shape.t === null ? t.text : fill,
        stroke: t.sliceStroke, 'stroke-width': 1, class: 'chart-map-dot',
      }, tooltip, hover, descriptor));
    }
  }

  const svg = svgRoot(options.rootClass ?? 'chart chart-svg chart-map-chart',
    width, height, theme, children, (options.keyPrefix ?? 'map-') + hash);
  return annotateChart(svg, ast.title);
}
