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
  isValidJSONPathSegments,
} from '@jarenjs/json';

import {
  isValidGeohash,
  isValidWkt,
  isValidGeoJson,
} from '@jarenjs/core/geo';

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
  'json-path-segments': isValidJSONPathSegments,
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
 * Geospatial format testers (the geo.js compiler group). `geohash` and
 * `wkt` take strings; `geojson` takes the OBJECT value — the quick
 * yes-or-no twin of the GeoJSON meta-schema artifacts in `@jarenjs/json`,
 * including the ring-closure invariant JSON Schema cannot express.
 * @type {Record<string, (value: any) => boolean>}
 */
export const geoFormatTesters = {
  'geohash': isValidGeohash,
  'wkt': isValidWkt,
  'geojson': isValidGeoJson,
};

/**
 * The test of an integer format: a number by the core predicate (an
 * integer in range; a safe integer for the 64-bit formats, the integers a
 * number holds exactly), and a bigint by the format's own range, exactly
 * and never as the number it converts to.
 * @param {(value: number) => boolean} isNumber - The number predicate
 * @param {bigint} minimum - The least integer of the format
 * @param {bigint} maximum - The greatest integer of the format
 * @returns {(value: number | bigint) => boolean}
 */
function integerTester(isNumber, minimum, maximum) {
  return function isInteger(value) {
    return typeof value === 'bigint' ? value >= minimum && value <= maximum : isNumber(value);
  };
}

/**
 * Integer format testers: the number formats that judge a bigint too.
 * Each takes a NUMBER or a BIGINT, not a string.
 * @type {Record<string, (value: number | bigint) => boolean>}
 */
export const integerFormatTesters = {
  // Signed integer types
  'int8': integerTester(isValidInt8, -128n, 127n),
  'int16': integerTester(isValidInt16, -32768n, 32767n),
  'int32': integerTester(isValidInt32, -(2n ** 31n), 2n ** 31n - 1n),
  'int64': integerTester(isValidInt64, -(2n ** 63n), 2n ** 63n - 1n),
  // Unsigned integer types
  'uint8': integerTester(isValidUInt8, 0n, 255n),
  'uint16': integerTester(isValidUInt16, 0n, 65535n),
  'uint32': integerTester(isValidUInt32, 0n, 2n ** 32n - 1n),
  'uint64': integerTester(isValidUInt64, 0n, 2n ** 64n - 1n),
};

/**
 * Number format testers (the number.js compiler group). These take the
 * NUMBER value, not a string; an integer format's takes a bigint too
 * ({@link integerFormatTesters}), a floating point format's describes no
 * bigint.
 * @type {Record<string, NumberFormatTester>}
 */
export const numberFormatTesters = {
  ...integerFormatTesters,
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
  ...geoFormatTesters,
  ...dateTimeFormatTesters,
  ...numberFormatTesters,
};
