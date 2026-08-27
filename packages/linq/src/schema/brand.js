//@ts-check
/**
 * @file The schema-builder brand: how anything outside the pen tells a
 * builder from the document it writes. The brand is a registry symbol
 * (`Symbol.for`), so the chain — which imports nothing from this
 * directory, by the tree-shaking rule — recognises a builder handed to
 * `ofType`/`cast` by looking the same symbol up; a data object that
 * merely carries a `toJSON` member is a schema, never a builder.
 */

/** The brand key every builder answers `true` under. */
export const SCHEMA_BUILDER = Symbol.for('@jarenjs/linq/schema-builder');

/**
 * Whether `value` is a schema builder (carries the brand).
 * @param {any} value
 * @returns {boolean}
 */
export function isSchemaBuilder(value) {
  return value !== null && typeof value === 'object' && value[SCHEMA_BUILDER] === true;
}

/**
 * A builder's document, or the value as given: the one call a consumer
 * needs to accept "a schema, by hand or by pen".
 * @param {any} value
 * @returns {any} the JSON Schema document
 */
export function schemaOf(value) {
  return isSchemaBuilder(value) ? value.schema : value;
}
