//@ts-check
/**
 * What Monkey Grove says, in English and Dutch: the HUD, the prompts,
 * Mimi's lines, the praise and every explanation a wrong answer earns.
 * The table is a JSON document (`strings.json`) with one map per
 * language and the same keys in both; `t` fills a line's `{name}`
 * placeholders. A placeholder with no value stays visible as `{name}`,
 * so a line missing its numbers is caught by the tests, never shown as
 * a silent gap.
 */

import STRINGS from './strings.json' with { type: 'json' };

/** @typedef {'en' | 'nl'} Lang */

/** The languages the game speaks. */
export const LANGS = Object.freeze(/** @type {Lang[]} */ (['en', 'nl']));

/** The string tables, by language. */
export const TABLES = /** @type {Readonly<Record<Lang, Readonly<Record<string, string>>>>} */ (STRINGS);

/**
 * A language the game speaks, or English.
 * @param {unknown} lang @returns {Lang}
 */
export function langOf(lang) {
  return lang === 'nl' ? 'nl' : 'en';
}

/**
 * A line in a language with its placeholders filled.
 * @param {Lang} lang @param {string} key @param {Record<string, unknown>} [vars]
 * @returns {string} the line, or the key itself when no table has it
 */
export function t(lang, key, vars = {}) {
  const line = TABLES[lang][key] ?? key;
  return line.replace(/\{(\w+)\}/g, (whole, name) => (vars[name] === undefined || vars[name] === null ? whole : String(vars[name])));
}

/**
 * Whether a key is a line the game has.
 * @param {string} key
 */
export function hasLine(key) {
  return Object.hasOwn(TABLES.en, key);
}
