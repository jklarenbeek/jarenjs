import { describe, it } from 'node:test';
import * as assert from '@jarenjs/tools/assert';

import {
  FLOAT16_MAX,
  FLOAT16_MIN,
  FLOAT32_MAX,
  FLOAT32_MIN,
  FLOAT64_MAX,
  FLOAT64_MIN,
  Float32_decrement,
  Float32_increment,
  Float64_decrement,
  Float64_increment,
  Float16_decrement,
  Float16_increment,
} from '@jarenjs/numbers/float';

import {
  INT64_MAX,
  INT64_MIN,
  UINT64_MAX,
  UINT64_MIN,
} from '@jarenjs/numbers/integer';

import {
  compileSchemaValidator,
} from '@jarenjs/validate';

// https://json-schema.org/understanding-json-schema/reference/numeric.html

describe('Schema BigInt Type', function () {

  describe('#general()', function () {
    it('should validate type: \'bigint\'', function () {
      const root = compileSchemaValidator({ type: 'bigint' });

      assert.isFalse(root.validate(42), 'not validates an integer');
      assert.isFalse(root.validate(-1), 'not validates a negative integer');
      assert.isFalse(root.validate(Math.PI), 'not validates a number');
      assert.isFalse(root.validate('42'), 'not validates a string');
      assert.isTrue(root.validate(BigInt(42)), 'validates a big integer');
      assert.isTrue(root.validate(BigInt(-1)), 'validates a negative big integer');
    });

  });

  describe('#range()', function () {
    it('should validate exclusiveMaximum: BigInt(42)', function () {
      const root = compileSchemaValidator({
        exclusiveMaximum: BigInt(42),
      });

      assert.isTrue(root.validate(52), 'it should ignore numbers');
      assert.isTrue(root.validate('52'), 'ignores non-numbers');
      assert.isTrue(root.validate(BigInt(32)), 'below the exclusiveMaximum is valid');
      assert.isFalse(root.validate(BigInt(42)), 'boundary point is invalid');
      assert.isFalse(root.validate(BigInt(52)), 'above the exclusiveMaximum is invalid');
    });

    it('should validate exclusiveMinimum: BigInt(16)', function () {
      const root = compileSchemaValidator({
        exclusiveMinimum: BigInt(16),
      });

      assert.isTrue(root.validate(10), 'it should ignore numbers');
      assert.isTrue(root.validate('10'), 'ignores non-numbers');
      assert.isTrue(root.validate(BigInt(21)), 'above the exclusiveMinimum is valid');
      assert.isFalse(root.validate(BigInt(16)), 'boundary point is invalid');
      assert.isFalse(root.validate(BigInt(10)), 'below the exclusiveMinimum is invalid');
    });

    it('should validate maximum: BigInt(42)', function () {
      const root = compileSchemaValidator({
        maximum: BigInt(42),
      });

      assert.isTrue(root.validate(52), 'it should ignore numbers');
      assert.isTrue(root.validate('52'), 'ignores non-numbers');
      assert.isTrue(root.validate(BigInt(32)), 'below the maximum is valid');
      assert.isTrue(root.validate(BigInt(42)), 'boundary point is valid');
      assert.isFalse(root.validate(BigInt(52)), 'above the maximum is invalid');
    });

    it('should validate minimum: BigInt(16)', function () {
      const root = compileSchemaValidator({
        minimum: BigInt(16),
      });

      assert.isTrue(root.validate(10), 'it should ignore numbers');
      assert.isTrue(root.validate('10'), 'ignores non-numbers');
      assert.isTrue(root.validate(BigInt(21)), 'above the minimum is valid');
      assert.isTrue(root.validate(BigInt(16)), 'boundary point is valid');
      assert.isFalse(root.validate(BigInt(10)), 'below the minimum is invalid');
    });

    it('should validate multipleOf: BigInt(2)', function () {
      const root = compileSchemaValidator({
        multipleOf: BigInt(2),
      });

      assert.isTrue(root.validate(7), 'it should ignore numbers');
      assert.isTrue(root.validate('7'), 'ignores a string');
      assert.isTrue(root.validate(BigInt(0)), 'zero is multipleOf everything');
      assert.isTrue(root.validate(BigInt(4)), 'four is a multipleof two');
      assert.isFalse(root.validate(BigInt(7)), 'seven is a not a multipleOf two');
    });
  });
});
