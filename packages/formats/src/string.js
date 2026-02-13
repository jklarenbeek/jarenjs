//@ts-check
// eslint-disable no-useless-escape

import {
  isStringType,
} from '@jarenjs/core';

import {
  isStringLowerCase,
  isStringUpperCase,
  isStringRegExp,
} from '@jarenjs/core/string';

import {
  isValidUri,
  isValidUriRef,
  isValidUriTemplate,
  isValidUrl,
  isValidEmail,
  isValidHostname,
  isValidIdnEmail,
  isValidIdnHostname,
  isValidIPv4,
  isValidIPv6,
  isValidUUID,
  isValidAlpha,
  isValidAlphaNumeric,
  isValidIdentifier,
  isValidHtmlIdentifier,
  isValidCssIdentifier,
  isValidHexaDecimal,
  isValidNumeric,
  isValidIRI,
  isValidIRIRef,
  isValidHexColor,
  isValidUriFull,
  isValidUriRefFull,
  isValidEmailFull,
  isValidGUID,
  isValidISBN10,
  isValidISBN13,
  isValidMACAddr,
  isValidBase64,
  isValidCountryAlpha2,
  isValidIBAN,
} from '@jarenjs/core/text';

import {
  isValidJSONPointer,
  isValidJSONPointerUriFragment,
  isValidRelativeJSONPointer,
  isValidJSONPath,
} from '@jarenjs/core/json';

/**
 * @typedef {import('@jarenjs/validate').ValidationObject} ValidationObject
 * @typedef {import('@jarenjs/validate').JSONSchema} JSONSchema
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
function createStringFormatCompiler(formatName, isFormatTest) {
  return function compileStringFormat(schemaObj, jsonSchema) {
    if (jsonSchema.format !== formatName)
      throw new Error('Format is not equal to jsonSchema (should not happen!)');

    // when skipErrors is true, we don't need to create error objects
    if (schemaObj.options.skipErrors) {
      return function validateStringFormatFast(data, dataPath) {
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
export const compileAlphaFormat = createStringFormatCompiler('alpha', isValidAlpha);

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
export const compileAlphaNumericFormat = createStringFormatCompiler('alphanumeric', isValidAlphaNumeric);

/**
 * Compiles a validator for the 'uppercase' format.
 * Validates strings containing only uppercase characters.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileUppercaseFormat = createStringFormatCompiler('uppercase', isStringUpperCase);

/**
 * Compiles a validator for the 'lowercase' format.
 * Validates strings containing only lowercase characters.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileLowercaseFormat = createStringFormatCompiler('lowercase', isStringLowerCase);

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
export const compileIdentifierFormat = createStringFormatCompiler('identifier', isValidIdentifier);

/**
 * Compiles a validator for the 'html-identifier' format.
 * Validates HTML element and attribute identifiers.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileHtmlIdentifierFormat = createStringFormatCompiler('html-identifier', isValidHtmlIdentifier);

/**
 * Compiles a validator for the 'css-identifier' format.
 * Validates CSS class and ID selectors.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileCssIdentifierFormat = createStringFormatCompiler('css-identifier', isValidCssIdentifier);

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
export const compileHexadecimalFormat = createStringFormatCompiler('hexadecimal', isValidHexaDecimal);

/**
 * Compiles a validator for the 'numeric' format.
 * Validates numeric strings containing only digits.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileNumericFormat = createStringFormatCompiler('numeric', isValidNumeric);

/**
 * Compiles a validator for the 'color' format.
 * Validates hexadecimal color codes (e.g., #FFF, #FFFFFF).
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileColorFormat = createStringFormatCompiler('color', isValidHexColor);

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
export const compileRegexFormat = createStringFormatCompiler('regex', isStringRegExp);

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
export const compileUriFormat = createStringFormatCompiler('uri', isValidUri);

/**
 * Compiles a validator for the 'uri--full' format.
 * Validates absolute URI strings with stricter checking.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileUriFullFormat = createStringFormatCompiler('uri--full', isValidUriFull);

/**
 * Compiles a validator for the 'uri-reference' format.
 * Validates URI reference strings (absolute or relative) per RFC 3986.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileUriReferenceFormat = createStringFormatCompiler('uri-reference', isValidUriRef);

/**
 * Compiles a validator for the 'uri-reference--full' format.
 * Validates URI reference strings with stricter checking.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileUriReferenceFullFormat = createStringFormatCompiler('uri-reference--full', isValidUriRefFull);

/**
 * Compiles a validator for the 'uri-template' format.
 * Validates URI template strings per RFC 6570.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileUriTemplateFormat = createStringFormatCompiler('uri-template', isValidUriTemplate);

/**
 * Compiles a validator for the 'url' format.
 * Validates URL strings per the WHATWG URL Standard.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileUrlFormat = createStringFormatCompiler('url', isValidUrl);

/**
 * Compiles a validator for the 'url--full' format.
 * Validates URL strings with stricter checking.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileUrlFullFormat = createStringFormatCompiler('url--full', isValidUrl);

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
export const compileIriFormat = createStringFormatCompiler('iri', isValidIRI);

/**
 * Compiles a validator for the 'iri-reference' format.
 * Validates IRI reference strings (absolute or relative) per RFC 3987.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileIriReferenceFormat = createStringFormatCompiler('iri-reference', isValidIRIRef);

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
export const compileEmailFormat = createStringFormatCompiler('email', isValidEmail);

/**
 * Compiles a validator for the 'email--full' format.
 * Validates email address strings with stricter checking.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileEmailFullFormat = createStringFormatCompiler('email--full', isValidEmailFull);

/**
 * Compiles a validator for the 'idn-email' format.
 * Validates internationalized email addresses (EAI) per RFC 6531.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileIdnEmailFormat = createStringFormatCompiler('idn-email', isValidIdnEmail);

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
export const compileHostnameFormat = createStringFormatCompiler('hostname', isValidHostname);

/**
 * Compiles a validator for the 'idn-hostname' format.
 * Validates internationalized domain names (IDN) per RFC 5890.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileIdnHostnameFormat = createStringFormatCompiler('idn-hostname', isValidIdnHostname);

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
export const compileIpv4Format = createStringFormatCompiler('ipv4', isValidIPv4);

/**
 * Compiles a validator for the 'ipv6' format.
 * Validates IPv6 address strings.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileIpv6Format = createStringFormatCompiler('ipv6', isValidIPv6);

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
export const compileUuidFormat = createStringFormatCompiler('uuid', isValidUUID);

/**
 * Compiles a validator for the 'guid' format.
 * Validates GUID strings (Microsoft format).
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileGuidFormat = createStringFormatCompiler('guid', isValidGUID);

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
 * Validates JSONPath expressions per RFC 9535.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 * @example
 * compileJsonPathFormat(schemaObj, { format: 'json-path' })('$.store.book[0].title'); // true
 * compileJsonPathFormat(schemaObj, { format: 'json-path' })('$..name'); // true
 * compileJsonPathFormat(schemaObj, { format: 'json-path' })('$[*]'); // true
 * compileJsonPathFormat(schemaObj, { format: 'json-path' })('store'); // false (with error)
 */
