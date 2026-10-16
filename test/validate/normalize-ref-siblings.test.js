import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { compileNormalizer } from '@jarenjs/validate/normalize';
import { JarenValidator } from '@jarenjs/validate';

// Before draft 2019-09, and in a document that declares no draft, the
// validator reads a `$ref` alone: the keywords beside it apply nothing. The
// normalizer read them anyway, so a coerced, defaulted or stripped document
// meant something the validator never said: '12', which validates, became
// 12, which does not. It now reads them as the validator does, per draft.

const D07 = 'http://json-schema.org/draft-07/schema#';
const D19 = 'https://json-schema.org/draft/2019-09/schema';
const D20 = 'https://json-schema.org/draft/2020-12/schema';
const OAS = 'https://spec.openapis.org/oas/3.1/dialect/base';

/**
 * Normalize `input` under `options` and answer the output with what the
 * validator says of the input and of the output.
 */
const outcome = (schema, options, input) => {
  const validate = new JarenValidator().compile(schema);
  const out = compileNormalizer(schema, options)(input);
  return { out, input: validate(input), output: validate(out) };
};

const COERCE = { coerceTypes: true };

describe('a $ref whose siblings the validator ignores normalizes as its target alone', () => {
  for (const [name, draft] of [['a document that declares no draft', undefined], ['draft-07', D07], ['a dialect read as draft-07', OAS]]) {
    const declare = (schema) => (draft === undefined ? schema : { $schema: draft, ...schema });

    it(`${name}: a sibling type coerces nothing (was '12' -> 12, which the validator refuses)`, () => {
      assert.deepEqual(outcome(declare({ $defs: { S: { type: 'string' } }, $ref: '#/$defs/S', type: 'integer' }), COERCE, '12'),
        { out: '12', input: true, output: true });
    });

    it(`${name}: sibling properties normalize nothing (was { a: '1' } -> { a: 1 })`, () => {
      assert.deepEqual(outcome(declare({ $defs: { T: { properties: { a: { type: 'string' } } } }, $ref: '#/$defs/T', properties: { a: { type: 'integer' } } }), COERCE, { a: '1' }),
        { out: { a: '1' }, input: true, output: true });
    });

    it(`${name}: sibling items normalize nothing (was ['1'] -> [1])`, () => {
      assert.deepEqual(outcome(declare({ $defs: { A: { type: 'array', items: { type: 'string' } } }, $ref: '#/$defs/A', items: { type: 'integer' } }), COERCE, ['1']),
        { out: ['1'], input: true, output: true });
    });

    it(`${name}: a sibling allOf normalizes nothing (was '12' -> 12)`, () => {
      assert.deepEqual(outcome(declare({ $defs: { S: { type: 'string' } }, $ref: '#/$defs/S', allOf: [{ type: 'integer' }] }), COERCE, '12'),
        { out: '12', input: true, output: true });
    });

    it(`${name}: a default in sibling properties is not materialized (was {} -> { b: 1 })`, () => {
      assert.deepEqual(outcome(declare({ $defs: { O: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false } }, $ref: '#/$defs/O', properties: { b: { default: 1 } } }), { useDefaults: true }, {}),
        { out: {}, input: true, output: true });
    });

    it(`${name}: a sibling additionalProperties strips nothing (was { a: 1, b: 2 } -> { a: 1 })`, () => {
      const out = compileNormalizer(declare({ $defs: { O: { type: 'object' } }, $ref: '#/$defs/O', properties: { a: {} }, additionalProperties: false }), { removeAdditional: true })({ a: 1, b: 2 });
      assert.deepEqual(out, { a: 1, b: 2 });
    });

    it(`${name}: a default beside a property's $ref is not materialized (was {} -> { p: 5 })`, () => {
      assert.deepEqual(outcome(declare({ type: 'object', $defs: { S: { type: 'string' } }, properties: { p: { $ref: '#/$defs/S', default: 5 } } }), { useDefaults: true }, {}),
        { out: {}, input: true, output: true });
    });

    it(`${name}: a default beside the root $ref is not materialized (was undefined -> 5)`, () => {
      assert.equal(compileNormalizer(declare({ $defs: { S: { type: 'string' } }, $ref: '#/$defs/S', default: 5 }), { useDefaults: true })(undefined), undefined);
    });

    it(`${name}: a sibling type beside a $ref the normalizer cannot follow coerces nothing (was '12' -> 12)`, () => {
      assert.equal(compileNormalizer(declare({ $ref: 'https://elsewhere.test/s.json', type: 'integer' }), COERCE)('12'), '12');
    });

    it(`${name}: the target normalizes by its own keywords alone (was '12' -> 12 -> '12' by the sibling type)`, () => {
      assert.deepEqual(outcome(declare({ $defs: { N: { type: 'integer' } }, $ref: '#/$defs/N', type: 'string' }), COERCE, '12'),
        { out: 12, input: false, output: true });
    });
  }
});

