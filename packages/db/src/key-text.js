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

/** A plain decimal literal — the only shape a number's stored text has. */
const DECIMAL = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;

/**
 * Whether a key read back from the key column names a document's key
 * member: the same value, its canonical text, or — for a number — the
 * spelling an earlier node:sqlite write stored for it (`'7.0'`), which
 * reads back as the same number. A string that merely parses to the
 * number (`'0x7'`, `'7 '`) is a different key.
 * @param {unknown} documentKey - the member the document carries
 * @param {unknown} stored - the key column's value
 * @returns {boolean}
 */
export function storedKeyMatches(documentKey, stored) {
  if (documentKey === stored) return true;
  if (typeof documentKey !== 'number' || typeof stored !== 'string') return false;
  return stored === JSON.stringify(documentKey)
    || (DECIMAL.test(stored) && Number(stored) === documentKey);
}
