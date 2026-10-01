//@ts-check
/**
 * @file Saved formulas and the capabilities a profile declares
 * (FORMULA-FORMAT): operator packs listed by `{ name, version }` and resolved
 * from the host's `createJsltRegistry()`, only the listed ones; and the
 * locale data a formula formats with — `dateNames` and `decimalFormats` —
 * handed through `compileFormula`'s options.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { compileFormula, createFormulaCompiler } from '@jarenjs/json/formula';
import { createJsltRegistry, mathPack, statsPack } from '@jarenjs/json/jslt';
import { compileDateLocale, compileNumberLocale, nl } from '@jarenjs/locales';

const packs = createJsltRegistry().use(mathPack).use(statsPack);
/** @param {any} expression @param {any} [extra] */
const profile = (expression, extra = {}) => ({ $formula: '1', id: 'f', revision: '1', expression, ...extra });
/** @param {any} doc @param {any} options @param {string} code @param {RegExp} pattern */
const refused = (doc, options, code, pattern) => assert.throws(() => compileFormula(doc, options),
  (/** @type {any} */ e) => e.code === code && pattern.test(e.message), JSON.stringify(doc));

describe('a formula\'s operator packs', () => {
  it('evaluates an operator of a listed pack at its version', () => {
    const formula = compileFormula(profile({ $sqrt: ['$.x'] }, { packs: [{ name: 'math', version: '1' }] }), { packs });
    assert.deepStrictEqual(formula.evaluate({ x: 16 }), { kind: 'value', value: 4 });
  });

  it('refuses a pack the host did not supply, or at another version, as a missing helper is refused (JQ0014)', () => {
    refused(profile({ $sqrt: ['$.x'] }, { packs: [{ name: 'math', version: '2' }] }), { packs }, 'JQ0014', /missing\/incompatible operator pack math@2 at \/packs\/0/);
    refused(profile({ $sqrt: ['$.x'] }, { packs: [{ name: 'geo', version: '1' }] }), { packs }, 'JQ0014', /operator pack geo@1/);
    refused(profile({ $sqrt: ['$.x'] }, { packs: [{ name: 'math', version: '1' }] }), {}, 'JQ0014', /operator pack math@1/);
  });

  it('offers only the listed packs: an unlisted pack\'s operator stays unknown (JQ0002)', () => {
    refused(profile({ $mean: [[1, 2, 3]] }, { packs: [{ name: 'math', version: '1' }] }), { packs }, 'JQ0002', /unknown operator '\$mean'/);
    refused(profile({ $sqrt: ['$.x'] }), { packs }, 'JQ0002', /unknown operator '\$sqrt'/);
  });

  it('validates the packs member like helpers: unique names and versions', () => {
    refused(profile(1, { packs: [{ name: 'math' }] }), { packs }, 'JQ0013', /unique pack name and version required/);
    refused(profile(1, { packs: [{ name: 'math', version: '1' }, { name: 'math', version: '1' }] }), { packs }, 'JQ0013', /unique pack name/);
    refused(profile(1, { packs: 'math' }), { packs }, 'JQ0013', /packs must be an array/);
  });

  it('keys the compiled cache on the pack registry', () => {
    const compiler = createFormulaCompiler({ packs });
    const doc = profile({ $sqrt: ['$.x'] }, { packs: [{ name: 'math', version: '1' }] });
    assert.strictEqual(compiler.compile(doc), compiler.compile(doc));
    assert.strictEqual(compiler.size(), 1);
  });
});

describe('a formula\'s locale data', () => {
  it('formats a price and a date with the Dutch pack\'s data', () => {
    const options = { decimalFormats: { nl: compileNumberLocale(nl).decimalFormat }, dateNames: compileDateLocale(nl).names };
    const price = compileFormula(profile({ '$format-number': ['$.price', '€ #.##0,00', 'nl'] }), options);
    assert.deepStrictEqual(price.evaluate({ price: 1234.5 }), { kind: 'value', value: '€ 1.234,50' });
    const date = compileFormula(profile({ '$date-format': ['$.d', 'd MMMM yyyy'] }), options);
    assert.deepStrictEqual(date.evaluate({ d: '2026-09-27' }), { kind: 'value', value: '27 september 2026' });
    const weight = compileFormula(profile({ $quantity: ['$.t', 'g', 'nl'] }), options);
    assert.deepStrictEqual(weight.evaluate({ t: '1,5 kg' }), { kind: 'value', value: 1500 });
    assert.deepStrictEqual(weight.evaluate({ t: '14 cm' }), { kind: 'empty', values: [] });
  });

  it('refuses a names pattern without dateNames, naming the option', () => {
    refused(profile({ '$date-format': ['$.d', 'MMMM'] }), {}, 'JQ0003', /dateNames option/);
  });
});
