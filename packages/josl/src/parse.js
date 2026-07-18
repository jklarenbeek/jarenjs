//#region JOSL parse
// Whole-document parsing is the streaming machine fed a single chunk, so
// both entry points share one grammar implementation (machine.js).

import { JoslMachine } from './machine.js';

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
 */
export function parseJosl(text, options = undefined) {
  return new JoslMachine(options).feed(text).end();
}

/**
 * Parse a complete document in strict TOML 1.0 mode.
 * @param {string} text - TOML source text
 * @param {object} [options] - Reader options minus `mode`
 * @returns {object} The root table
 */
export function parseToml(text, options = undefined) {
  return new JoslMachine({ ...options, mode: 'toml' }).feed(text).end();
}

export { JoslSyntaxError } from './errors.js';
export { LocalDate, LocalTime, LocalDateTime } from './values.js';

//#endregion
