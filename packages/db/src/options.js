//@ts-check
/**
 * @file How this package reads a closed option set (MODEL-FORMAT §4,
 * §5): a member outside the set is refused before any effect — no handle
 * opened, no file created, no statement run — naming the member the
 * caller most plausibly meant. `openStore` (`JD0009`), the transaction
 * surfaces (`JD0013`) and the PostgreSQL driver (`JD0003`) each raise
 * their own code; the nearest-name judgement is `@jarenjs/core/object`'s,
 * shared with every other closed option set in the suite. The model
 * document's declarations are closed sets too (MODEL-FORMAT §2), refused
 * as an invalid model (`JD0005`) at the member itself.
 */

import { isPlainOptions, nearestName, refuseUnknownMembers } from '@jarenjs/core/object';
import { encodeJSONPointerSegment } from '@jarenjs/json/pointer';
import { DbCompileError } from './errors.js';
export { isPlainOptions, nearestName, refuseUnknownMembers } from '@jarenjs/core/object';

/**
 * Refuse the first member of a model declaration outside its closed set:
 * `JD0005` whose `docPath` points at the member, naming the nearest member
 * and the set. Called before any other rule of the declaration, so a typo
 * is reported as the typo it is — a misspelt `unique` used to be dropped,
 * and the index it declared was created without it.
 * @param {Record<string, any>} declaration
 * @param {readonly string[]} members - the closed set, in its documented order
 * @param {string} docPath - the declaration's own pointer into the model
 * @param {string} what - what the declaration is (`'index'`, `'physical layout'`)
 * @returns {void}
 */
export function refuseUnknownModelMembers(declaration, members, docPath, what) {
  for (const key of Object.keys(declaration)) {
    if (members.includes(key)) continue;
    const near = nearestName(key, members);
    throw new DbCompileError('JD0005',
      `unknown ${what} member '${key}'${near === undefined ? '' : ` — did you mean '${near}'?`} `
      + `(${/^[aeiou]/.test(what) ? 'an' : 'a'} ${what} declares ${members.join(', ')})`,
      `${docPath}/${encodeJSONPointerSegment(key)}`);
  }
}

/** Refuse a malformed or misspelt option before its owner takes any resource.
 * @param {any} options @param {readonly string[]} members @param {string} owner
 * @param {string} [code] @returns {void} */
export function readOptions(options, members, owner, code = 'JD0013') {
  if (options === undefined) return;
  if (!isPlainOptions(options)) throw new DbCompileError(code, `${owner} options must be a plain object`);
  refuseUnknownMembers(options, members, (key, hint) =>
    new DbCompileError(code, `${owner} option '${key}' is not one it reads${hint}`));
}

/** Whether a value can stand for an `AbortSignal`: what admission reads
 * (`aborted`) and listens on (`addEventListener`, `removeEventListener`).
 * @param {any} signal @returns {boolean} */
export function isAbortSignal(signal) {
  return signal !== null && typeof signal === 'object' && typeof signal.aborted === 'boolean'
    && typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function';
}

/** Validate controls before a signal enters admission or a deadline is compared.
 * This reads values only; each operation owns its closed set of names.
 * @param {any} options @param {string} owner @returns {void} */
export function readControls(options, owner) {
  if (options === undefined) return;
  const refuse = (name, rule) => new DbCompileError('JD0013', `${owner} option '${name}' ${rule}`);
  const signal = options?.signal;
  if (signal !== undefined && !isAbortSignal(signal)) throw refuse('signal', 'must be an AbortSignal');
  if (options?.deadline !== undefined && (typeof options.deadline !== 'number' || !Number.isFinite(options.deadline)))
    throw refuse('deadline', 'must be a finite timestamp');
  if (options?.strictStreaming !== undefined && typeof options.strictStreaming !== 'boolean')
    throw refuse('strictStreaming', 'must be true or false');
  if (options?.externals !== undefined && !isPlainOptions(options.externals))
    throw refuse('externals', 'must be a plain object of named values');
}
