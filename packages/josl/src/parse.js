//#region JOSL parse
// Whole-document parsing and streaming share one grammar implementation
// (machine.js) and differ only in how a logical line's end is found: with
// the whole text in hand the parser discovers it as it goes, while a chunk
// stream needs the cutter's side-effect-free pre-pass first.

import { JoslMachine } from './machine.js';
import { admitOptions, JOSL_READ, TOML_READ } from './options.js';

/**
 * Parse a complete JOSL document.
 * @param {string} text - JOSL source text
 * @param {object} [options] - Reader options
 * @param {'josl'|'toml'} [options.mode] - 'toml' rejects JOSL extensions
 *  (null, bigint, regexp literals, root arrays) for strict TOML 1.0 input
 * @param {(event: object) => void} [options.onEvent] - Document-order
 *  event sink; see `createStreamReader`
 * @returns {object|Array} The root table, or root array for [[]] documents
 * @throws {import('./errors.js').JoslSyntaxError} On invalid input
 * @throws {TypeError} On an option the reader does not take (the
 *  `JOSL2xxx` limits included), or a value of the wrong type
 */
export function parseJosl(text, options = undefined) {
  return new JoslMachine(admitOptions(options, JOSL_READ, 'parseJosl')).parseAll(text);
}

/**
 * Parse a complete document in strict TOML 1.0 mode.
 * @param {string} text - TOML source text
 * @param {object} [options] - Reader options minus `mode`, which is always `'toml'`
 * @returns {object} The root table
 */
export function parseToml(text, options = undefined) {
  return new JoslMachine({ ...admitOptions(options, TOML_READ, 'parseToml'), mode: 'toml' }).parseAll(text);
}

export { JoslSyntaxError } from './errors.js';
export { LocalDate, LocalTime, LocalDateTime } from './values.js';

//#endregion
