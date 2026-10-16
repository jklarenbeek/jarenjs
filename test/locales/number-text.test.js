//@ts-check
/**
 * @file A number written and read in a pack's language: `formatNumber` and
 * `parseNumber` of `@jarenjs/core/math` under the decimal format
 * `compileNumberLocale` compiles, per pack; the round trip under every pack;
 * and the one reading they share with `$quantity` of `@jarenjs/json`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { nl, fr, es, pt, de, ja, ko, zhTW, ru, tr, ar, compileNumberLocale } from '@jarenjs/locales';
import { formatNumber, parseNumber } from '@jarenjs/core/math';
import { mulberry32, randomInt } from '@jarenjs/core/random';
import { compileJsonQuery } from '@jarenjs/json';

const PACKS = { en: undefined, nl, fr, es, pt, de, ja, ko, 'zh-TW': zhTW, ru, tr, ar };
/** @type {Record<string, any>} */
const FORMATS = Object.fromEntries(Object.entries(PACKS).map(([code, pack]) => [code, compileNumberLocale(pack).decimalFormat]));

// the text each pack writes -1234567.25 in, grouped, character for character
const WRITTEN = {
  en: '-1,234,567.25', nl: '-1.234.567,25', fr: '-1\u202f234\u202f567,25', es: '-1.234.567,25',
  pt: '-1.234.567,25', de: '-1.234.567,25', ja: '-1,234,567.25', ko: '-1,234,567.25',
  'zh-TW': '-1,234,567.25', ru: '-1\u00a0234\u00a0567,25', tr: '-1.234.567,25', ar: '-1,234,567.25',
};

describe('a number in a pack\'s language', () => {
  for (const [code, decimalFormat] of Object.entries(FORMATS)) {
    const d = decimalFormat.decimalSeparator;
    const g = decimalFormat.groupingSeparator;
    it(`${code} writes and reads its own separators, and nothing else`, () => {
      assert.equal(formatNumber(-1234567.25, { decimalFormat, group: true }), WRITTEN[code]);
      assert.equal(formatNumber(-1234567.25, { decimalFormat }), `-1234567${d}25`);
      assert.equal(parseNumber(WRITTEN[code], { decimalFormat }), -1234567.25);
      assert.equal(parseNumber(`3${d}45`, { decimalFormat }), 3.45);
      assert.equal(parseNumber(`1${g}234${d}5`, { decimalFormat }), 1234.5);
      assert.equal(parseNumber(`1${g}234`, { decimalFormat }), 1234);
      assert.equal(parseNumber(`1234${d}5`, { decimalFormat }), 1234.5);
      for (const text of [`1${d}2${d}3`, `1${g}23`, `12${g}34${g}567`, `1${d}234${g}5`, `${d}5`, `1${g}5`, `3${g}45`])
        assert.ok(Number.isNaN(parseNumber(text, { decimalFormat })), JSON.stringify(text));
    });
  }

  it('Dutch reads the decimal comma, where the default reads grouping', () => {
    const decimalFormat = FORMATS.nl;
    assert.equal(parseNumber('3,45', { decimalFormat }), 3.45);
    assert.equal(parseNumber('1.234,5', { decimalFormat }), 1234.5);
    assert.ok(Number.isNaN(parseNumber('1,2,3', { decimalFormat })));
    assert.equal(parseNumber('1,234.5', { decimalFormat: FORMATS.en }), 1234.5);
    assert.equal(parseNumber('3,45'), 345);
  });

  it('formats a price with the currency sign where the picture puts it, under the same record', () => {
    const decimalFormats = { nl: FORMATS.nl, en: FORMATS.en };
    const price = (/** @type {string} */ picture, /** @type {string} */ code) =>
      compileJsonQuery({ '$format-number': ['$.p', picture, code] }, { decimalFormats });
    assert.equal(price('€ #.##0,00', 'nl')({ p: 1234.5 }), '€ 1.234,50');
    assert.equal(price('€ #.##0,00', 'nl')({ p: -1234.5 }), '-€ 1.234,50');
    assert.equal(price('#.##0,00 €', 'nl')({ p: 1234.5 }), '1.234,50 €');
    assert.equal(price('#,##0.00 EUR', 'en')({ p: 1234.5 }), '1,234.50 EUR');
    assert.equal(parseNumber('1.234,50', { decimalFormat: FORMATS.nl }), 1234.5);
    const euro = compileJsonQuery({ '$format-number': ['$', '€ #.##0,00', 'nl'] }, { decimalFormats });
    assert.equal(euro(1234.5), '€ 1.234,50');
    assert.equal(euro(-0.5), '-€ 0,50');
  });
});

describe('format then parse round-trips under every pack', () => {
  const random = mulberry32(0x5eed);
  /** @type {number[]} */
  const values = [0, 1, -1, 0.1, 1e21, -1e21, 1.5e-7, 123456789012345680000, 2 ** 53, Number.MAX_VALUE, Number.MIN_VALUE];
  for (let i = 0; i < 400; i++) {
    const digits = randomInt(random, 1, 17);
    const mantissa = Number(String(randomInt(random, 1, 9)) + Array.from({ length: digits - 1 }, () => randomInt(random, 0, 9)).join(''));
    const value = mantissa * 10 ** randomInt(random, -30, 10);
    values.push(random() < 0.5 ? -value : value);
  }

  for (const [code, decimalFormat] of Object.entries(FORMATS)) {
    it(`${code}: ${values.length} values, grouped and not, auto and fixed`, () => {
      for (const value of values) {
        for (const group of [false, true]) {
          const text = formatNumber(value, { decimalFormat, group });
          assert.equal(parseNumber(text, { decimalFormat }), value, `${value} -> ${JSON.stringify(text)}`);
          if (Math.abs(value) < 1e21) {
            const fixed = formatNumber(value, { decimalFormat, group, notation: 'fixed', precision: 3 });
            assert.equal(parseNumber(fixed, { decimalFormat }), Number(value.toFixed(3)), `${value} -> ${JSON.stringify(fixed)}`);
          }
        }
      }
      for (const value of [Infinity, -Infinity])
        assert.equal(parseNumber(formatNumber(value, { decimalFormat }), { decimalFormat }), value);
      assert.ok(Number.isNaN(parseNumber(formatNumber(NaN, { decimalFormat }), { decimalFormat })));
    });
  }
});

describe('parseNumber reads a pack\'s text as $quantity does', () => {
  for (const [code, decimalFormat] of Object.entries(FORMATS)) {
    it(code, () => {
      const d = decimalFormat.decimalSeparator;
      const g = decimalFormat.groupingSeparator;
      const quantity = compileJsonQuery({ $quantity: ['$.t', 'g', code] }, { decimalFormats: { [code]: decimalFormat } });
      const texts = ['3', `3${d}45`, `1${g}234${d}5`, `-1${g}234${g}567${d}25`, `1234${d}5`, `1${g}234`, `10${g}000`,
        `1${d}2${d}3`, `1${g}23`, `12${g}34${g}567`, `1${g}234${g}5`, `3${g}45`, `1${d}234${g}567`];
      for (const text of texts) {
        const read = parseNumber(text, { decimalFormat });
        const quantityRead = quantity({ t: `${text} g` });
        assert.equal(Number.isNaN(read) ? undefined : read, quantityRead, JSON.stringify(text));
      }
    });
  }
});
