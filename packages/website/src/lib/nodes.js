//@ts-check
/** Shared render vocabulary used by the site's boundaries. */
import {
  p as studioP, cards as studioCards, table as studioTable, callout as studioCallout, chart as studioChart,
} from '@jarenjs/studio/component';
import { saidBySite } from '../messages.js';

export { code, errorMessage, error, details, article, search, more } from '@jarenjs/studio/component';

/**
 * The language of a paragraph the site writes: English by design (marked,
 * so a screen reader pronounces it right and it reads left to right in a
 * right-to-left page), unless the site's catalog said it.
 * @param {unknown} text
 * @returns {'en' | null}
 */
const proseLang = (text) => (typeof text !== 'string' || text === '' || saidBySite(text) ? null : 'en');

/** The member that marks a text English, or none. @param {string} name @param {unknown} text */
const marked = (name, text) => (proseLang(text) === 'en' ? { [name]: 'en' } : {});

/** A paragraph. @param {string} text */
export const p = (text) => ({ ...studioP(text), ...marked('lang', text) });

/** A row of stat cards, each note marked by its language. @param {any[]} items */
export const cards = (items) => {
  const node = studioCards(items);
  return { ...node, items: node.items.map((/** @type {any} */ item) => ({ ...item, ...marked('noteLang', item.note) })) };
};

/** A table, its note marked by its language. @type {typeof studioTable} */
export const table = (title, head, rows, note) => ({ ...studioTable(title, head, rows, note), ...marked('noteLang', note) });

/** A callout, its text marked by its language. @type {typeof studioCallout} */
export const callout = (title, text, href, link) => ({ ...studioCallout(title, text, href, link), ...marked('lang', text) });

/** A chart card, its note marked by its language. @type {typeof studioChart} */
export const chart = (title, vnode, note) => ({ ...studioChart(title, vnode, note), ...marked('noteLang', note) });
