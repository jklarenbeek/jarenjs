import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  JarenValidator,
} from '@jarenjs/validate';


// https://json-schema.org/understanding-json-schema/reference/type.html
const compiler = new JarenValidator();

describe('JSON Schema Types', function () {
  describe('#types()', function () {
    it('should validate a boolean true schema', function () {
      const validate = compiler.compile(true);
      assert.isTrue(validate(undefined), 'undefined value is valid');
      assert.isTrue(validate(null), 'null value is valid');
      assert.isTrue(validate(false), 'false value is valid');
      assert.isTrue(validate(3.14), 'number value is valid');
      assert.isTrue(validate('string'), 'string value is valid');
      assert.isTrue(validate([]), 'array value is valid');
      assert.isTrue(validate({}), 'object value is valid');
    });

    it('should validate a boolean false schema', function () {
      const validate = compiler.compile(false);
      assert.isFalse(validate(undefined), 'undefined value is invalid');
      assert.isFalse(validate(null), 'null value is invalid');
      assert.isFalse(validate(true), 'true value is invalid');
      assert.isFalse(validate(3.14), 'number value is invalid');
      assert.isFalse(validate('string'), 'string value is invalid');
      assert.isFalse(validate([]), 'array value is invalid');
      assert.isFalse(validate({}), 'object value is invalid');
    });

    it('should error on invalid schema types', function () {
      assert.throws(() => compiler.compile({ type: 'untinkable' }));
      assert.throws(() => compiler.compile({ type: ['what', 'are', 'you', 'thinking'] }));
      assert.throws(() => compiler.compile({ type: [] }));
      assert.throws(() => compiler.compile([]));
    });

    it('should validate type: \'number\'', function () {
      const validate = compiler.compile({ type: 'number' });

      assert.isTrue(validate(undefined), 'undefined is always true!');
      assert.isFalse(validate(null), 'null is not a number');
      assert.isTrue(validate(42), 'validates an integer');
      assert.isTrue(validate(Math.PI), 'validates a float');
      assert.isFalse(validate('42'), 'not validates a string');
      assert.isFalse(validate([]), 'not validates an empty array');
      assert.isFalse(validate({}), 'not validates an object');
    });

    it('should validate type: \'integer\'', function () {
      const validate = compiler.compile({ type: 'integer' });

      assert.isTrue(validate(undefined), 'undefined is always true!');
      assert.isFalse(validate(null), 'null is not an integer');
      assert.isTrue(validate(42), '42 is an integer');
      assert.isFalse(validate(Math.PI), 'PI is not an integer');
      assert.isFalse(validate('42'), 'a string is not valid');
      assert.isFalse(validate([]), 'not validates an empty array');
      assert.isFalse(validate({}), 'not validates an object');
    });

    it('should validate type: \'bigint\'', function () {
      const validate = compiler.compile({ type: 'bigint' });

      assert.isTrue(validate(undefined), 'undefined is always true!');
      assert.isFalse(validate(null), 'null is not an bigint');
      assert.isFalse(validate(42), '42 is not an bigint');
      assert.isTrue(validate(BigInt(42)), '42n is a bigint');
      assert.isFalse(validate(Math.PI), 'PI is not an bigint');
      assert.isFalse(validate('42'), 'a string is not valid');
      assert.isFalse(validate([]), 'not validates an empty array');
      assert.isFalse(validate({}), 'not validates an object');
    });

    it('should validate type: \'string\'', function () {
      const validate = compiler.compile({ type: 'string' });

      assert.isTrue(validate(undefined), 'undefined is always true!');
      assert.isFalse(validate(null), 'null is not a string');
      assert.isFalse(validate(42), 'integer is not a string');
      assert.isFalse(validate(Math.PI), 'PI is not a string');
      assert.isFalse(validate(BigInt(42)), 'bigint is not a string');
      assert.isTrue(validate('this is a string'), 'this is a valid string');
      assert.isFalse(validate(['this', 'is', 'an', 'array']), 'this array is not a string');
      assert.isFalse(validate({ keyword: 'value' }), 'this object is not a string');
    });

    it('should validate type: \'null\'', function () {
      const validate = compiler.compile({ type: 'null' });

      assert.isFalse(validate(0), 'zero is not null');
      assert.isFalse(validate(1), 'an integer is not null');
      assert.isFalse(validate(Math.PI), 'a float is not null');
      assert.isFalse(validate('foobar'), 'string is not null');
      assert.isFalse(validate(''), 'an empty string is not null');
      assert.isFalse(validate({}), 'an object is not null');
      assert.isFalse(validate([]), 'an array is not null');
      assert.isFalse(validate(true), 'boolean true is not null');
      assert.isFalse(validate(false), 'boolean false is not null');
      assert.isTrue(validate(null), 'null equals null');
    });

    it('should validate type: \'object\'', function () {
      const validate = compiler.compile({ type: 'object' });

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

      assert.isTrue(validate(undefined), 'undefined is always true!');
      assert.isFalse(validate(null), 'not validates null!');
      assert.isTrue(validate({}), 'validates an empty object literal');
      assert.isTrue(validate(testObj1), 'validates a simple object with strings');
      assert.isTrue(validate(testObj2), 'validates a simple object with numbers');
      assert.isFalse(validate(2.99792458e8), 'not validates a float literal');
      assert.isFalse(validate('Is Not Valid'), 'not validates a string');
      assert.isFalse(validate(['is', 'not', 'an', 'object']), 'not validates an array');

    });

    it('should validate type: \'array\'', function () {
      const validate = compiler.compile({ type: 'array' });

      assert.isTrue(validate(undefined), 'undefined is always true!');
      assert.isFalse(validate(null), 'not validates null!');
      assert.isTrue(validate([]), 'validates an empty array literal');
      assert.isTrue(validate([1, 2, 3, 4, 5]), 'validates array of integers');
      assert.isTrue(validate([1, '2', null, {}, 5]), 'validates array of integers');
      assert.isTrue(validate([3, 'different', { types: 'of values' }]), 'validates array of objects');
      assert.isFalse(validate({ Not: 'an array' }), 'not an array type');
      assert.isFalse(validate(2.99792458e8), 'not a number type');
      assert.isFalse(validate('This is not valid'), 'not a string type');
    });

    it('should validate type: [\'string\']', function () {
      const validate = compiler.compile({ type: ['string'] });

      assert.isTrue(validate(undefined), 'undefined is always true!');
      assert.isFalse(validate(null), 'null is not a string');
      assert.isFalse(validate(42), 'validates an integer');
      assert.isFalse(validate(Math.PI), 'validates a number');
      assert.isTrue(validate('Math.PI'), 'validates a string');
      assert.isFalse(validate([42, '42']), 'does not validate an array');
      assert.isFalse(validate({}), 'does not validate an object');
    });

    it('should validate type: [\'integer\', \'string\']', function () {
      const validate = compiler.compile({ type: ['integer', 'string'] });

      assert.isTrue(validate(undefined), 'undefined is always true!');
      assert.isFalse(validate(null), 'null is not a number or string');
      assert.isTrue(validate(42), 'validates an integer');
      assert.isFalse(validate(Math.PI), 'validates a number');
      assert.isTrue(validate('Math.PI'), 'validates a string');
      assert.isFalse(validate([42, '42']), 'does not validate an array');
      assert.isFalse(validate({}), 'does not validate an object');
    });

    it('should validate type: [\'string\', \'integer\', \'number\']', function () {
      const validate = compiler.compile({ type: ['string', 'integer', 'number'] });

      assert.isTrue(validate(undefined), 'undefined is always true!');
      assert.isFalse(validate(null), 'null is not a number or string');
      assert.isTrue(validate(42), 'validates an integer');
      assert.isTrue(validate(Math.PI), 'validates a number');
      assert.isTrue(validate('Math.PI'), 'validates a string');
      assert.isFalse(validate([42, '42']), 'does not validate an array');
      assert.isFalse(validate({}), 'does not validate an object');
    });

    it('should validate type: [\'number\', \'string\', \'null\']', function () {
      const validate = compiler.compile({ type: ['number', 'string', 'null'] });

      assert.isTrue(validate(undefined), 'undefined is always true!');
      assert.isTrue(validate(null), 'null is not a number or string');
      assert.isTrue(validate(42), 'validates an integer');
      assert.isTrue(validate(Math.PI), 'validates a number');
      assert.isTrue(validate('Math.PI'), 'validates a string');
      assert.isFalse(validate([42, '42']), 'does not validate an array');
      assert.isFalse(validate({}), 'does not validate an object');
    });

    it('should validate type: [null, \'string\', \'integer\', \'number\']', function () {
      const validate = compiler.compile({ type: [null, 'string', 'integer', 'number'] });

      assert.isTrue(validate(undefined), 'undefined is always true!');
      assert.isTrue(validate(null), 'null is not a number or string');
      assert.isTrue(validate(42), 'validates an integer');
      assert.isTrue(validate(Math.PI), 'validates a number');
      assert.isTrue(validate('Math.PI'), 'validates a string');
      assert.isFalse(validate([42, '42']), 'does not validate an array');
      assert.isFalse(validate({}), 'does not validate an object');
    });

    it('should validate type: new Set([null, \'string\', \'integer\', \'number\'])', function () {
      const validate = compiler.compile({ type: new Set([null, 'string', 'integer', 'number']) });

      assert.isTrue(validate(undefined), 'undefined is always true!');
      assert.isTrue(validate(null), 'null is not a number or string');
      assert.isTrue(validate(42), 'validates an integer');
      assert.isTrue(validate(Math.PI), 'validates a number');
      assert.isTrue(validate('Math.PI'), 'validates a string');
      assert.isFalse(validate([42, '42']), 'does not validate an array');
      assert.isFalse(validate({}), 'does not validate an object');
    });

  });

  describe('#required()', function () {

    it('should validate type: \'number\', required: true', function () {
      const validate = compiler.compile({ type: 'number', required: true });

      assert.isFalse(validate(undefined), 'undefined returns always false!');
      assert.isFalse(validate(null), 'null is not a number');
      assert.isTrue(validate(42), 'validates an integer');
      assert.isTrue(validate(Math.PI), 'validates a float');
      assert.isFalse(validate('42'), 'not validates a string');
      assert.isFalse(validate([]), 'not validates an empty array');
      assert.isFalse(validate({}), 'not validates an object');
    });

    it('should validate type: \'integer\', required: true', function () {
      const validate = compiler.compile({ type: 'integer', required: true });

      assert.isFalse(validate(undefined), 'undefined returns always false!');
      assert.isFalse(validate(null), 'null is not an integer');
      assert.isTrue(validate(42), '42 is an integer');
      assert.isFalse(validate(Math.PI), 'PI is not an integer');
      assert.isFalse(validate('42'), 'a string is not valid');
      assert.isFalse(validate([]), 'not validates an empty array');
      assert.isFalse(validate({}), 'not validates an object');
    });

    it('should validate type: \'bigint\', required: true', function () {
      const validate = compiler.compile({ type: 'bigint', required: true });

      assert.isFalse(validate(undefined), 'undefined returns always false!');
      assert.isFalse(validate(null), 'null is not an bigint');
      assert.isFalse(validate(42), '42 is not an bigint');
      assert.isTrue(validate(BigInt(42)), '42n is a bigint');
      assert.isFalse(validate(Math.PI), 'PI is not an bigint');
      assert.isFalse(validate('42'), 'a string is not valid');
      assert.isFalse(validate([]), 'not validates an empty array');
      assert.isFalse(validate({}), 'not validates an object');
    });

    it('should validate type: \'string\', required: true', function () {
      const validate = compiler.compile({ type: 'string', required: true });

      assert.isFalse(validate(undefined), 'undefined returns always false!');
      assert.isFalse(validate(null), 'null is not a string');
      assert.isFalse(validate(42), 'integer is not a string');
      assert.isFalse(validate(Math.PI), 'PI is not a string');
      assert.isFalse(validate(BigInt(42)), 'bigint is not a string');
      assert.isTrue(validate('this is a string'), 'this is a valid string');
      assert.isFalse(validate(['this', 'is', 'an', 'array']), 'this array is not a string');
      assert.isFalse(validate({ keyword: 'value' }), 'this object is not a string');
    });

    it('should validate type: [null, \'string\'], required: true', function () {
      const validate = compiler.compile({ type: [null, 'string'], required: true });

      assert.isFalse(validate(undefined), 'undefined returns always false!');
      assert.isTrue(validate(null), 'null is not a string');
      assert.isFalse(validate(42), 'integer is not a string');
      assert.isFalse(validate(Math.PI), 'PI is not a string');
      assert.isFalse(validate(BigInt(42)), 'bigint is not a string');
      assert.isTrue(validate('this is a string'), 'this is a valid string');
      assert.isFalse(validate(['this', 'is', 'an', 'array']), 'this array is not a string');
      assert.isFalse(validate({ keyword: 'value' }), 'this object is not a string');
    });

  });

  describe('#nullable()', function () {
    it('should validate nullable: true', function () {
      const validate = compiler.compile({ nullable: true });

      assert.isTrue(validate(undefined), 'undefined is always true!');
      assert.isTrue(validate(null), 'nullable is allowed');
      assert.isTrue(validate(42), 'validates an integer');
      assert.isTrue(validate(Math.PI), 'validates a float');
      assert.isTrue(validate('42'), 'not validates a string');
      assert.isTrue(validate([]), 'not validates an empty array');
      assert.isTrue(validate({}), 'not validates an object');

    });

    it('should validate nullable: false', function () {
      const validate = compiler.compile({ nullable: false });

      assert.isTrue(validate(undefined), 'undefined is always true!');
      assert.isFalse(validate(null), 'nullable is not allowed');
      assert.isTrue(validate(42), 'validates an integer');
      assert.isTrue(validate(Math.PI), 'validates a float');
      assert.isTrue(validate('42'), 'not validates a string');
      assert.isTrue(validate([]), 'not validates an empty array');
      assert.isTrue(validate({}), 'not validates an object');

    });

    it('should validate type: \'number\', nullable: true', function () {
      const validate = compiler.compile({ type: 'number', nullable: true });

      assert.isTrue(validate(undefined), 'undefined is always true!');
      assert.isTrue(validate(null), 'nullable is allowed');
      assert.isTrue(validate(42), 'validates an integer');
      assert.isTrue(validate(Math.PI), 'validates a float');
      assert.isFalse(validate('42'), 'not validates a string');
      assert.isFalse(validate([]), 'not validates an empty array');
      assert.isFalse(validate({}), 'not validates an object');
    });

    it('should validate type: \'number\', nullable: true, required: true', function () {
      const validate = compiler.compile({ type: 'number', nullable: true, required: true });

      assert.isFalse(validate(undefined), 'undefined is always true!');
      assert.isTrue(validate(null), 'nullable is allowed');
      assert.isTrue(validate(42), 'validates an integer');
      assert.isTrue(validate(Math.PI), 'validates a float');
      assert.isFalse(validate('42'), 'not validates a string');
      assert.isFalse(validate([]), 'not validates an empty array');
      assert.isFalse(validate({}), 'not validates an object');
    });

    it('should validate type: [\'number\', \'string\', \'null\'], nullable: true', function () {
      const validate = compiler.compile({ type: ['number', 'string', 'null'], nullable: true });

      assert.isTrue(validate(undefined), 'undefined is always true!');
      assert.isTrue(validate(null), 'null is not a number or string');
      assert.isTrue(validate(42), 'validates an integer');
      assert.isTrue(validate(Math.PI), 'validates a number');
      assert.isTrue(validate('Math.PI'), 'validates a string');
      assert.isFalse(validate([42, '42']), 'does not validate an array');
      assert.isFalse(validate({}), 'does not validate an object');
    });

    it('should validate type: [\'number\', \'string\', \'null\'], nullable: true, required: true', function () {
      const validate = compiler.compile({ type: ['number', 'string', 'null'], nullable: true, required: true });

      assert.isFalse(validate(undefined), 'undefined is always true!');
      assert.isTrue(validate(null), 'null is not a number or string');
      assert.isTrue(validate(42), 'validates an integer');
      assert.isTrue(validate(Math.PI), 'validates a number');
      assert.isTrue(validate('Math.PI'), 'validates a string');
      assert.isFalse(validate([42, '42']), 'does not validate an array');
      assert.isFalse(validate({}), 'does not validate an object');
    });


  });

});
