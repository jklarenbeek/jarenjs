//@ts-check
/**
 * @file The shared studio view pieces (extracted when the third studio
 * arrived): the editor textarea (hand-written six times before, same
 * five core props, one site's `readonly` taken as an option) and the
 * error line (eight inline sites). The two existing studios' template
 * pickers differ in match path, mode AND card structure, and the data
 * studio has no picker, so that rule is deliberately NOT extracted.
 */

/**
 * The five-prop editor textarea.
 * @param {{ value: string, action: string, rows?: number,
 *   readonly?: boolean }} options
 */
export function editorTextarea(options) {
  return ['textarea', {
    class: 'editor',
    rows: options.rows ?? 22,
    spellcheck: 'false',
    value: options.value,
    ...(options.readonly === true ? { readonly: '' } : {}),
    on: { change: options.action },
  }];
}

/**
 * The error line.
 * @param {any} content - a query expression or literal text
 */
export function errorLine(content) {
  return ['p', { class: 'error-line' }, content];
}
