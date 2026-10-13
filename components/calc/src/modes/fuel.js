//@ts-check
/**
 * @file The fuel-economy dimension of the converter. Fuel economy is
 * reciprocal, not affine: L/100km is fuel per distance while mpg and km/L are
 * distance per fuel, so a conversion between the two kinds is `k / value`, not
 * `value * factor + offset`, and `@jarenjs/core/convert`'s registry (which is
 * affine through a base unit) cannot hold it. The kernel lives here, pure and
 * synchronous, and `converter.js` routes the `fuel` dimension to it.
 *
 * Every unit carries one constant `k`, the consumption in L/100km of a vehicle
 * whose economy is exactly 1 of that unit (`null` for L/100km itself). It is
 * one division of two exact integers, so it is the correctly rounded double
 * of the true constant:
 *
 *   km/L      100
 *   mpg (US)  100 L * 1 gal(US) / 1 mi = 378541178400 / 1609344000
 *   mpg (UK)  100 L * 1 gal(UK) / 1 mi = 454609000 / 1609344
 *
 * (US gallon = 3.785411784 L, imperial gallon = 4.54609 L, mile = 1.609344 km,
 * all exact by definition.)
 */

/** The converter dimension id. */
export const FUEL = 'fuel';

/**
 * @typedef {object} FuelUnit
 * @property {string} id unique unit id
 * @property {string} symbol display symbol
 * @property {number|null} k L/100km of a vehicle at exactly 1 of this unit;
 *   `null` for L/100km, the one unit that is fuel per distance
 */

/**
 * The four units, in the order the converter offers them. The array and its
 * records are frozen: the constants are what every later answer is computed
 * from.
 * @type {readonly Readonly<FuelUnit>[]}
 */
export const FUEL_UNITS = Object.freeze([
  Object.freeze({ id: 'l100km', symbol: 'L/100km', k: null }),
  Object.freeze({ id: 'mpgus', symbol: 'mpg (US)', k: 378541178400 / 1609344000 }),
  Object.freeze({ id: 'mpguk', symbol: 'mpg (UK)', k: 454609000 / 1609344 }),
  Object.freeze({ id: 'kml', symbol: 'km/L', k: 100 }),
]);

/** @type {Map<string, Readonly<FuelUnit>>} */
const BY_ID = new Map(FUEL_UNITS.map((unit) => [unit.id, unit]));

/**
 * Convert a fuel economy between L/100km, mpg (US), mpg (UK) and km/L.
 *
 * Between a distance-per-fuel unit and L/100km the result is `k / value`;
 * between two distance-per-fuel units it is `value * (k_to / k_from)` (no
 * double reciprocal, and no intermediate that overflows before the result
 * does). A vehicle that burns no fuel has no finite economy and
 * one that goes nowhere on fuel has no finite consumption, so `0` across the
 * two kinds is refused; `0` stays `0` between units of the same kind, and a
 * unit converted to itself returns the value unchanged.
 *
 * @param {number} value a finite number, zero or greater
 * @param {string} fromId `l100km`, `mpgus`, `mpguk` or `kml`
 * @param {string} toId
 * @returns {number}
 * @throws {RangeError} for an unknown unit, a value that is negative or not
 *   finite, zero across the reciprocal, or a result beyond the double range
 *   (overflowing to Infinity or underflowing to 0)
 */
export function convertFuel(value, fromId, toId) {
  const from = BY_ID.get(fromId);
  const to = BY_ID.get(toId);
  if (from === undefined) throw new RangeError(`convertFuel: unknown unit '${fromId}'`);
  if (to === undefined) throw new RangeError(`convertFuel: unknown unit '${toId}'`);
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`convertFuel: a fuel economy is a finite number of zero or more, got ${String(value)}`);
  }
  if (from === to) return value + 0;
  if (value === 0) {
    if ((from.k === null) !== (to.k === null)) {
      throw new RangeError(`convertFuel: 0 ${from.symbol} has no finite ${to.symbol}`);
    }
    return 0;
  }
  let result;
  if (from.k === null) result = /** @type {number} */ (to.k) / value;
  else if (to.k === null) result = from.k / value;
  else result = value * (to.k / from.k);
  if (!Number.isFinite(result) || result === 0) {
    throw new RangeError(`convertFuel: ${value} ${from.symbol} is beyond the range of ${to.symbol}`);
  }
  return result;
}
