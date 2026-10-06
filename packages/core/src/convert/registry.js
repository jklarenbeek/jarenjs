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
 * and decimal (KB/MB, 1000) prefixes.
 *
 * Number-base conversion (HEX/DEC/OCT/BIN) is intentionally NOT here — it
 * is `@jarenjs/core/math/word.js` (`toBase`/`fromBase`), which the
 * converter delegates to. Fuel-economy (mpg ↔ L/100km) is non-affine and
 * likewise out of this data-driven model.
 */

const F = 5 / 9; // °F/°R scale relative to Kelvin

/**
 * @typedef {object} Unit
 * @property {string} id unique unit id
 * @property {string} symbol display symbol
 * @property {number} factor multiply to reach the base unit
 * @property {number} [offset] affine offset toward the base unit
 */

/**
 * Construct a registry entry; the common display symbol is its id.
 * @param {string} id
 * @param {number} factor
 * @param {string} [symbol]
 * @param {number} [offset]
 * @returns {Unit}
 */
function defineUnit(id, factor, symbol = id, offset) {
  /** @type {Unit} */
  const result = { id, symbol, factor };
  if (offset !== undefined) result.offset = offset;
  return result;
}

/** @type {Record<string, { base: string, units: Unit[] }>} */
export const DIMENSIONS = {
  length: {
    base: 'm',
    units: [
      defineUnit('nm', 1e-9),
      defineUnit('um', 1e-6, 'µm'),
      defineUnit('mm', 0.001),
      defineUnit('cm', 0.01),
      defineUnit('m', 1),
      defineUnit('km', 1000),
      defineUnit('in', 0.0254),
      defineUnit('ft', 0.3048),
      defineUnit('yd', 0.9144),
      defineUnit('mi', 1609.344),
      defineUnit('nmi', 1852),
    ],
  },
  area: {
    base: 'm2',
    units: [
      defineUnit('mm2', 1e-6, 'mm²'),
      defineUnit('cm2', 1e-4, 'cm²'),
      defineUnit('m2', 1, 'm²'),
      defineUnit('ha', 10000),
      defineUnit('km2', 1e6, 'km²'),
      defineUnit('in2', 0.00064516, 'in²'),
      defineUnit('ft2', 0.09290304, 'ft²'),
      defineUnit('acre', 4046.8564224),
      defineUnit('mi2', 2589988.110336, 'mi²'),
    ],
  },
  volume: {
    base: 'l',
    units: [
      defineUnit('ml', 0.001, 'mL'),
      defineUnit('l', 1, 'L'),
      defineUnit('m3', 1000, 'm³'),
      defineUnit('tsp', 0.00492892159),
      defineUnit('tbsp', 0.0147867648),
      defineUnit('floz', 0.0295735296, 'fl oz'),
      defineUnit('cup', 0.2365882365),
      defineUnit('pt', 0.473176473),
      defineUnit('qt', 0.946352946),
      defineUnit('gal', 3.785411784),
    ],
  },
  mass: {
    base: 'kg',
    units: [
      defineUnit('mg', 1e-6),
      defineUnit('g', 0.001),
      defineUnit('kg', 1),
      defineUnit('t', 1000),
      defineUnit('oz', 0.028349523125),
      defineUnit('lb', 0.45359237),
      defineUnit('st', 6.35029318),
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
      defineUnit('ns', 1e-9),
      defineUnit('us', 1e-6, 'µs'),
      defineUnit('ms', 0.001),
      defineUnit('s', 1),
      defineUnit('min', 60),
      defineUnit('h', 3600),
      defineUnit('day', 86400),
      defineUnit('week', 604800),
      defineUnit('year', 31557600),
    ],
  },
  speed: {
    base: 'mps',
    units: [
      defineUnit('mps', 1, 'm/s'),
      defineUnit('kmh', 1 / 3.6, 'km/h'),
      defineUnit('mph', 0.44704),
      defineUnit('fps', 0.3048, 'ft/s'),
      defineUnit('knot', 0.514444444, 'kn'),
    ],
  },
  pressure: {
    base: 'pa',
    units: [
      defineUnit('pa', 1, 'Pa'),
      defineUnit('kpa', 1000, 'kPa'),
      defineUnit('bar', 100000),
      defineUnit('atm', 101325),
      defineUnit('psi', 6894.757293168),
      defineUnit('mmhg', 133.322387415, 'mmHg'),
      defineUnit('torr', 101325 / 760, 'Torr'),
    ],
  },
  energy: {
    base: 'j',
    units: [
      defineUnit('j', 1, 'J'),
      defineUnit('kj', 1000, 'kJ'),
      defineUnit('cal', 4.184),
      defineUnit('kcal', 4184),
      defineUnit('wh', 3600, 'Wh'),
      defineUnit('kwh', 3600000, 'kWh'),
      defineUnit('btu', 1055.05585262, 'BTU'),
      defineUnit('ev', 1.602176634e-19, 'eV'),
    ],
  },
  power: {
    base: 'w',
    units: [
      defineUnit('w', 1, 'W'),
      defineUnit('kw', 1000, 'kW'),
      defineUnit('mw', 1e6, 'MW'),
      defineUnit('hp', 745.699871582),
      defineUnit('ps', 735.49875, 'PS'),
    ],
  },
  data: {
    base: 'B',
    units: [
      defineUnit('bit', 0.125),
      defineUnit('B', 1),
      defineUnit('KB', 1e3),
      defineUnit('MB', 1e6),
      defineUnit('GB', 1e9),
      defineUnit('TB', 1e12),
      defineUnit('KiB', 1024),
      defineUnit('MiB', 1048576),
      defineUnit('GiB', 1073741824),
      defineUnit('TiB', 1099511627776),
    ],
  },
  datarate: {
    base: 'bps',
    units: [
      defineUnit('bps', 1, 'bit/s'),
      defineUnit('kbps', 1e3, 'kbit/s'),
      defineUnit('mbps', 1e6, 'Mbit/s'),
      defineUnit('gbps', 1e9, 'Gbit/s'),
      defineUnit('Bps', 8, 'B/s'),
      defineUnit('KBps', 8e3, 'KB/s'),
      defineUnit('MBps', 8e6, 'MB/s'),
    ],
  },
  frequency: {
    base: 'hz',
    units: [
      defineUnit('hz', 1, 'Hz'),
      defineUnit('khz', 1e3, 'kHz'),
      defineUnit('mhz', 1e6, 'MHz'),
      defineUnit('ghz', 1e9, 'GHz'),
    ],
  },
  angle: {
    base: 'rad',
    units: [
      defineUnit('rad', 1),
      defineUnit('deg', Math.PI / 180, '°'),
      defineUnit('grad', Math.PI / 200),
      defineUnit('turn', 2 * Math.PI),
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
