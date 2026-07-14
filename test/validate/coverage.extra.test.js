import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  JarenValidator,
  ValidatorOptions,
} from '@jarenjs/validate';

import {
  stringFormats,
  dateTimeFormats,
} from '@jarenjs/formats';

// Targets validator code paths that the official JSON-Schema-Test-Suite and
// the keyword-focused unit tests do not reach: error-collecting object
// validators, non-grapheme string fast paths, combined constraint chains,
// the data keyword, and runtime dynamic-anchor registration through $ref.

const newErrorCompiler = () => new JarenValidator(new ValidatorOptions({ collectErrors: true }));

describe('Object validators in error-collecting mode', function () {
  it('should validate minProperties, maxProperties and required together', function () {
    const validate = newErrorCompiler().compile({
      type: 'object',
      minProperties: 1,
      maxProperties: 3,
      required: ['a'],
    });

    assert.isTrue(validate({ a: 0 }).valid);
    assert.isTrue(validate({ a: 0, b: 1, c: 2 }).valid);
    assert.isFalse(validate({}).valid, 'empty object misses minProperties and required');
    assert.isFalse(validate({ a: 0, b: 1, c: 2, d: 3 }).valid, 'four properties exceed maxProperties');

    const missing = validate({ b: 1 });
    assert.isFalse(missing.valid, 'the required property is absent');
    assert.isTrue(missing.errors.some((err) => err.keyword === 'required'));
  });

  it('should validate minProperties combined with required', function () {
    const validate = newErrorCompiler().compile({
      type: 'object',
      minProperties: 2,
      required: ['a'],
    });

    assert.isTrue(validate({ a: 0, b: 1 }).valid);
    assert.isFalse(validate({ a: 0 }).valid, 'one property is below minProperties');
    assert.isFalse(validate({ b: 1, c: 2 }).valid, 'the required property is absent');
  });

  it('should validate maxProperties combined with required', function () {
    const validate = newErrorCompiler().compile({
      type: 'object',
      maxProperties: 2,
      required: ['a'],
    });

    assert.isTrue(validate({ a: 0, b: 1 }).valid);
    assert.isFalse(validate({ a: 0, b: 1, c: 2 }).valid, 'three properties exceed maxProperties');
    assert.isFalse(validate({ b: 1 }).valid, 'the required property is absent');
  });

  it('should validate patternProperties while collecting errors', function () {
    const validate = newErrorCompiler().compile({
      type: 'object',
      patternProperties: {
        '^S_': { type: 'string' },
        '^I_': { type: 'integer' },
      },
    });

    assert.isTrue(validate({ S_name: 'jaren', I_count: 3 }).valid);

    const result = validate({ S_name: 42 });
    assert.isFalse(result.valid, 'S_ properties must be strings');
    assert.isTrue(result.errors.length > 0);
  });

  it('should validate an additionalProperties schema while collecting errors', function () {
    const validate = newErrorCompiler().compile({
      type: 'object',
      properties: { a: { type: 'number' } },
      additionalProperties: { type: 'string' },
    });

    assert.isTrue(validate({ a: 1, b: 'extra' }).valid);
    assert.isFalse(validate({ a: 1, b: 2 }).valid, 'additional properties must be strings');
  });
});

describe('String fast paths', function () {
  const byteCompiler = new JarenValidator(new ValidatorOptions({ useGrapheme: false }));

  it('should validate maxLength without grapheme counting', function () {
    const validate = byteCompiler.compile({ type: 'string', maxLength: 3 });
    assert.isTrue(validate('abc'));
    assert.isFalse(validate('abcd'));
    assert.isFalse(validate(42), 'the type keyword rejects non-strings');
  });

  it('should validate minLength without grapheme counting', function () {
    const validate = byteCompiler.compile({ type: 'string', minLength: 2 });
    assert.isTrue(validate('ab'));
    assert.isFalse(validate('a'));
    assert.isFalse(validate(42), 'the type keyword rejects non-strings');
  });

  it('should validate single-keyword length schemas without grapheme counting', function () {
    const validateMin = byteCompiler.compile({ minLength: 2 });
    assert.isTrue(validateMin('ab'));
    assert.isFalse(validateMin('a'));

    const validateMax = byteCompiler.compile({ maxLength: 3 });
    assert.isTrue(validateMax('abc'));
    assert.isFalse(validateMax('abcd'));
  });

  it('should validate pattern combined with length constraints', function () {
    const compiler = new JarenValidator();
    const validate = compiler.compile({
      type: 'string',
      minLength: 2,
      maxLength: 5,
      pattern: '^a',
    });

    assert.isTrue(validate('ab'));
    assert.isFalse(validate('a'), 'too short');
    assert.isFalse(validate('abcdef'), 'too long');
    assert.isFalse(validate('ba'), 'pattern requires a leading a');
  });
});

describe('Number constraint chains', function () {
  it('should validate minimum, maximum and multipleOf together', function () {
    const validate = new JarenValidator().compile({
      minimum: 0,
      maximum: 100,
      multipleOf: 5,
    });

    assert.isTrue(validate(50));
    assert.isTrue(validate(0));
    assert.isFalse(validate(-5), 'below minimum');
    assert.isFalse(validate(105), 'above maximum');
    assert.isFalse(validate(3), 'not a multiple of 5');
    assert.isTrue(validate('x'), 'non-numbers are ignored');
  });
});

