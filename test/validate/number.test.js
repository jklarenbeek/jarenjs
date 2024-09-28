import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';


import {
  JarenValidator,
} from '@jarenjs/validate';

// https://json-schema.org/understanding-json-schema/reference/numeric.html

const compiler = new JarenValidator();

describe('Schema Numeric Type', function () {

  describe('#numeric()', function () {

    it('should validate type: \'number\'', function () {
      const validate = compiler.compile({ type: 'number' });


      assert.isFalse(validate(BigInt(42)), 'bigint is invalid');
      assert.isFalse(validate('42'), 'string is invalid');
      assert.isTrue(validate(42), 'validates an integer');
      assert.isTrue(validate(-1), 'validates a negative integer');
      assert.isTrue(validate(Math.PI), 'validates a number');
      assert.isTrue(validate(2.99792458e8), 'validates a float literal');
    });

    it('should validate exclusiveMaximum: 3.0', function () {
      const validate = compiler.compile({
        exclusiveMaximum: 3.0,
      });


      assert.isTrue(validate(BigInt(3)), 'ignores bigint');
      assert.isTrue(validate('3.5'), 'ignores strings');
      assert.isTrue(validate(2.2), 'below the exclusiveMaximum is valid');
      assert.isFalse(validate(3.0), 'boundary point is invalid');
      assert.isFalse(validate(3.5), 'above the exclusiveMaximum is invalid');
    });

    it('should validate exclusiveMinimum: 1.1', function () {
      const validate = compiler.compile({
        exclusiveMinimum: 1.1,
      });


      assert.isTrue(validate(BigInt(1)), 'ignores bigint');
      assert.isTrue(validate('0.6'), 'ignores strings');
      assert.isTrue(validate(1.2), 'above the exclusiveMinimum is valid');
      assert.isFalse(validate(1.1), 'boundary point is invalid');
      assert.isFalse(validate(0.6), 'below the exclusiveMinimum is invalid');
    });

    it('should validate maximum: 3.0', function () {
      const validate = compiler.compile({
        maximum: 3.0,
      });


      assert.isTrue(validate(BigInt(4)), 'ignores bigint');
      assert.isTrue(validate('4'), 'ignores strings');
      assert.isTrue(validate(2.6), 'below the maximum is valid');
      assert.isTrue(validate(3.0), 'boundary point is valid');
      assert.isFalse(validate(3.5), 'above the maximum is invalid');
    });

    it('should validate minimum: 1.1', function () {
      const validate = compiler.compile({
        minimum: 1.1,
      });


      assert.isTrue(validate(BigInt(1)), 'ignores bigint');
      assert.isTrue(validate('1'), 'ignores string');
      assert.isTrue(validate(1.2), 'above the minimum is valid');
      assert.isTrue(validate(1.1), 'boundary point is valid');
      assert.isFalse(validate(0.6), 'below the minimum is invalid');
    });

    it('should validate multipleOf: 1.5', function () {
      const validate = compiler.compile({ multipleOf: 1.5 });


      assert.isTrue(validate(BigInt(1)), 'ignores bigint');
      assert.isTrue(validate('1'), 'ignores string');
      assert.isTrue(validate(0), 'zero is multipleOf everything');
      assert.isTrue(validate(3), 'three is a multipleof one point five');
      assert.isTrue(validate(4.5), 'four point five is a multipleOf one point five');
      assert.isFalse(validate(31), 'tortyone is a not a multipleOf one point five');
      assert.isTrue(validate('42'), 'ignores a string');
    });
  });

  describe('#integer()', function () {

    it('should validate type: \'integer\'', function () {
      const validate = compiler.compile({ type: 'integer' });


      assert.isTrue(validate(42), 'validates an integer');
      assert.isTrue(validate(-1), 'validates a negative integer');
      assert.isFalse(validate(Math.PI), 'does not validate a float');
      assert.isFalse(validate('42'), 'does not validate a string');
      assert.isFalse(validate({}), 'does not validate an object');
      assert.isFalse(validate([]), 'does not validate an array');
    });

    it('should validate type: \'integer\', minimum: -2', function () {
      const validate = compiler.compile({
        type: 'integer',
        minimum: -2,
      });


      assert.isTrue(validate(-1), 'negative above the minimum is valid');
      assert.isTrue(validate(0), 'positive above the minimum is valid');
      assert.isTrue(validate(-2), 'boundary point is valid');
      assert.isFalse(validate(2.4), 'does not validates floating point numbers');
      assert.isFalse(validate(-3), 'below the minimum is invalid');
      assert.isFalse(validate('x'), 'ignores non-numbers');
    });

    it('should validate type: \'integer\', maximum: 2', function () {
      const validate = compiler.compile({
        type: 'integer',
        maximum: 2,
      });

      assert.isTrue(validate(-1), 'negative below the maximum is valid');
      assert.isTrue(validate(1), 'positive below the maximum is valid');
      assert.isTrue(validate(2), 'boundary point is valid');
      assert.isFalse(validate(1.4), 'does not validates floating point numbers');
      assert.isFalse(validate(3), 'above the maximum is invalid');
      assert.isFalse(validate('x'), 'ignores non-numbers');

    });

    it('should validate multipleOf: 2', function () {
      const validate = compiler.compile({ multipleOf: 2 });

      assert.isTrue(validate(10), 'ten is multipleOf 2');
      assert.isFalse(validate(7), 'seven is not a multipleOf 2');
      assert.isTrue(validate('42'), 'ignores a string');
    });

  });

  describe('#bigint()', function () {
    it('should validate type: \'bigint\'', function () {
      const validate = compiler.compile({ type: 'bigint' });

      assert.isFalse(validate(42), 'not validates an integer');
      assert.isFalse(validate(-1), 'not validates a negative integer');
      assert.isFalse(validate(Math.PI), 'not validates a number');
      assert.isFalse(validate('42'), 'not validates a string');
      assert.isTrue(validate(BigInt(42)), 'validates a big integer');
      assert.isTrue(validate(BigInt(-1)), 'validates a negative big integer');
    });

    it('should validate exclusiveMaximum: BigInt(42)', function () {
      const validate = compiler.compile({
        exclusiveMaximum: BigInt(42),
      });

      assert.isTrue(validate(52), 'it should ignore numbers');
      assert.isTrue(validate('52'), 'ignores non-numbers');
      assert.isTrue(validate(BigInt(32)), 'below the exclusiveMaximum is valid');
      assert.isFalse(validate(BigInt(42)), 'boundary point is invalid');
      assert.isFalse(validate(BigInt(52)), 'above the exclusiveMaximum is invalid');
    });

    it('should validate exclusiveMinimum: BigInt(16)', function () {
      const validate = compiler.compile({
        exclusiveMinimum: BigInt(16),
      });

      assert.isTrue(validate(10), 'it should ignore numbers');
      assert.isTrue(validate('10'), 'ignores non-numbers');
      assert.isTrue(validate(BigInt(21)), 'above the exclusiveMinimum is valid');
      assert.isFalse(validate(BigInt(16)), 'boundary point is invalid');
      assert.isFalse(validate(BigInt(10)), 'below the exclusiveMinimum is invalid');
    });

    it('should validate maximum: BigInt(42)', function () {
      const validate = compiler.compile({
        maximum: BigInt(42),
      });

      assert.isTrue(validate(52), 'it should ignore numbers');
      assert.isTrue(validate('52'), 'ignores non-numbers');
      assert.isTrue(validate(BigInt(32)), 'below the maximum is valid');
      assert.isTrue(validate(BigInt(42)), 'boundary point is valid');
      assert.isFalse(validate(BigInt(52)), 'above the maximum is invalid');
    });

    it('should validate minimum: BigInt(16)', function () {
      const validate = compiler.compile({
        minimum: BigInt(16),
      });

      assert.isTrue(validate(10), 'it should ignore numbers');
      assert.isTrue(validate('10'), 'ignores non-numbers');
      assert.isTrue(validate(BigInt(21)), 'above the minimum is valid');
      assert.isTrue(validate(BigInt(16)), 'boundary point is valid');
      assert.isFalse(validate(BigInt(10)), 'below the minimum is invalid');
    });

    it('should validate multipleOf: BigInt(2)', function () {
      const validate = compiler.compile({ multipleOf: BigInt(2) });

      assert.isTrue(validate(7), 'it should ignore numbers');
      assert.isTrue(validate('7'), 'ignores a string');
      assert.isTrue(validate(BigInt(0)), 'zero is multipleOf everything');
      assert.isTrue(validate(BigInt(4)), 'four is a multipleof two');
      assert.isFalse(validate(BigInt(7)), 'seven is a not a multipleOf two');
    });
  });

});
