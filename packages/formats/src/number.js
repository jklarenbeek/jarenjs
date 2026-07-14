//@ts-check

import {
  isValidInt8,
  isValidInt16,
  isValidInt32,
  isValidInt64,
  isValidUInt8,
  isValidUInt16,
  isValidUInt32,
  isValidUInt64,
} from '@jarenjs/core/integer';

import {
  isValidFloat16,
  isValidFloat32,
  isValidFloat64,
} from '@jarenjs/core/float';

/**
 * @typedef {import('@jarenjs/validate').ValidationObject} ValidationObject
 * @typedef {import('@jarenjs/validate').JSONSchema} JSONSchema
 */

/**
 * Creates a number format compiler function.
 *
 * @param {string} formatName - The name of the format (e.g., 'int32', 'float64')
 * @param {(value: number) => boolean} isNumberTest - The function to test if a number matches the format constraints
 * @returns {(schemaObj: ValidationObject, jsonSchema: JSONSchema) => (data: unknown, dataPath?: string) => boolean} A compiler function that creates number format validators
 * @example
 * const compiler = createNumberFormatCompiler('int8', isValidInt8);
 * const validator = compiler(schemaObj, { format: 'int8' });
 * validator(127); // true
 * validator('127'); // true (coerced to number)
 * validator(128); // false (out of int8 range)
 */
function createNumberFormatCompiler(formatName, isNumberTest) {
  return function compileNumberFormat(schemaObj, jsonSchema) {
    if (jsonSchema.format !== formatName)
      throw new Error('Format is not equal to jsonSchema (should not happen!)');

    const addError = schemaObj.createErrorHandler(formatName, 'format');

    return function validateNumberFormat(data, dataPath) {
      return (data == null
        || isNumberTest(Number(data))
        || addError(data, dataPath));
    };
  };
}

// =============================================================================
// Signed Integer Format Compilers
// =============================================================================

/**
 * Compiles a validator for the 'int8' format.
 * Validates 8-bit signed integers (-128 to 127).
 *
 * @param {ValidationObject} schemaObj - The validation object for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 * @example
 * compileInt8Format(schemaObj, { format: 'int8' })(127); // true
 * compileInt8Format(schemaObj, { format: 'int8' })(128); // false (with error)
 * compileInt8Format(schemaObj, { format: 'int8' })('64'); // true (coerced)
 */
export const compileInt8Format = createNumberFormatCompiler('int8', isValidInt8);

/**
 * Compiles a validator for the 'int16' format.
 * Validates 16-bit signed integers (-32768 to 32767).
 *
 * @param {ValidationObject} schemaObj - The validation object for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileInt16Format = createNumberFormatCompiler('int16', isValidInt16);

/**
 * Compiles a validator for the 'int32' format.
 * Validates 32-bit signed integers (-2147483648 to 2147483647).
 *
 * @param {ValidationObject} schemaObj - The validation object for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileInt32Format = createNumberFormatCompiler('int32', isValidInt32);

/**
 * Compiles a validator for the 'int64' format.
 * Validates 64-bit signed integers (approximate range in JavaScript).
 *
 * @param {ValidationObject} schemaObj - The validation object for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileInt64Format = createNumberFormatCompiler('int64', isValidInt64);

// =============================================================================
// Unsigned Integer Format Compilers
// =============================================================================

/**
 * Compiles a validator for the 'uint8' format.
 * Validates 8-bit unsigned integers (0 to 255).
 *
 * @param {ValidationObject} schemaObj - The validation object for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 * @example
 * compileUInt8Format(schemaObj, { format: 'uint8' })(255); // true
 * compileUInt8Format(schemaObj, { format: 'uint8' })(256); // false (with error)
 */
export const compileUInt8Format = createNumberFormatCompiler('uint8', isValidUInt8);

/**
 * Compiles a validator for the 'uint16' format.
 * Validates 16-bit unsigned integers (0 to 65535).
 *
 * @param {ValidationObject} schemaObj - The validation object for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileUInt16Format = createNumberFormatCompiler('uint16', isValidUInt16);

/**
 * Compiles a validator for the 'uint32' format.
 * Validates 32-bit unsigned integers (0 to 4294967295).
 *
 * @param {ValidationObject} schemaObj - The validation object for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileUInt32Format = createNumberFormatCompiler('uint32', isValidUInt32);

/**
 * Compiles a validator for the 'uint64' format.
 * Validates 64-bit unsigned integers (approximate range in JavaScript).
 *
 * @param {ValidationObject} schemaObj - The validation object for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileUInt64Format = createNumberFormatCompiler('uint64', isValidUInt64);

// =============================================================================
// Floating Point Format Compilers
// =============================================================================

/**
 * Compiles a validator for the 'float16' format.
 * Validates 16-bit floating point numbers (IEEE 754 half-precision).
 *
 * @param {ValidationObject} schemaObj - The validation object for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileFloat16Format = createNumberFormatCompiler('float16', isValidFloat16);

/**
 * Compiles a validator for the 'float32' format.
 * Validates 32-bit floating point numbers (IEEE 754 single-precision).
 *
 * @param {ValidationObject} schemaObj - The validation object for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileFloat32Format = createNumberFormatCompiler('float32', isValidFloat32);

/**
 * Compiles a validator for the 'float64' format.
 * Validates 64-bit floating point numbers (IEEE 754 double-precision).
 *
 * @param {ValidationObject} schemaObj - The validation object for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileFloat64Format = createNumberFormatCompiler('float64', isValidFloat64);

/**
 * Compiles a validator for the 'float' format.
 * Alias for 'float32' - validates 32-bit floating point numbers.
 *
 * @param {ValidationObject} schemaObj - The validation object for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileFloatFormat = createNumberFormatCompiler('float', isValidFloat32);

/**
 * Compiles a validator for the 'double' format.
 * Alias for 'float64' - validates 64-bit floating point numbers.
 *
 * @param {ValidationObject} schemaObj - The validation object for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileDoubleFormat = createNumberFormatCompiler('double', isValidFloat64);

// =============================================================================
// Aggregated Format Validators Object (Backward Compatibility)
// =============================================================================

/**
 * Object mapping number format names to their compiler functions.
 * Used for backward compatibility and aggregate imports.
 *
 * @type {Record<string, (schemaObj: ValidationObject, jsonSchema: JSONSchema) => (data: unknown, dataPath?: string) => boolean>}
 */
export const formatValidators = {
  // Signed integer types
  int8: compileInt8Format,
  int16: compileInt16Format,
  int32: compileInt32Format,
  int64: compileInt64Format,
  // Unsigned integer types
  uint8: compileUInt8Format,
  uint16: compileUInt16Format,
  uint32: compileUInt32Format,
  uint64: compileUInt64Format,
  // Floating point types
  float16: compileFloat16Format,
  float32: compileFloat32Format,
  float64: compileFloat64Format,
  float: compileFloatFormat,
  double: compileDoubleFormat,
};
