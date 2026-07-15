//@ts-check

/**
 * Format registry for form fields.
 *
 * Maps JSON Schema `format` names to a cheap synchronous test from
 * @jarenjs/core plus rendering hints (which HTML input control fits and a
 * sensible placeholder). These tests power the PREEMPTIVE per-field
 * validation that runs on every keystroke, before the complete schema
 * validation (with @jarenjs/validate) takes place.
 */

import {
  isValidEmail,
  isValidEmailFull,
  isValidIdnEmail,
  isValidHostname,
  isValidIdnHostname,
  isValidIPv4,
  isValidIPv6,
  isValidMACAddr,
  isValidUUID,
  isValidGUID,
  isValidUri,
  isValidUriFull,
  isValidUriRef,
  isValidUriRefFull,
  isValidUriTemplate,
  isValidUrl,
  isValidUrlFull,
  isValidIRI,
  isValidIRIRef,
  isValidAlpha,
  isValidNumeric,
  isValidAlphaNumeric,
  isValidHexaDecimal,
  isValidHexColor,
  isValidBase64,
  isValidISBN10,
  isValidISBN13,
  isValidIBAN,
  isValidCountryAlpha2,
  isValidIdentifier,
  isValidHtmlIdentifier,
  isValidCssIdentifier,
} from '@jarenjs/core/text';

import {
  isDateOnlyRFC3339,
  isTimeOnlyRFC3339,
  isDateTimeRFC3339,
  isValidISODateTime,
  isValidDuration,
} from '@jarenjs/core/dates';

import {
  isValidJSONPointer,
  isValidJSONPointerUriFragment,
  isValidRelativeJSONPointer,
} from '@jarenjs/json';

import {
  createRegExp,
} from '@jarenjs/core/string';

function isValidRegex(str) {
  try {
    return createRegExp(str) != null;
  }
  catch (e) {
    return false;
  }
}

/**
 * @typedef {object} FormatInfo
 * @property {(value: string) => boolean} test - Synchronous validity test
 * @property {string} control - Suggested HTML input control
 * @property {string} [placeholder] - Suggested placeholder text
 */

/** @type {Record<string, FormatInfo>} */
export const FORM_FORMATS = {
  // -- date and time (RFC 3339 requires a timezone offset, which the HTML
  //    time / datetime-local inputs cannot produce; those stay text inputs)
  'date': { test: isDateOnlyRFC3339, control: 'date', placeholder: '2024-01-15' },
  'time': { test: isTimeOnlyRFC3339, control: 'text', placeholder: '13:45:30Z' },
  'date-time': { test: isDateTimeRFC3339, control: 'text', placeholder: '2024-01-15T13:45:30Z' },
  'iso-date-time': { test: isValidISODateTime, control: 'text', placeholder: '2024-01-15T13:45:30' },
  'iso-time': { test: isTimeOnlyRFC3339, control: 'text', placeholder: '13:45:30Z' },
  'duration': { test: isValidDuration, control: 'text', placeholder: 'P3DT4H' },

  // -- email
  'email': { test: isValidEmail, control: 'email', placeholder: 'user@example.com' },
  'email--full': { test: isValidEmailFull, control: 'email', placeholder: 'user@example.com' },
  'idn-email': { test: isValidIdnEmail, control: 'email', placeholder: 'user@example.com' },

  // -- hosts and addresses
  'hostname': { test: isValidHostname, control: 'text', placeholder: 'example.com' },
  'idn-hostname': { test: isValidIdnHostname, control: 'text', placeholder: 'example.com' },
  'ipv4': { test: isValidIPv4, control: 'text', placeholder: '192.168.0.1' },
  'ipv6': { test: isValidIPv6, control: 'text', placeholder: '::1' },
  'mac': { test: isValidMACAddr, control: 'text', placeholder: '00:1B:44:11:3A:B7' },

  // -- uris
  'uri': { test: isValidUri, control: 'url', placeholder: 'https://example.com/path' },
  'uri--full': { test: isValidUriFull, control: 'url', placeholder: 'https://example.com/path' },
  'uri-reference': { test: isValidUriRef, control: 'text', placeholder: '/relative/path' },
  'uri-reference--full': { test: isValidUriRefFull, control: 'text', placeholder: '/relative/path' },
  'uri-template': { test: isValidUriTemplate, control: 'text', placeholder: '/users/{id}' },
  'url': { test: isValidUrl, control: 'url', placeholder: 'https://example.com' },
  'url--full': { test: isValidUrlFull, control: 'url', placeholder: 'https://example.com' },
  'iri': { test: isValidIRI, control: 'url', placeholder: 'https://example.com/päth' },
  'iri-reference': { test: isValidIRIRef, control: 'text', placeholder: '/relative/päth' },

  // -- identifiers
  'uuid': { test: isValidUUID, control: 'text', placeholder: '123e4567-e89b-12d3-a456-426614174000' },
  'guid': { test: isValidGUID, control: 'text', placeholder: '123e4567-e89b-12d3-a456-426614174000' },
  'identifier': { test: isValidIdentifier, control: 'text', placeholder: 'my_identifier' },
  'html-identifier': { test: isValidHtmlIdentifier, control: 'text', placeholder: 'my-element-id' },
  'css-identifier': { test: isValidCssIdentifier, control: 'text', placeholder: 'my-class-name' },

  // -- json pointers
  'json-pointer': { test: isValidJSONPointer, control: 'text', placeholder: '/path/to/value' },
  'json-pointer-uri-fragment': { test: isValidJSONPointerUriFragment, control: 'text', placeholder: '#/path/to/value' },
  'relative-json-pointer': { test: isValidRelativeJSONPointer, control: 'text', placeholder: '1/sibling' },

  // -- misc
  'regex': { test: isValidRegex, control: 'text', placeholder: '^[a-z]+$' },
  'base64': { test: isValidBase64, control: 'textarea', placeholder: 'SGVsbG8=' },
  'byte': { test: isValidBase64, control: 'textarea', placeholder: 'SGVsbG8=' },
  'alpha': { test: isValidAlpha, control: 'text', placeholder: 'alpha' },
  'numeric': { test: isValidNumeric, control: 'text', placeholder: '0123' },
  'alphanumeric': { test: isValidAlphaNumeric, control: 'text', placeholder: 'abc123' },
  'hexadecimal': { test: isValidHexaDecimal, control: 'text', placeholder: 'deadbeef' },
  'color': { test: isValidHexColor, control: 'color', placeholder: '#ff8800' },
  'isbn10': { test: isValidISBN10, control: 'text', placeholder: '0-306-40615-2' },
  'isbn13': { test: isValidISBN13, control: 'text', placeholder: '978-3-16-148410-0' },
  'iban': { test: isValidIBAN, control: 'text', placeholder: 'NL91ABNA0417164300' },
  'country2': { test: isValidCountryAlpha2, control: 'text', placeholder: 'NL' },

  // -- convenience (non-standard, control hints only)
  'password': { test: () => true, control: 'password' },
  'textarea': { test: () => true, control: 'textarea' },
  'multiline': { test: () => true, control: 'textarea' },
};

/**
 * Look up the format info for a JSON Schema format name.
 * @param {string|undefined} format - The format name
 * @returns {FormatInfo|null} The format info, or null when unknown
 */
export function getFormatInfo(format) {
  if (typeof format !== 'string') return null;
  return FORM_FORMATS[format] || null;
}
