import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

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
} from '@jarenjs/core/float';

import {
  INT64_MAX,
  INT64_MIN,
  UINT64_MAX,
  UINT64_MIN,
} from '@jarenjs/core/integer';

import {
  compileSchemaValidator,
  registerFormatCompilers,
  ValidatorOptions
} from '@jarenjs/validate';

import * as formats from '@jarenjs/formats';

const options = new ValidatorOptions(
  registerFormatCompilers({}, formats.numberFormats)
)

// https://json-schema.org/understanding-json-schema/reference/numeric.html

describe('Schema Numeric Formats', function () {

  describe('#formatInteger()', function () {

    it('should validate format: \'int8\'', function () {
      const root = compileSchemaValidator({
        format: 'int8'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is valid');
      assert.isTrue(root.validate(-128), 'valid minimum for int8');
      assert.isTrue(root.validate(127), 'a valid maximum for int8');
      assert.isTrue(root.validate('12'), 'a valid int8 as string is valid');
      assert.isFalse(root.validate(Number('NaN')), 'NaN is not valid');
      assert.isFalse(root.validate(-129), 'an invalid minimum for int8');
      assert.isFalse(root.validate(128), 'an invalid maximum for int8');
    });
    it('should validate format: \'uint8\'', function () {
      const root = compileSchemaValidator({
        format: 'uint8'
      }, options);

      assert.isTrue(root.validate(0), 'valid minimum for uint8');
      assert.isTrue(root.validate(255), 'a valid maximum for uint8');
      assert.isTrue(root.validate('12'), 'a valid uint8 as string is valid');
      assert.isFalse(root.validate(Number('NaN')), 'NaN is not valid');
      assert.isFalse(root.validate(-1), 'an invalid minimum for uint8');
      assert.isFalse(root.validate(256), 'an invalid maximum for uint8');
    });
    it('should validate format: \'int16\'', function () {
      const root = compileSchemaValidator({
        format: 'int16'
      }, options);

      assert.isTrue(root.validate(-32768), 'valid minimum for int16');
      assert.isTrue(root.validate(32767), 'a valid maximum for int16');
      assert.isTrue(root.validate('12'), 'a valid int16 as string is valid');
      assert.isFalse(root.validate(Number('NaN')), 'NaN is not valid');
      assert.isFalse(root.validate(-32769), 'an invalid minimum for int16');
      assert.isFalse(root.validate(32768), 'an invalid maximum for int16');
    });
    it('should validate format: \'uint16\'', function () {
      const root = compileSchemaValidator({
        format: 'uint16'
      }, options);

      assert.isTrue(root.validate(0), 'valid minimum for uint16');
      assert.isTrue(root.validate(65535), 'a valid maximum for uint16');
      assert.isTrue(root.validate('12'), 'a valid uint16 as string is valid');
      assert.isFalse(root.validate(Number('NaN')), 'NaN is not valid');
      assert.isFalse(root.validate(-1), 'an invalid minimum for uint16');
      assert.isFalse(root.validate(65536), 'an invalid maximum for uint16');
    });
    it('should validate format: \'int32\'', function () {
      const root = compileSchemaValidator({
        format: 'int32'
      }, options);

      assert.isTrue(root.validate(-2147483648), 'valid minimum for int32');
      assert.isTrue(root.validate(2147483647), 'a valid maximum for int32');
      assert.isTrue(root.validate('12'), 'a valid int32 as string is valid');
      assert.isFalse(root.validate(Number('NaN')), 'NaN is not valid');
      assert.isFalse(root.validate(-2147483649), 'an invalid minimum for int32');
      assert.isFalse(root.validate(2147483648), 'an invalid maximum for int32');

    });
    it('should validate format: \'uint32\'', function () {
      const root = compileSchemaValidator({
        format: 'uint32'
      }, options);

      assert.isTrue(root.validate(0), 'valid minimum for uint32');
      assert.isTrue(root.validate(4294967295), 'a valid maximum for uint32');
      assert.isTrue(root.validate('12'), 'a valid uint32 as string is valid');
      assert.isFalse(root.validate(Number('NaN')), 'NaN is not valid');
      assert.isFalse(root.validate(-1), 'an invalid minimum for uint32');
      assert.isFalse(root.validate(4294967296), 'an invalid maximum for uint32');

    });
    it('should validate format: \'int64\'', function () {
      const root = compileSchemaValidator({
        format: 'int64'
      }, options);

      assert.isTrue(root.validate(INT64_MIN), 'valid minimum for int64');
      assert.isTrue(root.validate(INT64_MAX), 'a valid maximum for int64');
      assert.isTrue(root.validate('12'), 'a valid int64 as string is valid');
      assert.isFalse(root.validate(Number('NaN')), 'NaN is not valid');
      assert.isFalse(root.validate(INT64_MIN - 1), 'an invalid minimum for int64');
      assert.isFalse(root.validate(INT64_MAX + 1), 'an invalid maximum for int64');
    });
    it('should validate format: \'uint64\'', function () {
      const root = compileSchemaValidator({
        format: 'uint64'
      }, options);

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
      const root = compileSchemaValidator({
        format: 'float16'
      }, options);

      assert.isTrue(root.validate(-FLOAT16_MAX), 'valid minimum for float16');
      assert.isTrue(root.validate(FLOAT16_MIN), 'valid smalles float16');
      assert.isTrue(root.validate(FLOAT16_MAX), 'a valid maximum for float16');
      assert.isTrue(root.validate('3.1415'), 'a valid float16 as string is valid');
      assert.isFalse(root.validate(Number('NaN')), 'NaN is not valid');
      assert.isFalse(root.validate(Float16_decrement(-FLOAT16_MAX)), 'an invalid minimum for float16');
      assert.isFalse(root.validate(Float16_increment(FLOAT16_MAX)), 'an invalid maximum for float16');
    });
    it('should validate format: \'float\' (float32)', function () {
      const root = compileSchemaValidator({
        format: 'float'
      }, options);

      assert.isTrue(root.validate(-FLOAT32_MAX), 'valid minimum for float');
      assert.isTrue(root.validate(FLOAT32_MIN), 'valid smalles float');
      assert.isTrue(root.validate(FLOAT32_MAX), 'a valid maximum for float');
      assert.isTrue(root.validate(Number(PI.toFixed(7))), 'PI as a 32bit float is valid');
      assert.isTrue(root.validate('3.1415'), 'a valid float32 as string is valid');
      assert.isFalse(root.validate(Float32_decrement(-FLOAT32_MAX)), 'an invalid minimum for float');
      assert.isFalse(root.validate(Float32_increment(FLOAT32_MAX)), 'an invalid maximum for float');
    });
    it('should validate format: \'double\' (float64)', function () {
      const root = compileSchemaValidator({
        format: 'double'
      }, options);

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
