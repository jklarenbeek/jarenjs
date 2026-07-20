//@ts-check
/**
 * @file The pure currency-conversion primitive (Part A-convert, design
 * decision D12/D13). `convertCurrency` is deterministic and side-effect
 * free: the caller supplies the `{ code: rate }` table; core NEVER
 * fetches it. This lives in core because the dividing line is **purity**,
 * not constant-vs-variable factors — this function is exactly as pure as
 * the fixed-factor path, it just receives its factors as an argument.
 * Fetching the table is the impure half and stays in the app component.
 *
 * Rate convention: `rateTable[code]` is the value of ONE unit of `code`
 * expressed in the table's base currency (so the base currency has rate
 * 1). To convert `value` from → to:
 *
 *   result = value * rate[from] / rate[to]
 */

/**
 * @typedef {object} RateTable
 * @property {string} [base] the base currency code (informational)
 * @property {Record<string, number>} rates code → value-in-base
 * @property {number|string} [at] timestamp of the table (informational)
 */

/**
 * Resolve a rate for `code` from a table that may be either the
 * `{ rates: {...} }` envelope or a bare `{ code: rate }` map.
 * @param {RateTable | Record<string, number>} rateTable
 * @param {string} code
 * @returns {number|undefined}
 */
function rateFor(rateTable, code) {
  if (rateTable && typeof rateTable === 'object' && 'rates' in rateTable
    && rateTable.rates && typeof rateTable.rates === 'object') {
    return /** @type {any} */ (rateTable).rates[code];
  }
  return /** @type {any} */ (rateTable)?.[code];
}

/**
 * Convert an amount between currencies using a supplied rate table.
 * Throws a `RangeError` when either code is missing from the table (the
 * component decides how to fall back — a static table, a last-good cache).
 *
 * @param {number} value
 * @param {string} from
 * @param {string} to
 * @param {RateTable | Record<string, number>} rateTable
 * @returns {number}
 */
export function convertCurrency(value, from, to, rateTable) {
  if (from === to) return value;
  const rFrom = rateFor(rateTable, from);
  const rTo = rateFor(rateTable, to);
  if (typeof rFrom !== 'number' || !isFinite(rFrom)) {
    throw new RangeError(`convertCurrency: no rate for '${from}'`);
  }
  if (typeof rTo !== 'number' || !isFinite(rTo) || rTo === 0) {
    throw new RangeError(`convertCurrency: no rate for '${to}'`);
  }
  return (value * rFrom) / rTo;
}

/**
 * The currency codes available in a rate table.
 * @param {RateTable | Record<string, number>} rateTable
 * @returns {string[]}
 */
export function currenciesOf(rateTable) {
  const rates = (rateTable && typeof rateTable === 'object' && 'rates' in rateTable)
    ? /** @type {any} */ (rateTable).rates
    : rateTable;
  return rates ? Object.keys(rates) : [];
}
