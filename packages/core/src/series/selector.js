//@ts-check

//#region Reading a source row
// Where a member lives in a caller's row, and nothing else.
//
// Timestamped rows almost never arrive spelled `{ at, value }` or
// `{ start, end }`. They come out of a document as `on`, out of a
// database as `recorded_at`, out of a booking system as `from`/`to`. A
// selector is either that member's name or a function of the row, so
// nothing has to be rewritten into the canonical shape before it can be
// normalized or indexed.
//
// This module imports nothing on purpose: it is the leaf both the
// normalizer and the index stand on.

/**
 * A reader for one member of a source row.
 * @param {string | ((item: any, index: number) => any)} spec - a
 *   property name, or a function of the row and its position
 * @param {string} role - the member's name, for the message
 * @returns {(item: any, index: number) => any}
 * @throws {TypeError} when `spec` is neither
 */
export function selectorOf(spec, role) {
  if (typeof spec === 'string')
    return (item) => item[spec];
  if (typeof spec === 'function')
    return spec;
  throw new TypeError(`the '${role}' selector is a property name or a function`);
}

/**
 * The row at `index`, confirmed to be something with members to read.
 * @param {any} item
 * @param {number} index
 * @returns {any}
 * @throws {TypeError} when it is not an object
 */
export function requireRow(item, index) {
  if (item === null || typeof item !== 'object')
    throw new TypeError(`row ${index} is not an object`);
  return item;
}

//#endregion
