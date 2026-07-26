//@ts-check
// eslint-disable no-useless-escape

import {
  isStringType,
} from '@jarenjs/core';

// The name -> predicate bindings live in ONE place: testers.js. This
// module only wraps them in the validator's compiler contract.
import { stringFormatTesters } from './testers.js';

/**
 * @typedef {{format?: string, formatMinimum?: string, formatExclusiveMinimum?: string, formatMaximum?: string, formatExclusiveMaximum?: string}} JSONSchema
 * @typedef {{
 *   options: {skipErrors: boolean},
 *   createErrorHandler: (expected: any, key: string, ...details: any[]) => (data: any, dataPath?: string) => boolean
 * }} ValidationObject
 */

/**
 * Creates a string format compiler function.
 *
 * @param {string} formatName - The name of the format (e.g., 'email', 'uri')
 * @param {(value: string) => boolean} isFormatTest - The function to test if a string matches the format
 * @returns {(schemaObj: ValidationObject, jsonSchema: JSONSchema) => (data: unknown, dataPath?: string) => boolean} A compiler function that creates format validators
 * @example
 * const compiler = createStringFormatCompiler('email', isValidEmail);
 * const validator = compiler(schemaObj, { format: 'email' });
 * validator('user@example.com'); // true
 */
export function createStringFormatCompiler(formatName, isFormatTest) {
  return function compileStringFormat(schemaObj, jsonSchema) {
    if (jsonSchema.format !== formatName)
      throw new Error('Format is not equal to jsonSchema (should not happen!)');

    // when skipErrors is true, we don't need to create error objects
    if (schemaObj.options.skipErrors) {
      return function validateStringFormatFast(data, _dataPath) {
        return isStringType(data)
          ? isFormatTest(data)
          : true;
      };
    }

    const addError = schemaObj.createErrorHandler(formatName, 'format', isFormatTest.constructor.name);

    return function validateStringFormat(data, dataPath) {
      return isStringType(data)
        ? isFormatTest(data) || addError(data, dataPath)
        : true;
    };
  };
}

// =============================================================================
// Alphabetic & Case Format Compilers
// =============================================================================

/**
 * Compiles a validator for the 'alpha' format.
 * Validates strings containing only alphabetic characters (a-z, A-Z).
 *
 * @param {ValidationObject} schemaObj - The validation object for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 * @example
 * compileAlphaFormat(schemaObj, { format: 'alpha' })('HelloWorld'); // true
 * compileAlphaFormat(schemaObj, { format: 'alpha' })('Hello123'); // false (with error)
 */
export const compileAlphaFormat = createStringFormatCompiler('alpha', stringFormatTesters['alpha']);

/**
 * Compiles a validator for the 'alphanumeric' format.
 * Validates strings containing only alphabetic characters and digits (a-z, A-Z, 0-9).
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 * @example
 * compileAlphaNumericFormat(schemaObj, { format: 'alphanumeric' })('Hello123'); // true
 */
export const compileAlphaNumericFormat = createStringFormatCompiler('alphanumeric', stringFormatTesters['alphanumeric']);

/**
 * Compiles a validator for the 'uppercase' format.
 * Validates strings containing only uppercase characters.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileUppercaseFormat = createStringFormatCompiler('uppercase', stringFormatTesters['uppercase']);

/**
 * Compiles a validator for the 'lowercase' format.
 * Validates strings containing only lowercase characters.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileLowercaseFormat = createStringFormatCompiler('lowercase', stringFormatTesters['lowercase']);

// =============================================================================
// Identifier Format Compilers
// =============================================================================

/**
 * Compiles a validator for the 'identifier' format.
 * Validates general identifier strings (variable names, etc.).
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileIdentifierFormat = createStringFormatCompiler('identifier', stringFormatTesters['identifier']);

/**
 * Compiles a validator for the 'html-identifier' format.
 * Validates HTML element and attribute identifiers.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileHtmlIdentifierFormat = createStringFormatCompiler('html-identifier', stringFormatTesters['html-identifier']);

/**
 * Compiles a validator for the 'css-identifier' format.
 * Validates CSS class and ID selectors.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileCssIdentifierFormat = createStringFormatCompiler('css-identifier', stringFormatTesters['css-identifier']);

// =============================================================================
// Numeric & Color Format Compilers
// =============================================================================

/**
 * Compiles a validator for the 'hexadecimal' format.
 * Validates hexadecimal number strings (0-9, a-f, A-F).
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileHexadecimalFormat = createStringFormatCompiler('hexadecimal', stringFormatTesters['hexadecimal']);

/**
 * Compiles a validator for the 'numeric' format.
 * Validates numeric strings containing only digits.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileNumericFormat = createStringFormatCompiler('numeric', stringFormatTesters['numeric']);

/**
 * Compiles a validator for the 'color' format.
 * Validates hexadecimal color codes (e.g., #FFF, #FFFFFF).
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileColorFormat = createStringFormatCompiler('color', stringFormatTesters['color']);

// =============================================================================
// Regex Format Compiler
// =============================================================================

/**
 * Compiles a validator for the 'regex' format.
 * Validates that a string is a valid regular expression pattern.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileRegexFormat = createStringFormatCompiler('regex', stringFormatTesters['regex']);

/**
 * Compiles a validator for the 'iregexp' format.
 * Validates that a string is a valid I-Regexp (RFC 9485) pattern - the
 * interoperable subset that carries the same meaning across regexp
 * dialects. Stricter than 'regex': shorthand classes (\d, \w), lazy
 * quantifiers, anchors and lookaround are all rejected.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileIRegexpFormat = createStringFormatCompiler('iregexp', stringFormatTesters['iregexp']);

// =============================================================================
// URI Format Compilers
// =============================================================================

/**
 * Compiles a validator for the 'uri' format.
 * Validates absolute URI strings per RFC 3986.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 * @example
 * compileUriFormat(schemaObj, { format: 'uri' })('https://example.com'); // true
 */