describe('Array validator combinations', function () {
  const compiler = new JarenValidator();

  it('should validate arrays where items must be arrays', function () {
    const validate = compiler.compile({ items: { type: 'array' } });
    assert.isTrue(validate([[1], []]));
    assert.isFalse(validate([[1], 2]));
  });

  it('should validate arrays where items must be objects', function () {
    const validate = compiler.compile({ items: { type: 'object' } });
    assert.isTrue(validate([{}, { a: 1 }]));
    assert.isFalse(validate([[]]), 'arrays are not objects');
    assert.isFalse(validate([null]), 'null is not an object');
  });

  it('should validate arrays with a required-only item schema', function () {
    const validate = compiler.compile({ items: { required: ['id'] } });
    assert.isTrue(validate([{ id: 1 }, { id: 2, name: 'x' }]));
    assert.isFalse(validate([{ id: 1 }, {}]));
    assert.isTrue(validate([1, 'a']), 'required ignores non-objects');
  });

  it('should combine primitives, boolean contains and item schemas', function () {
    const validate = compiler.compile({
      minItems: 1,
      contains: true,
      items: { type: 'number' },
    });

    assert.isTrue(validate([1, 2]));
    assert.isFalse(validate([]), 'minItems and contains require at least one item');
    assert.isFalse(validate(['a']), 'items must be numbers');
    assert.isTrue(validate('not-an-array'), 'non-arrays are ignored');
  });

  it('should treat items:true as evaluating every item for unevaluatedItems', function () {
    const validate = compiler.compile({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      items: true,
      unevaluatedItems: false,
    });
    assert.isTrue(validate([1, 'two', null]));
    assert.isTrue(validate([]));

    // Sanity check: without an evaluating keyword the same data fails
    const validateNone = compiler.compile({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      unevaluatedItems: false,
    });
    assert.isFalse(validateNone([1]));
  });
});

describe('The data keyword', function () {
  const compiler = new JarenValidator();
  compiler.addFormats(stringFormats);

  it('should resolve a format name from the instance data', function () {
    const validate = compiler.compile({
      type: 'object',
      properties: {
        fmt: { type: 'string' },
        v: { type: 'string', data: { format: '/fmt' } },
      },
    });

    assert.isTrue(validate({ fmt: 'email', v: 'user@example.com' }));
    assert.isFalse(validate({ fmt: 'email', v: 'not-an-email' }));
    assert.isTrue(validate({ v: 'anything' }), 'a missing format reference asserts nothing');
    assert.isTrue(validate({ fmt: 'no-such-format', v: 'anything' }), 'unknown formats assert nothing');
  });

  it('should resolve relative JSON pointers', function () {
    const validate = compiler.compile({
      type: 'object',
      properties: {
        min: { type: 'number' },
        val: { type: 'number', data: { minimum: '1/min' } },
      },
    });

    assert.isTrue(validate({ min: 5, val: 10 }));
    assert.isFalse(validate({ min: 5, val: 3 }), 'val is below the referenced minimum');
    assert.isTrue(validate({ val: 3 }), 'a missing reference target asserts nothing');
  });

  it('should chain multiple data constraints on one schema', function () {
    const validate = compiler.compile({
      type: 'object',
      properties: {
        min: { type: 'number' },
        max: { type: 'number' },
        v: { type: 'string', data: { minLength: '/min', maxLength: '/max' } },
      },
    });

    assert.isTrue(validate({ min: 2, max: 4, v: 'abc' }));
    assert.isFalse(validate({ min: 2, max: 4, v: 'a' }), 'below the referenced minLength');
    assert.isFalse(validate({ min: 2, max: 4, v: 'abcde' }), 'above the referenced maxLength');
  });
});

describe('$data references', function () {
  const compiler = new JarenValidator();
  compiler.addFormats(stringFormats);

  it('should toggle uniqueItems through a $data reference', function () {
    const validate = compiler.compile({
      type: 'object',
      properties: {
        list: { type: 'array', uniqueItems: { $data: '1/unique' } },
        unique: { type: 'boolean' },
      },
    });

    assert.isTrue(validate({ list: [1, 2, 3], unique: true }));
    assert.isFalse(validate({ list: [1, 1], unique: true }));
    assert.isTrue(validate({ list: [1, 1], unique: false }), 'uniqueness is not requested');
  });

  it('should resolve a format name through a $data reference', function () {
    const validate = compiler.compile({
      type: 'object',
      properties: {
        fmt: { type: 'string' },
        v: { type: 'string', format: { $data: '1/fmt' } },
      },
    });

    assert.isTrue(validate({ fmt: 'email', v: 'user@example.com' }));
    assert.isFalse(validate({ fmt: 'email', v: 'not-an-email' }));
  });
});

