//@ts-check
/**
 * @file `$format-number` (QUERY-FORMAT §8.7): F&O `fn:format-number` with the
 * decimal format as data — F&O's own picture examples, the Dutch currency
 * picture, the ICU edge cases the shortest-decimal rounding exists for, and
 * every refusal in its own words.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { compileJsonQuery } from '@jarenjs/json';
import { compileNumberLocale, nl, ar } from '@jarenjs/locales';

const NL = compileNumberLocale(nl).decimalFormat;
/** @param {any} value @param {string} picture @param {any} [format] @param {any} [options] */
const fmt = (value, picture, format = undefined, options = undefined) =>
  compileJsonQuery({ '$format-number': format === undefined ? ['$.v', picture] : ['$.v', picture, format] }, options)({ v: value });
/** @param {any} doc @param {string} code @param {RegExp} pattern @param {any} [options] @param {any} [data] */
const refused = (doc, code, pattern, options = undefined, data = {}) => assert.throws(
  () => compileJsonQuery(doc, options)(data),
  (/** @type {any} */ e) => e.code === code && pattern.test(e.message), JSON.stringify(doc));

describe('$format-number — F&O pictures', () => {
  it('formats the F&O examples under the default decimal format', () => {
    for (const [value, picture, want] of /** @type {[number, string, string][]} */ ([
      [12345.6, '#,###.00', '12,345.60'], [12345678.9, '9,999.99', '12,345,678.90'], [123.9, '9999', '0124'],
      [0.14, '01%', '14%'], [-6, '000', '-006'], [1234.5678, '#,##0.00', '1,234.57'], [1234.5678, '00.000e0', '12.346e2'],
      [0.234, '0.0e0', '2.3e-1'], [0.5, '#.00', '.50'], [0, '#', '0'], [0.0125, '#‰', '13‰'], [12345678, '#,##,##0', '123,45,678'],
    ])) assert.strictEqual(fmt(value, picture), want, `${value} ${picture}`);
  });

  it('takes a negative sub-picture, and the minus sign before the prefix without one', () => {
    assert.strictEqual(fmt(-1234.5, '#,##0.00;(#,##0.00)'), '(1,234.50)');
    // a string starting with $ is a path in a query: the literal dollar is $$
    assert.strictEqual(fmt(-1234.5, '$$ #,##0.00'), '-$ 1,234.50');
    assert.strictEqual(fmt(-0, '0.00'), '-0.00', 'negative zero is negative');
  });

  it("scales an exponent's mantissa by the picture's mandatory integer digits, none allowed, and prints it as it rounds", () => {
    const fortran = { exponentSeparator: 'E' };
    for (const [value, picture, want] of /** @type {[number, string, string][]} */ ([
      // the mantissa has as many integer digits as the picture has mandatory ones
      [1, '00.0e0', '10.0e-1'], [0.2, '000.0e0', '200.0e-3'], [12, '000.00e0', '120.00e-1'], [5, '000e0', '500e-2'],
      [-7, '00.0e0', '-70.0e-1'],
      // none: the mantissa is under one, and an optional integer digit writes its zero
      [12345.678, '#.99e99', '0.12e05'], [0.2, '#e0', '0.2e0'], [0, '#.0e9', '0.0e0'], [0.123, '#.e9', '0.1e0'],
      [0.1, '.9e9', '.1e0'],
      // a rounding carry prints as it rounds
      [0.99999, '0.0e0', '10.0e-1'],
    ])) assert.strictEqual(fmt(value, picture), want, `${value} ${picture}`);
    assert.strictEqual(fmt(0.234, '#.00E0', fortran), '0.23E0');
    assert.strictEqual(fmt(0.234, '.00E0', fortran), '.23E0');
  });

  it('applies the minimum-size adjustments: zero under a picture with no mandatory digit keeps one fraction digit', () => {
    for (const [value, picture, want] of /** @type {[number, string, string][]} */ ([
      [0, '#.#', '.0'], [0, '.#', '.0'], [0, '###.###', '.0'], [0, '#.##', '.0'], [0, '###,###.##', '.0'],
      [0.1, '###,###.##', '.1'], [1.2, '#.#', '1.2'], [1, '#.#', '1.0'], [0.2, '#.', '0'], [0, '#.00', '.00'],
    ])) assert.strictEqual(fmt(value, picture), want, `${value} ${picture}`);
  });

  it('repeats grouping only when every multiple of its size inside the integer part holds a separator', () => {
    for (const [value, picture, want] of /** @type {[number, string, string][]} */ ([
      [642120, '####,##', '6421,20'], [642120, '###,##', '6421,20'], [642120, '0000,00', '6421,20'],
      [642120, '##,#,#', '6421,2,0'], [123456789, '###,##,00', '12345,67,89'],
      // regular: the multiples repeat as far as the number needs
      [123456789, '#,##0', '123,456,789'], [123456789, '##,##', '1,23,45,67,89'], [1234567, '###,###', '1,234,567'],
    ])) assert.strictEqual(fmt(value, picture), want, `${value} ${picture}`);
  });

  it('spells NaN alone, an infinity between the prefix and suffix, and the empty sequence as NaN', () => {
    assert.strictEqual(compileJsonQuery({ '$format-number': [{ $div: [0, 0] }, '€ #0'] })(null), 'NaN');
    assert.strictEqual(compileJsonQuery({ '$format-number': [{ $div: [-1, 0] }, '€ #0 x'] })(null), '-€ Infinity x');
    assert.strictEqual(compileJsonQuery({ '$format-number': ['$.missing', '#0'] })({}), 'NaN');
  });
});

