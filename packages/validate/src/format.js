import {
  isStringType,
  isFn,
} from '@jarenjs/core';

/** @typedef {import('./index.js').FormatCompiler} FormatCompiler */

/**
 * Registers a single format compiler under a name.
 * Existing registrations are never overwritten.
 * @param {Record<string, FormatCompiler>} registered - The formats registry object
 * @param {string} name - The format name (e.g. 'email', 'uri', 'date-time')
 * @param {FormatCompiler} formatCompiler - The compiler to register
 * @returns {boolean} True when the compiler was registered
 */
export function registerFormatCompiler(registered, name, formatCompiler) {
  if (registered[name] == null) {
    if (isFn(formatCompiler)) {
      registered[name] = formatCompiler;
      return true;
    }
  }
  return false;
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

export function getSchemaFormatCompiler(registered, name) {
  if (isStringType(name))
    return registered[name];
  else
    return undefined;
}

export function compileFormatBasic(schemaObj, jsonSchema) {
  if (!isStringType(jsonSchema.format))
    return undefined;

  // From draft 2020-12 on, format is annotation-only unless assertion is
  // enabled (formatAssertion option or format-assertion vocabulary).
  if (schemaObj.options.formatAssertion === false)
    return undefined;
  const compiler = getSchemaFormatCompiler(
    schemaObj.formats,
    jsonSchema.format);

  if (compiler)
    return compiler(schemaObj, jsonSchema);
  else
    return undefined;
}
