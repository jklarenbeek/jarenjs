//@ts-check

//#region @jarenjs/core/dates
// The suite's date kernel. Dates are not a type here: they are the two
// forms JSON already has - an RFC 3339 **string** (lexical, what
// documents, schemas, forms and TOML actually contain) and **epoch
// milliseconds** (arithmetic, what a chart plots). A wrapper object,
// even an immutable one, could not be a query-engine item, a JSON Patch
// target or part of app state, which is why `canonicalizeJson` turns a
// `Date` into `{}`.
//
// The parts record produced by `parseRFC3339Parts` is the intermediate
// the calendar functions work on; it is deliberately plain data and is
// never handed to a consumer as an opaque handle.
//
//   rfc3339.js  validation, lexical decomposition, epoch conversion
//   civil.js    proleptic Gregorian arithmetic over integers
//   format.js   LDML pattern -> compiled formatter
//   duration.js ISO 8601 duration decomposition and conversion
//   ticks.js    the time-axis step ladder and its boundaries
//
// Locale-dependent presentation (month and weekday names, relative
// phrasing) is NOT here: it belongs to @jarenjs/locales, so this module
// stays zero-dependency and free of data that would drift per language.

export * from './rfc3339.js';
export * from './civil.js';
export * from './format.js';
export * from './duration.js';
export * from './ticks.js';

//#endregion
