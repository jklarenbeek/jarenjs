//@ts-check
/**
 * @file The brand of the temporal seam (MODEL-FORMAT §2, `temporals`), the
 * one piece of it the store carries: a declared temporal member is keyed,
 * refused and compared through `@jarenjs/db/temporals`, so a store that
 * declares none carries no calendar and none of that code.
 */

/** The values `storeTemporals()` answered: the only ones a store takes as `temporals`. */
export const TEMPORAL_SEAMS = new WeakSet();

/**
 * Whether a value is one `storeTemporals()` from `@jarenjs/db/temporals` answered.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isStoreTemporals(value) {
  return value !== null && typeof value === 'object' && TEMPORAL_SEAMS.has(value);
}
