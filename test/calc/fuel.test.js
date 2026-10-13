import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  convertFuel, convertValue, unitOptions, converterDimensions, FUEL, FUEL_UNITS,
} from '@jarenjs/calc';
import { convert } from '@jarenjs/core/convert';
import {
  createCalcComponent, contributeCalcViewModel,
} from '../../components/calc/src/component/index.js';

/** The double nearest `n / d` for integers, by 40-digit decimal long division. */
function nearest(n, d) {
  const scaled = (BigInt(n) * 10n ** 40n) / BigInt(d);
  const text = scaled.toString().padStart(41, '0');
  return Number(`${text.slice(0, -40)}.${text.slice(-40)}`);
}

/** Distance between two doubles in units of the larger one's last place. */
function ulps(a, b) {
  const big = Math.max(Math.abs(a), Math.abs(b));
  const ulp = 2 ** (Math.floor(Math.log2(big)) - 52);
  return Math.abs(a - b) / ulp;
}

const K_US = nearest(378541178400, 1609344000); // 100 L * US gallon / mile
const K_UK = nearest(454609000, 1609344); //        100 L * imperial gallon / mile

describe('#calc fuel economy: exact values', function () {
  it('the constants are frozen', () => {
    assert.ok(Object.isFrozen(FUEL_UNITS));
    for (const unit of FUEL_UNITS) assert.ok(Object.isFrozen(unit));
    assert.throws(() => { FUEL_UNITS[1].k = 1; }, TypeError);
    assert.equal(convertFuel(1, 'mpgus', 'l100km'), K_US);
    assert.deepEqual(FUEL_UNITS.map((unit) => unit.k), [null, K_US, K_UK, 100]);
  });

  it('the constants are the correctly rounded doubles of the defined ratios', () => {
    assert.equal(convertFuel(1, 'mpgus', 'l100km'), K_US);
    assert.equal(convertFuel(1, 'mpguk', 'l100km'), K_UK);
    assert.equal(convertFuel(1, 'kml', 'l100km'), 100);
    assert.equal(K_US.toFixed(9), '235.214583333');
    assert.equal(K_UK.toFixed(9), '282.480936332');
  });

  it('agrees with the gallon and the mile core already holds', () => {
    assert.ok(ulps(K_US, 100 * convert(1, 'gal', 'l') / convert(1, 'mi', 'km')) <= 2);
    assert.ok(ulps(K_UK, 100 * 4.54609 / convert(1, 'mi', 'km')) <= 2);
  });

  it('L/100km and km/L are exact reciprocals where the double holds them', () => {
    assert.equal(convertFuel(10, 'kml', 'l100km'), 10);
    assert.equal(convertFuel(5, 'l100km', 'kml'), 20);
    assert.equal(convertFuel(8, 'l100km', 'kml'), 12.5);
    assert.equal(convertFuel(25, 'kml', 'l100km'), 4);
    assert.equal(convertFuel(12.5, 'kml', 'l100km'), 8);
  });

  it('mpg against L/100km, the published pairs', () => {
    assert.equal(convertFuel(8, 'l100km', 'mpgus'), K_US / 8);
    assert.equal(convertFuel(8, 'l100km', 'mpgus').toFixed(6), '29.401823');
    assert.equal(convertFuel(8, 'l100km', 'mpguk').toFixed(6), '35.310117');
    assert.equal(convertFuel(30, 'mpgus', 'l100km').toFixed(6), '7.840486');
    assert.equal(convertFuel(30, 'mpguk', 'l100km').toFixed(6), '9.416031');
    assert.equal(convertFuel(100, 'l100km', 'kml'), 1);
  });

  it('between distance-per-fuel units there is no double reciprocal', () => {
    assert.equal(convertFuel(1, 'mpgus', 'mpguk'), K_UK / K_US);
    assert.ok(ulps(convertFuel(1, 'mpgus', 'mpguk'), nearest(454609000000, 378541178400)) <= 1);
    assert.equal(convertFuel(1, 'kml', 'mpgus'), K_US / 100);
    for (const v of [3, 11, 13, 30]) assert.equal(convertFuel(v, 'mpgus', 'mpguk'), v * (K_UK / K_US));
    assert.equal(convertFuel(1, 'mpguk', 'mpgus').toFixed(9), '0.832674185');
    assert.equal(convertFuel(30, 'mpgus', 'kml').toFixed(6), '12.754311');
  });

  it('a round trip lands within two last places', () => {
    for (const unit of ['mpgus', 'mpguk', 'kml']) {
      for (const v of [0.1, 3, 7.5, 33, 1234.5]) {
        assert.ok(ulps(convertFuel(convertFuel(v, 'l100km', unit), unit, 'l100km'), v) <= 2, `${v} ${unit}`);
        assert.ok(ulps(convertFuel(convertFuel(v, unit, 'mpgus'), 'mpgus', unit), v) <= 2, `${v} ${unit}`);
      }
    }
  });

  it('a unit converted to itself returns the value unchanged', () => {
    for (const unit of FUEL_UNITS) assert.equal(convertFuel(0.1 + 0.2, unit.id, unit.id), 0.1 + 0.2);
    assert.ok(Object.is(convertFuel(-0, 'mpgus', 'mpgus'), 0));
  });
});

