//@ts-check
/**
 * @file The error vnode (design decision D7). The render path never
 * throws: a parse/layout failure becomes a clear error box — message +
 * offending line — mirroring Mermaid's own error box, keyed so the
 * patcher swaps it cleanly.
 */

import { rect, textAt } from '@jarenjs/view/helpers';
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
    rect(1, 1, width - 2, height - 2, { rx: 6, fill: '#fdf2f2', stroke: '#e74c3c', 'stroke-width': 1.5 }),
    textAt(14, 26, 'Mermaid parse error', 14, { 'font-weight': 'bold', fill: '#c0392b' }),
    textAt(14, 48, lineLabel + message, 12, { fill: '#7b241c' }),
    ...(sourceLine
      ? [textAt(14, 72, truncate(sourceLine, 72), 12, { fill: '#555', style: { 'white-space': 'pre' } })]
      : []),
  ];
}

/**
 * @param {string} s @param {number} max @returns {string}
 */
function truncate(s, max) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