export const compileUriFormat = createStringFormatCompiler('uri', stringFormatTesters['uri']);

/**
 * Compiles a validator for the 'uri-reference' format.
 * Validates URI reference strings (absolute or relative) per RFC 3986.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileUriReferenceFormat = createStringFormatCompiler('uri-reference', stringFormatTesters['uri-reference']);

/**
 * Compiles a validator for the 'uri-template' format.
 * Validates URI template strings per RFC 6570.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileUriTemplateFormat = createStringFormatCompiler('uri-template', stringFormatTesters['uri-template']);

/**
 * Compiles a validator for the 'url' format.
 * Validates URL strings per the WHATWG URL Standard.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileUrlFormat = createStringFormatCompiler('url', stringFormatTesters['url']);

// =============================================================================
// IRI Format Compilers (Internationalized Resource Identifiers)
// =============================================================================

/**
 * Compiles a validator for the 'iri' format.
 * Validates IRI strings per RFC 3987.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileIriFormat = createStringFormatCompiler('iri', stringFormatTesters['iri']);

/**
 * Compiles a validator for the 'iri-reference' format.
 * Validates IRI reference strings (absolute or relative) per RFC 3987.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileIriReferenceFormat = createStringFormatCompiler('iri-reference', stringFormatTesters['iri-reference']);

// =============================================================================
// Email Format Compilers
// =============================================================================

/**
 * Compiles a validator for the 'email' format.
 * Validates email address strings per RFC 5321.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 * @example
 * compileEmailFormat(schemaObj, { format: 'email' })('user@example.com'); // true
 */
export const compileEmailFormat = createStringFormatCompiler('email', stringFormatTesters['email']);

/**
 * Compiles a validator for the 'idn-email' format.
 * Validates internationalized email addresses (EAI) per RFC 6531.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileIdnEmailFormat = createStringFormatCompiler('idn-email', stringFormatTesters['idn-email']);

// =============================================================================
// Hostname Format Compilers
// =============================================================================

/**
 * Compiles a validator for the 'hostname' format.
 * Validates hostname strings per RFC 1123.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileHostnameFormat = createStringFormatCompiler('hostname', stringFormatTesters['hostname']);

/**
 * Compiles a validator for the 'idn-hostname' format.
 * Validates internationalized domain names (IDN) per RFC 5890.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileIdnHostnameFormat = createStringFormatCompiler('idn-hostname', stringFormatTesters['idn-hostname']);

// =============================================================================
// IP Address Format Compilers
// =============================================================================

/**
 * Compiles a validator for the 'ipv4' format.
 * Validates IPv4 address strings.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 * @example
 * compileIpv4Format(schemaObj, { format: 'ipv4' })('192.168.1.1'); // true
 */
export const compileIpv4Format = createStringFormatCompiler('ipv4', stringFormatTesters['ipv4']);

/**
 * Compiles a validator for the 'ipv6' format.
 * Validates IPv6 address strings.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileIpv6Format = createStringFormatCompiler('ipv6', stringFormatTesters['ipv6']);

// =============================================================================
// UUID & GUID Format Compilers
// =============================================================================

/**
 * Compiles a validator for the 'uuid' format.
 * Validates UUID strings per RFC 4122.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 * @example
 * compileUuidFormat(schemaObj, { format: 'uuid' })('550e8400-e29b-41d4-a716-446655440000'); // true
 */
