//@ts-check
/**
 * @file The error vnode. The render path is total — it emits this
 * instead of throwing. A small standalone `<svg>` that
 * states the parse/eval error with its line/column when known.
 */

import { svgRoot, textAt } from '@jarenjs/view/helpers';
import { createTheme } from '../theme.js';
import { calcText } from '../messages.js';

/**
 * @param {{ message: string, line?: number, column?: number }} error
 * @param {{ theme?: any, width?: number, height?: number, messages?: Readonly<Record<string, unknown>> | null }} [options]
 *   `messages`, a compiled locale catalog, translates the card's own words
 *   (its title and the position), falling back to English per id
 * @returns {any}
 */
export function errorToVnode(error, options = {}) {
  const theme = createTheme(options.theme ?? 'default');
  const width = options.width ?? 480;
  const height = options.height ?? 80;
  const t = calcText(options.messages);
  const message = String(error.message);
  return svgRoot('calc-plot', width, height, theme, [
    textAt(12, 28, t('calc/error/title'), 13, { fill: theme.tokens.errorText, 'font-weight': 'bold', class: 'calc-error-title' }),
    textAt(12, 48, error.line !== undefined ? t('calc/error/at', { message, line: error.line, column: error.column }) : message, 11,
      { fill: theme.tokens.text, class: 'calc-error-msg' }),
  ], 'err:' + message);
}
