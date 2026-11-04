//@ts-check
/**
 * @file md's message catalog: the accessible names its emitters write,
 * keyed by message id the way every catalog in the suite is, so a
 * `@jarenjs/locales` pack carries them beside the validator's and the
 * forms' messages. `labelsFromCatalog` turns a catalog into the
 * `footnotesLabel` and `labels` options every md surface takes.
 */

import { compileMessageTemplate } from '@jarenjs/core/message';
import { DEFAULT_LABELS } from './utils.js';

/** The English catalog: the ids a pack translates, over md's own defaults. */
export const mdMessagesEn = Object.freeze({
  'md/footnotes': 'Footnotes',
  'md/page-break': DEFAULT_LABELS.pageBreak,
  'md/permalink': DEFAULT_LABELS.permalink,
  'md/permalink-section': DEFAULT_LABELS.permalinkSection,
  'md/backref': DEFAULT_LABELS.backref,
  'md/backref-occurrence': DEFAULT_LABELS.backrefOccurrence,
});

/** Each label under the message id that names it. */
const LABEL_IDS = /** @type {const} */ ([
  ['pageBreak', 'md/page-break'],
  ['permalink', 'md/permalink'],
  ['permalinkSection', 'md/permalink-section'],
  ['backref', 'md/backref'],
  ['backrefOccurrence', 'md/backref-occurrence'],
]);

/**
 * The rendering options a message catalog names — `footnotesLabel` and
 * `labels` — to spread into any md surface. An entry is a template or a
 * closure, as in every catalog; an id the catalog lacks keeps md's
 * English default, and an entry of any other kind is passed on for the
 * surface to refuse.
 * @example
 * import { nl } from '@jarenjs/locales';
 * toHtml(doc, { headingIds: true, headingAnchors: true, ...labelsFromCatalog(nl) });
 * @param {Readonly<Record<string, unknown>>} catalog e.g. a `@jarenjs/locales` pack
 * @returns {{ footnotesLabel: string | undefined, labels: import('./utils.js').MdLabels }}
 */
export function labelsFromCatalog(catalog) {
  /** @type {Record<string, any>} */
  const labels = {};
  for (const [name, id] of LABEL_IDS) {
    if (catalog[id] !== undefined) labels[name] = catalog[id];
  }
  const footnotes = catalog['md/footnotes'];
  return {
    footnotesLabel: typeof footnotes === 'function' ? String(footnotes({}))
      : typeof footnotes === 'string' ? compileMessageTemplate(footnotes)({}) : /** @type {any} */ (footnotes),
    labels,
  };
}
