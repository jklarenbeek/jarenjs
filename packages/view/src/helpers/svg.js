//@ts-check
/**
 * @file Shared SVG vnode builders over the view `h()` constructor — the
 * single home for the small helper set that `@jarenjs/calc` and
 * `@jarenjs/mermaid` (and any future SVG-emitting component) draw from.
 *
 * Every helper returns a tagged-array vnode; nothing here touches the DOM.
 * The root is `['svg', {viewBox,…}, …]` so the view patcher namespaces the
 * whole subtree (VIEW-FORMAT §5.4) and the serializer escapes text. These
 * builders are geometry-defensive: coordinates flow through `num` so a
 * NaN/±Inf never reaches the emitted string.
 */

import { Float64 } from '@jarenjs/core/math';
import { h } from '../vnode.js';

/**
 * Clamp a value to a finite number (defends the geometry against
 * NaN/±Inf).
 * @param {number} n
 * @param {number} [fallback]
 * @returns {number}
 */
export function num(n, fallback = 0) {
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Quantize a coordinate to two decimals — the precision SVG geometry is
 * emitted at, which keeps path data short and makes repeated renders of the
 * same shape produce identical strings. Non-finite input passes straight
 * through, so pair this with `num` wherever the value reaches an attribute.
 * @param {number} v
 * @returns {number}
 */
export function coord(v) {
  return Float64.roundTo(v, 2);
}

/**
 * The point at distance `r` from `(cx, cy)` along `angle` (radians,
 * 0 = east, y growing downward — SVG screen orientation). Raw
 * coordinates: quantization (`coord`/`num`) stays at the call site so a
 * caller's emitted bytes are its own choice.
 * @param {number} cx
 * @param {number} cy
 * @param {number} r
 * @param {number} angle
 * @returns {{ x: number, y: number }}
 */
export function polarPoint(cx, cy, r, angle) {
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

/**
 * The `text-anchor` for a label placed radially outward at `angle`
 * (radians, 0 = east, y growing downward). Labels near the left or right
 * of the circle read away from it (`end`/`start`); the deadband around
 * ±90° keeps top and bottom labels centred rather than flipping anchor on
 * a hair's difference in angle.
 * @param {number} angle
 * @returns {'start'|'end'|'middle'}
 */
export function anchorForAngle(angle) {
  const c = Math.cos(angle);
  return c > 0.3 ? 'start' : c < -0.3 ? 'end' : 'middle';
}

/**
 * The root `<svg>`. The caller supplies the `class` string; theme tokens
 * become CSS custom properties on the element (via `theme.cssVars`) so the
 * stylesheet can re-theme without a re-render, and `theme.tokens.fontFamily`
 * is written as the base font.
 * @param {string} className the root element's `class`
 * @param {number} width
 * @param {number} height
 * @param {{ cssVars: Record<string,string>, tokens: Record<string,string> }} theme
 * @param {any[]} children
 * @param {string} [key]
 * @returns {any}
 */
export function svgRoot(className, width, height, theme, children, key) {
  const style = { ...theme.cssVars, 'font-family': theme.tokens.fontFamily, 'max-width': '100%' };
  const props = {
    class: className,
    role: 'img',
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: `0 0 ${num(width, 1)} ${num(height, 1)}`,
    width: num(width, 1),
    height: num(height, 1),
    style,
  };
  if (key !== undefined) props.key = key;
  return ['svg', props, ...children];
}

/**
 * A `<g>` group.
 * @param {Record<string,any>} props
 * @param {any[]} children
 * @returns {any}
 */
export function group(props, children) {
  return ['g', props, ...children];
}

/**
 * A `<rect>` (optionally rounded via props).
 * @param {number} x @param {number} y @param {number} w @param {number} height
 * @param {Record<string,any>} props
 * @returns {any}
 */
export function rect(x, y, w, height, props) {
  return h('rect', { x: num(x), y: num(y), width: num(w), height: num(height), ...props });
}

/**
 * A `<circle>`.
 * @param {number} cx @param {number} cy @param {number} r
 * @param {Record<string,any>} props
 * @returns {any}
 */
export function circle(cx, cy, r, props) {
  return h('circle', { cx: num(cx), cy: num(cy), r: num(r), ...props });
}

/**
 * A `<line>`.
 * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
 * @param {Record<string,any>} [props]
 * @returns {any}
 */
export function line(x1, y1, x2, y2, props) {
  return h('line', { x1: num(x1), y1: num(y1), x2: num(x2), y2: num(y2), ...props });
}

/**
 * A `<path>` from a `d` string.
 * @param {string} d @param {Record<string,any>} [props]
 * @returns {any}
 */
export function path(d, props) {
  return h('path', { d, ...props });
}

/**
 * A `<polyline>` from `{x,y}` points (open; defaults to no fill).
 * @param {{x:number,y:number}[]} points @param {Record<string,any>} [props]
 * @returns {any}
 */
export function polyline(points, props) {
  const p = points.map((pt) => `${num(pt.x)},${num(pt.y)}`).join(' ');
  return h('polyline', { points: p, fill: 'none', ...props });
}

/**
 * A `<polygon>` from `{x,y}` points (closed).
 * @param {{x:number,y:number}[]} points @param {Record<string,any>} [props]
 * @returns {any}
 */
export function polygon(points, props) {
  const p = points.map((pt) => `${num(pt.x)},${num(pt.y)}`).join(' ');
  return h('polygon', { points: p, ...props });
}

/**
 * A single-line `<text>` anchored at (x,y). `str` is coerced with
 * `String()` so numeric labels emit as text.
 * @param {number} x @param {number} y @param {any} str @param {number} fontSize
 * @param {Record<string,any>} [props]
 * @returns {any}
 */
export function textAt(x, y, str, fontSize, props = {}) {
  return h('text', { x: num(x), y: num(y), 'font-size': fontSize, ...props }, String(str));
}

/**
 * A `<text>` block, one `<tspan>` per line, vertically centered on `cy`.
 * @param {number} cx @param {number} cy
 * @param {string[]} lines
 * @param {number} fontSize
 * @param {Record<string,any>} [props]
 * @returns {any}
 */
export function textLines(cx, cy, lines, fontSize, props = {}) {
  const total = lines.length;
  const lineH = fontSize * 1.2;
  const startY = cy - ((total - 1) * lineH) / 2;
  const children = lines.map((ln, i) => h('tspan', {
    x: num(cx),
    y: num(startY + i * lineH),
    'text-anchor': 'middle',
    'dominant-baseline': 'central',
  }, ln));
  return h('text', {
    'font-size': fontSize,
    'text-anchor': 'middle',
    ...props,
  }, ...children);
}

/**
 * Build an SVG path `d` from a list of `{x,y}` points, breaking the line
 * on `null` entries (discontinuities / out-of-range samples). Returns
 * `''` when there is nothing to draw.
 * @param {Array<{x:number,y:number}|null>} points
 * @returns {string}
 */
export function polylinePath(points) {
  let d = '';
  let pen = false;
  for (const pt of points) {
    if (pt === null || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
      pen = false;
      continue;
    }
    d += (pen ? 'L' : 'M') + num(pt.x) + ' ' + num(pt.y) + ' ';
    pen = true;
  }
  return d.trim();
}
