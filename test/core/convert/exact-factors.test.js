//@ts-check
/**
 * @file Every linear unit's factor is its exact definition, written here as
 * a rational: the nearest double of the definition, and between two units
 * the exact ratio of the two, rounded once (1 fl oz is 6 tsp, never
 * 6.00000001; 1 kn is 1.852 km/h).
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { convert, unitsOf, dimensions } from '@jarenjs/core/convert';

/** n/d in whole numbers, the definition of each unit in its dimension's base. */
const IN = [254n, 10000n];
const FT = [3048n, 10000n];
const MI = [1609344n, 1000n];
const LB = [45359237n, 100000000n];
const LBF = [45359237n * 980665n, 100000000n * 100000n]; // lb × standard gravity
const GAL = [3785411784n, 1000000000n]; // 231 in³ in litres
/** @param {bigint[]} a @param {bigint[]} b */
const mul = (a, b) => [a[0] * b[0], a[1] * b[1]];
/** @param {bigint[]} a @param {bigint[]} b */
const div = (a, b) => [a[0] * b[1], a[1] * b[0]];
/** @param {bigint} n @param {bigint} [d] */
const r = (n, d = 1n) => [n, d];

const DEFINITIONS = {
  length: { nm: r(1n, 10n ** 9n), um: r(1n, 10n ** 6n), mm: r(1n, 1000n), cm: r(1n, 100n), m: r(1n), km: r(1000n), in: IN, ft: FT, yd: r(9144n, 10000n), mi: MI, nmi: r(1852n) },
  area: { mm2: r(1n, 10n ** 6n), cm2: r(1n, 10n ** 4n), m2: r(1n), ha: r(10000n), km2: r(10n ** 6n), in2: mul(IN, IN), ft2: mul(FT, FT), acre: mul(r(43560n), mul(FT, FT)), mi2: mul(MI, MI) },
  volume: { ml: r(1n, 1000n), l: r(1n), m3: r(1000n), tsp: div(GAL, r(768n)), tbsp: div(GAL, r(256n)), floz: div(GAL, r(128n)), cup: div(GAL, r(16n)), pt: div(GAL, r(8n)), qt: div(GAL, r(4n)), gal: GAL },
  mass: { mg: r(1n, 10n ** 6n), g: r(1n, 1000n), kg: r(1n), t: r(1000n), oz: div(LB, r(16n)), lb: LB, st: mul(LB, r(14n)) },
  time: { ns: r(1n, 10n ** 9n), us: r(1n, 10n ** 6n), ms: r(1n, 1000n), s: r(1n), min: r(60n), h: r(3600n), day: r(86400n), week: r(604800n), year: r(31557600n) },
  speed: { mps: r(1n), kmh: r(1000n, 3600n), mph: div(MI, r(3600n)), fps: FT, knot: r(1852n, 3600n) },
  pressure: { pa: r(1n), kpa: r(1000n), bar: r(100000n), atm: r(101325n), psi: div(LBF, mul(IN, IN)), mmhg: r(133322387415n, 10n ** 9n), torr: r(101325n, 760n) },
  // the thermochemical calorie (4.184 J) and the International Table BTU
  energy: { j: r(1n), kj: r(1000n), cal: r(4184n, 1000n), kcal: r(4184n), wh: r(3600n), kwh: r(3600000n), btu: r(105505585262n, 10n ** 8n), ev: r(1602176634n, 10n ** 28n) },
  // mechanical horsepower (550 ft·lbf/s) and the metric PS (75 kgf·m/s)
  power: { w: r(1n), kw: r(1000n), mw: r(10n ** 6n), hp: mul(r(550n), mul(FT, LBF)), ps: mul(r(75n), r(980665n, 100000n)) },
  data: { bit: r(1n, 8n), B: r(1n), KB: r(1000n), MB: r(10n ** 6n), GB: r(10n ** 9n), TB: r(10n ** 12n), KiB: r(1024n), MiB: r(1n << 20n), GiB: r(1n << 30n), TiB: r(1n << 40n) },
  datarate: { bps: r(1n), kbps: r(1000n), mbps: r(10n ** 6n), gbps: r(10n ** 9n), Bps: r(8n), KBps: r(8000n), MBps: r(8000000n) },
  frequency: { hz: r(1n), khz: r(1000n), mhz: r(10n ** 6n), ghz: r(10n ** 9n) },
};

