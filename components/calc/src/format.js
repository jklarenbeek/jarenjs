//@ts-check
/**
 * @file The calculator's number text: a result as a reader reads it on the
 * display, the tape and the converter. A safe integer (below 2^53, where
 * every whole number is exact) shows every digit it has; any other finite
 * value shows `digits` significant digits, positional for human-scale
 * magnitudes and exponential where rounding would drop digits left of the
 * point, with no zeros padding the mantissa (`9.99e+22`).
 * `group` separates the thousands of the whole part with commas, as the
 * financial panel's amounts are. The digits are core's `formatNumber`; this
 * module chooses the precision and the reader's separators.
 */

import { formatNumber } from '@jarenjs/core/math';

/**
 * A finite or non-finite number as the display shows it, through core's
 * `formatNumber` (`notation: 'auto'`): `digits` significant digits, and a
 * safe integer with every digit it has.
 * @param {number | bigint | string} value a `Number`; any other value reads
 *   as the `Number` it converts to
 * @param {{ digits?: number, group?: boolean }} [options] significant digits
 *   (default 12) and thousands separators (default none: the text is then
 *   also an expression literal the parser reads back)
 * @returns {string}
 */
export function formatSignificant(value, options = {}) {
  // a host may patch a string into the slice: it reads as the Number it spells
  const number = typeof value === 'number' ? value : Number(value);
  const digits = options.digits ?? 12;
  const precision = Number.isSafeInteger(number) ? Math.max(digits, String(Math.abs(number)).length) : digits;
  return formatNumber(number, { notation: 'auto', precision, group: options.group === true });
}

/**
 * A number with exactly `decimals` fraction digits and grouped thousands,
 * an amount of money in its currency's minor units (`92.59`, `13,736`),
 * through core's `formatNumber` (`notation: 'fixed'`); a zero that rounded
 * from below shows no sign.
 * @param {number} value
 * @param {number} decimals
 * @returns {string}
 */
export function formatFixed(value, decimals) {
  const text = formatNumber(value, { notation: 'fixed', precision: decimals, group: true });
  return /^-0(\.0*)?$/.test(text) ? text.slice(1) : text;
}

/**
 * The decimal and grouping separators of a reader's compiled catalog (the
 * `number/decimal-separator` and `number/grouping-separator` entries a
 * `@jarenjs/locales` pack carries), else the English `.` and `,`.
 * @param {Readonly<Record<string, unknown>> | null | undefined} catalog
 * @returns {{ decimal: string, group: string }}
 */
export function numberSymbols(catalog) {
  /** @param {string} id @param {string} fallback */
  const read = (id, fallback) => {
    const render = catalog != null && Object.hasOwn(catalog, id) ? catalog[id] : undefined;
    if (typeof render !== 'function') return fallback;
    try {
      const text = render({});
      return typeof text === 'string' && text !== '' ? text : fallback;
    }
    catch { return fallback; }
  };
  return { decimal: read('number/decimal-separator', '.'), group: read('number/grouping-separator', ',') };
}

/**
 * A number this module formatted (`.` decimal, `,` grouping) in the
 * reader's separators: `-1,199.10` reads `-1.199,10` to a Dutch reader.
 * @param {string} text
 * @param {{ decimal: string, group: string }} symbols
 * @returns {string}
 */
export function localizeNumber(text, symbols) {
  if (symbols.decimal === '.' && symbols.group === ',') return text;
  return text.replace(/[.,]/g, (c) => (c === '.' ? symbols.decimal : symbols.group));
}
