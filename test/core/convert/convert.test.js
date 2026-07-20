import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  convert, unitsOf, dimensions, dimensionOf,
  convertCurrency, currenciesOf,
} from '@jarenjs/core/convert';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~= ${b}`);

describe('#convert static dimensions (A-convert)', function () {
  it('length', () => {
    close(convert(1, 'km', 'm'), 1000);
    close(convert(1, 'mi', 'km'), 1.609344);
    close(convert(12, 'in', 'ft'), 1);
  });

  it('mass', () => {
    close(convert(1, 'kg', 'g'), 1000);
    close(convert(1, 'lb', 'kg'), 0.45359237);
  });

  it('temperature is affine (°C/°F/K/°R)', () => {
    close(convert(0, 'C', 'K'), 273.15);
    close(convert(100, 'C', 'F'), 212);
    close(convert(32, 'F', 'C'), 0);
    close(convert(-40, 'C', 'F'), -40);   // the famous crossover
    close(convert(0, 'C', 'R'), 491.67);
  });

  it('round-trips through the base', () => {
    for (const [a, b] of [['C', 'F'], ['km', 'mi'], ['l', 'gal'], ['bar', 'psi']]) {
      close(convert(convert(123.4, a, b), b, a), 123.4, 1e-6);
    }
  });

  it('digital storage: binary vs decimal prefixes', () => {
    close(convert(1, 'KiB', 'B'), 1024);
    close(convert(1, 'KB', 'B'), 1000);
    close(convert(1, 'MiB', 'KiB'), 1024);
    close(convert(8, 'bit', 'B'), 1);
  });

  it('rejects cross-dimension conversion', () => {
    assert.throws(() => convert(1, 'kg', 'm'), /cannot convert/);
    assert.throws(() => convert(1, 'nope', 'm'), /unknown unit/);
  });

  it('metadata helpers', () => {
    assert.ok(dimensions().includes('length'));
    assert.ok(unitsOf('length').some((u) => u.id === 'm'));
    assert.equal(dimensionOf('kg'), 'mass');
    assert.equal(dimensionOf('nope'), null);
  });
});

describe('#convertCurrency pure rate-table (A-convert)', function () {
  // rate[code] = value of 1 unit in USD base
  const table = { base: 'USD', rates: { USD: 1, EUR: 1.1, GBP: 1.25, BTC: 60000 }, at: 0 };

  it('converts through the base', () => {
    close(convertCurrency(100, 'USD', 'EUR', table), 100 / 1.1, 1e-9);
    close(convertCurrency(1, 'BTC', 'USD', table), 60000, 1e-9);
    close(convertCurrency(2, 'EUR', 'GBP', table), 2 * 1.1 / 1.25, 1e-9);
  });

  it('identity when from == to', () => {
    close(convertCurrency(50, 'EUR', 'EUR', table), 50);
  });

  it('accepts a bare code→rate map too', () => {
    close(convertCurrency(100, 'USD', 'EUR', { USD: 1, EUR: 1.1 }), 100 / 1.1, 1e-9);
  });

  it('throws on an unknown code (component decides the fallback)', () => {
    assert.throws(() => convertCurrency(1, 'USD', 'XYZ', table), /no rate/);
  });

  it('currenciesOf lists codes', () => {
    assert.deepEqual(currenciesOf(table).sort(), ['BTC', 'EUR', 'GBP', 'USD']);
  });
});
