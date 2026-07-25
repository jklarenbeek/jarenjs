//@ts-check
/**
 * @file The static conversion engine. Pure, single-pass,
 * no per-call allocation. Rejects cross-dimension conversions with a
 * clear error.
 */

import { DIMENSIONS, UNIT_INDEX } from './registry.js';

/**
 * Convert `value` from unit `fromId` to unit `toId` (same dimension).
 * Affine through the dimension base: `base = value*factor + offset`,
 * `target = (base - offset')/factor'`.
 *
 * @param {number} value
 * @param {string} fromId
 * @param {string} toId
 * @returns {number}
 */
export function convert(value, fromId, toId) {
  const from = UNIT_INDEX.get(fromId);
  const to = UNIT_INDEX.get(toId);
  if (from === undefined) throw new RangeError(`convert: unknown unit '${fromId}'`);
  if (to === undefined) throw new RangeError(`convert: unknown unit '${toId}'`);
  if (from.dimension !== to.dimension) {
    throw new RangeError(
      `convert: cannot convert '${fromId}' (${from.dimension}) to '${toId}' (${to.dimension})`);
  }
  const base = value * from.unit.factor + (from.unit.offset ?? 0);
  return (base - (to.unit.offset ?? 0)) / to.unit.factor;
}

/**
 * The unit list for a dimension (in registry order).
 * @param {string} dimension
 * @returns {import('./registry.js').Unit[]}
 */
export function unitsOf(dimension) {
  const def = DIMENSIONS[dimension];
  if (def === undefined) throw new RangeError(`convert: unknown dimension '${dimension}'`);
  return def.units;
}

/**
 * All dimension names.
 * @returns {string[]}
 */
export function dimensions() {
  return Object.keys(DIMENSIONS);
}

/**
 * Look up the dimension a unit belongs to (or `null`).
 * @param {string} unitId
 * @returns {string|null}
 */
export function dimensionOf(unitId) {
  return UNIT_INDEX.get(unitId)?.dimension ?? null;
}
