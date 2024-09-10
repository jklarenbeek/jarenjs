import { describe, it } from 'node:test';
import * as assert from '@jaren/tools/assert';

import {
  compileSchemaValidator,
} from '@jaren/validate';


// https://json-schema.org/understanding-json-schema/reference/type.html

describe('JSON Schema Types', function () {
  describe('#types()', function () {
    it('should validate a boolean true schema', function () {
      const root = compileSchemaValidator(true);
      assert.isTrue(root.validate(undefined), 'undefined value is valid');
      assert.isTrue(root.validate(null), 'null value is valid');
      assert.isTrue(root.validate(false), 'false value is valid');
      assert.isTrue(root.validate(3.14), 'number value is valid');
      assert.isTrue(root.validate('string'), 'string value is valid');
      assert.isTrue(root.validate([]), 'array value is valid');
      assert.isTrue(root.validate({}), 'object value is valid');
    });

    it('should validate a boolean false schema', function () {
      const root = compileSchemaValidator(false);
      assert.isFalse(root.validate(undefined), 'undefined value is invalid');
      assert.isFalse(root.validate(null), 'null value is invalid');
      assert.isFalse(root.validate(true), 'true value is invalid');
      assert.isFalse(root.validate(3.14), 'number value is invalid');
      assert.isFalse(root.validate('string'), 'string value is invalid');
      assert.isFalse(root.validate([]), 'array value is invalid');
      assert.isFalse(root.validate({}), 'object value is invalid');
    });

    it('should error on invalid schema types', function () {
      assert.throws(() => compileSchemaValidator({ type: 'untinkable' }));
      assert.throws(() => compileSchemaValidator({ type: ['what', 'are', 'you', 'thinking'] }));
      assert.throws(() => compileSchemaValidator({ type: [] }));
      assert.throws(() => compileSchemaValidator([]));
    });

    it('should validate type: \'number\'', function () {
      const root = compileSchemaValidator({ type: 'number' });

      assert.isTrue(root.validate(undefined), 'undefined is always true!');
      assert.isFalse(root.validate(null), 'null is not a number');
      assert.isTrue(root.validate(42), 'validates an integer');
      assert.isTrue(root.validate(Math.PI), 'validates a float');
      assert.isFalse(root.validate('42'), 'not validates a string');
      assert.isFalse(root.validate([]), 'not validates an empty array');
      assert.isFalse(root.validate({}), 'not validates an object');
    });

    it('should validate type: \'integer\'', function () {
      const root = compileSchemaValidator({ type: 'integer' });

      assert.isTrue(root.validate(undefined), 'undefined is always true!');
      assert.isFalse(root.validate(null), 'null is not an integer');
      assert.isTrue(root.validate(42), '42 is an integer');
      assert.isFalse(root.validate(Math.PI), 'PI is not an integer');
      assert.isFalse(root.validate('42'), 'a string is not valid');
      assert.isFalse(root.validate([]), 'not validates an empty array');
      assert.isFalse(root.validate({}), 'not validates an object');
    });

    it('should validate type: \'bigint\'', function () {
      const root = compileSchemaValidator({ type: 'bigint' });

      assert.isTrue(root.validate(undefined), 'undefined is always true!');
      assert.isFalse(root.validate(null), 'null is not an bigint');
      assert.isFalse(root.validate(42), '42 is not an bigint');
      assert.isTrue(root.validate(BigInt(42)), '42n is a bigint');
      assert.isFalse(root.validate(Math.PI), 'PI is not an bigint');
      assert.isFalse(root.validate('42'), 'a string is not valid');
      assert.isFalse(root.validate([]), 'not validates an empty array');
      assert.isFalse(root.validate({}), 'not validates an object');
    });

    it('should validate type: \'string\'', function () {
      const root = compileSchemaValidator({ type: 'string' });

      assert.isTrue(root.validate(undefined), 'undefined is always true!');
      assert.isFalse(root.validate(null), 'null is not a string');
      assert.isFalse(root.validate(42), 'integer is not a string');
      assert.isFalse(root.validate(Math.PI), 'PI is not a string');
      assert.isFalse(root.validate(BigInt(42)), 'bigint is not a string');
      assert.isTrue(root.validate('this is a string'), 'this is a valid string');
      assert.isFalse(root.validate(['this', 'is', 'an', 'array']), 'this array is not a string');
      assert.isFalse(root.validate({ keyword: 'value' }), 'this object is not a string');
    });

    it('should validate type: \'null\'', function () {
      const root = compileSchemaValidator({ type: 'null' });

      assert.isFalse(root.validate(0), 'zero is not null');
      assert.isFalse(root.validate(1), 'an integer is not null');
      assert.isFalse(root.validate(Math.PI), 'a float is not null');
      assert.isFalse(root.validate('foobar'), 'string is not null');
      assert.isFalse(root.validate(''), 'an empty string is not null');
      assert.isFalse(root.validate({}), 'an object is not null');
      assert.isFalse(root.validate([]), 'an array is not null');
      assert.isFalse(root.validate(true), 'boolean true is not null');
      assert.isFalse(root.validate(false), 'boolean false is not null');
      assert.isTrue(root.validate(null), 'null equals null');
    });

    it('should validate type: \'object\'', function () {
      const root = compileSchemaValidator({ type: 'object' });

      const testObj1 = {
        key: 'value',
        another_key: 'another_value',
      };

      const testObj2 = {
        Sun: 1.9891e30,
        Jupiter: 1.8986e27,
        Saturn: 5.6846e26,
        Neptune: 10.243e25,
        Uranus: 8.6810e25,
        Earth: 5.9736e24,
        Venus: 4.8685e24,
        Mars: 6.4185e23,
        Mercury: 3.3022e23,
        Moon: 7.349e22,
        Pluto: 1.25e22,
      };

      assert.isTrue(root.validate(undefined), 'undefined is always true!');
      assert.isFalse(root.validate(null), 'not validates null!');
      assert.isTrue(root.validate({}), 'validates an empty object literal');
      assert.isTrue(root.validate(testObj1), 'validates a simple object with strings');
      assert.isTrue(root.validate(testObj2), 'validates a simple object with numbers');
      assert.isFalse(root.validate(2.99792458e8), 'not validates a float literal');
      assert.isFalse(root.validate('Is Not Valid'), 'not validates a string');
      assert.isFalse(root.validate(['is', 'not', 'an', 'object']), 'not validates an array');

    });

    it('should validate type: \'array\'', function () {
      const root = compileSchemaValidator({ type: 'array' });

      assert.isTrue(root.validate(undefined), 'undefined is always true!');
      assert.isFalse(root.validate(null), 'not validates null!');
      assert.isTrue(root.validate([]), 'validates an empty array literal');
      assert.isTrue(root.validate([1, 2, 3, 4, 5]), 'validates array of integers');
      assert.isTrue(root.validate([1, '2', null, {}, 5]), 'validates array of integers');
      assert.isTrue(root.validate([3, 'different', { types: 'of values' }]), 'validates array of objects');
      assert.isFalse(root.validate({ Not: 'an array' }), 'not an array type');
      assert.isFalse(root.validate(2.99792458e8), 'not a number type');
      assert.isFalse(root.validate('This is not valid'), 'not a string type');
    });

    it('should validate type: [\'string\']', function () {
      const root = compileSchemaValidator({ type: ['string'] });

      assert.isTrue(root.validate(undefined), 'undefined is always true!');
      assert.isFalse(root.validate(null), 'null is not a string');
      assert.isFalse(root.validate(42), 'validates an integer');
      assert.isFalse(root.validate(Math.PI), 'validates a number');
      assert.isTrue(root.validate('Math.PI'), 'validates a string');
      assert.isFalse(root.validate([42, '42']), 'does not validate an array');
      assert.isFalse(root.validate({}), 'does not validate an object');
    });

    it('should validate type: [\'integer\', \'string\']', function () {
      const root = compileSchemaValidator({ type: ['integer', 'string'] });

      assert.isTrue(root.validate(undefined), 'undefined is always true!');
      assert.isFalse(root.validate(null), 'null is not a number or string');
      assert.isTrue(root.validate(42), 'validates an integer');
      assert.isFalse(root.validate(Math.PI), 'validates a number');
      assert.isTrue(root.validate('Math.PI'), 'validates a string');
      assert.isFalse(root.validate([42, '42']), 'does not validate an array');
      assert.isFalse(root.validate({}), 'does not validate an object');
    });

    it('should validate type: [\'string\', \'integer\', \'number\']', function () {
      const root = compileSchemaValidator({ type: ['string', 'integer', 'number'] });

      assert.isTrue(root.validate(undefined), 'undefined is always true!');
      assert.isFalse(root.validate(null), 'null is not a number or string');
      assert.isTrue(root.validate(42), 'validates an integer');
      assert.isTrue(root.validate(Math.PI), 'validates a number');
      assert.isTrue(root.validate('Math.PI'), 'validates a string');
      assert.isFalse(root.validate([42, '42']), 'does not validate an array');
      assert.isFalse(root.validate({}), 'does not validate an object');
    });

    it('should validate type: [\'number\', \'string\', \'null\']', function () {
      const root = compileSchemaValidator({ type: ['number', 'string', 'null'] });

      assert.isTrue(root.validate(undefined), 'undefined is always true!');
      assert.isTrue(root.validate(null), 'null is not a number or string');
      assert.isTrue(root.validate(42), 'validates an integer');
      assert.isTrue(root.validate(Math.PI), 'validates a number');
      assert.isTrue(root.validate('Math.PI'), 'validates a string');
      assert.isFalse(root.validate([42, '42']), 'does not validate an array');
      assert.isFalse(root.validate({}), 'does not validate an object');
    });

    it('should validate type: [null, \'string\', \'integer\', \'number\']', function () {
      const root = compileSchemaValidator({ type: [null, 'string', 'integer', 'number'] });

      assert.isTrue(root.validate(undefined), 'undefined is always true!');
      assert.isTrue(root.validate(null), 'null is not a number or string');
      assert.isTrue(root.validate(42), 'validates an integer');
      assert.isTrue(root.validate(Math.PI), 'validates a number');
      assert.isTrue(root.validate('Math.PI'), 'validates a string');
      assert.isFalse(root.validate([42, '42']), 'does not validate an array');
      assert.isFalse(root.validate({}), 'does not validate an object');
    });

    it('should validate type: new Set([null, \'string\', \'integer\', \'number\'])', function () {
      const root = compileSchemaValidator({ type: new Set([null, 'string', 'integer', 'number']) });

      assert.isTrue(root.validate(undefined), 'undefined is always true!');
      assert.isTrue(root.validate(null), 'null is not a number or string');
      assert.isTrue(root.validate(42), 'validates an integer');
      assert.isTrue(root.validate(Math.PI), 'validates a number');
      assert.isTrue(root.validate('Math.PI'), 'validates a string');
      assert.isFalse(root.validate([42, '42']), 'does not validate an array');
      assert.isFalse(root.validate({}), 'does not validate an object');
    });

  });

  describe('#required()', function () {

    it('should validate type: \'number\', required: true', function () {
      const root = compileSchemaValidator({ type: 'number', required: true });

      assert.isFalse(root.validate(undefined), 'undefined returns always false!');
      assert.isFalse(root.validate(null), 'null is not a number');
      assert.isTrue(root.validate(42), 'validates an integer');
      assert.isTrue(root.validate(Math.PI), 'validates a float');
      assert.isFalse(root.validate('42'), 'not validates a string');
      assert.isFalse(root.validate([]), 'not validates an empty array');
      assert.isFalse(root.validate({}), 'not validates an object');
    });

    it('should validate type: \'integer\', required: true', function () {
      const root = compileSchemaValidator({ type: 'integer', required: true });

      assert.isFalse(root.validate(undefined), 'undefined returns always false!');
      assert.isFalse(root.validate(null), 'null is not an integer');
      assert.isTrue(root.validate(42), '42 is an integer');
      assert.isFalse(root.validate(Math.PI), 'PI is not an integer');
      assert.isFalse(root.validate('42'), 'a string is not valid');
      assert.isFalse(root.validate([]), 'not validates an empty array');
      assert.isFalse(root.validate({}), 'not validates an object');
    });

    it('should validate type: \'bigint\', required: true', function () {
      const root = compileSchemaValidator({ type: 'bigint', required: true });

      assert.isFalse(root.validate(undefined), 'undefined returns always false!');
      assert.isFalse(root.validate(null), 'null is not an bigint');
      assert.isFalse(root.validate(42), '42 is not an bigint');
      assert.isTrue(root.validate(BigInt(42)), '42n is a bigint');
      assert.isFalse(root.validate(Math.PI), 'PI is not an bigint');
      assert.isFalse(root.validate('42'), 'a string is not valid');
      assert.isFalse(root.validate([]), 'not validates an empty array');
      assert.isFalse(root.validate({}), 'not validates an object');
    });

    it('should validate type: \'string\', required: true', function () {
      const root = compileSchemaValidator({ type: 'string', required: true });

      assert.isFalse(root.validate(undefined), 'undefined returns always false!');
      assert.isFalse(root.validate(null), 'null is not a string');
      assert.isFalse(root.validate(42), 'integer is not a string');
      assert.isFalse(root.validate(Math.PI), 'PI is not a string');
      assert.isFalse(root.validate(BigInt(42)), 'bigint is not a string');
      assert.isTrue(root.validate('this is a string'), 'this is a valid string');
      assert.isFalse(root.validate(['this', 'is', 'an', 'array']), 'this array is not a string');
      assert.isFalse(root.validate({ keyword: 'value' }), 'this object is not a string');
    });

    it('should validate type: [null, \'string\'], required: true', function () {
      const root = compileSchemaValidator({ type: [null, 'string'], required: true });

      assert.isFalse(root.validate(undefined), 'undefined returns always false!');
      assert.isTrue(root.validate(null), 'null is not a string');
      assert.isFalse(root.validate(42), 'integer is not a string');
      assert.isFalse(root.validate(Math.PI), 'PI is not a string');
      assert.isFalse(root.validate(BigInt(42)), 'bigint is not a string');
      assert.isTrue(root.validate('this is a string'), 'this is a valid string');
      assert.isFalse(root.validate(['this', 'is', 'an', 'array']), 'this array is not a string');
      assert.isFalse(root.validate({ keyword: 'value' }), 'this object is not a string');
    });

  });

  describe('#nullable()', function () {
    it('should validate nullable: true', function () {
      const root = compileSchemaValidator({ nullable: true });

      assert.isTrue(root.validate(undefined), 'undefined is always true!');
      assert.isTrue(root.validate(null), 'nullable is allowed');
      assert.isTrue(root.validate(42), 'validates an integer');
      assert.isTrue(root.validate(Math.PI), 'validates a float');
      assert.isTrue(root.validate('42'), 'not validates a string');
      assert.isTrue(root.validate([]), 'not validates an empty array');
      assert.isTrue(root.validate({}), 'not validates an object');

    });

    it('should validate nullable: false', function () {
      const root = compileSchemaValidator({ nullable: false });

      assert.isTrue(root.validate(undefined), 'undefined is always true!');
      assert.isFalse(root.validate(null), 'nullable is not allowed');
      assert.isTrue(root.validate(42), 'validates an integer');
      assert.isTrue(root.validate(Math.PI), 'validates a float');
      assert.isTrue(root.validate('42'), 'not validates a string');
      assert.isTrue(root.validate([]), 'not validates an empty array');
      assert.isTrue(root.validate({}), 'not validates an object');

    });

    it('should validate type: \'number\', nullable: true', function () {
      const root = compileSchemaValidator({ type: 'number', nullable: true });

      assert.isTrue(root.validate(undefined), 'undefined is always true!');
      assert.isTrue(root.validate(null), 'nullable is allowed');
      assert.isTrue(root.validate(42), 'validates an integer');
      assert.isTrue(root.validate(Math.PI), 'validates a float');
      assert.isFalse(root.validate('42'), 'not validates a string');
      assert.isFalse(root.validate([]), 'not validates an empty array');
      assert.isFalse(root.validate({}), 'not validates an object');
    });

    it('should validate type: \'number\', nullable: true, required: true', function () {
      const root = compileSchemaValidator({ type: 'number', nullable: true, required: true });

      assert.isFalse(root.validate(undefined), 'undefined is always true!');
      assert.isTrue(root.validate(null), 'nullable is allowed');
      assert.isTrue(root.validate(42), 'validates an integer');
      assert.isTrue(root.validate(Math.PI), 'validates a float');
      assert.isFalse(root.validate('42'), 'not validates a string');
      assert.isFalse(root.validate([]), 'not validates an empty array');
      assert.isFalse(root.validate({}), 'not validates an object');
    });

    it('should validate type: [\'number\', \'string\', \'null\'], nullable: true', function () {
      const root = compileSchemaValidator({ type: ['number', 'string', 'null'], nullable: true });

      assert.isTrue(root.validate(undefined), 'undefined is always true!');
      assert.isTrue(root.validate(null), 'null is not a number or string');
      assert.isTrue(root.validate(42), 'validates an integer');
      assert.isTrue(root.validate(Math.PI), 'validates a number');
      assert.isTrue(root.validate('Math.PI'), 'validates a string');
      assert.isFalse(root.validate([42, '42']), 'does not validate an array');
      assert.isFalse(root.validate({}), 'does not validate an object');
    });

    it('should validate type: [\'number\', \'string\', \'null\'], nullable: true, required: true', function () {
      const root = compileSchemaValidator({ type: ['number', 'string', 'null'], nullable: true, required: true });

      assert.isFalse(root.validate(undefined), 'undefined is always true!');
      assert.isTrue(root.validate(null), 'null is not a number or string');
      assert.isTrue(root.validate(42), 'validates an integer');
      assert.isTrue(root.validate(Math.PI), 'validates a number');
      assert.isTrue(root.validate('Math.PI'), 'validates a string');
      assert.isFalse(root.validate([42, '42']), 'does not validate an array');
      assert.isFalse(root.validate({}), 'does not validate an object');
    });


  });

});