export const compileUuidFormat = createStringFormatCompiler('uuid', stringFormatTesters['uuid']);

/**
 * Compiles a validator for the 'guid' format.
 * Validates GUID strings (Microsoft format).
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileGuidFormat = createStringFormatCompiler('guid', stringFormatTesters['guid']);

// =============================================================================
// ISBN Format Compilers
// =============================================================================

/**
 * Compiles a validator for the 'isbn10' format.
 * Validates ISBN-10 identifier strings.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileIsbn10Format = createStringFormatCompiler('isbn10', stringFormatTesters['isbn10']);

/**
 * Compiles a validator for the 'isbn13' format.
 * Validates ISBN-13 identifier strings.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileIsbn13Format = createStringFormatCompiler('isbn13', stringFormatTesters['isbn13']);

// =============================================================================
// Hardware Address Format Compilers
// =============================================================================

/**
 * Compiles a validator for the 'mac' format.
 * Validates MAC address strings.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileMacFormat = createStringFormatCompiler('mac', stringFormatTesters['mac']);

// =============================================================================
// Encoding Format Compilers
// =============================================================================

/**
 * Compiles a validator for the 'base64' format.
 * Validates Base64 encoded strings.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileBase64Format = createStringFormatCompiler('base64', stringFormatTesters['base64']);

/**
 * Compiles a validator for the 'byte' format.
 * Alias for 'base64' format.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileByteFormat = createStringFormatCompiler('byte', stringFormatTesters['byte']);

// =============================================================================
// Country & Banking Format Compilers
// =============================================================================

/**
 * Compiles a validator for the 'country2' format.
 * Validates ISO 3166-1 alpha-2 country codes.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 * @example
 * compileCountry2Format(schemaObj, { format: 'country2' })('US'); // true
 * compileCountry2Format(schemaObj, { format: 'country2' })('XX'); // false (with error)
 */
export const compileCountry2Format = createStringFormatCompiler('country2', stringFormatTesters['country2']);

/**
 * Compiles a validator for the 'iban' format.
 * Validates IBAN (International Bank Account Number) strings.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileIbanFormat = createStringFormatCompiler('iban', stringFormatTesters['iban']);

// =============================================================================
// Aggregated Format Validators Object (Backward Compatibility)
// =============================================================================

/**
 * Object mapping format names to their compiler functions.
 * Used for backward compatibility and aggregate imports.
 *
 * @type {Record<string, (schemaObj: ValidationObject, jsonSchema: JSONSchema) => (data: unknown, dataPath?: string) => boolean>}
 */
export const formatValidators = {
  // Alphabetic & Case
  'alpha': compileAlphaFormat,
  'alphanumeric': compileAlphaNumericFormat,
  'uppercase': compileUppercaseFormat,
  'lowercase': compileLowercaseFormat,
  // Identifiers
  'identifier': compileIdentifierFormat,
  'html-identifier': compileHtmlIdentifierFormat,
  'css-identifier': compileCssIdentifierFormat,
  // Numeric & Color
  'hexadecimal': compileHexadecimalFormat,
  'numeric': compileNumericFormat,
  'color': compileColorFormat,
  // Regex
  'regex': compileRegexFormat,
  'iregexp': compileIRegexpFormat,
  // URI
  'uri': compileUriFormat,
  'uri-reference': compileUriReferenceFormat,
  'uri-template': compileUriTemplateFormat,
  'url': compileUrlFormat,
  // IRI
  'iri': compileIriFormat,
  'iri-reference': compileIriReferenceFormat,
  // Email
  'email': compileEmailFormat,
  'idn-email': compileIdnEmailFormat,
  // Hostname
  'hostname': compileHostnameFormat,
  'idn-hostname': compileIdnHostnameFormat,
  // IP Address
  'ipv4': compileIpv4Format,
  'ipv6': compileIpv6Format,
  // UUID & GUID
  'uuid': compileUuidFormat,
  'guid': compileGuidFormat,
  // ISBN
  'isbn10': compileIsbn10Format,
  'isbn13': compileIsbn13Format,
  // Hardware Address
  'mac': compileMacFormat,
  // Encoding
  'base64': compileBase64Format,
  'byte': compileByteFormat,
  // Country & Banking
  'country2': compileCountry2Format,
  'iban': compileIbanFormat,
};
