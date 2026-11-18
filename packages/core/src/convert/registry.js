//@ts-check
/**
 * @file Unit registry. Fixed-factor unit definitions per
 * **dimension**. Conversion is affine through the dimension's base unit:
 *
 *   base   = value * factor + offset
 *   target = (base - offset') / factor'
 *
 * Most dimensions are linear (`offset` absent = 0); **temperature** is
 * affine (°C/°F/K/°R). Digital storage ships both binary (KiB/MiB, 1024)
 * and decimal (KB/MB, 1000) prefixes. Every linear factor is written as its
 * exact definition (a rational, times π for the angles), so a conversion
 * between two units divides out exactly what they share: 1 fl oz is 6 tsp,
 * 1 gal is 128 fl oz.
 *
 * Number-base conversion (HEX/DEC/OCT/BIN) is intentionally NOT here — it
 * is `@jarenjs/core/math/word.js` (`toBase`/`fromBase`), which the
 * converter delegates to. Fuel-economy (mpg ↔ L/100km) is non-affine and
 * likewise out of this data-driven model.
 */

const F = 5 / 9; // °F/°R scale relative to Kelvin

/**
 * A factor as its exact definition: the rational `n / d` (whole numbers),
 * times π to the power `pi` (an angle's radian is the one irrational unit).
 * @typedef {{ n: bigint, d: bigint, pi: number }} ExactFactor
 */

/**
 * The exact factor `n / d · π^pi`.
 * @param {bigint | number} n @param {bigint | number} [d] @param {number} [pi]
 * @returns {ExactFactor}
 */
function q(n, d = 1n, pi = 0) {
  return { n: BigInt(n), d: BigInt(d), pi };
}

/**
 * The double of `n / d`: the quotient carried in BigInt to at least 25
 * significant digits, whatever the two magnitudes, then read once.
 * @param {bigint} n @param {bigint} d
 * @returns {number}
 */
export function ratioToNumber(n, d) {
  const negative = (n < 0n) !== (d < 0n);
  const top = n < 0n ? -n : n;
  const bottom = d < 0n ? -d : d;
  const shift = Math.max(0, 25 + String(bottom).length - String(top).length);
  const value = Number(`${(top * 10n ** BigInt(shift)) / bottom}e-${shift}`);
  return negative ? -value : value;
}

/**
 * The exact factor of each unit that has one, by unit id: every unit but
 * the temperatures, whose offsets keep them on the `factor`/`offset` path.
 * Kept beside the registry, not on the `Unit` records, so a unit stays
 * plain JSON.
 * @type {Map<string, ExactFactor>}
 */
export const EXACT_FACTORS = new Map();

/**
 * @typedef {object} Unit
 * @property {string} id unique unit id
 * @property {string} symbol display symbol
 * @property {number} factor multiply to reach the base unit (the nearest
 *   double of the unit's exact definition)
 * @property {number} [offset] affine offset toward the base unit
 */

/**
 * Construct a registry entry; the common display symbol is its id. A
 * factor given as its exact definition (`q(n, d, pi)`) is recorded in
 * {@link EXACT_FACTORS} and held on the unit as its nearest double.
 * @param {string} id
 * @param {number | ExactFactor} factor
 * @param {string} [symbol]
 * @param {number} [offset]
 * @returns {Unit}
 */
function defineUnit(id, factor, symbol = id, offset) {
  let value = /** @type {number} */ (factor);
  if (typeof factor === 'object') {
    EXACT_FACTORS.set(id, factor);
    value = ratioToNumber(factor.n, factor.d) * Math.PI ** factor.pi;
  }
  /** @type {Unit} */
  const result = { id, symbol, factor: value };
  if (offset !== undefined) result.offset = offset;
  return result;
}

