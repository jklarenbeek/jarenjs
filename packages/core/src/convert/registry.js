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

/** @type {Record<string, { base: string, units: Unit[] }>} */
export const DIMENSIONS = {
  length: {
    base: 'm',
    units: [
      { id: 'nm', symbol: 'nm', factor: 1e-9 },
      { id: 'um', symbol: 'µm', factor: 1e-6 },
      { id: 'mm', symbol: 'mm', factor: 0.001 },
      { id: 'cm', symbol: 'cm', factor: 0.01 },
      { id: 'm', symbol: 'm', factor: 1 },
      { id: 'km', symbol: 'km', factor: 1000 },
      { id: 'in', symbol: 'in', factor: 0.0254 },
      { id: 'ft', symbol: 'ft', factor: 0.3048 },
      { id: 'yd', symbol: 'yd', factor: 0.9144 },
      { id: 'mi', symbol: 'mi', factor: 1609.344 },
      { id: 'nmi', symbol: 'nmi', factor: 1852 },
    ],
  },
  area: {
    base: 'm2',
    units: [
      { id: 'mm2', symbol: 'mm²', factor: 1e-6 },
      { id: 'cm2', symbol: 'cm²', factor: 1e-4 },
      { id: 'm2', symbol: 'm²', factor: 1 },
      { id: 'ha', symbol: 'ha', factor: 10000 },
      { id: 'km2', symbol: 'km²', factor: 1e6 },
      { id: 'in2', symbol: 'in²', factor: 0.00064516 },
      { id: 'ft2', symbol: 'ft²', factor: 0.09290304 },
      { id: 'acre', symbol: 'acre', factor: 4046.8564224 },
      { id: 'mi2', symbol: 'mi²', factor: 2589988.110336 },
    ],
  },
  volume: {
    base: 'l',
    units: [
      { id: 'ml', symbol: 'mL', factor: 0.001 },
      { id: 'l', symbol: 'L', factor: 1 },
      { id: 'm3', symbol: 'm³', factor: 1000 },
      { id: 'tsp', symbol: 'tsp', factor: 0.00492892159 },
      { id: 'tbsp', symbol: 'tbsp', factor: 0.0147867648 },
      { id: 'floz', symbol: 'fl oz', factor: 0.0295735296 },
      { id: 'cup', symbol: 'cup', factor: 0.2365882365 },
      { id: 'pt', symbol: 'pt', factor: 0.473176473 },
      { id: 'qt', symbol: 'qt', factor: 0.946352946 },
      { id: 'gal', symbol: 'gal', factor: 3.785411784 },
    ],
  },
  mass: {
    base: 'kg',
    units: [
      { id: 'mg', symbol: 'mg', factor: 1e-6 },
      { id: 'g', symbol: 'g', factor: 0.001 },
      { id: 'kg', symbol: 'kg', factor: 1 },
      { id: 't', symbol: 't', factor: 1000 },
      { id: 'oz', symbol: 'oz', factor: 0.028349523125 },
      { id: 'lb', symbol: 'lb', factor: 0.45359237 },
      { id: 'st', symbol: 'st', factor: 6.35029318 },
    ],
  },
  temperature: {
    base: 'K',
    units: [
      { id: 'K', symbol: 'K', factor: 1, offset: 0 },
      { id: 'C', symbol: '°C', factor: 1, offset: 273.15 },
      { id: 'F', symbol: '°F', factor: F, offset: 273.15 - 32 * F },
      { id: 'R', symbol: '°R', factor: F, offset: 0 },
    ],
  },
  time: {
    base: 's',
    units: [
      { id: 'ns', symbol: 'ns', factor: 1e-9 },
      { id: 'us', symbol: 'µs', factor: 1e-6 },
      { id: 'ms', symbol: 'ms', factor: 0.001 },
      { id: 's', symbol: 's', factor: 1 },
      { id: 'min', symbol: 'min', factor: 60 },
      { id: 'h', symbol: 'h', factor: 3600 },
      { id: 'day', symbol: 'day', factor: 86400 },
      { id: 'week', symbol: 'week', factor: 604800 },
      { id: 'year', symbol: 'year', factor: 31557600 },
    ],
  },
  speed: {
    base: 'mps',
    units: [
      { id: 'mps', symbol: 'm/s', factor: 1 },
      { id: 'kmh', symbol: 'km/h', factor: 1 / 3.6 },
      { id: 'mph', symbol: 'mph', factor: 0.44704 },
      { id: 'fps', symbol: 'ft/s', factor: 0.3048 },
      { id: 'knot', symbol: 'kn', factor: 0.514444444 },
    ],
  },
  pressure: {
    base: 'pa',
    units: [
      { id: 'pa', symbol: 'Pa', factor: 1 },
      { id: 'kpa', symbol: 'kPa', factor: 1000 },
      { id: 'bar', symbol: 'bar', factor: 100000 },
      { id: 'atm', symbol: 'atm', factor: 101325 },
      { id: 'psi', symbol: 'psi', factor: 6894.757293168 },
      { id: 'mmhg', symbol: 'mmHg', factor: 133.322387415 },
      { id: 'torr', symbol: 'Torr', factor: 101325 / 760 },
    ],
  },
  energy: {
    base: 'j',
    units: [
      { id: 'j', symbol: 'J', factor: 1 },
      { id: 'kj', symbol: 'kJ', factor: 1000 },
      { id: 'cal', symbol: 'cal', factor: 4.184 },
      { id: 'kcal', symbol: 'kcal', factor: 4184 },
      { id: 'wh', symbol: 'Wh', factor: 3600 },
      { id: 'kwh', symbol: 'kWh', factor: 3600000 },
      { id: 'btu', symbol: 'BTU', factor: 1055.05585262 },
      { id: 'ev', symbol: 'eV', factor: 1.602176634e-19 },
    ],
  },
  power: {
    base: 'w',
    units: [
      { id: 'w', symbol: 'W', factor: 1 },
      { id: 'kw', symbol: 'kW', factor: 1000 },
      { id: 'mw', symbol: 'MW', factor: 1e6 },
      { id: 'hp', symbol: 'hp', factor: 745.699871582 },
      { id: 'ps', symbol: 'PS', factor: 735.49875 },
    ],
  },
  data: {
    base: 'B',
    units: [
      { id: 'bit', symbol: 'bit', factor: 0.125 },
      { id: 'B', symbol: 'B', factor: 1 },
      { id: 'KB', symbol: 'KB', factor: 1e3 },
      { id: 'MB', symbol: 'MB', factor: 1e6 },
      { id: 'GB', symbol: 'GB', factor: 1e9 },
      { id: 'TB', symbol: 'TB', factor: 1e12 },
      { id: 'KiB', symbol: 'KiB', factor: 1024 },
      { id: 'MiB', symbol: 'MiB', factor: 1048576 },
      { id: 'GiB', symbol: 'GiB', factor: 1073741824 },
      { id: 'TiB', symbol: 'TiB', factor: 1099511627776 },
    ],
  },
  datarate: {
    base: 'bps',
    units: [
      { id: 'bps', symbol: 'bit/s', factor: 1 },
      { id: 'kbps', symbol: 'kbit/s', factor: 1e3 },
      { id: 'mbps', symbol: 'Mbit/s', factor: 1e6 },
      { id: 'gbps', symbol: 'Gbit/s', factor: 1e9 },
      { id: 'Bps', symbol: 'B/s', factor: 8 },
      { id: 'KBps', symbol: 'KB/s', factor: 8e3 },
      { id: 'MBps', symbol: 'MB/s', factor: 8e6 },
    ],
  },
  frequency: {
    base: 'hz',
    units: [
      { id: 'hz', symbol: 'Hz', factor: 1 },
      { id: 'khz', symbol: 'kHz', factor: 1e3 },
      { id: 'mhz', symbol: 'MHz', factor: 1e6 },
      { id: 'ghz', symbol: 'GHz', factor: 1e9 },
    ],
  },
  angle: {
    base: 'rad',
    units: [
      { id: 'rad', symbol: 'rad', factor: 1 },
      { id: 'deg', symbol: '°', factor: Math.PI / 180 },
      { id: 'grad', symbol: 'grad', factor: Math.PI / 200 },
      { id: 'turn', symbol: 'turn', factor: 2 * Math.PI },
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
