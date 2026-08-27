//@ts-check
/**
 * @file The chain's side of the schema-builder brand. `ofType`/`cast`
 * accept a builder from `@jarenjs/linq/schema` where a document was,
 * and take its document — recognised by the registry symbol the pen
 * brands its builders with, never by `toJSON` duck-typing (a data
 * object with a `toJSON` member is a schema, not a builder). The
 * symbol is looked up by key so the chain imports nothing from the
 * pen's directory and a chain-only bundle carries none of it.
 */

/** The brand key `@jarenjs/linq/schema` answers `true` under. */
const SCHEMA_BUILDER = Symbol.for('@jarenjs/linq/schema-builder');

/**
 * A builder's document, or the value as given.
 * @param {any} value
 * @returns {any} the JSON Schema document
 */
export function schemaOf(value) {
  return value !== null && typeof value === 'object' && value[SCHEMA_BUILDER] === true
    ? value.schema
    : value;
}
