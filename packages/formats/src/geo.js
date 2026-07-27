//@ts-check

// The name -> predicate bindings live in ONE place: testers.js. This
// module only wraps them in the validator's compiler contract.
import { geoFormatTesters } from './testers.js';

import { createStringFormatCompiler } from './string.js';

/**
 * @typedef {{format?: string, formatMinimum?: string, formatExclusiveMinimum?: string, formatMaximum?: string, formatExclusiveMaximum?: string}} JSONSchema
 * @typedef {{
 *   options: {skipErrors: boolean},
 *   createErrorHandler: (expected: any, key: string, ...details: any[]) => (data: any, dataPath?: string) => boolean
 * }} ValidationObject
 */

// =============================================================================
// Geospatial Format Compilers
// =============================================================================

/**
 * Compiles a validator for the 'geohash' format.
 * Validates geohash strings: any length, every character in the
 * base-32 geohash alphabet.
 *
 * @param {ValidationObject} schemaObj - The validation object for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 * @example
 * compileGeohashFormat(schemaObj, { format: 'geohash' })('u173z'); // true
 * compileGeohashFormat(schemaObj, { format: 'geohash' })('u17a'); // false ('a' is not in the alphabet)
 */
export const compileGeohashFormat = createStringFormatCompiler('geohash', geoFormatTesters['geohash']);

/**
 * Compiles a validator for the 'wkt' format.
 * Validates Well-Known Text geometry strings (ISO 19125 / OGC Simple
 * Features): the seven tagged geometry types with optional Z/M/ZM
 * modifiers, consistent coordinate counts, and closed polygon rings.
 *
 * @param {ValidationObject} schemaObj - The validation object for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 * @example
 * compileWktFormat(schemaObj, { format: 'wkt' })('POINT (4.9041 52.3676)'); // true
 * compileWktFormat(schemaObj, { format: 'wkt' })('POLYGON ((0 0, 4 0, 4 4, 1 1))'); // false (open ring)
 */
export const compileWktFormat = createStringFormatCompiler('wkt', geoFormatTesters['wkt']);

/**
 * Compiles a validator for the 'geojson' format. Unlike the string
 * formats, this one applies to **objects**: any non-array object must be
 * a structurally valid GeoJSON object (RFC 7946) — the coordinate
 * nesting its `type` requires, positions inside the WGS 84 bounds, and
 * every linear ring closed. Non-object values pass, following the rule
 * that a format constrains only its own type.
 *
 * This is the quick, shallow judgment; the GeoJSON meta-schema artifacts
 * in `@jarenjs/json` validate the same grammar more thoroughly (locating
 * the failure, and — in the Jaren-extended variant — checking ring
 * winding through `$query`). Reach for the schema when you want to know
 * *what* is wrong; reach for the format when a one-keyword annotation is
 * worth more than a diagnosis.
 *
 * @param {ValidationObject} schemaObj - The validation object for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 * @example
 * compileGeoJsonFormat(schemaObj, { format: 'geojson' })({ type: 'Point', coordinates: [4.9, 52.4] }); // true
 * compileGeoJsonFormat(schemaObj, { format: 'geojson' })({ type: 'Polygon', coordinates: [[[0,0],[1,0],[1,1],[2,2]]] }); // false (open ring)
 * compileGeoJsonFormat(schemaObj, { format: 'geojson' })('not an object'); // true (wrong type is not this format's business)
 */
export function compileGeoJsonFormat(schemaObj, jsonSchema) {
  if (jsonSchema.format !== 'geojson')
    throw new Error('Format is not equal to jsonSchema (should not happen!)');

  const isGeoJson = geoFormatTesters['geojson'];

  if (schemaObj.options.skipErrors) {
    return function validateGeoJsonFormatFast(data, _dataPath) {
      return data === null || typeof data !== 'object' || Array.isArray(data)
        ? true
        : isGeoJson(data);
    };
  }

  const addError = schemaObj.createErrorHandler('geojson', 'format', isGeoJson.constructor.name);

  return function validateGeoJsonFormat(data, dataPath) {
    return data === null || typeof data !== 'object' || Array.isArray(data)
      ? true
      : isGeoJson(data) || addError(data, dataPath);
  };
}

// =============================================================================
// Aggregated Format Validators Object
// =============================================================================

/**
 * Object mapping geospatial format names to their compiler functions.
 *
 * @type {Record<string, (schemaObj: ValidationObject, jsonSchema: JSONSchema) => (data: unknown, dataPath?: string) => boolean>}
 */
export const formatValidators = {
  'geohash': compileGeohashFormat,
  'wkt': compileWktFormat,
  'geojson': compileGeoJsonFormat,
};
