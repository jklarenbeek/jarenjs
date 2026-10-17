import {
  isStringType,
  isFn,
} from '@jarenjs/core';

import { describeValue, SchemaCompileError } from './errors.js';
import { isDollarDataRef } from './schema-keywords.js';
import { compiledLocation, keywordLocation } from './traverse.js';

/** @typedef {import('./index.js').FormatCompiler} FormatCompiler */

/**
 * Registers a single format compiler under a name, as an own member of the
 * registry (a name the object prototype holds, `constructor` or `__proto__`,
 * registers like any other).
 * Existing registrations are never overwritten.
 * @param {Record<string, FormatCompiler>} registered - The formats registry object
 * @param {string} name - The format name (e.g. 'email', 'uri', 'date-time')
 * @param {FormatCompiler} formatCompiler - The compiler to register
 * @returns {boolean} True when the compiler was registered
 */
export function registerFormatCompiler(registered, name, formatCompiler) {
  if (getSchemaFormatCompiler(registered, name) != null || !isFn(formatCompiler))
    return false;
  Object.defineProperty(registered, name, { value: formatCompiler, writable: true, enumerable: true, configurable: true });
  return true;
}

/**
 * Registers multiple format compilers at once.
 * Existing registrations are never overwritten.
 * @param {Record<string, FormatCompiler>} registered - The formats registry object
 * @param {Record<string, FormatCompiler>} formatCompilers - Object mapping format names to compiler functions
 * @returns {Record<string, FormatCompiler>} The registry object passed in
 */
export function registerFormatCompilers(registered, formatCompilers) {
  const keys = Object.keys(formatCompilers);
  for (let i = 0; i < keys.length; ++i) {
    const key = keys[i];
    const item = formatCompilers[key];
    registerFormatCompiler(registered, key, item);
  }
  return registered;
}

/** Named once: both wrong-shape paths end at the same mistake. */
const WRONG_SHAPE_HINT = 'Register the format COMPILERS (stringFormats, dateTimeFormats, '
  + 'numberFormats, jsonFormats, geoFormats) rather than the raw testers (formatTesters) — '
  + 'both are objects full of functions, and only the compilers take (schemaObj, jsonSchema).';

/**
 * The compiler registered under a format name: an own member of the
 * registry, so a name only the object prototype holds (`toString`) is
 * registered nowhere.
 * @param {Record<string, FormatCompiler>} registered - The formats registry object
 * @param {unknown} name - The format keyword's value
 * @returns {FormatCompiler | undefined}
 */
export function getSchemaFormatCompiler(registered, name) {
  return isStringType(name) && Object.hasOwn(registered, name) ? registered[name] : undefined;
}

export function compileFormatBasic(schemaObj, jsonSchema) {
  const format = jsonSchema.format;
  // A $data reference is compiled with the $data keywords.
  if (format === undefined || isDollarDataRef(format))
    return undefined;

  // From draft 2020-12 on, format is annotation-only unless assertion is
  // enabled (formatAssertion option or format-assertion vocabulary).
  // Nothing is lost by an unregistered name here — the keyword would not
  // have asserted even with a compiler — so the unknownFormats check
  // below deliberately does not run in this branch. Complaining here
  // would be complaining about the spec.
  if (schemaObj.options.formatAssertion === false)
    return undefined;
  const compiler = getSchemaFormatCompiler(schemaObj.formats, format);

  // An unregistered name with assertion ON is the silent failure this
  // check exists to end: the author asked for the value to be checked,
  // the registry has nothing to check it with, and without this the
  // schema compiles to a validator that accepts everything. A value that
  // is no name at all (a number, null) is the same failure. Raising it
  // at COMPILE time keeps instance validation spec-exact — no data is
  // ever invalidated by an unknown format, the schema's AUTHOR is told.
  if (compiler == null) {
    if (schemaObj.options.unknownFormats === 'ignore')
      return undefined;
    const named = isStringType(format)
      ? `Unknown format '${format}': no compiler is registered for it`
      : `'format' holds ${describeValue(format)}, which names no format`;
    throw new SchemaCompileError('JK0015', `${named}, `
      + 'so this schema would accept every value for that keyword. Register one '
      + '(addFormats(dateTimeFormats) etc. from @jarenjs/formats, or addFormat(name, compiler) '
      + "for your own), or pass { unknownFormats: 'ignore' } to accept it as an annotation",
    compiledLocation(keywordLocation(schemaObj.path, 'format'), schemaObj.root.origin));
  }

  // A format COMPILER is called once per schema location and returns the
  // per-value validator. Handing it a bare tester — `formatTesters`
  // instead of `dateTimeFormats`, an easy mistake since both are objects
  // full of functions — either returns a boolean (which the caller
  // silently drops, so the format checks nothing again) or throws deep
  // inside the tester on an argument it never expected. Both become one
  // legible complaint here.
  let validator;
  try {
    validator = compiler(schemaObj, jsonSchema);
  }
  catch (err) {
    throw new Error(`Format '${format}' failed to compile: ${err?.message ?? err}. `
      + `${WRONG_SHAPE_HINT}`, { cause: err });
  }
  // Nullish stays legal: a compiler may decline a schema it cannot serve.
  if (validator != null && !isFn(validator) && !Array.isArray(validator)) {
    throw new Error(`Format '${format}' is registered with something that is not a `
      + `format compiler: calling it returned ${typeof validator}, not a validator function. `
      + `${WRONG_SHAPE_HINT}`);
  }
  return validator;
}
