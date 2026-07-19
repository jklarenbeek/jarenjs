//@ts-check
/**
 * @file The error vnode (design decision D7). The render path never
 * throws: a parse/layout failure becomes a clear error box — message +
 * offending line — mirroring Mermaid's own error box, keyed so the
 * patcher swaps it cleanly.
 */

import { h } from '@jarenjs/view';
import { hashContent } from '../utils.js';

/**
 * @param {string} message
 * @param {number} [line]
 * @param {string} [sourceLine] the offending source line, if known
 * @returns {any} an SVG error vnode
 */
export function errorVnode(message, line = 0, sourceLine = '') {
  const width = 520;
  const height = sourceLine ? 96 : 72;
  const key = 'mmerr-' + hashContent(message + ':' + line);
  const lineLabel = line > 0 ? `Line ${line}: ` : '';
  return ['svg', {
    class: 'mermaid mm-error',
    role: 'img',
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    key,
    style: { 'max-width': '100%', 'font-family': 'monospace' },
  },
    h('rect', { x: 1, y: 1, width: width - 2, height: height - 2, rx: 6, fill: '#fdf2f2', stroke: '#e74c3c', 'stroke-width': 1.5 }),
    h('text', { x: 14, y: 26, 'font-size': 14, 'font-weight': 'bold', fill: '#c0392b' }, 'Mermaid parse error'),
    h('text', { x: 14, y: 48, 'font-size': 12, fill: '#7b241c' }, lineLabel + message),
    ...(sourceLine
      ? [h('text', { x: 14, y: 72, 'font-size': 12, fill: '#555', style: { 'white-space': 'pre' } }, truncate(sourceLine, 72))]
      : []),
  ];
}

/**
 * @param {string} s @param {number} max @returns {string}
 */
function truncate(s, max) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
