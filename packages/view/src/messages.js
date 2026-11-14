//@ts-check
/**
 * @file The view package's English message catalog: the words its
 * helpers show a reader (the dialog's close button), keyed by a stable
 * `view/...` id in the suite's one message grammar
 * (`@jarenjs/core/message`): `{name}` substitutes a parameter and `{{` is
 * a literal brace. A locale pack translates these ids; {@link viewText}
 * renders through such a pack, compiled, falling back to this English
 * per id.
 */

import { compileMessageCatalog } from '@jarenjs/core/message';

/**
 * The view package's English catalog: message id → template. Frozen; a
 * locale pack supplies the same ids.
 * @type {Readonly<Record<string, string | ((params: any) => string)>>}
 */
export const viewMessagesEn = /*#__PURE__*/ Object.freeze({
  'view/dialog/close': 'Close',
});

/** @type {Readonly<Record<string, (params: object) => string>> | undefined} */
let english;

/**
 * A text function over a compiled catalog: `t(id, params)` renders `id`
 * through `catalog` (the output of `compileMessageCatalog` over a locale
 * pack) and falls back to the English of {@link viewMessagesEn} per id —
 * when the catalog lacks the id, or its entry throws or answers something
 * other than a string. With no catalog every id renders its English.
 * @example
 * import { compileMessageCatalog } from '@jarenjs/core/message';
 * viewText(compileMessageCatalog({ 'view/dialog/close': 'Sluiten' }))('view/dialog/close'); // 'Sluiten'
 * @param {Readonly<Record<string, unknown>> | null} [catalog] - a compiled catalog, or none for English
 * @returns {(id: string, params?: Record<string, unknown>) => string}
 */
export function viewText(catalog) {
  return function viewMessage(id, params = {}) {
    const render = catalog != null && Object.hasOwn(catalog, id) ? catalog[id] : undefined;
    if (typeof render === 'function') {
      try {
        const text = render(params);
        if (typeof text === 'string') return text;
      }
      catch { /* a throwing translation renders the English */ }
    }
    english ??= compileMessageCatalog(viewMessagesEn);
    return Object.hasOwn(english, id) ? english[id](params) : id;
  };
}
