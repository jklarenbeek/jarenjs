//@ts-check
/**
 * @file `@jarenjs/core/convert` — pure, deterministic quantity
 * conversion. Fixed-factor dimensional conversion (`convert`) plus the
 * pure rate-table primitive `convertCurrency` (the caller supplies the
 * table; core never fetches). Zero runtime dependencies.
 */

export { DIMENSIONS, UNIT_INDEX } from './registry.js';
export { convert, unitsOf, dimensions, dimensionOf } from './convert.js';
export { convertCurrency, currenciesOf } from './currency.js';
