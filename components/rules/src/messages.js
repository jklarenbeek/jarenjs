//@ts-check
/**
 * @file The rule editor's English message catalog: every word of chrome
 * the editor shows a reader (its controls' labels and accessible names,
 * the buttons, the status line, the review list and its pages, and the
 * outcome messages the editor writes into its state), keyed by a stable
 * `rules/...` id in the suite's one message grammar
 * (`@jarenjs/core/message`): `{name}` substitutes a parameter and `{{` is
 * a literal brace. A locale pack translates these ids; {@link rulesText}
 * renders through such a pack, compiled, falling back to this English per
 * id.
 *
 * Deliberately not here: the rule document itself, the field labels the
 * schema supplies (its `title`, through `@jarenjs/forms`), a preview
 * service's own diagnostics and error text (quoted as given), and the
 * developer-facing refusals of a host that misconfigured the editor.
 */

import { compileMessageCatalog } from '@jarenjs/core/message';

/**
 * The rules English catalog: message id → template or render closure.
 * Frozen; a locale pack supplies the same ids.
 * @type {Readonly<Record<string, string | ((params: any) => string)>>}
 */
export const rulesMessagesEn = /*#__PURE__*/ Object.freeze({
  // ——— the editor's controls ———
  'rules/editor': 'Rule editor',
  'rules/target': 'Target',
  'rules/target/name': 'Rule target',
  'rules/field': 'Writable field',
  'rules/enabled': 'Enabled',
  'rules/enabled/name': 'Target enabled',
  'rules/document': 'Rule document',
  'rules/fields': 'Available schema fields',
  'rules/preview': 'Preview rules',
  'rules/commit': 'Commit selected ({count})',

  // ——— the status line and the review ———
  'rules/status/previewing': 'Evaluating preview…',
  'rules/status/review': '{changes} proposed changes · {selected} selected',
  'rules/diagnostics': 'Preview diagnostics',
  'rules/diagnostics/omitted': '{count} further diagnostics omitted by the configured limit.',
  'rules/changes': 'Proposed changes',
  'rules/change/absent': '(absent)',
  'rules/pages': 'Preview pages',
  'rules/page/previous': 'Previous',
  'rules/page/of': 'Page {page} of {pages}',
  'rules/page/next': 'Next',

  // ——— the outcome the editor writes into its state ———
  'rules/message/check': 'Check the rule document.',
  'rules/message/preview-failed': 'Preview failed: {reason}',
  'rules/message/committed': 'Selected changes committed.',
  'rules/message/refused': 'Command refused. Preview current data again.',
  'rules/message/failed': 'Command failed. Preview current data again.',
});

/**
 * The English catalog, compiled on first use: the fallback of every id.
 * @type {Readonly<Record<string, (params: object) => string>> | undefined}
 */
let english;

/**
 * A text function over a compiled catalog: `t(id, params)` renders `id`
 * through `catalog` (the output of `compileMessageCatalog` over a locale
 * pack: a record of render functions) and falls back to the English of
 * {@link rulesMessagesEn} per id — when the catalog lacks the id, or its
 * entry throws or answers something other than a string. With no catalog
 * every id renders its English.
 * @param {Readonly<Record<string, unknown>> | null} [catalog] - a compiled catalog, or none for English
 * @returns {(id: string, params?: Record<string, unknown>) => string}
 */
export function rulesText(catalog) {
  return function rulesMessage(id, params = {}) {
    const render = catalog != null && Object.hasOwn(catalog, id) ? catalog[id] : undefined;
    if (typeof render === 'function') {
      try {
        const text = render(params);
        if (typeof text === 'string') return text;
      }
      catch { /* a throwing translation renders the English */ }
    }
    english ??= compileMessageCatalog(rulesMessagesEn);
    return Object.hasOwn(english, id) ? english[id](params) : id;
  };
}