/** The correctly rounded double of n/d, by long division to 40 digits. */
function nearest(/** @type {bigint[]} */ [n, d]) {
  const g = (/** @type {bigint} */ a, /** @type {bigint} */ b) => { while (b) [a, b] = [b, a % b]; return a; };
  const k = g(n, d);
  const [a, b] = [n / k, d / k];
  if (a <= 2n ** 53n && b <= 2n ** 53n) return Number(a) / Number(b); // one correctly rounded IEEE division
  const digits = 40 + String(b).length - String(a).length;
  return Number(`${(a * 10n ** BigInt(Math.max(0, digits))) / b}e-${Math.max(0, digits)}`);
}

describe('#convert exact factors', () => {
  it('covers every linear dimension and every unit in it', () => {
    assert.deepEqual(dimensions().filter((d) => d !== 'temperature' && d !== 'angle').sort(), Object.keys(DEFINITIONS).sort());
    for (const [dimension, units] of Object.entries(DEFINITIONS)) {
      assert.deepEqual(unitsOf(dimension).map((u) => u.id).sort(), Object.keys(units).sort(), dimension);
    }
  });

  for (const [dimension, units] of Object.entries(DEFINITIONS)) {
    it(`${dimension}: each factor is the nearest double of its definition, each pair its exact ratio`, () => {
      for (const unit of unitsOf(dimension)) {
        const definition = /** @type {any} */ (units)[unit.id];
        assert.equal(unit.factor, nearest(definition), `${unit.id} factor`);
      }
      for (const [from, a] of Object.entries(units)) {
        for (const [to, b] of Object.entries(units)) {
          const want = nearest(div(a, b));
          const got = convert(1, from, to);
          assert.ok(Math.abs(got - want) <= Math.abs(want) * Number.EPSILON, `1 ${from} → ${to}: ${got} vs ${want}`);
        }
      }
    });
  }

  it('the pairs a reader checks are exact', () => {
    for (const [value, from, to, want] of /** @type {Array<[number, string, string, number]>} */ ([
      [1, 'floz', 'tsp', 6], [1, 'tbsp', 'tsp', 3], [1, 'gal', 'floz', 128], [1, 'cup', 'floz', 8], [1, 'gal', 'l', 3.785411784],
      [1, 'knot', 'kmh', 1.852], [1, 'mi', 'ft', 5280], [1, 'ft', 'in', 12], [1, 'yd', 'ft', 3], [1, 'st', 'lb', 14], [1, 'lb', 'oz', 16],
      [1, 'acre', 'ft2', 43560], [1, 'mph', 'kmh', 1.609344], [1, 'kwh', 'kj', 3600], [1, 'atm', 'torr', 760],
      [90, 'deg', 'grad', 100], [1, 'turn', 'deg', 360], [3, 'floz', 'tbsp', 6],
    ])) assert.equal(convert(value, from, to), want, `${value} ${from} → ${to}`);
  });

  it('an angle in radians still converts through π', () => {
    assert.ok(Math.abs(convert(180, 'deg', 'rad') - Math.PI) <= Number.EPSILON * 4);
    assert.ok(Math.abs(convert(Math.PI, 'rad', 'turn') - 0.5) <= Number.EPSILON);
  });

  it('units stay plain JSON', () => {
    for (const dimension of dimensions()) assert.doesNotThrow(() => JSON.stringify(unitsOf(dimension)), dimension);
  });
});
