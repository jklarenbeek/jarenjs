//@ts-check

/**
 * Format registry for form fields.
 *
 * The test predicates come from the CANONICAL format registry in
 * `@jarenjs/formats` (`formatTesters`) - the same name -> tester bindings
 * the schema validator's format compilers wrap - so the preemptive
 * per-keystroke validation accepts exactly what the authoritative
 * validation accepts. This module only adds what is genuinely
 * form-specific: rendering hints (which HTML input control fits and a
 * sensible placeholder) plus a few control-hint-only convenience formats.
 */

import {
  formatTesters,
  numberFormatTesters,
} from '@jarenjs/formats';

/**
 * @typedef {object} FormatInfo
 * @property {(value: string) => boolean} test - Synchronous validity test
 * @property {string} control - Suggested HTML input control
 * @property {string} [placeholder] - Suggested placeholder text
 */

/**
 * Rendering hints per format name. Formats without an entry render as a
 * plain text input (number-group formats as a number input).
 * @type {Record<string, { control?: string, placeholder?: string }>}
 */
const FORM_HINTS = {
  // -- date and time (RFC 3339 requires a timezone offset, which the HTML
  //    time / datetime-local inputs cannot produce; those stay text inputs)
  'date': { control: 'date', placeholder: '2024-01-15' },
  'time': { placeholder: '13:45:30Z' },
  'date-time': { placeholder: '2024-01-15T13:45:30Z' },
  'iso-date-time': { placeholder: '2024-01-15T13:45:30' },
  'iso-time': { placeholder: '13:45:30' },
  'duration': { placeholder: 'P3DT4H' },

  // -- email
  'email': { control: 'email', placeholder: 'user@example.com' },
  'email--full': { control: 'email', placeholder: 'user@example.com' },
  'idn-email': { control: 'email', placeholder: 'user@example.com' },

  // -- hosts and addresses
  'hostname': { placeholder: 'example.com' },
  'idn-hostname': { placeholder: 'example.com' },
  'ipv4': { placeholder: '192.168.0.1' },
  'ipv6': { placeholder: '::1' },
  'mac': { placeholder: '00:1B:44:11:3A:B7' },

  // -- uris
  'uri': { control: 'url', placeholder: 'https://example.com/path' },
  'uri--full': { control: 'url', placeholder: 'https://example.com/path' },
  'uri-reference': { placeholder: '/relative/path' },
  'uri-reference--full': { placeholder: '/relative/path' },
  'uri-template': { placeholder: '/users/{id}' },
  'url': { control: 'url', placeholder: 'https://example.com' },
  'url--full': { control: 'url', placeholder: 'https://example.com' },
  'iri': { control: 'url', placeholder: 'https://example.com/päth' },
  'iri-reference': { placeholder: '/relative/päth' },

  // -- identifiers
  'uuid': { placeholder: '123e4567-e89b-12d3-a456-426614174000' },
  'guid': { placeholder: '123e4567-e89b-12d3-a456-426614174000' },
  'identifier': { placeholder: 'my_identifier' },
  'html-identifier': { placeholder: 'my-element-id' },
  'css-identifier': { placeholder: 'my-class-name' },

  // -- json addressing
  'json-pointer': { placeholder: '/path/to/value' },
  'json-pointer-uri-fragment': { placeholder: '#/path/to/value' },
  'relative-json-pointer': { placeholder: '1/sibling' },
  'json-path': { placeholder: '$.store.book[0].title' },

  // -- misc
  'regex': { placeholder: '^[a-z]+$' },
  'base64': { control: 'textarea', placeholder: 'SGVsbG8=' },
  'byte': { control: 'textarea', placeholder: 'SGVsbG8=' },
  'alpha': { placeholder: 'alpha' },
  'numeric': { placeholder: '0123' },
  'alphanumeric': { placeholder: 'abc123' },
  'hexadecimal': { placeholder: 'deadbeef' },
  'uppercase': { placeholder: 'ABC' },
  'lowercase': { placeholder: 'abc' },
  'color': { control: 'color', placeholder: '#ff8800' },
  'isbn10': { placeholder: '0-306-40615-2' },
  'isbn13': { placeholder: '978-3-16-148410-0' },
  'iban': { placeholder: 'NL91ABNA0417164300' },
  'country2': { placeholder: 'NL' },
};

function acceptAnything() {
  return true;
}

/** @type {Record<string, FormatInfo>} */
export const FORM_FORMATS = {};
for (const [name, test] of Object.entries(formatTesters)) {
  const control = name in numberFormatTesters ? 'number' : 'text';
  FORM_FORMATS[name] = { test, control, ...FORM_HINTS[name] };
}

// -- convenience (non-standard, control hints only; unknown to the
//    validator's registries, so they never assert anything)
FORM_FORMATS['password'] = { test: acceptAnything, control: 'password' };
FORM_FORMATS['textarea'] = { test: acceptAnything, control: 'textarea' };
FORM_FORMATS['multiline'] = { test: acceptAnything, control: 'textarea' };

/**
 * Look up the format info for a JSON Schema format name.
 * @param {string|undefined} format - The format name
 * @returns {FormatInfo|null} The format info, or null when unknown
 */
export function getFormatInfo(format) {
  if (typeof format !== 'string') return null;
  return FORM_FORMATS[format] || null;
}
