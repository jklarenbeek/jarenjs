//@ts-check
/**
 * @file A form field refuses a bigint where the validator's `type`
 * refuses one. The field check read a bigint as the number it converts
 * to, so `validateAllFields` took `21n` under `type: 'number'` or
 * `'integer'`, where the validator's `number` and `integer` refuse every
 * bigint (only its extended `bigint` type takes one), and past 2^53 it
 * judged the bounds on the rounded number. A field whose `type` names
 * `bigint`, or that declares no `type` (a number field by its bounds),
 * still takes the bigints it took.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { buildFormModel, validateAllFields } from '@jarenjs/forms';

/** @param {object} schema @param {unknown} value */
const errorsOf = (schema, value) => validateAllFields(buildFormModel({ type: 'object', properties: { n: schema } }), { n: value })['/n'] ?? [];

/** @param {object} schema @param {unknown} value */
const validatorTakes = (schema, value) => new JarenValidator().compile(schema)(value);

/** @param {unknown} value */
const label = (value) => (typeof value === 'bigint' ? `${value}n` : JSON.stringify(value));

const BIGINTS = [21n, 0n, -5n, 2n ** 53n + 1n, -(2n ** 64n)];

/** Fields whose declared `type` names no `bigint`: the validator refuses every bigint. */
const REFUSING = [
  { type: 'number' },
  { type: 'integer' },
  { type: ['number', 'null'] },
  { type: ['null', 'integer'] },
  { type: 'number', nullable: true },
  { anyOf: [{ type: 'number' }, { type: 'null' }] },
  { oneOf: [{ type: 'integer' }, { type: 'null' }] },
  { type: 'integer', maximum: 2 ** 53 },
  { type: 'number', minimum: -(2 ** 70), maximum: 2 ** 70 },
];

/** Fields that take a bigint as before: a `type` that names `bigint`, or none. */
const TAKING = [
  { type: ['number', 'bigint'] },
  { type: ['integer', 'bigint'] },
  { type: ['bigint', 'null'], minimum: -(2 ** 70) },
  { minimum: -(2 ** 70) },
];

describe('a form field refuses a bigint where the validator\'s type does', () => {
  it('refuses every bigint under a type that names no bigint, as the validator does', () => {
    /** @type {string[]} */
    const wrong = [];
    for (const schema of REFUSING) {
      for (const value of BIGINTS) {
        const errors = errorsOf(schema, value);
        const takes = validatorTakes(schema, value);
        if (takes || JSON.stringify(errors.map((e) => [e.keyword, e.params])) !== '[["type",{"type":"number"}]]')
          wrong.push(`${JSON.stringify(schema)} ${label(value)}: validator ${takes}, form ${JSON.stringify(errors.map((e) => e.keyword))}`);
      }
    }
    assert.deepEqual(wrong, []);
  });

  it('takes a bigint under a type that names bigint, or under no type, as the validator does', () => {
    /** @type {string[]} */
    const wrong = [];
    for (const schema of TAKING) {
      for (const value of BIGINTS) {
        const errors = errorsOf(schema, value);
        const takes = validatorTakes(schema, value);
        if (!takes || errors.length > 0)
          wrong.push(`${JSON.stringify(schema)} ${label(value)}: validator ${takes}, form ${JSON.stringify(errors.map((e) => e.keyword))}`);
      }
    }
    assert.deepEqual(wrong, []);
  });

  it('reports the type error for 21n under type number, and judges a number there as before', () => {
    const model = buildFormModel({ type: 'object', properties: { n: { type: 'number', minimum: 0 } } });
    assert.deepEqual(validateAllFields(model, { n: 21n }), {
      '/n': [{ keyword: 'type', params: { type: 'number' }, msgid: 'form/type', message: 'Must be a number' }],
    });
    assert.deepEqual(validateAllFields(model, { n: 21 }), {});
    assert.deepEqual(validateAllFields(model, { n: -1 }), {
      '/n': [{ keyword: 'minimum', params: { limit: 0 }, msgid: 'form/minimum', message: 'Must be at least 0' }],
    });
  });

  it('compares a bigint the field takes with a bigint bound, the boolean beside it read as the validator does', () => {
    for (const [schema, value, keyword] of /** @type {[object, bigint, string][]} */ ([
      [{ minimum: 5n }, 1n, 'minimum'],
      [{ minimum: 5n, exclusiveMinimum: true }, 5n, 'exclusiveMinimum'],
      [{ type: ['number', 'bigint'], maximum: 10n, exclusiveMaximum: true }, 10n, 'exclusiveMaximum'],
    ])) {
      assert.equal(validatorTakes(schema, value), false);
      assert.deepEqual(errorsOf(schema, value).map((e) => e.keyword), [keyword], `${JSON.stringify(schema, (k, x) => (typeof x === 'bigint' ? `${x}n` : x))} ${value}n`);
    }
    assert.equal(validatorTakes({ minimum: 5n, exclusiveMinimum: false }, 5n), true);
    assert.deepEqual(errorsOf({ minimum: 5n, exclusiveMinimum: false }, 5n), []);
  });

  it('no longer judges a rounded bigint past 2^53 within an integer bound', () => {
    const schema = { type: 'integer', maximum: 2 ** 53 };
    assert.equal(validatorTakes(schema, 2n ** 53n + 1n), false);
    assert.deepEqual(errorsOf(schema, 2n ** 53n + 1n).map((e) => e.keyword), ['type']);
  });
});
