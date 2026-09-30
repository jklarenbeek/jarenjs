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

export { nearestName, refuseUnknownMembers } from '@jarenjs/core/object';

/**
 * Whether `value` is a plain options object: an object literal or a
 * null-prototype record, never an array, a class instance or a string.
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
export function isPlainOptions(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
