import { describe, it } from 'node:test';
import * as assert from '@jaren/tools/assert';

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
} from '@jaren/numbers/float';

import {
  INT64_MAX,
  INT64_MIN,
  UINT64_MAX,
  UINT64_MIN,
} from '@jaren/numbers/integer';

import {
  compileSchemaValidator,
  registerFormatCompilers
} from '@jaren/validate';

import * as formats from '@jaren/formats';

registerFormatCompilers(formats.numberFormats);

// https://json-schema.org/understanding-json-schema/reference/numeric.html

describe('Schema Numeric Type', function () {

  describe('#numeric()', function () {

    it('should validate type: \'number\'', function () {
      const root = compileSchemaValidator({ type: 'number' });


      assert.isFalse(root.validate(BigInt(42)), 'bigint is invalid');
      assert.isFalse(root.validate('42'), 'string is invalid');
      assert.isTrue(root.validate(42), 'validates an integer');
      assert.isTrue(root.validate(-1), 'validates a negative integer');
      assert.isTrue(root.validate(Math.PI), 'validates a number');
      assert.isTrue(root.validate(2.99792458e8), 'validates a float literal');
    });

    it('should validate exclusiveMaximum: 3.0', function () {
      const root = compileSchemaValidator({
        exclusiveMaximum: 3.0,
      });


      assert.isTrue(root.validate(BigInt(3)), 'ignores bigint');
      assert.isTrue(root.validate('3.5'), 'ignores strings');
      assert.isTrue(root.validate(2.2), 'below the exclusiveMaximum is valid');
      assert.isFalse(root.validate(3.0), 'boundary point is invalid');
      assert.isFalse(root.validate(3.5), 'above the exclusiveMaximum is invalid');
    });

    it('should validate exclusiveMinimum: 1.1', function () {
      const root = compileSchemaValidator({
        exclusiveMinimum: 1.1,
      });


      assert.isTrue(root.validate(BigInt(1)), 'ignores bigint');
      assert.isTrue(root.validate('0.6'), 'ignores strings');
      assert.isTrue(root.validate(1.2), 'above the exclusiveMinimum is valid');
      assert.isFalse(root.validate(1.1), 'boundary point is invalid');
      assert.isFalse(root.validate(0.6), 'below the exclusiveMinimum is invalid');
    });

    it('should validate maximum: 3.0', function () {
      const root = compileSchemaValidator({
        maximum: 3.0,
      });


      assert.isTrue(root.validate(BigInt(4)), 'ignores bigint');
      assert.isTrue(root.validate('4'), 'ignores strings');
      assert.isTrue(root.validate(2.6), 'below the maximum is valid');
      assert.isTrue(root.validate(3.0), 'boundary point is valid');
      assert.isFalse(root.validate(3.5), 'above the maximum is invalid');
    });

    it('should validate minimum: 1.1', function () {
      const root = compileSchemaValidator({
        minimum: 1.1,
      });


      assert.isTrue(root.validate(BigInt(1)), 'ignores bigint');
      assert.isTrue(root.validate('1'), 'ignores string');
      assert.isTrue(root.validate(1.2), 'above the minimum is valid');
      assert.isTrue(root.validate(1.1), 'boundary point is valid');
      assert.isFalse(root.validate(0.6), 'below the minimum is invalid');
    });

    it('should validate multipleOf: 1.5', function () {
      const root = compileSchemaValidator({ multipleOf: 1.5 });


      assert.isTrue(root.validate(BigInt(1)), 'ignores bigint');
      assert.isTrue(root.validate('1'), 'ignores string');
      assert.isTrue(root.validate(0), 'zero is multipleOf everything');
      assert.isTrue(root.validate(3), 'three is a multipleof one point five');
      assert.isTrue(root.validate(4.5), 'four point five is a multipleOf one point five');
      assert.isFalse(root.validate(31), 'tortyone is a not a multipleOf one point five');
      assert.isTrue(root.validate('42'), 'ignores a string');
    });
  });

  describe('#integer()', function () {

    it('should validate type: \'integer\'', function () {
      const root = compileSchemaValidator({ type: 'integer' });


      assert.isTrue(root.validate(42), 'validates an integer');
      assert.isTrue(root.validate(-1), 'validates a negative integer');
      assert.isFalse(root.validate(Math.PI), 'does not validate a float');
      assert.isFalse(root.validate('42'), 'does not validate a string');
      assert.isFalse(root.validate({}), 'does not validate an object');
      assert.isFalse(root.validate([]), 'does not validate an array');
    });

    it('should validate type: \'integer\', minimum: -2', function () {
      const root = compileSchemaValidator({
        type: 'integer',
        minimum: -2,
      });


      assert.isTrue(root.validate(-1), 'negative above the minimum is valid');
      assert.isTrue(root.validate(0), 'positive above the minimum is valid');
      assert.isTrue(root.validate(-2), 'boundary point is valid');
      assert.isFalse(root.validate(2.4), 'does not validates floating point numbers');
      assert.isFalse(root.validate(-3), 'below the minimum is invalid');
      assert.isFalse(root.validate('x'), 'ignores non-numbers');
    });

    it('should validate type: \'integer\', maximum: 2', function () {
      const root = compileSchemaValidator({
        type: 'integer',
        maximum: 2,
      });

      assert.isTrue(root.validate(-1), 'negative below the maximum is valid');
      assert.isTrue(root.validate(1), 'positive below the maximum is valid');
      assert.isTrue(root.validate(2), 'boundary point is valid');
      assert.isFalse(root.validate(1.4), 'does not validates floating point numbers');
      assert.isFalse(root.validate(3), 'above the maximum is invalid');
      assert.isFalse(root.validate('x'), 'ignores non-numbers');

    });

    it('should validate multipleOf: 2', function () {
      const root = compileSchemaValidator({ multipleOf: 2 });

      assert.isTrue(root.validate(10), 'ten is multipleOf 2');
      assert.isFalse(root.validate(7), 'seven is not a multipleOf 2');
      assert.isTrue(root.validate('42'), 'ignores a string');
    });

  });

  describe('#bigint()', function () {
    it('should validate type: \'bigint\'', function () {
      const root = compileSchemaValidator({ type: 'bigint' });

      assert.isFalse(root.validate(42), 'not validates an integer');
      assert.isFalse(root.validate(-1), 'not validates a negative integer');
      assert.isFalse(root.validate(Math.PI), 'not validates a number');
      assert.isFalse(root.validate('42'), 'not validates a string');
      assert.isTrue(root.validate(BigInt(42)), 'validates a big integer');
      assert.isTrue(root.validate(BigInt(-1)), 'validates a negative big integer');
    });

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
      const root = compileSchemaValidator({ multipleOf: BigInt(2) });

      assert.isTrue(root.validate(7), 'it should ignore numbers');
      assert.isTrue(root.validate('7'), 'ignores a string');
      assert.isTrue(root.validate(BigInt(0)), 'zero is multipleOf everything');
      assert.isTrue(root.validate(BigInt(4)), 'four is a multipleof two');
      assert.isFalse(root.validate(BigInt(7)), 'seven is a not a multipleOf two');
    });
  });

  describe('#formatInteger()', function () {

    it('should validate format: \'int8\'', function () {
      const root = compileSchemaValidator({ format: 'int8' });

      assert.isTrue(root.validate(undefined), 'undefined is valid');
      assert.isTrue(root.validate(-128), 'valid minimum for int8');
      assert.isTrue(root.validate(127), 'a valid maximum for int8');
      assert.isTrue(root.validate('12'), 'a valid int8 as string is valid');
      assert.isFalse(root.validate(Number('NaN')), 'NaN is not valid');
      assert.isFalse(root.validate(-129), 'an invalid minimum for int8');
      assert.isFalse(root.validate(128), 'an invalid maximum for int8');
    });
    it('should validate format: \'uint8\'', function () {
      const root = compileSchemaValidator({ format: 'uint8' });

      assert.isTrue(root.validate(0), 'valid minimum for uint8');
      assert.isTrue(root.validate(255), 'a valid maximum for uint8');
      assert.isTrue(root.validate('12'), 'a valid uint8 as string is valid');
      assert.isFalse(root.validate(Number('NaN')), 'NaN is not valid');
      assert.isFalse(root.validate(-1), 'an invalid minimum for uint8');
      assert.isFalse(root.validate(256), 'an invalid maximum for uint8');
    });
    it('should validate format: \'int16\'', function () {
      const root = compileSchemaValidator({ format: 'int16' });

      assert.isTrue(root.validate(-32768), 'valid minimum for int16');
      assert.isTrue(root.validate(32767), 'a valid maximum for int16');
      assert.isTrue(root.validate('12'), 'a valid int16 as string is valid');
      assert.isFalse(root.validate(Number('NaN')), 'NaN is not valid');
      assert.isFalse(root.validate(-32769), 'an invalid minimum for int16');
      assert.isFalse(root.validate(32768), 'an invalid maximum for int16');
    });
    it('should validate format: \'uint16\'', function () {
      const root = compileSchemaValidator({ format: 'uint16' });

      assert.isTrue(root.validate(0), 'valid minimum for uint16');
      assert.isTrue(root.validate(65535), 'a valid maximum for uint16');
      assert.isTrue(root.validate('12'), 'a valid uint16 as string is valid');
      assert.isFalse(root.validate(Number('NaN')), 'NaN is not valid');
      assert.isFalse(root.validate(-1), 'an invalid minimum for uint16');
      assert.isFalse(root.validate(65536), 'an invalid maximum for uint16');
    });
    it('should validate format: \'int32\'', function () {
      const root = compileSchemaValidator({ format: 'int32' });

      assert.isTrue(root.validate(-2147483648), 'valid minimum for int32');
      assert.isTrue(root.validate(2147483647), 'a valid maximum for int32');
      assert.isTrue(root.validate('12'), 'a valid int32 as string is valid');
      assert.isFalse(root.validate(Number('NaN')), 'NaN is not valid');
      assert.isFalse(root.validate(-2147483649), 'an invalid minimum for int32');
      assert.isFalse(root.validate(2147483648), 'an invalid maximum for int32');

    });
    it('should validate format: \'uint32\'', function () {
      const root = compileSchemaValidator({ format: 'uint32' });

      assert.isTrue(root.validate(0), 'valid minimum for uint32');
      assert.isTrue(root.validate(4294967295), 'a valid maximum for uint32');
      assert.isTrue(root.validate('12'), 'a valid uint32 as string is valid');
      assert.isFalse(root.validate(Number('NaN')), 'NaN is not valid');
      assert.isFalse(root.validate(-1), 'an invalid minimum for uint32');
      assert.isFalse(root.validate(4294967296), 'an invalid maximum for uint32');

    });
    it('should validate format: \'int64\'', function () {
      const root = compileSchemaValidator({ format: 'int64' });

      assert.isTrue(root.validate(INT64_MIN), 'valid minimum for int64');
      assert.isTrue(root.validate(INT64_MAX), 'a valid maximum for int64');
      assert.isTrue(root.validate('12'), 'a valid int64 as string is valid');
      assert.isFalse(root.validate(Number('NaN')), 'NaN is not valid');
      assert.isFalse(root.validate(INT64_MIN - 1), 'an invalid minimum for int64');
      assert.isFalse(root.validate(INT64_MAX + 1), 'an invalid maximum for int64');
    });
    it('should validate format: \'uint64\'', function () {
      const root = compileSchemaValidator({ format: 'uint64' });

      assert.isTrue(root.validate(UINT64_MIN), 'valid minimum for uint64');
      assert.isTrue(root.validate(UINT64_MAX), 'a valid maximum for uint64');
      assert.isTrue(root.validate('12'), 'a valid uint64 as string is valid');
      assert.isFalse(root.validate(Number('NaN')), 'NaN is not valid');
      assert.isFalse(root.validate(UINT64_MIN - 1), 'an invalid minimum for uint64');
      assert.isFalse(root.validate(UINT64_MAX + 1), 'an invalid maximum for uint64');
    });

  });

  describe('#formatNumeric()', function () {

    const PI = 3.14159265358979323846;

    it('should validate format: \'float16\'', function () {
      const root = compileSchemaValidator({ format: 'float16' });

      assert.isTrue(root.validate(-FLOAT16_MAX), 'valid minimum for float16');
      assert.isTrue(root.validate(FLOAT16_MIN), 'valid smalles float16');
      assert.isTrue(root.validate(FLOAT16_MAX), 'a valid maximum for float16');
      assert.isTrue(root.validate('3.1415'), 'a valid float16 as string is valid');
      assert.isFalse(root.validate(Number('NaN')), 'NaN is not valid');
      assert.isFalse(root.validate(Float16_decrement(-FLOAT16_MAX)), 'an invalid minimum for float16');
      assert.isFalse(root.validate(Float16_increment(FLOAT16_MAX)), 'an invalid maximum for float16');
    });
    it('should validate format: \'float\' (float32)', function () {
      const root = compileSchemaValidator({ format: 'float' });

      assert.isTrue(root.validate(-FLOAT32_MAX), 'valid minimum for float');
      assert.isTrue(root.validate(FLOAT32_MIN), 'valid smalles float');
      assert.isTrue(root.validate(FLOAT32_MAX), 'a valid maximum for float');
      assert.isTrue(root.validate(Number(PI.toFixed(7))), 'PI as a 32bit float is valid');
      assert.isTrue(root.validate('3.1415'), 'a valid float32 as string is valid');
      assert.isFalse(root.validate(Float32_decrement(-FLOAT32_MAX)), 'an invalid minimum for float');
      assert.isFalse(root.validate(Float32_increment(FLOAT32_MAX)), 'an invalid maximum for float');
    });
    it('should validate format: \'double\' (float64)', function () {
      const root = compileSchemaValidator({ format: 'double' });

      assert.isTrue(root.validate(-FLOAT64_MAX), 'valid minimum for double');
      assert.isTrue(root.validate(FLOAT64_MIN), 'valid tiny for double');
      assert.isTrue(root.validate(FLOAT64_MAX), 'a valid maximum for double');
      assert.isTrue(root.validate(PI), 'PI as a 64bit float is valid');
      assert.isTrue(root.validate('3.1415'), 'a valid float64 as string is valid');
      assert.isFalse(root.validate(Float64_decrement(-FLOAT64_MAX)), 'an invalid minimum for double');
      assert.isFalse(root.validate(Float64_increment(FLOAT64_MAX)), 'an invalid maximum for double');
    });
  });
});
