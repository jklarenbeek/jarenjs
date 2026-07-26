//@ts-check

// The name -> predicate bindings live in ONE place: testers.js. This
// module only wraps them in the validator's compiler contract.
import { jsonFormatTesters } from './testers.js';

import { createStringFormatCompiler } from './string.js';

/**
 * @typedef {{format?: string, formatMinimum?: string, formatExclusiveMinimum?: string, formatMaximum?: string, formatExclusiveMaximum?: string}} JSONSchema
 * @typedef {{
 *   options: {skipErrors: boolean},
 *   createErrorHandler: (expected: any, key: string, ...details: any[]) => (data: any, dataPath?: string) => boolean
 * }} ValidationObject
 */

// =============================================================================
// JSON Pointer Format Compilers
// =============================================================================

/**
 * Compiles a validator for the 'json-pointer' format.
 * Validates JSON Pointer strings per RFC 6901.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileJsonPointerFormat = createStringFormatCompiler('json-pointer', jsonFormatTesters['json-pointer']);

/**
 * Compiles a validator for the 'json-pointer-uri-fragment' format.
 * Validates JSON Pointer URI fragment strings (e.g., #/foo/bar).
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileJsonPointerUriFragmentFormat = createStringFormatCompiler('json-pointer-uri-fragment', jsonFormatTesters['json-pointer-uri-fragment']);

/**
 * Compiles a validator for the 'relative-json-pointer' format.
 * Validates Relative JSON Pointer strings.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileRelativeJsonPointerFormat = createStringFormatCompiler('relative-json-pointer', jsonFormatTesters['relative-json-pointer']);

// =============================================================================
// JSONPath Format Compiler (RFC 9535)
// =============================================================================

/**
 * Compiles a validator for the 'json-path' format.
 * Validates JSONPath query expressions strictly against the complete
 * RFC 9535 grammar, using the parser of the JSONPath compiler in
 * `@jarenjs/json`. This includes the well-typedness rules for
 * function expressions, so queries like `$[?length(@)]` or comparisons
 * against non-singular queries are rejected.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 * @example
 * compileJsonPathFormat(schemaObj, { format: 'json-path' })('$.store.book[0].title'); // true
 * compileJsonPathFormat(schemaObj, { format: 'json-path' })("$..book[?@.price < 10]"); // true
 * compileJsonPathFormat(schemaObj, { format: 'json-path' })('@.name'); // false (queries start at $)
 * compileJsonPathFormat(schemaObj, { format: 'json-path' })('$.foo '); // false (trailing whitespace)
 */
export const compileJsonPathFormat = createStringFormatCompiler('json-path', jsonFormatTesters['json-path']);

/**
 * Compiles a validator for the 'json-path-segments' format.
 * Validates a *variable-rooted* path string: `$name` followed by
 * optional RFC 9535 segments (`$book.price[?@.isbn]`). Such a string is
 * not a valid RFC 9535 query — the RFC's root identifier is `$` alone —
 * so `json-path` would reject it; this format is what gives the Jaren
 * query format's variable-rooted paths the same schema-time
 * well-formedness that absolute paths get from `json-path`.
 *
 * Both formats recognize the five built-in function extensions and no
 * others: a format is a property of the string itself, so it must mean
 * the same thing in every schema regardless of which custom extensions
 * a particular host registered.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 * @example
 * compileJsonPathSegmentsFormat(schemaObj, { format: 'json-path-segments' })('$book.price'); // true
 * compileJsonPathSegmentsFormat(schemaObj, { format: 'json-path-segments' })('$book'); // true
 * compileJsonPathSegmentsFormat(schemaObj, { format: 'json-path-segments' })('$.price'); // false (that is json-path)
 * compileJsonPathSegmentsFormat(schemaObj, { format: 'json-path-segments' })('$book.price['); // false
 */
export const compileJsonPathSegmentsFormat = createStringFormatCompiler('json-path-segments', jsonFormatTesters['json-path-segments']);

// =============================================================================
// Aggregated Format Validators Object
// =============================================================================

/**
 * Object mapping JSON-related format names to their compiler functions.
 *
 * @type {Record<string, (schemaObj: ValidationObject, jsonSchema: JSONSchema) => (data: unknown, dataPath?: string) => boolean>}
 */
export const formatValidators = {
  // JSON Pointer
  'json-pointer': compileJsonPointerFormat,
  'json-pointer-uri-fragment': compileJsonPointerUriFragmentFormat,
  'relative-json-pointer': compileRelativeJsonPointerFormat,
  // JSONPath
  'json-path': compileJsonPathFormat,
  'json-path-segments': compileJsonPathSegmentsFormat,
};
