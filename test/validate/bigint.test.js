import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  JarenValidator,
} from '@jarenjs/validate';

// https://json-schema.org/understanding-json-schema/reference/numeric.html
const compiler = new JarenValidator();


describe('Schema BigInt Type', function () {

  describe('#general()', function () {
    it('should validate type: \'bigint\'', function () {
      const validate = compiler.compile({ type: 'bigint' });

      assert.isFalse(validate(42), 'not validates an integer');
      assert.isFalse(validate(-1), 'not validates a negative integer');
      assert.isFalse(validate(Math.PI), 'not validates a number');
      assert.isFalse(validate('42'), 'not validates a string');
      assert.isTrue(validate(BigInt(42)), 'validates a big integer');
      assert.isTrue(validate(BigInt(-1)), 'validates a negative big integer');
    });

  });

  describe('#range()', function () {
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
      const validate = compiler.compile({
        multipleOf: BigInt(2),
      });

      assert.isTrue(validate(7), 'it should ignore numbers');
      assert.isTrue(validate('7'), 'ignores a string');
      assert.isTrue(validate(BigInt(0)), 'zero is multipleOf everything');
      assert.isTrue(validate(BigInt(4)), 'four is a multipleof two');
      assert.isFalse(validate(BigInt(7)), 'seven is a not a multipleOf two');
    });
  });
});