describe('#calc fuel economy: zero and refusals', function () {
  it('zero stays zero between units of one kind', () => {
    assert.ok(Object.is(convertFuel(0, 'mpgus', 'mpguk'), 0));
    assert.ok(Object.is(convertFuel(0, 'kml', 'mpgus'), 0));
    assert.ok(Object.is(convertFuel(-0, 'kml', 'mpgus'), 0));
    assert.ok(Object.is(convertFuel(0, 'l100km', 'l100km'), 0));
  });

  it('zero across the reciprocal is refused, both ways', () => {
    assert.throws(() => convertFuel(0, 'l100km', 'mpgus'),
      { name: 'RangeError', message: 'convertFuel: 0 L/100km has no finite mpg (US)' });
    assert.throws(() => convertFuel(0, 'mpguk', 'l100km'),
      { name: 'RangeError', message: 'convertFuel: 0 mpg (UK) has no finite L/100km' });
    assert.throws(() => convertFuel(0, 'l100km', 'kml'), RangeError);
    assert.throws(() => convertFuel(-0, 'kml', 'l100km'), RangeError);
  });

  it('a negative or non-finite economy is refused', () => {
    for (const bad of [-1, -1e-300, NaN, Infinity, -Infinity, '8', null, undefined]) {
      assert.throws(() => convertFuel(bad, 'l100km', 'mpgus'), RangeError, String(bad));
      assert.throws(() => convertFuel(bad, 'mpgus', 'mpgus'), RangeError, String(bad));
    }
  });

  it('an unknown unit is refused', () => {
    assert.throws(() => convertFuel(1, 'mpg', 'l100km'), { message: "convertFuel: unknown unit 'mpg'" });
    assert.throws(() => convertFuel(1, 'l100km', 'km'), { message: "convertFuel: unknown unit 'km'" });
  });

  it('a result beyond the double range is refused, not answered Infinity', () => {
    assert.throws(() => convertFuel(1e-320, 'l100km', 'kml'), RangeError);
    assert.throws(() => convertFuel(5e-324, 'mpgus', 'l100km'), RangeError);
    assert.throws(() => convertFuel(5e-324, 'mpgus', 'kml'), RangeError);
    assert.equal(convertFuel(0.5, 'l100km', 'kml'), 200);
  });

  it('a large economy between two units does not overflow in the middle', () => {
    const big = convertFuel(1e308, 'mpguk', 'mpgus');
    assert.ok(Number.isFinite(big));
    assert.ok(ulps(big, 1e308 * (K_US / K_UK)) <= 2);
  });
});

