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

describe('#number format/parse under a decimal format record', function () {
  // the members `compileNumberLocale(pack).decimalFormat` of @jarenjs/locales carries
  const NL = Object.freeze({ decimalSeparator: ',', groupingSeparator: '.', minusSign: '-', zeroDigit: '0',
    exponentSeparator: 'E', infinity: '∞', NaN: 'NaN' });
  const EN = Object.freeze({ decimalSeparator: '.', groupingSeparator: ',' });
  const FR = Object.freeze({ decimalSeparator: ',', groupingSeparator: '\u202f' });
  const ARAB = Object.freeze({ decimalSeparator: '٫', groupingSeparator: '٬', minusSign: '\u061c-', zeroDigit: '٠',
    exponentSeparator: 'اس', infinity: '∞', NaN: 'ليس رقم' });
  const nl = { decimalFormat: NL };

  it('reads the decimal comma and the grouping dot as the record names them', () => {
    assert.equal(parseNumber('3,45', nl), 3.45);
    assert.equal(parseNumber('1.234,5', nl), 1234.5);
    assert.equal(parseNumber('-1.234.567,89', nl), -1234567.89);
    assert.equal(parseNumber('1234,5', nl), 1234.5);
    assert.equal(parseNumber('1.234', nl), 1234);
    assert.equal(parseNumber('10.000', nl), 10000);
    assert.equal(parseNumber(' 3,45 ', nl), 3.45);
    assert.equal(parseNumber('+3,5', nl), 3.5);
    assert.equal(parseNumber('−3,5', nl), -3.5);
    assert.equal(parseNumber('1,5E3', nl), 1500);
    assert.equal(parseNumber('1,5e-3', nl), 0.0015);
    assert.equal(parseNumber('∞', nl), Infinity);
    assert.equal(parseNumber('-∞', nl), -Infinity);
    assert.equal(parseNumber('0xff', nl), 255);
  });

  it('answers NaN for text that is malformed under the record, never a guess', () => {
    for (const text of ['1,2,3', '1,5,6', '1.23', '12.34.567', '1.234.5', '3.45', '1.234,5,6', '1..234', '1.234.',
      ',5', '1,', '', '1,5E', '--1', '1.234,5.6', '1 234,5', '1234.567', '1.2345'])
      assert.ok(Number.isNaN(parseNumber(text, nl)), JSON.stringify(text));
  });

  it('reads English text under the English record, and refuses what the default reads as grouping', () => {
    const en = { decimalFormat: EN };
    assert.equal(parseNumber('1,234.5', en), 1234.5);
    assert.equal(parseNumber('1.234', en), 1.234);
    for (const text of ['3,45', '1,23', '1,2,3', '12,3456'])
      assert.ok(Number.isNaN(parseNumber(text, en)), JSON.stringify(text));
  });

  it('reads only the record\'s own grouping character', () => {
    assert.equal(parseNumber('1\u202f234,5', { decimalFormat: FR }), 1234.5);
    assert.ok(Number.isNaN(parseNumber('1 234,5', { decimalFormat: FR })));
    assert.ok(Number.isNaN(parseNumber('1\u00a0234,5', { decimalFormat: FR })));
  });

  it('reads and writes a digit family, a minus sign and an exponent separator of the record', () => {
    const arab = { decimalFormat: ARAB };
    assert.equal(parseNumber('١٬٢٣٤٫٥', arab), 1234.5);
    assert.equal(parseNumber('\u061c-٢٫٥', arab), -2.5);
    assert.equal(parseNumber('١٫٥اس٣', arab), 1500);
    assert.equal(formatNumber(1234.5, { decimalFormat: ARAB, group: true }), '١٬٢٣٤٫٥');
    assert.equal(formatNumber(-2, arab), '\u061c-٢');
    assert.equal(formatNumber(1.5e-7, arab), '١٫٥اس\u061c-٧');
    assert.equal(formatNumber(NaN, arab), 'ليس رقم');
    assert.equal(formatNumber(-Infinity, arab), '\u061c-∞');
    assert.equal(parseNumber('\u061c-∞', arab), -Infinity);
    assert.equal(parseNumber('\u2212∞', arab), -Infinity);
    assert.equal(parseNumber('+∞', arab), Infinity);
  });

  it('writes the record\'s separators', () => {
    assert.equal(formatNumber(1234.5, nl), '1234,5');
    assert.equal(formatNumber(1234.5, { decimalFormat: NL, group: true }), '1.234,5');
    assert.equal(formatNumber(-1234567.89, { decimalFormat: NL, group: true }), '-1.234.567,89');
    assert.equal(formatNumber(3, { decimalFormat: NL, notation: 'fixed', precision: 2 }), '3,00');
    assert.equal(formatNumber(1e21, nl), '1E+21');
    assert.equal(formatNumber(1.5e-7, nl), '1,5E-7');
    assert.equal(formatNumber(1234.5, { decimalFormat: NL, group: ' ' }), '1 234,5');
    assert.equal(formatNumber(1234.5, { decimalFormat: FR, group: true }), '1\u202f234,5');
  });

  it('refuses a record it cannot read one way', () => {
    for (const decimalFormat of [null, ',', {}, { decimalSeparator: ',', groupingSeparator: ',' },
      { decimalSeparator: '', groupingSeparator: '.' }, { decimalSeparator: ',', groupingSeparator: '.', zeroDigit: 'o' },
      { decimalSeparator: ',', groupingSeparator: '.', minusSign: '' },
      { decimalSeparator: ',', groupingSeparator: '.', zeroDigit: '\u{1D7CF}' },
      { decimalSeparator: '1', groupingSeparator: '.' }]) {
      assert.throws(() => parseNumber('1', { decimalFormat }), TypeError);
      assert.throws(() => formatNumber(1, { decimalFormat }), TypeError);
    }
  });

  it('reads a record that is not frozen as it stands at each call', () => {
    const record = { decimalSeparator: ',', groupingSeparator: '.' };
    assert.equal(parseNumber('1.234,5', { decimalFormat: record }), 1234.5);
    record.decimalSeparator = '.';
    record.groupingSeparator = ',';
    assert.equal(parseNumber('1,234.5', { decimalFormat: record }), 1234.5);
    assert.ok(Number.isNaN(parseNumber('1.234,5', { decimalFormat: record })));
  });

  it('keeps the default reading, where every comma is grouping', () => {
    assert.equal(parseNumber('3,45'), 345);
    assert.equal(parseNumber('1,23'), 123);
    assert.equal(parseNumber('1.234,5'), 1.2345);
    assert.equal(parseNumber('1,2,3'), 123);
  });
});
