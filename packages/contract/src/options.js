//@ts-check
/** @file Admission shared by the contract bindings: closed option records and
 * genuine AbortSignals, refused before a transport or handler sees them. */
import { isPlainOptions, refuseUnknownMembers } from '@jarenjs/core/object';

/**
 * @param {unknown} options
 * @param {readonly string[]} known
 * @param {(reason: string) => Error} refusal
 * @param {string} [label]
 * @returns {asserts options is Record<string, any>}
 */
export function admitOptions(options, known, refusal, label = 'options') {
  if (!isPlainOptions(options)) throw refusal(`${label} must be a plain object`);
  refuseUnknownMembers(options, known, (key, hint) => refusal(`${label} has no member '${key}'${hint}`));
}

/**
 * Use the platform's brand check, which also accepts signals from another
 * realm. A shape with an `aborted` member can still fail AbortSignal.any
 * or lose its listeners, so it is not an admitted cancellation signal.
 * @param {unknown} value
 * @param {(reason: string) => Error} refusal
 * @param {string} [label]
 * @returns {AbortSignal | null}
 */
export function admitSignal(value, refusal, label = 'options.signal') {
  if (value === undefined || value === null) return null;
  try {
    const readAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
    if (readAborted === undefined) throw new TypeError('AbortSignal has no aborted accessor');
    readAborted.call(value);
    return /** @type {AbortSignal} */ (value);
  }
  catch {
    throw refusal(`${label} must be an AbortSignal or null`);
  }
}
