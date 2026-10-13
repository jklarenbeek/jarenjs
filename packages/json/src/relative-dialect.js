//#region Relative JSON Pointer dialect option (package-internal)
// The grammar of a Relative JSON Pointer exists in two revisions. The format
// tester in basic.js and the parser in pointer.js are two implementations of
// it and must read the same option the same way, so the reading lives here;
// the module is package-internal and not listed in the package exports.

/**
 * Which revision of the Relative JSON Pointer grammar a call speaks.
 *
 * - `'handrews-01'` (the default) is draft-handrews-relative-json-pointer-01,
 *   the revision JSON Schema 2020-12 normatively references and the official
 *   `relative-json-pointer` format suite asserts: a non-negative integer, then
 *   `#` or a JSON Pointer.
 * - `'bhutton-00'` is draft-bhutton-relative-json-pointer-00, which adds the
 *   index manipulation between the integer and what follows it: a `+` or `-`
 *   and a non-negative integer (`0+1`, `1-1/name`, `0-1#`).
 * @typedef {'handrews-01'|'bhutton-00'} RelativePointerDialect
 */

/**
 * Read the `dialect` option, defaulting to `'handrews-01'`. An unknown value
 * is rejected rather than ignored: silently falling back would answer a
 * caller who meant `'bhutton-00'` with the grammar they were opting out of.
 * @param {{ dialect?: RelativePointerDialect }|undefined|null} options
 * @returns {boolean} true when index manipulation is part of the grammar
 * @throws {TypeError} When `dialect` is neither accepted spelling
 */
export function readIndexShiftDialect(options) {
  if (options === undefined || options === null)
    return false;
  const dialect = options.dialect;
  if (dialect === undefined || dialect === 'handrews-01')
    return false;
  if (dialect === 'bhutton-00')
    return true;
  throw new TypeError(
    `dialect must be 'handrews-01' or 'bhutton-00', got ${JSON.stringify(dialect)}`);
}

//#endregion
