//@ts-check
/**
 * @file Rounding in the query language (QUERY-FORMAT §8.5): `$floor`,
 * `$ceiling`, `$abs`, `$round` and `$round-half-to-even` with F&O semantics
 * over IEEE doubles — a precision rounds the EXACT value of the double —
 * and the unknown-operator hints that point at them, each proven.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { compileJsonQuery } from '@jarenjs/json';
import { roundExact } from '@jarenjs/core/math';

/** The value a query answers (a negative zero kept distinct). @param {any} doc @param {any} [data] */
const run = (doc, data = null) => compileJsonQuery(doc)(data);
/** @param {any} doc @param {string} code @param {RegExp} [pattern] */
const refused = (doc, code, pattern = /./) => assert.throws(() => run(doc, {}),
  (/** @type {any} */ e) => e.code === code && pattern.test(e.message), JSON.stringify(doc));

describe('rounding — F&O semantics', () => {
  it('answers the acceptance cases', () => {
    assert.strictEqual(run({ $floor: -1.5 }), -2);
    assert.strictEqual(run({ $ceiling: 2.01 }), 3);
    assert.strictEqual(run({ $round: [2.5] }), 3);
    assert.strictEqual(run({ $round: [-2.5] }), -2);
    assert.strictEqual(run({ $round: [1.005, 2] }), 1, 'the double is just below 1.005: F&O rounds the exact value');
    assert.strictEqual(run({ '$round-half-to-even': [2.5] }), 2);
    assert.strictEqual(run({ $abs: -3 }), 3);
  });

  it('rounds with a precision on the exact value, either side of the point', () => {
    for (const [doc, want] of /** @type {[any, number][]} */ ([
      [{ $round: [1234.5, -2] }, 1200], [{ $round: [1250, -2] }, 1300], [{ $round: [-1250, -2] }, -1200],
      [{ $round: [35.425, 2] }, 35.42], [{ $round: [0.30000000000000004, 1] }, 0.3], [{ $round: [123.456, -5] }, 0],
      [{ '$round-half-to-even': [3.5] }, 4], [{ '$round-half-to-even': [-2.5] }, -2], [{ '$round-half-to-even': [2.345, 2] }, 2.35],
      [{ '$round-half-to-even': [0.125, 2] }, 0.12], [{ $round: [1e21, 2] }, 1e21],
    ])) assert.strictEqual(run(doc), want, JSON.stringify(doc));
  });

  it('keeps the sign of a zero, passes NaN and the infinities, and propagates the empty sequence', () => {
    assert.ok(Object.is(run({ $ceiling: -0.5 }), -0));
    assert.ok(Object.is(run({ $round: [-0.4] }), -0));
    assert.ok(Object.is(run({ $round: [-0.5] }), -0));
    assert.ok(Object.is(run({ '$round-half-to-even': [-0.5] }), -0));
    assert.ok(Number.isNaN(run({ $floor: { $div: [0, 0] } })));
    assert.strictEqual(run({ $abs: { $div: [-1, 0] } }), Infinity);
    for (const op of ['$floor', '$ceiling', '$abs']) assert.strictEqual(run({ [op]: '$.missing' }, {}), undefined, op);
    assert.strictEqual(run({ $round: ['$.missing', 2] }, {}), undefined);
  });

  it('refuses a non-number operand and a precision that is not an integer (JQ2001)', () => {
    refused({ $floor: 'x' }, 'JQ2001', /arithmetic requires a number operand, got a string/);
    refused({ $round: [2.5, 0.5] }, 'JQ2001', /'\$round' precision must be an integer, got a number/);
    refused({ '$round-half-to-even': [2.5, '2'] }, 'JQ2001', /'\$round-half-to-even' precision must be an integer, got a string/);
    refused({ $round: 2.5 }, 'JQ0003', /takes an array of expressions/);
  });

  it('is core math\'s one implementation', () => {
    for (const [x, p] of [[2.5, 0], [-2.5, 0], [1.005, 2], [1250, -2]]) {
      assert.strictEqual(run({ $round: [x, p] }), roundExact(x, p, 'half-up'));
      assert.strictEqual(run({ '$round-half-to-even': [x, p] }), roundExact(x, p, 'half-even'));
    }
  });
});

describe('the hints that point at them are true', () => {
  it('$ceil names $ceiling, and $floor, $round and $abs are operators now', () => {
    refused({ $ceil: [1] }, 'JQ0002', /unknown operator '\$ceil' \(use '\$ceiling'\)/);
    for (const op of ['$floor', '$round', '$abs', '$ceiling']) assert.doesNotThrow(() => compileJsonQuery({ [op]: [1] }), op);
  });

  it('truncation is $idiv by 1: toward zero, where $floor goes down', () => {
    refused({ $trunc: [1] }, 'JQ0002', /\$idiv by 1/);
    assert.strictEqual(run({ $idiv: [-1.5, 1] }), -1);
    assert.strictEqual(run({ $floor: -1.5 }), -2);
  });

  it('$trim names the sentinel composition, and the composition trims without collapsing', () => {
    refused({ $trim: ['x'] }, 'JQ0002', /\$replace around a sentinel/);
    assert.throws(() => compileJsonQuery({ $trim: ['x'] }), (/** @type {any} */ e) => !/normalize-space/.test(e.message),
      'the hint names the composition only: $normalize-space would collapse the inside too');
    const trim = { $replace: [{ $concat: ['￿', { $replace: [{ $concat: ['$.s', '￿'] }, '[ \\t\\n\\r]*￿', ''] }] },
      '￿[ \\t\\n\\r]*', ''] };
    for (const [s, want] of [['  a  b \t', 'a  b'], ['\n x\ny \r', 'x\ny'], ['plain', 'plain'], ['', ''], ['   ', '']]) {
      assert.strictEqual(run(trim, { s }), want, JSON.stringify(s));
    }
    assert.strictEqual(run({ '$normalize-space': '$.s' }, { s: '  a  b \t' }), 'a b', 'the old hint collapsed the inside too');
  });
});
