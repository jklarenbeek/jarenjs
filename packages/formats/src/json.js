//@ts-check

import {
  isValidJSONPointer,
  isValidJSONPointerUriFragment,
  isValidRelativeJSONPointer,
  isValidJSONPathStrict,
} from '@jarenjs/json';

import { createStringFormatCompiler } from './string.js';

/**
 * @typedef {import('@jarenjs/validate').ValidationObject} ValidationObject
 * @typedef {import('@jarenjs/validate').JSONSchema} JSONSchema
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
export const compileJsonPointerFormat = createStringFormatCompiler('json-pointer', isValidJSONPointer);

/**
 * Compiles a validator for the 'json-pointer-uri-fragment' format.
 * Validates JSON Pointer URI fragment strings (e.g., #/foo/bar).
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileJsonPointerUriFragmentFormat = createStringFormatCompiler('json-pointer-uri-fragment', isValidJSONPointerUriFragment);

/**
 * Compiles a validator for the 'relative-json-pointer' format.
 * Validates Relative JSON Pointer strings.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileRelativeJsonPointerFormat = createStringFormatCompiler('relative-json-pointer', isValidRelativeJSONPointer);

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
export const compileJsonPathFormat = createStringFormatCompiler('json-path', isValidJSONPathStrict);

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
};
