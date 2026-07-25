import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatNumber, parseNumber } from '@jarenjs/core/math';

describe('#number format/parse', function () {
  it('auto notation', () => {
    assert.equal(formatNumber(1234.5), '1234.5');
    assert.equal(formatNumber(0), '0');
    assert.equal(formatNumber(1e30), '1e+30');
    assert.equal(formatNumber(1e-9), '1e-9');
  });

  it('fixed notation + precision', () => {
    assert.equal(formatNumber(3.14159, { notation: 'fixed', precision: 2 }), '3.14');
    assert.equal(formatNumber(2, { notation: 'fixed', precision: 3 }), '2.000');
  });

  it('scientific notation', () => {
    assert.equal(formatNumber(12345, { notation: 'sci', precision: 2 }), '1.23e+4');
  });

  it('engineering notation uses exponents that are multiples of 3', () => {
    assert.equal(formatNumber(12345, { notation: 'eng', precision: 2 }), '12.35e+3');
    assert.equal(formatNumber(0.0000123, { notation: 'eng', precision: 2 }), '12.30e-6');
    assert.equal(formatNumber(0, { notation: 'eng' }), '0e+0');
  });

  it('grouping', () => {
    assert.equal(formatNumber(1234567, { group: true }), '1,234,567');
    assert.equal(formatNumber(-1234567.89, { group: true }), '-1,234,567.89');
    assert.equal(formatNumber(1234, { group: ' ' }), '1 234');
  });

  it('radix output', () => {
    assert.equal(formatNumber(255, { radix: 16 }), 'FF');
    assert.equal(formatNumber(10, { radix: 2 }), '1010');
  });

  it('NaN / Infinity', () => {
    assert.equal(formatNumber(NaN), 'NaN');
    assert.equal(formatNumber(Infinity), '∞');
    assert.equal(formatNumber(-Infinity), '-∞');
  });

  it('parseNumber radix-aware + round-trip', () => {
    assert.equal(parseNumber('0xff'), 255);
    assert.equal(parseNumber('0b1010'), 10);
    assert.equal(parseNumber('0o17'), 15);
    assert.equal(parseNumber('FF', { radix: 16 }), 255);
    assert.equal(parseNumber('1,234,567'), 1234567);
    assert.equal(parseNumber('1.5e3'), 1500);
    assert.ok(Number.isNaN(parseNumber('nonsense')));
    assert.equal(parseNumber('∞'), Infinity);
  });
});
