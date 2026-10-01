//@ts-check
/**
 * @file `$quantity` (QUERY-FORMAT §8.7): a measured quantity read out of free
 * text, in the asked unit, through `@jarenjs/core/convert`'s registry and
 * alias table, with the decimal format's separators — and the empty
 * sequence, never `null`, when no quantity of the dimension is there.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { compileJsonQuery } from '@jarenjs/json';
import { UNIT_ALIASES, dimensionOf, unitOfAlias } from '@jarenjs/core/convert';
import { ar, compileNumberLocale, nl } from '@jarenjs/locales';

const NL = { decimalFormats: { nl: compileNumberLocale(nl).decimalFormat, ar: { ...compileNumberLocale(ar).decimalFormat, zeroDigit: '\u0660', decimalSeparator: '\u066b', groupingSeparator: '\u066c' } } };
/** @param {string} text @param {string} unit @param {string} [format] */
const qty = (text, unit, format = undefined) =>
  compileJsonQuery({ $quantity: format === undefined ? ['$.t', unit] : ['$.t', unit, format] }, NL)({ t: text });

describe('$quantity', () => {
  it('answers the acceptance cases', () => {
    assert.strictEqual(qty('1,5 kg', 'g', 'nl'), 1500);
    assert.strictEqual(qty('14 cm', 'g'), undefined, 'the empty sequence: no mass in the text');
    assert.strictEqual(qty('100 gram', 'g'), 100);
  });

  it('reads the units\' words, any case, glued or spaced, and converts within the dimension', () => {
    assert.strictEqual(qty('Inhoud: 250ml', 'l'), 0.25);
    assert.strictEqual(qty('2 Kilo', 'gram'), 2000, 'the asked unit may be an alias too');
    assert.strictEqual(qty('Lengte 14 cm, gewicht 300 gr', 'kg'), 0.3, 'the first quantity of the dimension, not the first number');
    assert.strictEqual(qty('2.5 liter', 'ml'), 2500);
  });

  it('reads the number with the format\'s separators, never by guessing', () => {
    assert.strictEqual(qty('1.500 gram', 'kg', 'nl'), 1.5, 'Dutch: . groups thousands');
    assert.strictEqual(qty('1,500 gram', 'kg'), 1.5, 'the default: , groups thousands');
    assert.strictEqual(qty('1,5 kg', 'g'), undefined, 'the default reads no 1,5 at all, and never a 5 kg');
    assert.strictEqual(qty('12,5 g', 'g', 'nl'), 12.5);
    assert.strictEqual(qty('1 500 g', 'g'), undefined, 'a space may group thousands: neither 500 nor 1500 is guessed');
    assert.strictEqual(qty('2 x 500 g', 'g'), 500, 'a word between the numbers keeps them apart');
    assert.strictEqual(qty('\u0661\u066b\u0665 kg', 'g', 'ar'), 1500, 'the format\'s own digit family');
  });

  it('composes with $default like ?? over undefined', () => {
    const q = compileJsonQuery({ $default: [{ $quantity: ['$.t', 'g'] }, 0] });
    assert.strictEqual(q({ t: 'Zonder gewicht' }), 0);
    assert.strictEqual(q({ t: '50 g' }), 50);
  });

  it('refuses an unknown unit (JQ0003 literal, JQ2001 computed) and a text that is no string', () => {
    assert.throws(() => compileJsonQuery({ $quantity: ['$.t', 'parsec'] }),
      (/** @type {any} */ e) => e.code === 'JQ0003' && /'\$quantity' knows no unit 'parsec'/.test(e.message));
    assert.throws(() => compileJsonQuery({ $quantity: ['$.t', '$.u'] })({ t: '1 g', u: 'furlong' }),
      (/** @type {any} */ e) => e.code === 'JQ2001' && /knows no unit 'furlong'/.test(e.message));
    assert.throws(() => compileJsonQuery({ $quantity: ['$.t', 5] }),
      (/** @type {any} */ e) => e.code === 'JQ0003' && /knows no unit '5'/.test(e.message), 'a literal that is no unit, before any row');
    const clash = { decimalSeparator: ',', groupingSeparator: ',' };
    assert.throws(() => compileJsonQuery({ $quantity: ['$.t', 'g', { $const: clash }] }),
      (/** @type {any} */ e) => e.code === 'JQ0003' && /',' plays two roles/.test(e.message));
    assert.throws(() => compileJsonQuery({ $quantity: ['$.t', 'g', '$.f'] })({ t: '1 g', f: clash }),
      (/** @type {any} */ e) => e.code === 'JQ2001' && /',' plays two roles/.test(e.message));
    assert.throws(() => compileJsonQuery({ $quantity: ['$.t', 'g'] })({ t: 5 }),
      (/** @type {any} */ e) => e.code === 'JQ2001' && /expected a string, got a number/.test(e.message));
    assert.strictEqual(compileJsonQuery({ $quantity: ['$.missing', 'g'] })({}), undefined);
  });

  it('every alias names a registry unit', () => {
    for (const [alias, id] of Object.entries(UNIT_ALIASES)) assert.ok(dimensionOf(id) !== null, `${alias} -> ${id}`);
    assert.strictEqual(unitOfAlias('GRAM'), 'g');
    assert.strictEqual(unitOfAlias('parsec'), undefined);
    assert.strictEqual(unitOfAlias('ton'), undefined, 'a word naming different units in different places is not guessed');
  });
});