export const compileJsonPathFormat = createStringFormatCompiler('json-path', isValidJSONPath);

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
export const compileIsbn10Format = createStringFormatCompiler('isbn10', isValidISBN10);

/**
 * Compiles a validator for the 'isbn13' format.
 * Validates ISBN-13 identifier strings.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileIsbn13Format = createStringFormatCompiler('isbn13', isValidISBN13);

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
export const compileMacFormat = createStringFormatCompiler('mac', isValidMACAddr);

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
export const compileBase64Format = createStringFormatCompiler('base64', isValidBase64);

/**
 * Compiles a validator for the 'byte' format.
 * Alias for 'base64' format.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileByteFormat = createStringFormatCompiler('byte', isValidBase64);

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
export const compileCountry2Format = createStringFormatCompiler('country2', isValidCountryAlpha2);

/**
 * Compiles a validator for the 'iban' format.
 * Validates IBAN (International Bank Account Number) strings.
 *
 * @param {ValidationObject} schemaObj - The validation JSONSchema for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 */
export const compileIbanFormat = createStringFormatCompiler('iban', isValidIBAN);

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
  // URI
  'uri': compileUriFormat,
  'uri--full': compileUriFullFormat,
  'uri-reference': compileUriReferenceFormat,
  'uri-reference--full': compileUriReferenceFullFormat,
  'uri-template': compileUriTemplateFormat,
  'url': compileUrlFormat,
  'url--full': compileUrlFullFormat,
  // IRI
  'iri': compileIriFormat,
  'iri-reference': compileIriReferenceFormat,
  // Email
  'email': compileEmailFormat,
  'email--full': compileEmailFullFormat,
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
  // JSON Pointer
  'json-pointer': compileJsonPointerFormat,
  'json-pointer-uri-fragment': compileJsonPointerUriFragmentFormat,
  'relative-json-pointer': compileRelativeJsonPointerFormat,
  // JSONPath
  'json-path': compileJsonPathFormat,
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
