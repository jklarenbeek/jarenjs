//@ts-check
/**
 * @file The converter mode kernel. Contains
 * **no factors** — static dimensions call `@jarenjs/core/convert`'s
 * `convert(...)`, and the **currency** dimension calls the pure
 * `convertCurrency(value, from, to, rateTable)` with the live table from
 * `$.calc.rates`. The component's rates layer is the only place that
 * fetches a rate; this module never does.
 */

import {
  convert, unitsOf, dimensions, convertCurrency, currenciesOf,
} from '@jarenjs/core/convert';
import { formatNumber } from '@jarenjs/core/math';

/** Currency is a fifth, rate-table-backed dimension beside the static ones. */
export const CURRENCY = 'currency';

/**
 * All selectable dimensions (static core dimensions + currency).
 * @returns {string[]}
 */
export function converterDimensions() {
  return [...dimensions(), CURRENCY];
}

/**
 * The unit options for a dimension. Static dimensions come from core;
 * the currency dimension enumerates the codes present in `rates`.
 * @param {string} dimension
 * @param {any} [rates] the rate table (currency only)
 * @returns {Array<{ id: string, symbol: string }>}
 */
export function unitOptions(dimension, rates) {
  if (dimension === CURRENCY) {
    return currenciesOf(rates ?? {}).map((code) => ({ id: code, symbol: code }));
  }
  return unitsOf(dimension).map((u) => ({ id: u.id, symbol: u.symbol }));
}

/**
 * Convert a value in a dimension. Delegates entirely to core: static
 * dimensions to `convert`, currency to the pure `convertCurrency`.
 * Returns `NaN` (never throws) so the display path stays total.
 *
 * @param {string} dimension @param {number} value @param {string} from @param {string} to
 * @param {any} [rates] the rate table (currency only)
 * @returns {number}
 */
export function convertValue(dimension, value, from, to, rates) {
  try {
    if (dimension === CURRENCY) return convertCurrency(value, from, to, rates ?? {});
    return convert(value, from, to);
  }
  catch {
    return NaN;
  }
}

/** Format a converter result. @param {number} value */
export function format(value) {
  if (!Number.isFinite(value)) return '—';
  return formatNumber(value, { notation: 'auto', precision: 8, group: true });
}

export const converterMode = {
  id: 'converter',
  label: 'Converter',
  dimensions: converterDimensions,
  unitOptions,
  convertValue,
  format,
};
