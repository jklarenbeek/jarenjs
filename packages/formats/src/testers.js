//@ts-check

/**
 * The canonical format-name -> tester registry.
 *
 * ONE place in the repo binds a JSON Schema `format` name to its predicate
 * from `@jarenjs/core` / `@jarenjs/json`. Everything else derives from it:
 * the validator-facing format compilers of this package (string.js,
 * json.js, number.js pass these testers to their compiler factories) and
 * the per-keystroke field validation of `@jarenjs/forms` (which merges its
 * UI hints over this table). Add a format here first; the consumers pick
 * it up.
 *
 * A tester is a plain synchronous predicate over the value the format
 * applies to: a string for the string/json/datetime groups, a number for
 * the number group. Testers carry no error handling, no schema coupling,
 * no draft semantics - that is the compilers' job.
 *
 * The datetime testers are the boolean twins of the parse-based compilers
 * in datetime.js (which additionally support `formatMinimum` /
 * `formatMaximum`); both sides accept the same strings.
 */

import {
  isValidUri,
  isValidUriRef,
  isValidUriTemplate,
  isValidUrl,
  isValidEmail,
  isValidIdnEmail,
  isValidHostname,
  isValidIdnHostname,
  isValidIPv4,
  isValidIPv6,
  isValidUUID,
  isValidGUID,
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
  isValidISBN10,
  isValidISBN13,
  isValidMACAddr,
  isValidBase64,
  isValidCountryAlpha2,
  isValidIBAN,
  isValidIRegexp,
} from '@jarenjs/core/text';

import {
  isStringUpperCase,
  isStringLowerCase,
  isStringRegExp,
} from '@jarenjs/core/string';

import {
  isDateTimeRFC3339,
  isDateOnlyRFC3339,
  isTimeOnlyRFC3339,
  isValidISODateTime,
  isValidISOTime,
  isValidDuration,
} from '@jarenjs/core/dates';

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

import {
  isValidJSONPointer,
  isValidJSONPointerUriFragment,
  isValidRelativeJSONPointer,
  isValidJSONPathStrict,
} from '@jarenjs/json';

/** @typedef {(value: string) => boolean} StringFormatTester */
/** @typedef {(value: number) => boolean} NumberFormatTester */

/**
 * String format testers (the string.js compiler group).
 * @type {Record<string, StringFormatTester>}
 */
export const stringFormatTesters = {
  // Alphabetic & Case
  'alpha': isValidAlpha,
  'alphanumeric': isValidAlphaNumeric,
  'uppercase': isStringUpperCase,
  'lowercase': isStringLowerCase,
  // Identifiers
  'identifier': isValidIdentifier,
  'html-identifier': isValidHtmlIdentifier,
  'css-identifier': isValidCssIdentifier,
  // Numeric & Color
  'hexadecimal': isValidHexaDecimal,
  'numeric': isValidNumeric,
  'color': isValidHexColor,
  // Regex
  'regex': isStringRegExp,
  'iregexp': isValidIRegexp,
  // URI
  'uri': isValidUri,
  'uri-reference': isValidUriRef,
  'uri-template': isValidUriTemplate,
  'url': isValidUrl,
  // IRI
  'iri': isValidIRI,
  'iri-reference': isValidIRIRef,
  // Email
  'email': isValidEmail,
  'idn-email': isValidIdnEmail,
  // Hostname
  'hostname': isValidHostname,
  'idn-hostname': isValidIdnHostname,
  // IP Address
  'ipv4': isValidIPv4,
  'ipv6': isValidIPv6,
  // UUID & GUID
  'uuid': isValidUUID,
  'guid': isValidGUID,
  // ISBN
  'isbn10': isValidISBN10,
  'isbn13': isValidISBN13,
  // Hardware Address
  'mac': isValidMACAddr,
  // Encoding
  'base64': isValidBase64,
  'byte': isValidBase64,
  // Country & Banking
  'country2': isValidCountryAlpha2,
  'iban': isValidIBAN,
};

/**
 * JSON addressing format testers (the json.js compiler group).
 * @type {Record<string, StringFormatTester>}
 */
export const jsonFormatTesters = {
  'json-pointer': isValidJSONPointer,
  'json-pointer-uri-fragment': isValidJSONPointerUriFragment,
  'relative-json-pointer': isValidRelativeJSONPointer,
  'json-path': isValidJSONPathStrict,
};

/**
 * Date and time format testers - the boolean twins of the parse-based
 * compilers in datetime.js.
 * @type {Record<string, StringFormatTester>}
 */
export const dateTimeFormatTesters = {
  'date-time': isDateTimeRFC3339,
  'date': isDateOnlyRFC3339,
  'time': isTimeOnlyRFC3339,
  'duration': isValidDuration,
  'iso-date-time': isValidISODateTime,
  'iso-time': isValidISOTime,
};

/**
 * Number format testers (the number.js compiler group). These take the
 * NUMBER value, not a string.
 * @type {Record<string, NumberFormatTester>}
 */
export const numberFormatTesters = {
  // Signed integer types
  'int8': isValidInt8,
  'int16': isValidInt16,
  'int32': isValidInt32,
  'int64': isValidInt64,
  // Unsigned integer types
  'uint8': isValidUInt8,
  'uint16': isValidUInt16,
  'uint32': isValidUInt32,
  'uint64': isValidUInt64,
  // Floating point types
  'float16': isValidFloat16,
  'float32': isValidFloat32,
  'float64': isValidFloat64,
  'float': isValidFloat32,
  'double': isValidFloat64,
};

/**
 * Every format tester this package knows, in one flat registry.
 * @type {Record<string, (value: any) => boolean>}
 */
export const formatTesters = {
  ...stringFormatTesters,
  ...jsonFormatTesters,
  ...dateTimeFormatTesters,
  ...numberFormatTesters,
};
