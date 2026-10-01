//@ts-check

/**
 * The number language: the characters a number is written and read with —
 * the decimal format of XPath F&O `fn:format-number` — as catalog entries,
 * on the same flat msgid machinery as the calendar language.
 *
 * The values are repository DATA, taken from CLDR (as ICU 78.3 ships it)
 * once and committed, not looked up through `Intl` at run time: a query
 * that formats a price stays deterministic across Node versions.
 *
 *   number/decimal-separator   number/grouping-separator   number/minus-sign
 *   number/percent             number/per-mille            number/zero-digit
 *   number/exponent-separator  number/infinity             number/nan
 *   number/minimum-grouping-digits
 *
 * Every entry is one character but `infinity` and `nan`, which are words, and
 * `minimum-grouping-digits`, a count: the fewest digits the leftmost group of
 * a grouped integer part may hold (CLDR's minimum grouping digits; Spanish
 * writes 1234 but 12.345, so 2).
 */

import { compileMessageCatalog } from '@jarenjs/core/message';

/** The keys a pack covers, in record order. */
const NUMBER_KEYS = Object.freeze([
  'number/decimal-separator', 'number/grouping-separator', 'number/minus-sign', 'number/percent',
  'number/per-mille', 'number/zero-digit', 'number/exponent-separator', 'number/infinity', 'number/nan',
  'number/minimum-grouping-digits',
]);

/**
 * The English number catalog: the key set every pack covers, and the
 * entries `compileNumberLocale` falls back to.
 * @type {Record<string, string>}
 */
export const numberMessagesEn = {
  'number/decimal-separator': '.',
  'number/grouping-separator': ',',
  'number/minus-sign': '-',
  'number/percent': '%',
  'number/per-mille': '‰',
  'number/zero-digit': '0',
  'number/exponent-separator': 'E',
  'number/infinity': '∞',
  'number/nan': 'NaN',
  'number/minimum-grouping-digits': '1',
};

/**
 * A decimal format: the record `$format-number` and `$quantity` of
 * `@jarenjs/json` read (`options.decimalFormats`, or the operand itself).
 * @typedef {Object} DecimalFormat
 * @property {string} decimalSeparator
 * @property {string} groupingSeparator
 * @property {string} minusSign
 * @property {string} percent
 * @property {string} perMille
 * @property {string} zeroDigit
 * @property {string} digit
 * @property {string} patternSeparator
 * @property {string} exponentSeparator
 * @property {string} infinity
 * @property {string} NaN
 */

/**
 * Compile a catalog into its decimal format, and the minimum grouping digits
 * a number written in the language observes (`toLocaleString` translated by
 * `@jarenjs/json/formula/migrate` reads them from its language description).
 * Every key the argument leaves out falls back to English; the eleven shipped
 * packs cover the whole set. A picture's own syntax (`#` and `;`) is the same
 * in every language.
 * @param {Record<string, any>} [catalogLike] - a locale pack, or undefined for English
 * @returns {Readonly<{ decimalFormat: Readonly<DecimalFormat>, minimumGroupingDigits: number }>}
 * @throws {TypeError} when an entry does not render a non-empty string, or the
 *   minimum grouping digits are not a positive whole number
 * @example
 * import { compileJsonQuery } from '@jarenjs/json';
 * import { nl } from '@jarenjs/locales';
 * const { decimalFormat } = compileNumberLocale(nl);
 * compileJsonQuery({ '$format-number': [1234.5, '€ #.##0,00', 'nl'] }, { decimalFormats: { nl: decimalFormat } })(null);
 * // '€ 1.234,50'
 */
export function compileNumberLocale(catalogLike = undefined) {
  /** @type {Record<string, any>} */
  const picked = {};
  if (catalogLike != null) {
    for (const key of NUMBER_KEYS) if (catalogLike[key] !== undefined) picked[key] = catalogLike[key];
  }
  const compiled = compileMessageCatalog(picked);
  const read = (/** @type {string} */ key) => {
    const render = compiled[key] ?? compileMessageCatalog(numberMessagesEn)[key];
    const text = render({});
    if (typeof text !== 'string' || text === '') throw new TypeError(`the number catalog entry '${key}' must render a non-empty string`);
    return text;
  };
  const minimumGroupingDigits = Number(read('number/minimum-grouping-digits'));
  if (!Number.isSafeInteger(minimumGroupingDigits) || minimumGroupingDigits < 1)
    throw new TypeError("the number catalog entry 'number/minimum-grouping-digits' must be a positive whole number");
  return Object.freeze({
    decimalFormat: Object.freeze({
      decimalSeparator: read('number/decimal-separator'),
      groupingSeparator: read('number/grouping-separator'),
      minusSign: read('number/minus-sign'),
      percent: read('number/percent'),
      perMille: read('number/per-mille'),
      zeroDigit: read('number/zero-digit'),
      digit: '#',
      patternSeparator: ';',
      exponentSeparator: read('number/exponent-separator'),
      infinity: read('number/infinity'),
      NaN: read('number/nan'),
    }),
    minimumGroupingDigits,
  });
}
