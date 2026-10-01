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

  it('converts the decimal the text writes exactly, rounding once, where the target unit is a power of ten', () => {
    assert.strictEqual(qty('0.7 l', 'ml'), 700);
    assert.strictEqual(qty('1.15 m', 'cm'), 115);
    assert.strictEqual(qty('5 mg', 'g'), 0.005);
    assert.strictEqual(qty('3 lbs', 'kg'), 1.36077711);
    assert.strictEqual(qty('-0,35 kg', 'g', 'nl'), -350);
    assert.ok(Object.is(qty('-0 kg', 'g'), -0), 'a negative zero keeps its sign');
    // every two-decimal value from 0.01 to 99.99, shifted by the power of ten between the units
    for (const [from, to, shift] of /** @type {[string, string, number][]} */ ([['kg', 'g', 3], ['g', 'kg', -3], ['l', 'ml', 3], ['ml', 'l', -3],
      ['m', 'cm', 2], ['km', 'm', 3], ['mg', 'g', -3]])) {
      const read = compileJsonQuery({ $quantity: ['$.t', to] });
      const artifacts = [];
      for (let i = 1; i <= 9999; i++) {
        const text = (i / 100).toFixed(2);
        if (read({ t: `${text} ${from}` }) !== Number(`${text}e${shift}`)) artifacts.push(text);
      }
      assert.deepStrictEqual(artifacts, [], `${from} to ${to}`);
    }
    assert.strictEqual(qty('1 m', 'in'), 1 / 0.0254, 'a target that is no power of ten divides as the registry does');
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

  it('never reads the tail of something else as a quantity', () => {
    for (const text of ['1/2 kg', '1/4 lb', '5 1/2 lb', '2-3 kg', '2 - 3 kg', '2–3 kg', '1e3 g', '1e-3 g', 'B12 kg', '5 -2 kg'])
      assert.strictEqual(qty(text, 'g'), undefined, text);
  });

  it('reads no number after another number and any run of white space', () => {
    for (const text of ['1  500 g', '1 \t 500 g', '1  500 g', '12   500 g'])
      assert.strictEqual(qty(text, 'g'), undefined, JSON.stringify(text));
    assert.strictEqual(qty('2 x  500 g', 'g'), 500, 'a word between the numbers keeps them apart');
  });

  it('reads a minus sign written right before the number', () => {
    assert.strictEqual(qty('Gewichtsverlies: -2 kg', 'g', 'nl'), -2000);
    assert.strictEqual(qty('Change: \u22122 kg', 'g'), -2000);
    assert.strictEqual(qty('Tolerance -0.5 mm', 'mm'), -0.5);
  });

  it('reads no number after a dash that is not its sign, never the number without its sign', () => {
    for (const text of ['Gewichtsverlies: –2 kg', 'Gewichtsverlies: - 2 kg', 'Change: ‒2 kg', 'Change: — 2 kg',
      'Change: − 2 kg', 'Change: --2 kg', '2〜3 kg'])
      assert.strictEqual(qty(text, 'g', 'nl'), undefined, JSON.stringify(text));
    assert.strictEqual(qty('Gewichtsverlies: -2 kg', 'g', 'nl'), -2000, 'a minus sign right before the number is its sign');
    assert.strictEqual(qty('- 2 kg, 3 kg', 'g'), 3000, 'the quantity after it is read');
  });

  it('reads a unit word whole: an area or a speed is never a length', () => {
    assert.strictEqual(qty('Perceel 300 m2, breedte 12 m', 'm', 'nl'), 12);
    assert.strictEqual(qty('Woning 120 m\u00b2, plafond 2,6 m hoog', 'm', 'nl'), 2.6);
    assert.strictEqual(qty('max 30 km/h over 5 km', 'km'), 5);
    assert.strictEqual(qty('Perceel 300 m2', 'm2'), 300, 'an area read as an area');
    assert.strictEqual(qty('1200 m3 gas', 'm3'), 1200);
    assert.strictEqual(qty('1200 m\u00b3 gas', 'l'), 1200000);
  });

  it('reads no unit symbol that a hyphen joins to a word', () => {
    assert.strictEqual(qty('maat: 2 t-shirts', 'kg'), undefined);
    assert.strictEqual(qty('2 t-shirts, 1 kg', 'kg'), 1, 'the quantity after it is read');
    assert.strictEqual(qty('5 g‐pack', 'g'), undefined, 'a Unicode hyphen joins a word too');
    assert.strictEqual(qty('5 kg-3', 'kg'), 5, 'a hyphen before a digit leaves the symbol whole');
  });

  it('reads a one-letter symbol as written, and leaves words with another meaning out', () => {
    assert.strictEqual(qty('Router 5G, gewicht 300 g', 'g', 'nl'), 300, 'G is giga, not a gram');
    assert.strictEqual(qty('2 in stock, 30 cm long', 'cm'), 30, 'in is a preposition');
    assert.strictEqual(qty('Costs 5 pounds, weighs 2 kg', 'g'), 2000, 'a pound is a currency too');
    assert.strictEqual(qty('1,5 L', 'ml', 'nl'), 1500, 'L is the litre');
  });

  it('reads a format whose separator is a hyphen', () => {
    const q = (/** @type {string} */ t, /** @type {any} */ f) => compileJsonQuery({ $quantity: ['$.t', 'g', '$.f'] })({ t, f });
    assert.strictEqual(q('1-500 g', { groupingSeparator: '-' }), 1500);
    assert.strictEqual(q('1-5 g', { decimalSeparator: '-' }), 1.5);
    assert.strictEqual(compileJsonQuery({ $quantity: ['$.t', 'g', '$.missing'] })({ t: '5 g' }), 5, 'an empty format is the default');
  });

  it('every alias names a registry unit', () => {
    for (const [alias, id] of Object.entries(UNIT_ALIASES)) assert.ok(dimensionOf(id) !== null, `${alias} -> ${id}`);
    assert.strictEqual(unitOfAlias('GRAM'), 'g');
    assert.strictEqual(unitOfAlias('parsec'), undefined);
    assert.strictEqual(unitOfAlias('ton'), undefined, 'a word naming different units in different places is not guessed');
    for (const word of ['in', 'pound', 'pounds', 'G', 'M', 'T']) assert.strictEqual(unitOfAlias(word), undefined, word);
    assert.deepStrictEqual(['g', 't', 'm', 'l', 'L'].map(unitOfAlias), ['g', 't', 'm', 'l', 'l']);
  });
});
