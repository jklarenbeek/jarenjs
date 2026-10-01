//@ts-check
/**
 * @file The JavaScript equivalents FORMULA-FORMAT publishes for translating a
 * formula body, each run value for value against the JavaScript it replaces,
 * and the counts the document states about the two rounding spellings,
 * computed here and read back out of the document.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { compileJsonQuery } from '@jarenjs/json';
import { compileNumberLocale, nl } from '@jarenjs/locales';

const DOC = readFileSync(new URL('../../packages/json/docs/FORMULA-FORMAT.md', import.meta.url), 'utf8');

/** Every half-cent value 0.005, 0.015, … 999.995, as the shortest decimal reads it. */
const HALF_CENTS = Array.from({ length: 100000 }, (_, k) => Number(((2 * k + 1) / 200).toFixed(3)));

/** A seeded sample over ±1000. */
function sample(count, seed) {
  let s = seed;
  return Array.from({ length: count }, () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 2000);
}

describe('FORMULA-FORMAT\'s JavaScript equivalents', () => {
  const ROWS = [{}, { a: null }, { a: 0 }, { a: '' }, { a: false }, { a: 'x' }, { a: [] }, { a: {} }, { a: -1.5 }];
  /** @param {any} doc @param {any} row */
  const run = (doc, row) => compileJsonQuery(doc)(row);

  it('a ?? b, a a missing field or a value: $default', () => {
    const q = { $default: ['$.a', 'B'] };
    for (const row of ROWS.filter((r) => !('a' in r) || r.a !== null))
      assert.deepStrictEqual(run(q, row), row.a ?? 'B', JSON.stringify(row));
  });

  it('a ?? b, a possibly an explicit null: $if over $is-null of $default', () => {
    const q = { $if: [{ '$is-null': { $default: ['$.a', null] } }, 'B', '$.a'] };
    for (const row of ROWS) assert.deepStrictEqual(run(q, row), row.a ?? 'B', JSON.stringify(row));
  });

  it('a == null: $is-null of $default', () => {
    const q = { '$is-null': { $default: ['$.a', null] } };
    for (const row of ROWS) assert.strictEqual(run(q, row), row.a == null, JSON.stringify(row));
  });

  it('Math.round(x * 100) / 100: multiply, round, divide — bit for bit', () => {
    const q = compileJsonQuery({ $div: [{ $round: [{ $mul: ['$.x', 100] }] }, 100] });
    const values = [...HALF_CENTS, ...HALF_CENTS.map((x) => -x), ...sample(200000, 20261001)];
    let differ = 0;
    for (const x of values) if (!Object.is(q({ x }), Math.round(x * 100) / 100)) differ++;
    assert.strictEqual(differ, 0);
    assert.strictEqual(values.length, 400000);
    assert.ok(DOC.includes('reproduces it bit for bit (no difference over\n400,000 values, both signs)'), 'the document states the measured count');
  });

  it('Number(x.toFixed(2)), x >= 0: $round at two places; the two rounding spellings differ as stated', () => {
    const q = compileJsonQuery({ $round: ['$.x', 2] });
    let fromFixed = 0;
    let fromProduct = 0;
    for (const x of HALF_CENTS) {
      const rounded = q({ x });
      if (rounded !== Number(x.toFixed(2))) fromFixed++;
      if (rounded !== Math.round(x * 100) / 100) fromProduct++;
    }
    assert.strictEqual(fromFixed, 0);
    assert.strictEqual(fromProduct, 43412);
    assert.ok(DOC.includes('43,412 of the 100,000 half-cent values from 0.005 to 999.995'), 'the document states the measured count');
    assert.strictEqual(q({ x: 0.015 }), 0.01);
    assert.strictEqual(Math.round(0.015 * 100) / 100, 0.02);
    assert.strictEqual(q({ x: -0.125 }), -0.12);
    assert.strictEqual((-0.125).toFixed(2), '-0.13');
  });

  // the Dutch number formats are ICU's, as the host runs it: measured on ICU 78.3
  const ICU = { skip: process.versions.icu !== '78.3' && `measured on ICU 78.3; this host runs ${process.versions.icu}` };
  const SIGNED = [...HALF_CENTS, ...HALF_CENTS.map((x) => -x)];

  it('n.toFixed(d): the exact value rounded half away from zero, then written', () => {
    const fixed = (/** @type {number} */ d) => compileJsonQuery({ '$format-number': [{ $if: [{ $lt: ['$.x', 0] }, { $neg: { $round: [{ $neg: '$.x' }, d] } },
      { $round: [{ $add: ['$.x', 0] }, d] }] }, d === 0 ? '0' : `0.${'0'.repeat(d)}`] });
    for (const d of [0, 1, 2]) {
      const q = fixed(d);
      let differ = 0;
      for (const x of SIGNED) if (q({ x }) !== x.toFixed(d)) differ++;
      assert.strictEqual(differ, 0, `toFixed(${d})`);
    }
    assert.strictEqual(SIGNED.length, 200000);
    assert.ok(DOC.includes('no difference over 200,000 values'), 'the document states the measured count');
  });

  it("n.toLocaleString('nl-NL', …): the decimal and currency pictures under the Dutch format", ICU, () => {
    const decimalFormats = { nl: compileNumberLocale(nl).decimalFormat };
    for (const [picture, options] of /** @type {[string, Intl.NumberFormatOptions][]} */ ([
      ['#.##0,###', {}], ['#.##0,#', { maximumFractionDigits: 1 }], ['€\u00a0#.##0,00;€\u00a0-#.##0,00', { style: 'currency', currency: 'EUR' }]])) {
      const q = compileJsonQuery({ '$format-number': ['$.x', picture, 'nl'] }, { decimalFormats });
      // toLocaleString(locale, options) is new Intl.NumberFormat(locale, options).format, built once here
      const intl = new Intl.NumberFormat('nl-NL', options);
      let differ = 0;
      for (const x of SIGNED) if (q({ x }) !== intl.format(x)) differ++;
      assert.strictEqual(differ, 0, picture);
    }
  });
});
