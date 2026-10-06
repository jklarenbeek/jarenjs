//@ts-check
/**
 * @file How this package reads a closed option set (MODEL-FORMAT §4,
 * §5): a member outside the set is refused before any effect — no handle
 * opened, no file created, no statement run — naming the member the
 * caller most plausibly meant. `openStore` (`JD0009`), the transaction
 * surfaces (`JD0013`) and the PostgreSQL driver (`JD0003`) each raise
 * their own code; the nearest-name judgement is `@jarenjs/core/object`'s,
 * shared with every other closed option set in the suite.
 */

import { isPlainOptions, refuseUnknownMembers } from '@jarenjs/core/object';
import { DbCompileError } from './errors.js';
export { isPlainOptions, nearestName, refuseUnknownMembers } from '@jarenjs/core/object';

/** Refuse a malformed or misspelt option before its owner takes any resource.
 * @param {any} options @param {readonly string[]} members @param {string} owner
 * @param {string} [code] @returns {void} */
export function readOptions(options, members, owner, code = 'JD0013') {
  if (options === undefined) return;
  if (!isPlainOptions(options)) throw new DbCompileError(code, `${owner} options must be a plain object`);
  refuseUnknownMembers(options, members, (key, hint) =>
    new DbCompileError(code, `${owner} option '${key}' is not one it reads${hint}`));
}

/** Validate controls before a signal enters admission or a deadline is compared.
 * This reads values only; each operation owns its closed set of names.
 * @param {any} options @param {string} owner @returns {void} */
export function readControls(options, owner) {
  if (options === undefined) return;
  const refuse = (name, rule) => new DbCompileError('JD0013', `${owner} option '${name}' ${rule}`);
  const signal = options?.signal;
  if (signal !== undefined && (signal === null || typeof signal !== 'object'
    || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function'
    || typeof signal.removeEventListener !== 'function')) throw refuse('signal', 'must be an AbortSignal');
  if (options?.deadline !== undefined && (typeof options.deadline !== 'number' || !Number.isFinite(options.deadline)))
    throw refuse('deadline', 'must be a finite timestamp');
  if (options?.strictStreaming !== undefined && typeof options.strictStreaming !== 'boolean')
    throw refuse('strictStreaming', 'must be true or false');
  if (options?.externals !== undefined && !isPlainOptions(options.externals))
    throw refuse('externals', 'must be a plain object of named values');
}
