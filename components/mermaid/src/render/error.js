//@ts-check
/**
 * @file The error vnode. The render path never
 * throws: a parse/layout failure becomes a clear error box — message +
 * offending line — mirroring Mermaid's own error box, keyed so the
 * patcher swaps it cleanly.
 *
 * It themes like every other diagram (DESIGN.md §7): concrete colors ride
 * as presentation attributes so `toSvgString()` stays standalone-valid,
 * and the root carries the inline `--mm-*` stamp plus a class per shape,
 * so a host theme re-colors the error box along with the diagrams it
 * replaces. The font is pinned to monospace because the box quotes source.
 */

import { rect, svgRoot, textAt } from '@jarenjs/view/helpers';
import { hashContent } from '../utils.js';
import { createTheme } from '../theme.js';

/**
 * @param {string} message
 * @param {number} [line]
 * @param {string} [sourceLine] the offending source line, if known
 * @param {ReturnType<typeof createTheme>} [theme] the resolved theme; the
 *   default keeps the vnode renderable on its own (a parse failure has no
 *   document to read a theme from)
 * @returns {any} an SVG error vnode
 */
export function errorVnode(message, line = 0, sourceLine = '', theme = createTheme('default')) {
  const width = 520;
  const height = sourceLine ? 96 : 72;
  const key = 'mmerr-' + hashContent(message + ':' + line);
  const lineLabel = line > 0 ? `Line ${line}: ` : '';
  const t = theme.tokens;
  return svgRoot('mermaid mm-error', width, height, theme, [
    rect(1, 1, width - 2, height - 2, {
      rx: 6, class: 'mm-error-box', fill: t.errFill, stroke: t.errStroke, 'stroke-width': 1.5,
    }),
    textAt(14, 26, 'Mermaid parse error', 14, {
      class: 'mm-error-title', 'font-weight': 'bold', fill: t.errTitle,
    }),
    textAt(14, 48, lineLabel + message, 12, { class: 'mm-error-msg', fill: t.errText }),
    ...(sourceLine
      ? [textAt(14, 72, truncate(sourceLine, 72), 12, {
        class: 'mm-error-source', fill: t.errSource, style: { 'white-space': 'pre' },
      })]
      : []),
  ], key, { fontFamily: 'monospace' });
}

/**
 * @param {string} s @param {number} max @returns {string}
 */
function truncate(s, max) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
