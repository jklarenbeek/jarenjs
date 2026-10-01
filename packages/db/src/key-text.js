//@ts-check
/**
 * @file One key, one spelling (MODEL-FORMAT §5): the text a collection
 * key is bound as on a TEXT key column, and the reading that recognizes
 * a key stored before that spelling was the only one.
 *
 * A JavaScript number reaching a TEXT key column used to be bound as the
 * driver chose: node:sqlite binds it as a REAL, so SQLite stored `7` as
 * `'7.0'`, while Bun binds an integer-valued number as an INTEGER and
 * stored `'7'` — one key, two rows on a file both runtimes wrote. Every
 * driver now binds its canonical JSON text; the store still finds (and
 * converges) a row an earlier node write stored.
 */

/**
 * The text a key is bound as on a TEXT key column: a string as it is, a
 * number as its canonical JSON text (`'7'`, `'1.5'`) on every driver.
 * @param {string | number} key
 * @returns {string | number}
 */
export function canonicalKeyText(key) {
  return typeof key === 'number' ? JSON.stringify(key) : key;
}

/** A decimal number as both engines read text into a numeric column: an
 * optional sign, digits with an optional fraction (or a bare fraction), an
 * optional exponent, white space around it. */
const DECIMAL_TEXT = /^[ \t\n\v\f\r]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\v\f\r]*$/;

/**
 * Whether a key names no row of a NUMERIC key column: a string that is no
 * decimal number. SQLite compares such text with the column's numbers and
 * finds nothing, while PostgreSQL refuses to read it as a number at all
 * (and on a transaction spends the transaction), so a lookup binds it as
 * NULL — which matches no row on either engine — and answers absent.
 * @param {unknown} key
 * @returns {boolean}
 */
export function namesNoNumber(key) {
  return typeof key === 'string' && !DECIMAL_TEXT.test(key);
}

/**
 * The text SQLite stores for a floating-point value in a TEXT column: a
 * decimal point always, no zero beyond the single `.0` of an integer, and
 * a signed exponent of two digits or more (`'7.0'`, `'0.1'`, `'1.0e+21'`,
 * `'1.0e-07'`). A string that merely parses to a number — `'0042'`,
 * `'1e3'`, `'7.00'` — is not one SQLite wrote, so it is another key.
 */
const SQLITE_REAL = /^-?(?:0|[1-9]\d*)\.(?:0|\d*[1-9])(?:e[+-]\d{2,})?$/;

/**
 * Whether a key read back from the key column names a document's key
 * member: the same value, its canonical text, or — for a number — the
 * spelling an earlier node:sqlite write stored for it (`'7.0'`), which
 * reads back as the same number. Any other text that parses to the number
 * (`'0042'`, `'1e3'`, `'0x7'`, `'7 '`) is a different key. A spelling an
 * older SQLite rounded to fifteen digits (`'1.23456789012346e+15'`) no
 * longer names the number, and matches nothing.
 * @param {unknown} documentKey - the member the document carries
 * @param {unknown} stored - the key column's value
 * @returns {boolean}
 */
export function storedKeyMatches(documentKey, stored) {
  if (documentKey === stored) return true;
  if (typeof documentKey !== 'number' || typeof stored !== 'string') return false;
  return stored === JSON.stringify(documentKey)
    || (SQLITE_REAL.test(stored) && Number(stored) === documentKey);
}
