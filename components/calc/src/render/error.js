//@ts-check
/**
 * @file The error vnode. The render path is total — it emits this
 * instead of throwing. A small standalone `<svg>` that
 * states the parse/eval error with its line/column when known.
 */

import { svgRoot, textAt } from '@jarenjs/view/helpers';
import { createTheme } from '../theme.js';

/**
 * @param {{ message: string, line?: number, column?: number }} error
 * @param {{ theme?: any, width?: number, height?: number }} [options]
 * @returns {any}
 */
export function errorToVnode(error, options = {}) {
  const theme = createTheme(options.theme ?? 'default');
  const width = options.width ?? 480;
  const height = options.height ?? 80;
  const where = error.line !== undefined ? ` (line ${error.line}, col ${error.column})` : '';
  return svgRoot('calc-plot', width, height, theme, [
    textAt(12, 28, 'Expression error', 13, { fill: theme.tokens.errorText, 'font-weight': 'bold', class: 'calc-error-title' }),
    textAt(12, 48, String(error.message) + where, 11, { fill: theme.tokens.text, class: 'calc-error-msg' }),
  ], 'err:' + String(error.message));
}