describe('$format-number — the decimal format as data', () => {
  it('spells a Dutch price with the Dutch record, as an operand or by its registered name', () => {
    assert.strictEqual(fmt(1234.5, '€ #.##0,00;€ -#.##0,00', NL), '€ 1.234,50');
    assert.strictEqual(fmt(-1234.5, '€ #.##0,00;€ -#.##0,00', 'nl', { decimalFormats: { nl: NL } }), '€ -1.234,50');
    assert.strictEqual(fmt(0.5, '0,0%', 'nl', { decimalFormats: { nl: NL } }), '50,0%');
  });

  it('rounds the shortest decimal half away from zero, as ICU does, and prints large magnitudes whole', () => {
    const icu = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
    const picture = '€ #.##0,00;€ -#.##0,00';
    for (const value of [1.005, -1.005, 2.675, 0.125, 1.255, 8.345, -0, 0, 1e21, 1e-7, -1e-7, 1.5e300, Number.MAX_SAFE_INTEGER]) {
      assert.strictEqual(fmt(value, picture, NL), icu.format(value), String(value));
    }
  });

  it('maps digits onto a format\'s own digit family', () => {
    const arabicIndic = { zeroDigit: '٠', decimalSeparator: '٫', groupingSeparator: '٬' };
    assert.strictEqual(fmt(1234.5, '#٬##٠٫٠٠', arabicIndic), '١٬٢٣٤٫٥٠');
    assert.strictEqual(compileNumberLocale(ar).decimalFormat.decimalSeparator, '.', 'ar ships latn digits, as CLDR 48 does');
  });
});

