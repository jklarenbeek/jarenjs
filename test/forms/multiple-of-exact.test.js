//@ts-check
/**
 * @file A form field's `multipleOf` gives the validator's answer: both
 * decide it with one test, on the decimals the value and the step spell
 * (`multipleOfTester` of `@jarenjs/core/math`). A fixed tolerance on the
 * float quotient took values within 1e-6 of a whole quotient that the
 * validator refuses (`5` under `multipleOf: 10000000`), and refused true
 * multiples whose float quotient drifted (`0.5` under `1e-15`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { buildFormModel, validateAllFields } from '@jarenjs/forms';

const validator = new JarenValidator();

/**
 * The field errors of one member under a `multipleOf`, through the walk.
 * @param {any} value @param {any} step @param {string} [type]
 */
const fieldErrors = (value, step, type = 'number') =>
  validateAllFields(buildFormModel({ type: 'object', properties: { n: { type, multipleOf: step } } }), { n: value })['/n'] ?? [];

/** @param {number} value @param {number} step @param {string} [type] */
const validatorTakes = (value, step, type = 'number') => validator.compile({ type, multipleOf: step })(value);

/** Values the tolerance took, which the validator refuses. */
const TOOK = [
  [5, 10000000], [9, 10000000], [20000001, 10000000], [-20000001, 10000000], [20000001, -10000000],
  [0.30000000000000004, 0.1], [-0.30000000000000004, 0.1], [0.10000001, 0.1], [1.0000005, 1],
  // past 2^53 every double divides to a whole float quotient
  [1e300, 3], [1e308, 3], [1e21, 7], [1e308, 0.123456789],
  // an infinite quotient, and a value that is not finite
  [1e10, 3e-300], [Infinity, 1], [-Infinity, 0.5], [Infinity, Infinity], [Infinity, -Infinity],
];

/** True multiples the tolerance refused, as their float quotient drifted. */
const REFUSED = [
  [0.5, 1e-15], [0.25, 1e-15], [-0.5, 1e-15], [0.5, -1e-15],
  [1234567890.1, 0.1], [-1234567890.1, 0.1], [370370367036.9, 0.3], [123456789012345.6, 0.1],
  [12.345678901, 1e-9], [0.012345678901, 1e-12], [3.08641972525, 2.5e-10], [299999999.997, 0.003],
  [9.8765432109e299, 1e289], [3.08641972525e260, 2.5e250],
];

/** Answers both readings gave. */
const KEPT = [
  [10000000, 10000000], [20000000, 10000000], [-10000000, 10000000], [0, 10000000],
  [0.7, 0.1], [1.1, 0.1], [12.34, 0.01], [1.005, 0.01], [2 ** 53, 3], [2 ** 53, 2], [123456789012345.66, 0.1],
  [3e-15, 1e-15], [1.5e-15, 1e-15], [12391239123, 1e-8], [7e-300, 1e-300], [1e308, 0.5],
  [1.7976931348623157e308, 1e308], [5e-324, 5e-324],
  // negative zero
  [-0, 5], [-0, 0.1], [-0, -1e-15], [0, 1e-300],
  // an infinite step: every finite value is a multiple
  [5, Infinity], [-5, -Infinity], [1e308, Infinity], [-0, Infinity],
  // an infinite quotient of a true multiple
  [1, 5e-324], [0.3, 5e-324],
];

describe('a form field reads multipleOf as the validator does', () => {
  it('gives the validator\'s answer on every pair, in both directions', () => {
    const pairs = [...TOOK, ...REFUSED, ...KEPT];
    assert.ok(pairs.length >= 40);
    /** @type {string[]} */
    const wrong = [];
    for (const [value, step] of pairs) {
      const errors = fieldErrors(value, step);
      const takes = validatorTakes(value, step);
      if ((errors.length === 0) !== takes || errors.some((e) => e.keyword !== 'multipleOf'))
        wrong.push(`multipleOf ${step}, ${value}: validator ${takes}, form ${JSON.stringify(errors.map((e) => e.keyword))}`);
    }
    assert.deepEqual(wrong, []);
    // the fixture holds what it names
    assert.deepEqual(TOOK.filter(([value, step]) => validatorTakes(value, step)), []);
    assert.deepEqual(REFUSED.filter(([value, step]) => !validatorTakes(value, step)), []);
  });

  it('reports the multipleOf error for 5 under 10000000', () => {
    const model = buildFormModel({ type: 'object', properties: { n: { type: 'number', multipleOf: 10000000 } } });
    assert.deepEqual(validateAllFields(model, { n: 5 }), {
      '/n': [{ keyword: 'multipleOf', params: { multipleOf: 10000000 }, msgid: 'form/multipleOf', message: 'Must be a multiple of 10000000' }],
    });
    assert.deepEqual(validateAllFields(model, { n: 20000000 }), {});
  });

  it('answers alike for an integer field', () => {
    for (const [value, step] of [[9, 10000000], [30000000, 10000000], [20000001, 10000000], [1e308, 0.5], [1e308, 3], [12391239123, 1e-8]])
      assert.equal(fieldErrors(value, step, 'integer').length === 0, validatorTakes(value, step, 'integer'), `multipleOf ${step}, ${value}`);
  });

  it('reads a step written as a number string as the validator does', () => {
    for (const step of ['2', ' 3 ', '0x10', '-0.1']) {
      const validate = validator.compile({ type: 'number', multipleOf: step });
      for (const value of [20, 3, 16, 1.5, 0.3, 0.30000000000000004])
        assert.equal(fieldErrors(value, step).length === 0, validate(value), `multipleOf ${JSON.stringify(step)}, ${value}`);
    }
  });

  it('asserts nothing under a step that bounds no number, as the validator', () => {
    // a bigint step is admitted, and asserts nothing on a number (the field check threw)
    assert.deepEqual([20, 3, 1.5].map((value) => validator.compile({ type: 'number', multipleOf: 10n })(value)), [true, true, true]);
    assert.deepEqual([20, 3, 1.5].map((value) => fieldErrors(value, 10n)), [[], [], []]);
  });

  it('asserts nothing under a step the validator refuses when the schema compiles', () => {
    for (const step of [0, -0, Number.NaN, null, true, false, [5], '', ' ', 'abc', '0', {}]) {
      assert.throws(() => validator.compile({ type: 'number', multipleOf: step }), { code: 'JK0013' }, `multipleOf ${JSON.stringify(step)}`);
      assert.deepEqual([20, 3, 1.5, 1.0000005, 0].map((value) => fieldErrors(value, step)), [[], [], [], [], []], `multipleOf ${JSON.stringify(step)}`);
    }
  });
});