// The definitions every factor below is built from (exact, by statute or
// by the SI): the international inch (1959), the international avoirdupois
// pound (1959), standard gravity, the US gallon (231 cubic inches), and the
// nautical mile.
const INCH = q(254, 10000); // m
const FOOT = q(3048, 10000); // m
const MILE = q(1609344, 1000); // m
const POUND = q(45359237, 100000000); // kg
const GRAVITY = q(980665, 100000); // m/s², standard gravity
/** @param {ExactFactor} a @param {ExactFactor} b @returns {ExactFactor} */
const times = (a, b) => q(a.n * b.n, a.d * b.d, a.pi + b.pi);
/** @param {ExactFactor} a @param {ExactFactor} b @returns {ExactFactor} */
const over = (a, b) => q(a.n * b.d, a.d * b.n, a.pi - b.pi);
const GALLON = q(231n * 254n ** 3n, 10n ** 9n); // L: 231 in³ = 3.785411784 L
const POUND_FORCE = times(POUND, GRAVITY); // N

/** @type {Record<string, { base: string, units: Unit[] }>} */
export const DIMENSIONS = {
  length: {
    base: 'm',
    units: [
      defineUnit('nm', q(1, 10n ** 9n)),
      defineUnit('um', q(1, 10n ** 6n), 'µm'),
      defineUnit('mm', q(1, 1000)),
      defineUnit('cm', q(1, 100)),
      defineUnit('m', q(1)),
      defineUnit('km', q(1000)),
      defineUnit('in', INCH),
      defineUnit('ft', FOOT),
      defineUnit('yd', q(9144, 10000)),
      defineUnit('mi', MILE),
      defineUnit('nmi', q(1852)),
    ],
  },
  area: {
    base: 'm2',
    units: [
      defineUnit('mm2', q(1, 10n ** 6n), 'mm²'),
      defineUnit('cm2', q(1, 10n ** 4n), 'cm²'),
      defineUnit('m2', q(1), 'm²'),
      defineUnit('ha', q(10000)),
      defineUnit('km2', q(10n ** 6n), 'km²'),
      defineUnit('in2', times(INCH, INCH), 'in²'),
      defineUnit('ft2', times(FOOT, FOOT), 'ft²'),
      defineUnit('acre', times(q(43560), times(FOOT, FOOT))), // 43,560 ft²
      defineUnit('mi2', times(MILE, MILE), 'mi²'),
    ],
  },
  volume: {
    base: 'l',
    units: [
      defineUnit('ml', q(1, 1000), 'mL'),
      defineUnit('l', q(1), 'L'),
      defineUnit('m3', q(1000), 'm³'),
      // the US customary measures, each a fraction of the gallon
      defineUnit('tsp', over(GALLON, q(768))),
      defineUnit('tbsp', over(GALLON, q(256))),
      defineUnit('floz', over(GALLON, q(128)), 'fl oz'),
      defineUnit('cup', over(GALLON, q(16))),
      defineUnit('pt', over(GALLON, q(8))),
      defineUnit('qt', over(GALLON, q(4))),
      defineUnit('gal', GALLON),
    ],
  },
  mass: {
    base: 'kg',
    units: [
      defineUnit('mg', q(1, 10n ** 6n)),
      defineUnit('g', q(1, 1000)),
      defineUnit('kg', q(1)),
      defineUnit('t', q(1000)), // the metric tonne
      defineUnit('oz', over(POUND, q(16))),
      defineUnit('lb', POUND),
      defineUnit('st', times(POUND, q(14))),
    ],
  },
  temperature: {
    base: 'K',
    units: [
      defineUnit('K', 1, 'K', 0),
      defineUnit('C', 1, '°C', 273.15),
      defineUnit('F', F, '°F', 273.15 - 32 * F),
      defineUnit('R', F, '°R', 0),
    ],
  },
  time: {
    base: 's',
    units: [
      defineUnit('ns', q(1, 10n ** 9n)),
      defineUnit('us', q(1, 10n ** 6n), 'µs'),
      defineUnit('ms', q(1, 1000)),
      defineUnit('s', q(1)),
      defineUnit('min', q(60)),
      defineUnit('h', q(3600)),
      defineUnit('day', q(86400)),
      defineUnit('week', q(604800)),
      defineUnit('year', q(31557600)), // the Julian year, 365.25 days
    ],
  },
  speed: {
    base: 'mps',
    units: [
      defineUnit('mps', q(1), 'm/s'),
      defineUnit('kmh', q(1000, 3600), 'km/h'),
      defineUnit('mph', over(MILE, q(3600))),
      defineUnit('fps', FOOT, 'ft/s'),
      defineUnit('knot', q(1852, 3600), 'kn'), // a nautical mile an hour
    ],
  },
  pressure: {
    base: 'pa',
    units: [
      defineUnit('pa', q(1), 'Pa'),
      defineUnit('kpa', q(1000), 'kPa'),
      defineUnit('bar', q(100000)),
      defineUnit('atm', q(101325)),
      defineUnit('psi', over(POUND_FORCE, times(INCH, INCH))), // lbf/in²
      defineUnit('mmhg', q(133322387415n, 10n ** 9n), 'mmHg'), // the conventional millimetre of mercury
      defineUnit('torr', q(101325, 760), 'Torr'),
    ],
  },
  energy: {
    base: 'j',
    units: [
      defineUnit('j', q(1), 'J'),
      defineUnit('kj', q(1000), 'kJ'),
      defineUnit('cal', q(4184, 1000)), // the thermochemical calorie
      defineUnit('kcal', q(4184)),
      defineUnit('wh', q(3600), 'Wh'),
      defineUnit('kwh', q(3600000), 'kWh'),
      defineUnit('btu', q(105505585262n, 10n ** 8n), 'BTU'), // the International Table BTU
      defineUnit('ev', q(1602176634n, 10n ** 28n), 'eV'),
    ],
  },
  power: {
    base: 'w',
    units: [
      defineUnit('w', q(1), 'W'),
      defineUnit('kw', q(1000), 'kW'),
      defineUnit('mw', q(10n ** 6n), 'MW'),
      defineUnit('hp', times(q(550), times(FOOT, POUND_FORCE))), // mechanical: 550 ft·lbf/s
      defineUnit('ps', times(q(75), GRAVITY), 'PS'), // metric: 75 kgf·m/s
    ],
  },
  data: {
    base: 'B',
    units: [
      defineUnit('bit', q(1, 8)),
      defineUnit('B', q(1)),
      defineUnit('KB', q(1000)),
      defineUnit('MB', q(10n ** 6n)),
      defineUnit('GB', q(10n ** 9n)),
      defineUnit('TB', q(10n ** 12n)),
      defineUnit('KiB', q(1024)),
      defineUnit('MiB', q(1048576)),
      defineUnit('GiB', q(1073741824)),
      defineUnit('TiB', q(1099511627776)),
    ],
  },
  datarate: {
    base: 'bps',
    units: [
      defineUnit('bps', q(1), 'bit/s'),
      defineUnit('kbps', q(1000), 'kbit/s'),
      defineUnit('mbps', q(10n ** 6n), 'Mbit/s'),
      defineUnit('gbps', q(10n ** 9n), 'Gbit/s'),
      defineUnit('Bps', q(8), 'B/s'),
      defineUnit('KBps', q(8000), 'KB/s'),
      defineUnit('MBps', q(8n * 10n ** 6n), 'MB/s'),
    ],
  },
  frequency: {
    base: 'hz',
    units: [
      defineUnit('hz', q(1), 'Hz'),
      defineUnit('khz', q(1000), 'kHz'),
      defineUnit('mhz', q(10n ** 6n), 'MHz'),
      defineUnit('ghz', q(10n ** 9n), 'GHz'),
    ],
  },
  angle: {
    base: 'rad',
    units: [
      defineUnit('rad', q(1)),
      defineUnit('deg', q(1, 180, 1), '°'),
      defineUnit('grad', q(1, 200, 1)),
      defineUnit('turn', q(2, 1, 1)),
    ],
  },
};

/**
 * Reverse index: unit id → `{ dimension, unit }`. Built once at module
 * load; ids are unique across dimensions.
 * @type {Map<string, { dimension: string, unit: Unit }>}
 */
export const UNIT_INDEX = new Map();
for (const [dimension, def] of Object.entries(DIMENSIONS)) {
  for (const unit of def.units) {
    UNIT_INDEX.set(unit.id, { dimension, unit });
  }
}