describe('$format-number — refusals', () => {
  it('names the picture rule broken: JQ0003 when literal', () => {
    for (const [picture, rule] of /** @type {[string, RegExp][]} */ ([
      ['#;#;#', /more than one pattern separator/], ['#.#.#', /more than one decimal separator/],
      ['#%%', /more than one percent or per-mille sign/], ['abc', /neither a mandatory nor an optional digit/],
      ['#a#', /passive character between active ones/], ['#,,##0', /two adjacent grouping separators/],
      ['#,.00', /grouping separator stands next to the decimal separator/], ['#0#', /optional digit follows a mandatory one/],
      ['0.0e0e0', /more than one exponent separator/], ['0.0e0%', /both an exponent and a percent/],
    ])) refused({ '$format-number': [1, picture] }, 'JQ0003', new RegExp(`picture '${picture.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' is invalid: .*${rule.source}`));
  });

  it('refuses a decimal format that breaks a rule, an unregistered name, and what is no format: JQ0003 literal, JQ2001 computed', () => {
    for (const [format, rule] of /** @type {[any, RegExp][]} */ ([
      [{ nope: '.' }, /'nope' is not a member of a decimal format/], [{ decimalSeparator: '..' }, /'decimalSeparator' must be one character/],
      [{ zeroDigit: 'a' }, /zeroDigit 'a' is not the zero of a decimal digit family/],
      [{ decimalSeparator: ',' }, /',' plays two roles in a picture/],
      ['de', /names no registered decimal format 'de'/],
      [7, /takes a decimal format record or the name of a registered one, got a number/],
    ])) {
      const literal = typeof format === 'object' ? { $const: format } : format;
      assert.throws(() => compileJsonQuery({ '$format-number': [1, '0', literal] }),
        (/** @type {any} */ e) => e.code === 'JQ0003' && rule.test(e.message), `literal ${JSON.stringify(format)}, before any row`);
      refused({ '$format-number': [1, '0', '$.f'] }, 'JQ2001', rule, undefined, { f: format });
    }
    refused({ '$format-number': [1, '#;#;#', '$.f'] }, 'JQ2001', /more than one pattern separator/, undefined, { f: { decimalSeparator: ',', groupingSeparator: '.' } });
    assert.throws(() => compileJsonQuery(1, { decimalFormats: { bad: { zeroDigit: 'x' } } }),
      (/** @type {any} */ e) => e instanceof TypeError && /options\.decimalFormats\.bad is not a decimal format/.test(e.message));
  });

  it('reads an empty format operand as the default format, as F&O reads an empty decimal-format name', () => {
    assert.strictEqual(compileJsonQuery({ '$format-number': ['$.v', '#,##0.0', '$.missing'] })({ v: 1234.5 }), '1,234.5');
  });

  it('reads a decimal format record that can still change afresh, never as it read it before', () => {
    const record = { decimalSeparator: ',', groupingSeparator: '.' };
    const spell = () => compileJsonQuery({ '$format-number': [1234.5, '#.##0,0', '$.f'] })({ f: record });
    assert.strictEqual(spell(), '1.234,5');
    record.decimalSeparator = '.';
    record.groupingSeparator = ',';
    assert.throws(spell, (/** @type {any} */ e) => e.code === 'JQ2001', 'the Dutch picture no longer reads under the changed record');
    assert.strictEqual(compileJsonQuery({ '$format-number': [1234.5, '#,##0.0', '$.f'] })({ f: record }), '1,234.5');
    // a frozen record cannot change: it is read once
    const frozen = Object.freeze({ decimalSeparator: ',', groupingSeparator: '.' });
    assert.strictEqual(compileJsonQuery({ '$format-number': [1234.5, '#.##0,0', '$.f'] })({ f: frozen }), '1.234,5');
  });

  it('refuses a computed picture or format at run time (JQ2001), and caches the last one', () => {
    refused({ '$format-number': [1, '$.p'] }, 'JQ2001', /picture '#,,0' is invalid/, undefined, { p: '#,,0' });
    refused({ '$format-number': [1, '$.p'] }, 'JQ2001', /expected a string, got a number/, undefined, { p: 3 });
    const q = compileJsonQuery({ $for: { p: '$.pictures[*]' }, $return: { '$format-number': ['$.v', '$p'] } });
    assert.deepStrictEqual(q({ v: 3.14159, pictures: ['0.0', '0.0', '0.000'] }), ['3.1', '3.1', '3.142']);
  });
});