describe('what read the siblings rightly still reads them', () => {
  for (const [name, draft] of [['2019-09', D19], ['2020-12', D20]]) {
    it(`${name}: sibling properties normalize beside the $ref`, () => {
      assert.deepEqual(outcome({ $schema: draft, $defs: { O: { type: 'object' } }, $ref: '#/$defs/O', properties: { a: { type: 'integer' } } }, COERCE, { a: '1' }),
        { out: { a: 1 }, input: false, output: true });
    });
    it(`${name}: a default beside a property's $ref is materialized`, () => {
      assert.deepEqual(outcome({ $schema: draft, type: 'object', $defs: { S: { type: 'string' } }, properties: { p: { $ref: '#/$defs/S', default: 'x' } } }, { useDefaults: true }, {}),
        { out: { p: 'x' }, input: true, output: true });
    });
    it(`${name}: a sibling additionalProperties strips`, () => {
      assert.deepEqual(compileNormalizer({ $schema: draft, $defs: { O: { type: 'object' } }, $ref: '#/$defs/O', properties: { a: {} }, additionalProperties: false }, { removeAdditional: true })({ a: 1, b: 2 }), { a: 1 });
    });
  }

  it('a subtree that declares 2020-12 inside an undeclared document reads its siblings', () => {
    const schema = { type: 'object', properties: { p: { $schema: D20, $defs: { O: { type: 'object' } }, $ref: '#/properties/p/$defs/O', properties: { a: { type: 'integer' } } } } };
    assert.deepEqual(compileNormalizer(schema, COERCE)({ p: { a: '1' } }), { p: { a: 1 } });
  });

  it('a reference target in a place that declares 2020-12 reads its own siblings', () => {
    const schema = { $defs: { T: { $schema: D20, $defs: { O: { type: 'object' } }, $ref: '#/$defs/T/$defs/O', properties: { a: { type: 'integer' } } } }, $ref: '#/$defs/T' };
    assert.deepEqual(compileNormalizer(schema, COERCE)({ a: '1' }), { a: 1 });
  });

  it('a property or root $ref that declares 2020-12 itself keeps the default beside it', () => {
    const S = { type: 'string' };
    assert.deepEqual(compileNormalizer({ type: 'object', properties: { p: { $schema: D20, $defs: { S }, $ref: '#/properties/p/$defs/S', default: 'x' } } }, { useDefaults: true })({}), { p: 'x' });
    assert.equal(compileNormalizer({ $schema: D20, $defs: { S }, $ref: '#/$defs/S', default: 'x' }, { useDefaults: true })(undefined), 'x');
  });

  it('a draft-07 default wrapped in allOf beside it is materialized (the draft-07 spelling)', () => {
    assert.deepEqual(outcome({ $schema: D07, type: 'object', definitions: { S: { type: 'string' } }, properties: { p: { allOf: [{ $ref: '#/definitions/S' }], default: 'x' } } }, { useDefaults: true }, {}),
      { out: { p: 'x' }, input: true, output: true });
  });

  it('trimStrings is a switch, not a keyword: it still trims at the $ref node', () => {
    const schema = { $defs: { S: { type: 'string' } }, $ref: '#/$defs/S', type: 'string' };
    assert.equal(compileNormalizer(schema, { trimStrings: (node) => node.$ref !== undefined })(' a '), 'a');
  });

  it('a $ref without siblings normalizes as before', () => {
    assert.deepEqual(compileNormalizer({ type: 'object', $defs: { N: { type: 'integer', default: 3 } }, properties: { n: { $ref: '#/$defs/N' } } }, COERCE)({ n: '2' }), { n: 2 });
  });
});