describe('#calc fuel economy: the converter dimension', function () {
  it('is listed before currency and offers the four units', () => {
    assert.equal(FUEL, 'fuel');
    const dims = converterDimensions();
    assert.equal(dims.indexOf('fuel'), dims.length - 2);
    assert.equal(dims.at(-1), 'currency');
    assert.deepEqual(unitOptions('fuel'), [
      { id: 'l100km', symbol: 'L/100km' },
      { id: 'mpgus', symbol: 'mpg (US)' },
      { id: 'mpguk', symbol: 'mpg (UK)' },
      { id: 'kml', symbol: 'km/L' },
    ]);
  });

  it('convertValue answers exactly and refuses as NaN, never throwing', () => {
    assert.equal(convertValue('fuel', 8, 'l100km', 'kml'), 12.5);
    assert.equal(convertValue('fuel', 8, 'l100km', 'mpgus'), K_US / 8);
    assert.ok(Number.isNaN(convertValue('fuel', 0, 'l100km', 'mpgus')));
    assert.ok(Number.isNaN(convertValue('fuel', -3, 'kml', 'l100km')));
    assert.ok(Number.isNaN(convertValue('fuel', 1, 'kg', 'l100km')));
    assert.ok(Number.isNaN(convertValue('length', 1, 'mpgus', 'm')));
    assert.equal(convertValue('fuel', 0, 'mpgus', 'kml'), 0);
  });
});

describe('#calc fuel economy: the component', function () {
  const makeApp = () => createCalcComponent({ fetch: async () => ({ ok: false, status: 503 }) })
    .createApp({ schedule: (f) => f() });

  it('selecting the dimension picks the first two units and shows the result', () => {
    const app = makeApp();
    app.dispatch('calc/mode', { mode: 'converter' });
    app.dispatch('calc/conv-dim', null, { target: { value: 'fuel' } });
    assert.deepEqual(app.getState().calc.conv, { dimension: 'fuel', from: 'l100km', to: 'mpgus', value: 100 });
    const vm = contributeCalcViewModel(app.getState()).converter;
    assert.equal(vm.result, '2.3521458');
    assert.equal(vm.isCurrency, false);
    assert.deepEqual(vm.unitsFrom.map((unit) => unit.symbol), ['L/100km', 'mpg (US)', 'mpg (UK)', 'km/L']);
    app.dispatch('calc/conv-from', null, { target: { value: 'mpgus' } });
    app.dispatch('calc/conv-to', null, { target: { value: 'l100km' } });
    app.dispatch('calc/conv-value', null, { target: { value: '30' } });
    assert.equal(contributeCalcViewModel(app.getState()).converter.result, '7.8404861');
    app.destroy();
  });

  it('zero L/100km into mpg shows the dash, not a number', () => {
    const app = makeApp();
    app.dispatch('calc/mode', { mode: 'converter' });
    app.dispatch('calc/conv-dim', null, { target: { value: 'fuel' } });
    app.dispatch('calc/conv-value', null, { target: { value: '0' } });
    assert.equal(contributeCalcViewModel(app.getState()).converter.result, '—');
    app.dispatch('calc/conv-to', null, { target: { value: 'l100km' } });
    assert.equal(contributeCalcViewModel(app.getState()).converter.result, '0');
    app.destroy();
  });

  it('leaving fuel for another dimension keeps only units that exist there', () => {
    const app = makeApp();
    app.dispatch('calc/mode', { mode: 'converter' });
    app.dispatch('calc/conv-dim', null, { target: { value: 'fuel' } });
    app.dispatch('calc/conv-dim', null, { target: { value: 'length' } });
    assert.deepEqual(app.getState().calc.conv, { dimension: 'length', from: 'nm', to: 'um', value: 100 });
    app.destroy();
  });
});
