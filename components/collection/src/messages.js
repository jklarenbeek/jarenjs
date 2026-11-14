//@ts-check
/**
 * @file The collection's English message catalog: every word of chrome
 * the collection shows a reader (the grid's accessible name, the
 * placeholder of a row still loading, the drag overlay and the drag
 * live-region announcements), keyed by a stable `collection/...` id in
 * the suite's one message grammar (`@jarenjs/core/message`): `{name}`
 * substitutes a parameter and `{{` is a literal brace. A locale pack
 * translates these ids; {@link collectionText} renders through such a
 * pack, compiled, falling back to this English per id.
 *
 * Deliberately not here: the cells (the host's `renderCell`), the row
 * keys and column keys an announcement names, the reason codes a
 * cancelled drag reports (`cancelled`, …), and the developer-facing
 * refusals of a host that misconfigured a credit.
 */

import { compileMessageCatalog } from '@jarenjs/core/message';

/**
 * The collection English catalog: message id → template or render closure.
 * Frozen; a locale pack supplies the same ids.
 * @type {Readonly<Record<string, string | ((params: any) => string)>>}
 */
export const collectionMessagesEn = /*#__PURE__*/ Object.freeze({
  // ——— the grid ———
  'collection/label': 'Collection',
  'collection/loading': 'Loading…',

  // ——— dragging: the overlay beside the pointer, then the live region ———
  'collection/drag/copy': 'Copy {item}',
  'collection/drag/move': 'Move {item}',
  'collection/drag/copying': 'Copying {source}. Enter to drop, Escape to cancel.',
  'collection/drag/moving': 'Moving {source}. Enter to drop, Escape to cancel.',
  'collection/drag/copying-to': 'Copying {source} to {target}, {column}. Enter to drop, Escape to cancel.',
  'collection/drag/moving-to': 'Moving {source} to {target}, {column}. Enter to drop, Escape to cancel.',
  'collection/drag/accepted': 'Drop accepted.',
  'collection/drag/cancelled': 'Drag cancelled: {reason}.',
  'collection/drag/checking': 'Checking drop.',
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
 * {@link collectionMessagesEn} per id — when the catalog lacks the id, or its
 * entry throws or answers something other than a string. With no catalog
 * every id renders its English.
 * @param {Readonly<Record<string, unknown>> | null} [catalog] - a compiled catalog, or none for English
 * @returns {(id: string, params?: Record<string, unknown>) => string}
 */
export function collectionText(catalog) {
  return function collectionMessage(id, params = {}) {
    const render = catalog != null && Object.hasOwn(catalog, id) ? catalog[id] : undefined;
    if (typeof render === 'function') {
      try {
        const text = render(params);
        if (typeof text === 'string') return text;
      }
      catch { /* a throwing translation renders the English */ }
    }
    english ??= compileMessageCatalog(collectionMessagesEn);
    return Object.hasOwn(english, id) ? english[id](params) : id;
  };
}
