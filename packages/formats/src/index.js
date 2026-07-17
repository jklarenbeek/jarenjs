//@ts-check

/**
 * A compiled format validator: tests one instance value against the
 * format. `dataPath` is the value's RFC 6901 location, used in error
 * reporting when error collection is enabled.
 * @typedef {(data: unknown, dataPath?: string) => boolean} FormatValidator
 */

/**
 * A format compiler as consumed by the JarenValidator's addFormat and
 * addFormats methods of @jarenjs/validate: called once per schema
 * location at compile time with the compiling validation object and the
 * schema declaring the format, it returns the FormatValidator invoked for
 * each instance value. Typed structurally so @jarenjs/formats stays free
 * of a dependency on @jarenjs/validate.
 * @typedef {(schemaObj: import('./string.js').ValidationObject, jsonSchema: import('./string.js').JSONSchema) => FormatValidator} FormatCompiler
 */

export { formatValidators as dateTimeFormats } from './datetime.js';
export { formatValidators as stringFormats } from './string.js';
export { formatValidators as numberFormats } from './number.js';
export { formatValidators as jsonFormats } from './json.js';

export {
  formatTesters,
  stringFormatTesters,
  jsonFormatTesters,
  dateTimeFormatTesters,
  numberFormatTesters,
} from './testers.js';
