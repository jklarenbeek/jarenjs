//@ts-check
/**
 * @file Every converter dimension against definitions written here, not
 * read from the code under test: the SI prefixes, the international yard
 * and pound (1959), the US customary gallon, the thermochemical calorie,
 * the IT British thermal unit, the mechanical horsepower, the Julian year,
 * the SI and IEC data prefixes, and fuel economy's reciprocal relation.
 * Each unit converts to its dimension's base and back, and known pairs
 * hold.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { convertValue, unitOptions, converterDimensions } from '@jarenjs/calc';

const INCH = 0.0254;
const FOOT = 12 * INCH;
const YARD = 3 * FOOT;
const MILE = 1760 * YARD;
const POUND = 0.45359237;
const US_GALLON = 231 * INCH ** 3; // m³: 3.785411784 L
const LBF = POUND * 9.80665; // N
const HOUR = 3600;

/** The size of each unit in its dimension's base unit. */
const BASE = {
  length: { base: 'm', nm: 1e-9, um: 1e-6, mm: 1e-3, cm: 1e-2, m: 1, km: 1e3, in: INCH, ft: FOOT, yd: YARD, mi: MILE, nmi: 1852 },
  area: { base: 'm2', mm2: 1e-6, cm2: 1e-4, m2: 1, ha: 1e4, km2: 1e6, in2: INCH ** 2, ft2: FOOT ** 2, acre: 43560 * FOOT ** 2, mi2: MILE ** 2 },
  volume: {
    base: 'l', ml: 1e-3, l: 1, m3: 1e3, gal: US_GALLON * 1e3, qt: US_GALLON * 1e3 / 4, pt: US_GALLON * 1e3 / 8,
    cup: US_GALLON * 1e3 / 16, floz: US_GALLON * 1e3 / 128, tbsp: US_GALLON * 1e3 / 256, tsp: US_GALLON * 1e3 / 768,
  },
  mass: { base: 'kg', mg: 1e-6, g: 1e-3, kg: 1, t: 1e3, lb: POUND, oz: POUND / 16, st: 14 * POUND },
  time: { base: 's', ns: 1e-9, us: 1e-6, ms: 1e-3, s: 1, min: 60, h: HOUR, day: 24 * HOUR, week: 7 * 24 * HOUR, year: 365.25 * 24 * HOUR },
  speed: { base: 'mps', mps: 1, kmh: 1000 / HOUR, mph: MILE / HOUR, fps: FOOT, knot: 1852 / HOUR },
  pressure: { base: 'pa', pa: 1, kpa: 1e3, bar: 1e5, atm: 101325, psi: LBF / INCH ** 2, mmhg: 133.322387415, torr: 101325 / 760 },
  energy: { base: 'j', j: 1, kj: 1e3, cal: 4.184, kcal: 4184, wh: HOUR, kwh: 3.6e6, btu: 1055.05585262, ev: 1.602176634e-19 },
  power: { base: 'w', w: 1, kw: 1e3, mw: 1e6, hp: 550 * FOOT * LBF, ps: 75 * 9.80665 },
  data: { base: 'bit', bit: 1, B: 8, KB: 8e3, MB: 8e6, GB: 8e9, TB: 8e12, KiB: 8 * 2 ** 10, MiB: 8 * 2 ** 20, GiB: 8 * 2 ** 30, TiB: 8 * 2 ** 40 },
  datarate: { base: 'bps', bps: 1, kbps: 1e3, mbps: 1e6, gbps: 1e9, Bps: 8, KBps: 8e3, MBps: 8e6 },
  frequency: { base: 'hz', hz: 1, khz: 1e3, mhz: 1e6, ghz: 1e9 },
  angle: { base: 'rad', rad: 1, deg: Math.PI / 180, grad: Math.PI / 200, turn: 2 * Math.PI },
};

/**
 * Every factor is exact, so a conversion agrees with the definition to the
 * rounding of the reference arithmetic here (a few units in the last place).
 */
const TOLERANCE = 1e-14;

