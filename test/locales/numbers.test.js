//@ts-check
/**
 * @file The number language (`@jarenjs/locales/numbers`): the decimal format
 * each pack carries as data, read back through `compileNumberLocale`, the
 * English fallback, and the claim the data makes — that it is CLDR as
 * ICU 78.3 ships it — checked against `Intl.NumberFormat` when the host runs
 * that ICU.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  nl, fr, es, pt, de, ja, ko, zhTW, ru, tr, ar,
  compileNumberLocale, numberMessagesEn,
} from '@jarenjs/locales';
import { compileJsonQuery } from '@jarenjs/json';

const PACKS = { en: undefined, nl, fr, es, pt, de, ja, ko, 'zh-TW': zhTW, ru, tr, ar };
const SOURCE_ICU = '78.3';

/** The symbols `Intl.NumberFormat` writes for a locale, in decimal-format terms. @param {string} code */
function intlSymbols(code) {
  const of = (/** @type {Intl.NumberFormatOptions} */ options, /** @type {number} */ value, /** @type {string} */ type) =>
    new Intl.NumberFormat(code, options).formatToParts(value).find((part) => part.type === type)?.value;
  return {
    decimalSeparator: of({}, -12345.6, 'decimal'),
    groupingSeparator: of({ useGrouping: 'always' }, -12345.6, 'group'),
    minusSign: of({}, -12345.6, 'minusSign'),
    percent: of({ style: 'percent' }, 0.5, 'percentSign'),
    zeroDigit: of({}, 0, 'integer'),
    exponentSeparator: of({ notation: 'scientific' }, 12345, 'exponentSeparator'),
    infinity: of({}, Infinity, 'infinity'),
    NaN: of({}, NaN, 'nan'),
  };
}

/** The fewest digits the leftmost group of a number `Intl.NumberFormat` groups holds, for a locale. @param {string} code */
function intlMinimumGroupingDigits(code) {
  const format = new Intl.NumberFormat(code);
  let digits = 1;
  while (!format.formatToParts(10 ** (2 + digits)).some((part) => part.type === 'group')) digits++;
  return digits;
}

describe('compileNumberLocale', () => {
  it('compiles English, the fallback, with the picture syntax every language shares', () => {
    assert.deepStrictEqual(compileNumberLocale().decimalFormat, {
      decimalSeparator: '.', groupingSeparator: ',', minusSign: '-', percent: '%', perMille: '‰', zeroDigit: '0',
      digit: '#', patternSeparator: ';', exponentSeparator: 'E', infinity: '∞', NaN: 'NaN',
    });
    assert.ok(Object.isFrozen(compileNumberLocale(nl).decimalFormat));
  });

  it('falls back to English per entry, and refuses an entry that renders nothing', () => {
    const half = compileNumberLocale({ 'number/decimal-separator': ',' }).decimalFormat;
    assert.strictEqual(half.decimalSeparator, ',');
    assert.strictEqual(half.groupingSeparator, ',', 'the English entry: a clash $format-number refuses when it reads the record');
    assert.throws(() => compileNumberLocale({ 'number/minus-sign': '' }), /'number\/minus-sign' must render a non-empty string/);
  });

  it('reads the minimum grouping digits as a positive whole number, 1 by default', () => {
    assert.strictEqual(compileNumberLocale().minimumGroupingDigits, 1);
    assert.strictEqual(compileNumberLocale(es).minimumGroupingDigits, 2, 'Spanish writes 1234 but 12.345');
    for (const digits of ['0', 'two', '1.5'])
      assert.throws(() => compileNumberLocale({ 'number/minimum-grouping-digits': digits }), /'number\/minimum-grouping-digits' must be a positive whole number/, digits);
  });

  for (const [code, pack] of Object.entries(PACKS)) {
    it(`${code} carries the decimal format CLDR gives it`, { skip: process.versions.icu !== SOURCE_ICU && `the data was taken from ICU ${SOURCE_ICU}; this host runs ${process.versions.icu}` }, () => {
      const { decimalFormat, minimumGroupingDigits } = compileNumberLocale(pack);
      const { perMille, digit, patternSeparator, ...compared } = decimalFormat;
      assert.deepStrictEqual(compared, intlSymbols(code));
      assert.strictEqual(minimumGroupingDigits, intlMinimumGroupingDigits(code), 'the fewest digits of a grouped number\'s leftmost group');
      assert.strictEqual(perMille, '‰');
      assert.deepStrictEqual([digit, patternSeparator], ['#', ';'], 'the picture syntax is the same in every language');
      if (pack !== undefined) assert.deepStrictEqual(Object.keys(numberMessagesEn).filter((key) => !(key in pack)), []);
    });
  }

  it('formats with a pack\'s data in a query, the picture written in the format\'s own characters', () => {
    const decimalFormats = Object.fromEntries(Object.entries(PACKS).map(([code, pack]) => [code, compileNumberLocale(pack).decimalFormat]));
    const format = (/** @type {string} */ picture, /** @type {string} */ code) =>
      compileJsonQuery({ '$format-number': [-1234567.891, picture, code] }, { decimalFormats })(null);
    assert.strictEqual(format('#,##0.00', 'en'), '-1,234,567.89');
    assert.strictEqual(format('#.##0,00', 'nl'), '-1.234.567,89');
    assert.strictEqual(format('#\u202f##0,00', 'fr'), '-1\u202f234\u202f567,89');
    assert.throws(() => format('#,##0.00', 'nl'), (/** @type {any} */ e) => e.code === 'JQ0003'
      && e.params.rule.messageId === 'query/picture/digit-order', 'under nl the English picture reads as a fraction ##0.00');
    assert.throws(() => format('# ##0,00', 'fr'), (/** @type {any} */ e) => e.code === 'JQ0003'
      && e.params.rule.messageId === 'query/picture/passive-inside', 'a plain space is not the French grouping separator');
  });
});
