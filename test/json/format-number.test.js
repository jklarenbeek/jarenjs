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

  it('refuses a computed picture or format at run time (JQ2001), and caches the last one', () => {
    refused({ '$format-number': [1, '$.p'] }, 'JQ2001', /picture '#,,0' is invalid/, undefined, { p: '#,,0' });
    refused({ '$format-number': [1, '$.p'] }, 'JQ2001', /expected a string, got a number/, undefined, { p: 3 });
    const q = compileJsonQuery({ $for: { p: '$.pictures[*]' }, $return: { '$format-number': ['$.v', '$p'] } });
    assert.deepStrictEqual(q({ v: 3.14159, pictures: ['0.0', '0.0', '0.000'] }), ['3.1', '3.1', '3.142']);
  });
});
