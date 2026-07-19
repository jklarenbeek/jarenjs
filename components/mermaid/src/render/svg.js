//@ts-check
/**
 * @file Shared SVG vnode helpers over `@jarenjs/view`'s `h()`. Every
 * helper returns a tagged-array vnode; nothing here touches the DOM.
 * The root is `['svg', {viewBox,…}, …]` so the view patcher creates the
 * whole subtree in the SVG namespace (VIEW-FORMAT §5.4), and text is
 * escaped by the view serializer. Labels are SVG `<text>` — view 0.1 has
 * no `foreignObject` (D-correction).
 */

import { h } from '@jarenjs/view';

/** URL schemes permitted on a link `href`. */
const RE_SAFE_URL = /^(https?:|mailto:|#|\/|\.)/i;

/**
 * Reject `javascript:`/`data:` and other non-http(s) URLs.
 * @param {any} url
 * @returns {string|null}
 */
export function sanitizeHref(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  return RE_SAFE_URL.test(trimmed) ? trimmed : null;
}

/**
 * Clamp a value to a finite number (defends against NaN geometry).
 * @param {number} n
 * @param {number} [fallback]
 * @returns {number}
 */
export function num(n, fallback = 0) {
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The root `<svg>`. Theme tokens become `--mm-*` CSS variables on the
 * element so the stylesheet can re-theme without a re-render.
 * @param {number} width
 * @param {number} height
 * @param {{ cssVars: Record<string,string>, tokens: Record<string,string> }} theme
 * @param {any[]} children
 * @param {string} [key]
 * @returns {any}
 */
export function svgRoot(width, height, theme, children, key) {
  const style = { ...theme.cssVars, 'font-family': theme.tokens.fontFamily, 'max-width': '100%' };
  const props = {
    class: 'mermaid mm-svg',
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
 * A `<rect>` (optionally rounded).
 * @param {number} x @param {number} y @param {number} w @param {number} height
 * @param {Record<string,any>} props
 * @returns {any}
 */
export function rect(x, y, w, height, props) {
  return h('rect', { x: num(x), y: num(y), width: num(w), height: num(height), ...props });
}

/**
 * A `<path>`.
 * @param {string} d @param {Record<string,any>} props
 * @returns {any}
 */
export function path(d, props) {
  return h('path', { d, ...props });
}

/**
 * A `<line>`.
 * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
 * @param {Record<string,any>} props
 * @returns {any}
 */
export function line(x1, y1, x2, y2, props) {
  return h('line', { x1: num(x1), y1: num(y1), x2: num(x2), y2: num(y2), ...props });
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
 * A `<polygon>` from a points array.
 * @param {{x:number,y:number}[]} points
 * @param {Record<string,any>} props
 * @returns {any}
 */
export function polygon(points, props) {
  const p = points.map((pt) => `${num(pt.x)},${num(pt.y)}`).join(' ');
  return h('polygon', { points: p, ...props });
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
 * A single-line `<text>` anchored at (x,y).
 * @param {number} x @param {number} y @param {string} str @param {number} fontSize
 * @param {Record<string,any>} [props]
 * @returns {any}
 */
export function textAt(x, y, str, fontSize, props = {}) {
  return h('text', { x: num(x), y: num(y), 'font-size': fontSize, ...props }, str);
}
