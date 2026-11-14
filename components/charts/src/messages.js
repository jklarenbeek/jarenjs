//@ts-check
/**
 * @file The charts engine's English message catalog: the words a chart
 * itself adds to what its definition says (the mark a series that reads
 * the right axis carries in its legend entry and hover text), keyed by a
 * stable `charts/...` id in the suite's one message grammar
 * (`@jarenjs/core/message`): `{name}` substitutes a parameter and `{{` is
 * a literal brace. A locale pack translates these ids; {@link chartsText}
 * renders through such a pack, compiled, falling back to this English per
 * id.
 *
 * Deliberately not here: every title, axis label, series and slice name
 * (the definition's own text, in whatever language it is written), the
 * tick labels (numbers and dates, formatted by the core kernels), and the
 * developer-facing refusals of a malformed definition. The benchmark
 * adapter's axis titles are the benchmarks page's own English: most of its
 * builders take a `title`/`valLabel` override, and the rest write the page's
 * fixed wording.
 */

import { compileMessageCatalog } from '@jarenjs/core/message';

/**
 * The charts English catalog: message id → template or render closure.
 * Frozen; a locale pack supplies the same ids.
 * @type {Readonly<Record<string, string | ((params: any) => string)>>}
 */
export const chartsMessagesEn = /*#__PURE__*/ Object.freeze({
  'charts/series/right-axis': '{name} (right axis)',
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
 * {@link chartsMessagesEn} per id — when the catalog lacks the id, or its
 * entry throws or answers something other than a string. With no catalog
 * every id renders its English.
 * @param {Readonly<Record<string, unknown>> | null} [catalog] - a compiled catalog, or none for English
 * @returns {(id: string, params?: Record<string, unknown>) => string}
 */
export function chartsText(catalog) {
  return function chartsMessage(id, params = {}) {
    const render = catalog != null && Object.hasOwn(catalog, id) ? catalog[id] : undefined;
    if (typeof render === 'function') {
      try {
        const text = render(params);
        if (typeof text === 'string') return text;
      }
      catch { /* a throwing translation renders the English */ }
    }
    english ??= compileMessageCatalog(chartsMessagesEn);
    return Object.hasOwn(english, id) ? english[id](params) : id;
  };
}