describe('Date and time formats', function () {
  it('should validate the duration format while collecting errors', function () {
    const compiler = newErrorCompiler();
    compiler.addFormats(dateTimeFormats);
    const validate = compiler.compile({ format: 'duration' });

    assert.isTrue(validate('P1Y2M3DT4H5M6S').valid);
    assert.isTrue(validate('P1W').valid);
    assert.isTrue(validate(42).valid, 'non-strings are ignored');

    const result = validate('P');
    assert.isFalse(result.valid);
    assert.isTrue(result.errors.some((err) => err.keyword === 'format'));
  });

  it('should validate the iso-date-time format', function () {
    const compiler = new JarenValidator();
    compiler.addFormats(dateTimeFormats);
    const validate = compiler.compile({ format: 'iso-date-time' });

    assert.isTrue(validate('2024-01-15T12:30:00Z'));
    assert.isTrue(validate('2024-01-15T12:30:00'), 'the timezone is optional');
    assert.isFalse(validate('2024-13-15T12:30:00'), 'month 13 does not exist');
  });

  it('should validate the iso-time format', function () {
    const compiler = new JarenValidator();
    compiler.addFormats(dateTimeFormats);
    const validate = compiler.compile({ format: 'iso-time' });

    assert.isTrue(validate('12:30:00Z'));
    assert.isTrue(validate('12:30:00'), 'the timezone is optional');
    assert.isFalse(validate('25:00:00'), 'hour 25 does not exist');
  });

  it('should validate string formats while collecting errors', function () {
    const compiler = newErrorCompiler();
    compiler.addFormats(stringFormats);
    const validate = compiler.compile({ format: 'email' });

    assert.isTrue(validate('user@example.com').valid);
    const result = validate('not-an-email');
    assert.isFalse(result.valid);
    assert.isTrue(result.errors.some((err) => err.keyword === 'format'));
  });
});

describe('Dynamic anchors entered through $ref', function () {
  it('should register $dynamicAnchor targets when following a $ref', function () {
    const validate = new JarenValidator().compile({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://example.com/dyn-ref-anchor',
      type: 'object',
      properties: {
        root: { $ref: '#/$defs/tree' },
      },
      $defs: {
        tree: {
          $dynamicAnchor: 'node',
          type: 'object',
          properties: {
            children: { type: 'array', items: { $dynamicRef: '#node' } },
          },
        },
      },
    });

    assert.isTrue(validate({ root: { children: [{ children: [] }] } }));
    assert.isFalse(validate({ root: { children: ['not-a-node'] } }));
  });

  it('should register $dynamicAnchor targets for a $ref with sibling keywords', function () {
    const validate = new JarenValidator().compile({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://example.com/dyn-ref-anchor-siblings',
      type: 'object',
      properties: {
        root: { $ref: '#/$defs/tree', type: 'object' },
      },
      $defs: {
        tree: {
          $dynamicAnchor: 'node',
          type: 'object',
          properties: {
            children: { type: 'array', items: { $dynamicRef: '#node' } },
          },
        },
      },
    });

    assert.isTrue(validate({ root: { children: [{ children: [] }] } }));
    assert.isFalse(validate({ root: { children: [42] } }));
  });

  it('should register $recursiveAnchor targets when following a $ref', function () {
    const validate = new JarenValidator().compile({
      $schema: 'https://json-schema.org/draft/2019-09/schema',
      $id: 'https://example.com/rec-ref-anchor',
      type: 'object',
      properties: {
        root: { $ref: '#/$defs/tree' },
      },
      $defs: {
        tree: {
          $recursiveAnchor: true,
          type: 'object',
          properties: {
            children: { type: 'array', items: { $recursiveRef: '#' } },
          },
        },
      },
    });

    assert.isTrue(validate({ root: { children: [{ children: [] }] } }));
    assert.isFalse(validate({ root: { children: ['not-a-node'] } }));
  });
});

describe('JarenValidator meta-schema API', function () {
  it('should expose the errors of the last validation on the validator', function () {
    const validate = new JarenValidator().compile({ type: 'number' });
    validate('not a number');
    assert.isTrue(Array.isArray(validate.errors));
  });

  it('should validate schemas against a registered meta-schema', async function () {
    const { getSchemaDraftByVersion } = await import('@jarenjs/refs');
    const draft7 = getSchemaDraftByVersion(7);

    const compiler = new JarenValidator();
    compiler.addMetaSchema(draft7.schema[0]);

    assert.isTrue(compiler.validateSchema({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'string',
    }));
    assert.isFalse(compiler.validateSchema({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 42,
    }), 'a numeric type keyword is not a valid schema');
    assert.isFalse(compiler.validateSchema({
      $schema: 'https://example.com/unknown-meta',
    }), 'unknown meta-schemas fail schema validation');
  });

  it('should retrieve registered schemas by key', async function () {
    const { getSchemaDraftByVersion } = await import('@jarenjs/refs');
    const draft7 = getSchemaDraftByVersion(7);

    const compiler = new JarenValidator();
    compiler.addMetaSchema(draft7.schema[0]);

    assert.isTrue(compiler.getSchema('http://json-schema.org/draft-07/schema#') != null);
    assert.isTrue(compiler.getSchema('https://example.com/never-registered') === null);
  });
});
