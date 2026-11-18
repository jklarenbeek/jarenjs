//@ts-check
/**
 * @file The static conversion engine. Pure, single-pass,
 * no per-call allocation. Rejects cross-dimension conversions with a
 * clear error.
 */

import { DIMENSIONS, UNIT_INDEX, EXACT_FACTORS, ratioToNumber } from './registry.js';

/** @param {bigint} a @param {bigint} b @returns {bigint} */
function gcd(a, b) {
  while (b !== 0n) [a, b] = [b, a % b];
  return a < 0n ? -a : a;
}

/**
 * The exact ratio of one unit to another, by `from` then `to`: a reduced
 * `mul / div` of two safe integers (`floz` → `tsp` is 6 / 1), else the
 * nearest double of the ratio, or `null` where the two have no exact
 * ratio (a temperature, or a π that does not cancel).
 * @type {Map<string, Map<string, { mul: number, div: number } | null>>}
 */
const RATIOS = new Map();

/**
 * @param {string} fromId @param {string} toId
 * @returns {{ mul: number, div: number } | null}
 */
function ratioOf(fromId, toId) {
  let row = RATIOS.get(fromId);
  if (row === undefined) RATIOS.set(fromId, row = new Map());
  let ratio = row.get(toId);
  if (ratio === undefined) {
    const a = EXACT_FACTORS.get(fromId);
    const b = EXACT_FACTORS.get(toId);
    ratio = null;
    if (a !== undefined && b !== undefined && a.pi === b.pi) {
      let n = a.n * b.d;
      let d = a.d * b.n;
      const g = gcd(n, d);
      n /= g;
      d /= g;
      const safe = (/** @type {bigint} */ x) => x <= BigInt(Number.MAX_SAFE_INTEGER);
      ratio = safe(n) && safe(d) ? { mul: Number(n), div: Number(d) } : { mul: ratioToNumber(n, d), div: 1 };
    }
    row.set(toId, ratio);
  }
  return ratio;
}

/**
 * Convert `value` from unit `fromId` to unit `toId` (same dimension).
 * Between two units with exact factors the value is multiplied and divided
 * by their reduced exact ratio (`1 fl oz` is exactly `6 tsp`, `1 gal` is
 * `3.785411784 L`, each rounded once); otherwise, a temperature, or an
 * angle with π on one side only, it is affine through the dimension base:
 * `base = value*factor + offset`, `target = (base - offset')/factor'`.
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
  const ratio = ratioOf(fromId, toId);
  if (ratio !== null) return ratio.div === 1 ? value * ratio.mul : (value * ratio.mul) / ratio.div;
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
