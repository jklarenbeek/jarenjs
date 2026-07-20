//@ts-check
/**
 * @file Shared SVG vnode helpers over `@jarenjs/view`'s `h()` (the small
 * helper set is adapted from `@jarenjs/mermaid`'s `render/svg.js`, kept
 * deliberately close so both engines emit the same shape). The root is
 * `['svg', …]` so the view patcher namespaces the whole subtree
 * (VIEW-FORMAT §5.4); nothing here touches the DOM.
 */

import { h } from '@jarenjs/view';

/**
 * Clamp to a finite number (defends the geometry against NaN/±Inf).
 * @param {number} n @param {number} [fallback]
 * @returns {number}
 */
export function num(n, fallback = 0) {
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Standard linear remap of `v` from `[smin, smax]` to `[dmin, dmax]`.
 * (Core's `Float64.map` uses a non-standard `lerp` and is unsuitable for
 * screen mapping, so the plotter maps here.)
 * @param {number} v @param {number} smin @param {number} smax @param {number} dmin @param {number} dmax
 * @returns {number}
 */
export function mapRange(v, smin, smax, dmin, dmax) {
  if (smax === smin) return dmin;
  return dmin + ((v - smin) / (smax - smin)) * (dmax - dmin);
}

/**
 * The root `<svg>`; theme tokens become `--calc-*` CSS variables.
 * @param {number} width @param {number} height
 * @param {{ cssVars: Record<string,string>, tokens: Record<string,string> }} theme
 * @param {any[]} children
 * @param {string} [key]
 * @returns {any}
 */
export function svgRoot(width, height, theme, children, key) {
  const style = { ...theme.cssVars, 'font-family': theme.tokens.fontFamily, 'max-width': '100%' };
  const props = {
    class: 'calc-plot',
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

/** A `<g>` group. @param {Record<string,any>} props @param {any[]} children */
export function group(props, children) {
  return ['g', props, ...children];
}

/** A `<line>`. */
export function line(x1, y1, x2, y2, props) {
  return h('line', { x1: num(x1), y1: num(y1), x2: num(x2), y2: num(y2), ...props });
}

/** A `<path>` from a `d` string. */
export function path(d, props) {
  return h('path', { d, ...props });
}

/** A `<polyline>` from `{x,y}` points (open). */
export function polyline(points, props) {
  const p = points.map((pt) => `${num(pt.x)},${num(pt.y)}`).join(' ');
  return h('polyline', { points: p, fill: 'none', ...props });
}

/** A `<polygon>` from `{x,y}` points (closed). */
export function polygon(points, props) {
  const p = points.map((pt) => `${num(pt.x)},${num(pt.y)}`).join(' ');
  return h('polygon', { points: p, ...props });
}

/** A single-line `<text>`. */
export function textAt(x, y, str, fontSize, props = {}) {
  return h('text', { x: num(x), y: num(y), 'font-size': fontSize, ...props }, String(str));
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