/** Relative closeness. */
function near(/** @type {number} */ got, /** @type {number} */ want, /** @type {number} */ tolerance, /** @type {string} */ what) {
  const scale = Math.max(Math.abs(want), Number.MIN_VALUE);
  assert.ok(Math.abs(got - want) / scale <= tolerance, `${what}: ${got} vs ${want}`);
}

describe('#calc converter against reference definitions', () => {
  it('offers exactly the sixteen dimensions', () => {
    assert.deepEqual(converterDimensions().sort(), [...Object.keys(BASE), 'temperature', 'fuel', 'currency'].sort());
  });

  for (const [dimension, table] of Object.entries(BASE)) {
    it(`${dimension}: every unit to the base, back, and to every other unit`, () => {
      const ids = unitOptions(dimension).map((u) => u.id);
      const { base, ...units } = table;
      assert.deepEqual(ids.sort(), Object.keys(units).sort(), `${dimension} units`);
      for (const [from, size] of Object.entries(units)) {
        const tolerance = TOLERANCE;
        near(convertValue(dimension, 3, from, base), 3 * size / /** @type {any} */ (units)[base], tolerance, `3 ${from} → ${base}`);
        near(convertValue(dimension, convertValue(dimension, 7.25, from, base), base, from), 7.25, 1e-12, `${from} round trip`);
        for (const [to, other] of Object.entries(units)) {
          const pair = TOLERANCE;
          near(convertValue(dimension, 2, from, to), 2 * size / other, pair, `2 ${from} → ${to}`);
        }
      }
    });
  }

  it('shows ten digits of an exact factor: 1 gal is 128 fl oz, 1 fl oz is 6 tsp', async () => {
    const { converterMode } = await import('@jarenjs/calc/component').then(() => import('../../components/calc/src/modes/converter.js'));
    assert.equal(converterMode.format(convertValue('volume', 1, 'gal', 'floz')), '128');
    assert.equal(converterMode.format(convertValue('volume', 1, 'floz', 'tsp')), '6');
    assert.equal(converterMode.format(convertValue('volume', 1, 'tbsp', 'ml')), '14.78676478');
    assert.equal(converterMode.format(convertValue('power', 1, 'hp', 'w')), '745.6998716');
    assert.equal(converterMode.format(convertValue('speed', 1, 'knot', 'kmh')), '1.852');
  });

  it('known pairs', () => {
    for (const [dimension, value, from, to, want] of /** @type {Array<[string, number, string, string, number]>} */ ([
      ['length', 1, 'in', 'cm', 2.54], ['length', 1, 'mi', 'km', 1.609344], ['length', 1, 'nmi', 'm', 1852],
      ['mass', 1, 'lb', 'kg', 0.45359237], ['mass', 1, 'st', 'lb', 14],
      ['volume', 1, 'gal', 'l', 3.785411784], ['volume', 1, 'gal', 'floz', 128],
      ['energy', 1, 'kwh', 'j', 3.6e6], ['energy', 1, 'kcal', 'cal', 1000],
      ['pressure', 1, 'bar', 'pa', 1e5], ['pressure', 1, 'atm', 'torr', 760], ['pressure', 1, 'psi', 'pa', 6894.757293168361],
      ['data', 1, 'KiB', 'B', 1024], ['data', 1, 'KB', 'B', 1000], ['data', 1, 'GiB', 'MiB', 1024], ['data', 1, 'B', 'bit', 8],
      ['datarate', 1, 'MBps', 'mbps', 8],
      ['speed', 100, 'kmh', 'mps', 100 / 3.6], ['speed', 60, 'mph', 'kmh', 96.56064],
      ['angle', 180, 'deg', 'rad', Math.PI], ['angle', 1, 'turn', 'grad', 400],
      ['time', 1, 'week', 'h', 168], ['time', 1, 'year', 'day', 365.25], ['time', 1, 'h', 'ms', 3.6e6],
      ['power', 1, 'kw', 'w', 1000], ['frequency', 2.4, 'ghz', 'mhz', 2400], ['area', 1, 'ha', 'm2', 1e4],
    ])) {
      const tolerance = TOLERANCE;
      near(convertValue(dimension, value, from, to), want, tolerance, `${value} ${from} → ${to}`);
    }
  });

  it('temperature: the offsets of Celsius, Fahrenheit and Rankine', () => {
    /** Kelvin from each scale. */
    const toK = { K: (/** @type {number} */ v) => v, C: (/** @type {number} */ v) => v + 273.15, F: (/** @type {number} */ v) => (v - 32) * 5 / 9 + 273.15, R: (/** @type {number} */ v) => v * 5 / 9 };
    const fromK = { K: (/** @type {number} */ k) => k, C: (/** @type {number} */ k) => k - 273.15, F: (/** @type {number} */ k) => (k - 273.15) * 9 / 5 + 32, R: (/** @type {number} */ k) => k * 9 / 5 };
    assert.deepEqual(unitOptions('temperature').map((u) => u.id).sort(), Object.keys(toK).sort());
    for (const from of /** @type {Array<keyof typeof toK>} */ (Object.keys(toK))) {
      for (const to of /** @type {Array<keyof typeof toK>} */ (Object.keys(toK))) {
        for (const v of [-40, 0, 37, 100, 451]) {
          const want = fromK[to](toK[from](v));
          assert.ok(Math.abs(convertValue('temperature', v, from, to) - want) <= 1e-9 * Math.max(1, Math.abs(want)), `${v} ${from} → ${to}`);
        }
      }
    }
    assert.ok(Math.abs(convertValue('temperature', 100, 'C', 'F') - 212) < 1e-12);
    assert.ok(Math.abs(convertValue('temperature', -40, 'F', 'C') + 40) < 1e-12);
    assert.ok(Math.abs(convertValue('temperature', 0, 'K', 'C') + 273.15) < 1e-12);
  });

  it('fuel economy is reciprocal: L/100km against US and imperial mpg and km/L', () => {
    const UK_GALLON = 4.54609; // L
    const US = 100 * US_GALLON * 1e3 / (MILE / 1000); // L/100km × mpg(US)
    const UK = 100 * UK_GALLON / (MILE / 1000);
    for (const l100 of [3, 5.5, 8, 12.4]) {
      near(convertValue('fuel', l100, 'l100km', 'mpgus'), US / l100, 1e-12, `${l100} L/100km → mpg US`);
      near(convertValue('fuel', l100, 'l100km', 'mpguk'), UK / l100, 1e-12, `${l100} L/100km → mpg UK`);
      near(convertValue('fuel', l100, 'l100km', 'kml'), 100 / l100, 1e-12, `${l100} L/100km → km/L`);
      near(convertValue('fuel', convertValue('fuel', l100, 'l100km', 'mpgus'), 'mpgus', 'l100km'), l100, 1e-12, 'round trip');
    }
    near(convertValue('fuel', 30, 'mpgus', 'mpguk'), 30 * UK / US, 1e-12, 'mpg US → mpg UK');
    // twice the economy is half the consumption
    near(convertValue('fuel', 40, 'mpgus', 'l100km') * 2, convertValue('fuel', 20, 'mpgus', 'l100km'), 1e-12, 'reciprocal');
    assert.ok(Number.isNaN(convertValue('fuel', 0, 'l100km', 'mpgus')));
  });

  it('currency through a fixed rate table: value of one unit in the base', () => {
    const rates = { base: 'USD', rates: { USD: 1, EUR: 1.25, JPY: 0.008, BTC: 50000 } };
    near(convertValue('currency', 100, 'EUR', 'USD', rates), 125, 1e-12, 'EUR → USD');
    near(convertValue('currency', 100, 'USD', 'EUR', rates), 80, 1e-12, 'USD → EUR');
    near(convertValue('currency', 1000, 'JPY', 'EUR', rates), 6.4, 1e-12, 'JPY → EUR');
    near(convertValue('currency', 1, 'BTC', 'JPY', rates), 6.25e6, 1e-12, 'BTC → JPY');
    near(convertValue('currency', convertValue('currency', 42, 'EUR', 'BTC', rates), 'BTC', 'EUR', rates), 42, 1e-12, 'round trip');
    assert.ok(Number.isNaN(convertValue('currency', 1, 'EUR', 'XXX', rates)));
  });
});
