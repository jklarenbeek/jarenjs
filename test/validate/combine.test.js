import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  JarenValidator,
} from '@jarenjs/validate';

const compiler = new JarenValidator();

describe('Schema Combinations', function () {
  describe('#allOf()', function () {
    // https://json-schema.org/understanding-json-schema/reference/combining.html
    it('should  be string with maxLength 5', function () {
      const validate = compiler.compile({
        allOf: [
          { type: 'string' },
          { maxLength: 5 },
        ],
      });

      assert.isTrue(validate('short'), 'some short value');
      assert.isFalse(validate('too long'), 'something to long');
      assert.isFalse(validate(42), 'a number is invalid');
    });

    it('should be an invalid string and number', function () {
      const validate = compiler.compile({
        allOf: [
          { type: 'string' },
          { type: 'number' },
        ],
      });

      assert.isFalse(validate('Yes Way'), 'a string will not validate');
      assert.isFalse(validate(42), 'a number will not validate');
      assert.isFalse(validate([]), 'an array will not validate');
      assert.isFalse(validate({}), 'an object will not validate either');
    });

    // https://github.com/json-schema-org/JSON-Schema-Test-Suite/blob/master/tests/draft7/allOf.json
    it('should validate multiple properties from different objects', function () {
      const validate = compiler.compile({
        allOf: [
          {
            properties: {
              bar: { type: 'integer' },
            },
            required: ['bar'],
          },
          {
            properties: {
              foo: { type: 'string' },
            },
            required: ['foo'],
          },
        ],
      });

      assert.isTrue(validate({ foo: 'baz', bar: 2 }), 'both properties are required');
      assert.isFalse(validate({ foo: 'baz' }), 'missing second property');
      assert.isFalse(validate({ bar: 2 }), 'missing first property');
      assert.isFalse(validate({ foo: 'baz', bar: 'quux' }), 'wong type second property');
    });

    it('should validate allOf with base schema', function () {
      const validate = compiler.compile({
        properties: { bar: { type: 'integer' } },
        required: ['bar'],
        allOf: [
          {
            properties: {
              foo: { type: 'string' },
            },
            required: ['foo'],
          },
          {
            properties: {
              baz: { type: 'null' },
            },
            required: ['baz'],
          },
        ],
      });

      assert.isTrue(validate({ foo: 'quux', bar: 2, baz: null }), 'all properties available');
      assert.isFalse(validate({ foo: 'quux', baz: null }), 'missing property base schema');
      assert.isFalse(validate({ bar: 2, baz: null }), 'missing first allOf');
      assert.isFalse(validate({ foo: 'quux', bar: 2 }), 'mismatch second allOf');
      assert.isFalse(validate({ bar: 2 }), 'mismatch both allOf\'s');
    });

    it('should validate allOf with simple type constraints', function () {
      const validate = compiler.compile({
        allOf: [
          { maximum: 30 },
          { minimum: 20 },
        ],
      });

      assert.isTrue(validate(25), '25 is between 20 and 30');
      assert.isFalse(validate(35), '35 is higher then 30');
    });

    it('should validate with boolean schemas, all true', function () {
      const validate = compiler.compile({
        allOf: [true, true],
      });

      assert.isTrue(validate('foo'), 'any value is valid');
    });

    it('should validate with boolean schemas, some false', function () {
      const validate = compiler.compile({
        allOf: [true, false],
      });

      assert.isFalse(validate('foo'), 'any value is invalid');
    });

    it('should validate with boolean schemas, all false', function () {
      const validate = compiler.compile({
        allOf: [false, false],
      });

      assert.isFalse(validate('foo'), 'any value is invalid');
    });

    it('should validate with one empty schema', function () {
      const validate = compiler.compile({
        allOf: [{}],
      });

      assert.isTrue(validate(1), 'any value is valid');
    });

    it('should validate with two empty schemas', function () {
      const validate = compiler.compile({
        allOf: [{}, {}],
      });

      assert.isTrue(validate(1), 'any value is valid');
    });

    it('should validate with first empty schemas', function () {
      const validate = compiler.compile({
        allOf: [
          {},
          { type: 'number' },
        ],
      });

      assert.isTrue(validate(1), 'number is valid');
      assert.isFalse(validate('foo'), 'string is invalid');
    });

    it('should validate with last empty schemas', function () {
      const validate = compiler.compile({
        allOf: [
          { type: 'number' },
          {},
        ],
      });

      assert.isTrue(validate(1), 'number is valid');
      assert.isFalse(validate('foo'), 'string is invalid');
    });

  });

  describe('#anyOf()', function () {
    it('should be valid against any (one or more) of the given subschemas.', function () {
      const validate = compiler.compile({
        anyOf: [
          { type: 'string' },
          { type: 'number' },
        ],
      });

      assert.isTrue(validate('Yes'), 'a string works');
      assert.isTrue(validate(42), 'a number works');
      assert.isFalse(validate({ 'an object': 'doesnt work' }));
    });

    // https://github.com/json-schema-org/JSON-Schema-Test-Suite/blob/master/tests/draft7/anyOf.json
    it('should validate an integer or number of minimum 2', function () {
      const validate = compiler.compile({
        anyOf: [
          { type: 'integer' },
          { minimum: 2 },
        ],
      });

      assert.isTrue(validate(1), 'first anyOf is valid');
      assert.isTrue(validate(2.5), 'second anyOf is valid');
      assert.isTrue(validate(3), 'both anyOf are valid');
      assert.isFalse(validate(1.5), 'neither anyOf is valid');
    });

    it('should validate anyOf with base schema', function () {
      const validate = compiler.compile({
        type: 'string',
        anyOf: [
          { maxLength: 2 },
          { minLength: 4 },
        ],
      });

      assert.isFalse(validate(3), 'mismatch base schema');
      assert.isTrue(validate('foobar'), 'one anyOf is valid');
      assert.isFalse(validate('foo'), 'both anyOf are invalid');
    });

    it('should validate with boolean schemas, all true', function () {
      const validate = compiler.compile({
        anyOf: [true, true],
      });

      assert.isTrue(validate('foo'), 'any value is valid');
    });

    it('should validate with boolean schemas, some false', function () {
      const validate = compiler.compile({
        anyOf: [true, false],
      });

      assert.isTrue(validate('foo'), 'any value is valid');
    });

    it('should validate with boolean schemas, all false', function () {
      const validate = compiler.compile({
        anyOf: [false, false],
      });

      assert.isFalse(validate('foo'), 'any value is invalid');
    });

    it('should validate anyOf complex types', function () {
      const validate = compiler.compile({
        anyOf: [
          {
            properties: {
              bar: { type: 'integer' },
            },
            required: ['bar'],
          },
          {
            properties: {
              foo: { type: 'string' },
            },
            required: ['foo'],
          },
        ],
      });

      assert.isTrue(validate({ bar: 2 }), 'first anyOf valid (complex)');
      assert.isTrue(validate({ foo: 'baz' }), 'second anyOf valid (complex)');
      assert.isTrue(validate({ foo: 'baz', bar: 2 }), 'both anyOf valid (complex)');
      assert.isFalse(validate({ foo: 2, bar: 'quux' }), 'neither anyOf valid (complex)');

    });

    it('should validate anyOf with one empty schema', function () {
      const validate = compiler.compile({
        anyOf: [
          { type: 'number' },
          { },
        ],
      });

      assert.isTrue(validate('foobar'), 'string is valid');
      assert.isTrue(validate(1234), 'number is valid');
    });

    it('should validate nested anyOf to check symantics', function () {
      const validate = compiler.compile({
        anyOf: [
          {
            anyOf: [{ type: 'null' }],
          },
        ],
      });

      assert.isTrue(validate(undefined), 'undefined is valid');
      assert.isTrue(validate(null), 'null is valid');
      assert.isFalse(validate(1234), 'anything non-null and number is invalid');
      assert.isFalse(validate('foo'), 'anything non-null and string is invalid');
      assert.isFalse(validate(['foo']), 'anything non-null and array is invalid');
      assert.isFalse(validate({ foo: 'baz' }), 'anything non-null and object is invalid');

    });
  });

  describe('#oneOf()', function () {
    it('should be valid against exactly one of the given subschemas.', function () {
      const validate = compiler.compile({
        type: 'number',
        oneOf: [
          { multipleOf: 5 },
          { multipleOf: 3 },
        ],
      });

      assert.isTrue(validate(10), 'multiple of 5');
      assert.isTrue(validate(9), 'multiple of 3');
      assert.isFalse(validate(2), '2 is not a multiple of 5 or 3');
      assert.isFalse(validate(15), 'multiple of 5 and 3 is rejected');

    });

    it('should validate or a integer or any above 2', function () {
      const validate = compiler.compile({
        oneOf: [
          { type: 'integer' },
          { minimum: 2 },
        ],
      });

      assert.isTrue(validate(1), 'one is an integer');
      assert.isTrue(validate(2.5), 'two point five >= two');
      assert.isFalse(validate(3), 'both schemas are invalid');
      assert.isFalse(validate(1.5), 'neither schema is valid');
    });

    it('should validate with a base schema', function () {
      const validate = compiler.compile({
        type: 'string',
        oneOf: [
          { minLength: 2 },
          { maxLength: 4 },
        ],
      });

      assert.isFalse(validate(3), 'mismatch base schema');
      assert.isTrue(validate('foobar'), 'one oneOf schema is valid');
      assert.isFalse(validate('foo'), 'both oneOf schemas cannot be valid');
    });

    it('should validate with boolean schemas, all true', function () {
      const validate = compiler.compile({
        oneOf: [true, true, true],
      });

      assert.isFalse(validate('foo'), 'any value is invalid');
    });

    it('should validate with boolean schemas, some false', function () {
      const validate = compiler.compile({
        oneOf: [true, true, false],
      });

      assert.isFalse(validate('foo'), 'any value is invalid');
    });

    it('should validate with boolean schemas, most false', function () {
      const validate = compiler.compile({
        oneOf: [true, false, false],
      });

      assert.isTrue(validate('foo'), 'any value is valid');
    });

    it('should validate with boolean schemas, all false', function () {
      const validate = compiler.compile({
        oneOf: [false, false, false],
      });

      assert.isFalse(validate('foo'), 'any value is invalid');
    });

    it('should validate complex types', function () {
      const validate = compiler.compile({
        oneOf: [{
          properties: {
            bar: { type: 'integer' },
          },
          required: ['bar'],
        },
        {
          properties: {
            foo: { type: 'string' },
          },
          required: ['foo'],
        }],
      });

      assert.isTrue(validate({ bar: 2 }), 'first oneOf valid (complex)');
      assert.isTrue(validate({ foo: 'baz' }), 'second oneOf valid (complex)');
      assert.isFalse(validate({ foo: 'baz', bar: 2 }), 'both oneOf are invalid (complex)');
      assert.isFalse(validate({ foo: 2, bar: 'quux' }), 'neither oneOf are valid');
    });

    it('should validate oneOf with one empty schema', function () {
      const validate = compiler.compile({
        oneOf: [
          { type: 'number' },
          { },
        ],
      });

      assert.isTrue(validate('foobar'), 'string is valid');
      assert.isFalse(validate(1234), 'both oneOf is invalid');
    });

    it('should validate oneOf with required', function () {
      const validate = compiler.compile({
        type: 'object',
        oneOf: [
          { required: ['foo', 'bar'] },
          { required: ['foo', 'baz'] },
        ],
      });

      assert.isFalse(validate({ bar: 2 }), 'one property is both invalid');
      assert.isTrue(validate({ foo: 1, bar: 2 }), 'first oneOf valid');
      assert.isTrue(validate({ foo: 3, baz: 4 }), 'second oneOf valid');
      assert.isFalse(validate({ foo: 1, bar: 2, baz: 3 }), 'both oneOf match is invalid');
    });
  });

  describe('#not()', function () {
    it('should validate against anything that is not a string', function () {
      const validate = compiler.compile({
        not: { type: 'string' },
      });

      assert.isTrue(validate(42), 'validates against a number');
      assert.isTrue(validate({ key: 'value' }), 'validates against an object');
      assert.isFalse(validate('this is a string'), 'fails against a string');
    });

    it('should not validate integer types', function () {
      const validate = compiler.compile({
        not: { type: 'integer' },
      });

      assert.isTrue(validate('foo'), 'a string is valid');
      assert.isFalse(validate(1), 'cannot allow an integer');
    });

    it('should not validate integer and boolean types', function () {
      const validate = compiler.compile({
        not: { type: ['integer', 'boolean'] },
      });

      assert.isTrue(validate(undefined), 'undefined is allowed (questionable)');
      assert.isTrue(validate(null), 'null is allowed');
      assert.isTrue(validate('foo'), 'string is neither boolean nor string');
      assert.isFalse(validate(1), 'integer is not allowed');
      assert.isFalse(validate(true), 'boolean is not allowed');
      assert.isTrue(validate(Math.PI), 'validates for a float like Math.PI');
    });

    it('should not allow objects with property foo of type string', function () {
      const validate = compiler.compile({
        not: {
          type: 'object',
          properties: {
            foo: { type: 'string' },
          },
        },
      });

      assert.isTrue(validate(1), 'numbers are allowed');
      assert.isTrue(validate({ foo: 5 }), 'property foo with numbers is allowed');
      assert.isFalse(validate({ foo: 'bar' }), 'property foo with strings is invalid');
    });

    it('should not allow forbidden properties', function () {
      const validate = compiler.compile({
        properties: {
          foo: { not: {} },
        },
      });

      assert.isFalse(validate({ foo: 1, bar: 2 }), 'foo cannot be present');
      assert.isTrue(validate({ bar: 3, baz: 4 }), 'foo is not present');
    });

    it('should not validate with boolean schema true', function () {
      const validate = compiler.compile({
        not: true,
      });

      assert.isFalse(validate('foo'), 'any value is invalid');
    });

    it('should validate with boolean schema false', function () {
      const validate = compiler.compile({
        not: false,
      });

      assert.isTrue(validate('foo'), 'any value is valid');
    });

    it('all should be equivalent to contains', function () {
      // https://ajv.js.org/keywords.html#contains
      const validate = compiler.compile({
        allOf: [
          {
            type: 'array',
            contains: {
              type: 'number',
            },
          },
          {
            not: {
              type: 'array',
              items: { not: { type: 'integer' } },
            },
          },
        ],
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isFalse(validate(null), 'null is not allowed');
      assert.isFalse(validate({}), 'object is invalid');
      assert.isFalse(validate(new Map([['a', 1]])), 'map is invalid');
      assert.isFalse(validate('validate this'), 'string is invalid');
      assert.isFalse(validate([]), 'an empty array is invalid');
      assert.isTrue(validate([1]), 'A single number is valid');
      assert.isTrue(validate([1, 2, 3, 4, 5]), 'All numbers is also okay');
      assert.isFalse(validate([1.1, 2.2, 3.3, 4.4, 5.5]), 'fractional numbers are not ok');
      assert.isTrue(validate([1, 'foo']), 'a single number as first item is valid');
      assert.isTrue(validate(['life', 'universe', 'everything', 42]), 'A single number is enough to make this pass');
      assert.isFalse(validate(['life', 'universe', 'everything', 'forty-two']), 'But if we have no number, it fails');

    });
  });

  describe('#combineAll()', function () {
    it('should be able to have two compount operators', function () {
      const validate = compiler.compile({
        oneOf: [
          { type: 'string' },
          { type: 'integer' },
        ],
        anyOf: [
          { type: 'string' },
          { type: 'integer' },
        ],
      });

      assert.isTrue(validate(1), 'an integer is valid');
      assert.isTrue(validate('some string'), 'a string is valid');
      assert.isFalse(validate(1.2), 'a float is invalid');
    });
    it('should be able to have three compount operators', function () {
      const validate = compiler.compile({
        oneOf: [
          { type: 'string' },
          { type: 'integer' },
        ],
        anyOf: [
          { type: 'string' },
          { type: 'integer' },
        ],
        not: { type: 'boolean' },
      });

      assert.isTrue(validate(1), 'an integer is valid');
      assert.isTrue(validate('some string'), 'a string is valid');
      assert.isFalse(validate(1.2), 'a float is invalid');
      assert.isFalse(validate(true), 'a boolean is explicitly forbidden');
    });

  });
});
