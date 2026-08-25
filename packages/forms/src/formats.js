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

import {
  isValidGeoJson,
} from '@jarenjs/core/geo';

/**
 * @typedef {object} FormatInfo
 * @property {(value: string) => boolean} test - Synchronous validity test
 * @property {string} control - Suggested HTML input control
 * @property {string} [placeholder] - Suggested placeholder text
 * @property {FormatPreview} [preview] - What a host MAY render beside the
 *   control, as data (see {@link FormatPreview}); absent for formats a
 *   text control already shows in full
 */

/**
 * A preview hint: a description of what to draw from the field's value,
 * for a host that has a renderer for it. It is DATA, not a renderer —
 * `@jarenjs/forms` imports no chart, and a host that does not recognise
 * `kind` ignores the hint and the field behaves exactly as without it.
 * The one kind shipped is `map`: the host feeds the field's parsed
 * GeoJSON to a map renderer (`@jarenjs/charts`' `map` type takes a
 * `FeatureCollection`, a `Feature` or a geometry as `features`).
 * @typedef {object} FormatPreview
 * @property {string} kind - The renderer family the host is asked for ('map')
 */

/**
 * Rendering hints per format name. Formats without an entry render as a
 * plain text input (number-group formats as a number input). A hint may
 * also override the canonical `test` when what a form field holds is not
 * what the validator's format judges (a field holds `geojson` as text,
 * the format applies to the parsed object).
 * @type {Record<string, { control?: string, placeholder?: string, test?: (value: string) => boolean, preview?: FormatPreview }>}
 */
const FORM_HINTS = {
  // -- date and time. Which formats get a native control is decided by
  //    the offset, not by convenience: HTML's `datetime-local` and `time`
  //    inputs cannot produce one, so binding them to the RFC 3339 formats
  //    would make the control emit values its own schema rejects. The ISO
  //    formats leave the offset optional and are exactly what those
  //    inputs spell, so they map losslessly.
  'date': { control: 'date', placeholder: '2024-01-15' },
  'time': { placeholder: '13:45:30Z' },
  'date-time': { placeholder: '2024-01-15T13:45:30Z' },
  'iso-date-time': { control: 'datetime-local', placeholder: '2024-01-15T13:45:30' },
  'iso-time': { control: 'time', placeholder: '13:45:30' },
  'duration': { placeholder: 'P3DT4H' },

  // -- email
  'email': { control: 'email', placeholder: 'user@example.com' },
  'idn-email': { control: 'email', placeholder: 'user@example.com' },

  // -- hosts and addresses
  'hostname': { placeholder: 'example.com' },
  'idn-hostname': { placeholder: 'example.com' },
  'ipv4': { placeholder: '192.168.0.1' },
  'ipv6': { placeholder: '::1' },
  'mac': { placeholder: '00:1B:44:11:3A:B7' },

  // -- uris
  'uri': { control: 'url', placeholder: 'https://example.com/path' },
  'uri-reference': { placeholder: '/relative/path' },
  'uri-template': { placeholder: '/users/{id}' },
  'url': { control: 'url', placeholder: 'https://example.com' },
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
  'iregexp': { placeholder: '[a-z]+' },
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

  // -- geospatial. The geojson tester judges the OBJECT, but a form
  //    field holds its text, so the field-level test parses first.
  //    The text a user types is valid GeoJSON long before it is the
  //    shape they meant, which no textarea can show: `preview` tells a
  //    host that has a map renderer to draw the parsed value. It is a
  //    hint in the same sense `control` is — a host without one
  //    ignores it and the field is exactly this textarea.
  'geohash': { placeholder: 'u173z' },
  'wkt': { placeholder: 'POINT (4.9041 52.3676)' },
  'geojson': {
    control: 'textarea',
    placeholder: '{"type":"Point","coordinates":[4.9,52.4]}',
    preview: { kind: 'map' },
    test: (text) => {
      try {
        return isValidGeoJson(JSON.parse(text));
      }
      catch {
        return false;
      }
    },
  },
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
