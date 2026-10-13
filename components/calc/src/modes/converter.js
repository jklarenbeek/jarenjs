//@ts-check
/**
 * @file The converter mode kernel. Static dimensions call
 * `@jarenjs/core/convert`'s `convert(...)`, the **currency** dimension calls
 * the pure `convertCurrency(value, from, to, rateTable)` with the live table
 * from `$.calc.rates`, and the **fuel** dimension calls `convertFuel` (fuel
 * economy is reciprocal, which core's affine registry cannot hold). The
 * component's rates layer is the only place that fetches a rate; this module
 * never does.
 */

import {
  convert, unitsOf, dimensions, convertCurrency, currenciesOf,
} from '@jarenjs/core/convert';
import { formatNumber } from '@jarenjs/core/math';
import { FUEL, FUEL_UNITS, convertFuel } from './fuel.js';

/** Currency is a fifth, rate-table-backed dimension beside the static ones. */
export const CURRENCY = 'currency';

/**
 * All selectable dimensions (static core dimensions, fuel economy, currency).
 * @returns {string[]}
 */
export function converterDimensions() {
  return [...dimensions(), FUEL, CURRENCY];
}

/**
 * The unit options for a dimension. Static dimensions come from core, fuel
 * economy from its own unit list; the currency dimension enumerates the codes
 * present in `rates`.
 * @param {string} dimension
 * @param {any} [rates] the rate table (currency only)
 * @returns {Array<{ id: string, symbol: string }>}
 */
export function unitOptions(dimension, rates) {
  if (dimension === CURRENCY) {
    return currenciesOf(rates ?? {}).map((code) => ({ id: code, symbol: code }));
  }
  if (dimension === FUEL) return FUEL_UNITS.map((u) => ({ id: u.id, symbol: u.symbol }));
  return unitsOf(dimension).map((u) => ({ id: u.id, symbol: u.symbol }));
}

/**
 * Convert a value in a dimension. Static dimensions go to core's `convert`,
 * currency to its pure `convertCurrency`, fuel economy to `convertFuel`.
 * Returns `NaN` (never throws) so the display path stays total; a conversion
 * the dimension refuses (a negative fuel economy, 0 L/100km as mpg) is `NaN`.
 *
 * @param {string} dimension @param {number} value @param {string} from @param {string} to
 * @param {any} [rates] the rate table (currency only)
 * @returns {number}
 */
export function convertValue(dimension, value, from, to, rates) {
  try {
    if (dimension === CURRENCY) return convertCurrency(value, from, to, rates ?? {});
    if (dimension === FUEL) return convertFuel(value, from, to);
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
