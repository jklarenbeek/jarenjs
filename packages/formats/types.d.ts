/**
 * JarenJS Formats - TypeScript Type Definitions
 * String, number, date-time and JSON format validators
 */

import { ValidationObject, JSONSchema } from '@jarenjs/validate';

/**
 * Format validator function type
 */
export type FormatValidator = (data: unknown, dataPath?: string) => boolean;

/**
 * Format compiler function type
 */
export type FormatCompiler = (schemaObj: ValidationObject, jsonSchema: JSONSchema) => FormatValidator;

// =============================================================================
// String Formats
// =============================================================================

// Alphabetic & Case
export const compileAlphaFormat: FormatCompiler;
export const compileAlphaNumericFormat: FormatCompiler;
export const compileUppercaseFormat: FormatCompiler;
export const compileLowercaseFormat: FormatCompiler;

// Identifiers
export const compileIdentifierFormat: FormatCompiler;
export const compileHtmlIdentifierFormat: FormatCompiler;
export const compileCssIdentifierFormat: FormatCompiler;

// Numeric & Color
export const compileHexadecimalFormat: FormatCompiler;
export const compileNumericFormat: FormatCompiler;
export const compileColorFormat: FormatCompiler;

// Regex
export const compileRegexFormat: FormatCompiler;

// URI
export const compileUriFormat: FormatCompiler;
export const compileUriFullFormat: FormatCompiler;
export const compileUriReferenceFormat: FormatCompiler;
export const compileUriReferenceFullFormat: FormatCompiler;
export const compileUriTemplateFormat: FormatCompiler;
export const compileUrlFormat: FormatCompiler;
export const compileUrlFullFormat: FormatCompiler;

// IRI
export const compileIriFormat: FormatCompiler;
export const compileIriReferenceFormat: FormatCompiler;

// Email
export const compileEmailFormat: FormatCompiler;
export const compileEmailFullFormat: FormatCompiler;
export const compileIdnEmailFormat: FormatCompiler;

// Hostname
export const compileHostnameFormat: FormatCompiler;
export const compileIdnHostnameFormat: FormatCompiler;

// IP Address
export const compileIpv4Format: FormatCompiler;
export const compileIpv6Format: FormatCompiler;

// UUID & GUID
export const compileUuidFormat: FormatCompiler;
export const compileGuidFormat: FormatCompiler;

// ISBN
export const compileIsbn10Format: FormatCompiler;
export const compileIsbn13Format: FormatCompiler;

// Hardware Address
export const compileMacFormat: FormatCompiler;

// Encoding
export const compileBase64Format: FormatCompiler;
export const compileByteFormat: FormatCompiler;

// Country & Banking
export const compileCountry2Format: FormatCompiler;
export const compileIbanFormat: FormatCompiler;

/**
 * All string format validators keyed by format name
 */
export const stringFormats: Record<string, FormatCompiler>;

// =============================================================================
// JSON Formats (json.js)
// =============================================================================

// JSON Pointer (RFC 6901)
export const compileJsonPointerFormat: FormatCompiler;
export const compileJsonPointerUriFragmentFormat: FormatCompiler;
export const compileRelativeJsonPointerFormat: FormatCompiler;

// JSONPath (RFC 9535, strict grammar via the @jarenjs/core/json parser)
export const compileJsonPathFormat: FormatCompiler;

/**
 * All JSON format validators keyed by format name
 */
export const jsonFormats: {
  'json-pointer': typeof compileJsonPointerFormat;
  'json-pointer-uri-fragment': typeof compileJsonPointerUriFragmentFormat;
  'relative-json-pointer': typeof compileRelativeJsonPointerFormat;
  'json-path': typeof compileJsonPathFormat;
};

// =============================================================================
// Date-Time Formats
// =============================================================================

export function compileDateTimeFormat(schemaObj: ValidationObject, jsonSchema: JSONSchema): FormatValidator;
export function compileDateOnlyFormat(schemaObj: ValidationObject, jsonSchema: JSONSchema): FormatValidator;
export function compileTimeOnlyFormat(schemaObj: ValidationObject, jsonSchema: JSONSchema): FormatValidator;

export function compileDurationFormat(schemaObj: ValidationObject, jsonSchema: JSONSchema): FormatValidator;
export function compileISODateTimeFormat(schemaObj: ValidationObject, jsonSchema: JSONSchema): FormatValidator;
export function compileISOTimeFormat(schemaObj: ValidationObject, jsonSchema: JSONSchema): FormatValidator;

/**
 * All date-time format validators keyed by format name
 */
export const dateTimeFormats: {
  'date-time': typeof compileDateTimeFormat;
  date: typeof compileDateOnlyFormat;
  time: typeof compileTimeOnlyFormat;
  duration: typeof compileDurationFormat;
  'iso-date-time': typeof compileISODateTimeFormat;
  'iso-time': typeof compileISOTimeFormat;
};

// =============================================================================
// Number Formats
// =============================================================================

// Signed Integers
export const compileInt8Format: FormatCompiler;
export const compileInt16Format: FormatCompiler;
export const compileInt32Format: FormatCompiler;
export const compileInt64Format: FormatCompiler;

// Unsigned Integers
export const compileUInt8Format: FormatCompiler;
export const compileUInt16Format: FormatCompiler;
export const compileUInt32Format: FormatCompiler;
export const compileUInt64Format: FormatCompiler;

// Floating Point
export const compileFloat16Format: FormatCompiler;
export const compileFloat32Format: FormatCompiler;
export const compileFloat64Format: FormatCompiler;
export const compileFloatFormat: FormatCompiler;
export const compileDoubleFormat: FormatCompiler;

/**
 * All number format validators keyed by format name
 */
export const numberFormats: {
  int8: typeof compileInt8Format;
  uint8: typeof compileUInt8Format;
  int16: typeof compileInt16Format;
  uint16: typeof compileUInt16Format;
  int32: typeof compileInt32Format;
  uint32: typeof compileUInt32Format;
  int64: typeof compileInt64Format;
  uint64: typeof compileUInt64Format;
  float16: typeof compileFloat16Format;
  float32: typeof compileFloat32Format;
  float64: typeof compileFloat64Format;
  float: typeof compileFloatFormat;
  double: typeof compileDoubleFormat;
};
