//@ts-check
/**
 * @file The brand of the temporal seam (MODEL-FORMAT §2, `temporals`) and the
 * refusal of a declaration met without it, the pieces of it the store
 * carries: a declared temporal member is read, keyed, refused and compared
 * through `@jarenjs/db/temporals`, so a store that declares none carries no
 * calendar and none of that code.
 */
import { DbCompileError } from './errors.js';

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

/**
 * The refusal of a declared temporal member met without the seam that keys
 * it (`JD0017`), at the declaration's place.
 * @param {string} docPath
 * @returns {DbCompileError}
 */
export const unseamed = (docPath) => new DbCompileError('JD0017',
  "a temporal member is keyed by the temporal seam: open the store with temporals: storeTemporals() from '@jarenjs/db/temporals'", docPath);
