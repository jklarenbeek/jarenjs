import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  JarenValidator,
} from '@jarenjs/validate';

const compiler = new JarenValidator();

describe('Schema Generics', function () {
  // https://json-schema.org/understanding-json-schema/reference/generic.html
  describe('#enums()', function () {
    it('should validate a string enum type', function () {
      const validate = compiler.compile({
        type: 'string',
        enum: ['red', 'amber', 'green'],
      });

      assert.isTrue(validate('amber'), 'amber is a valid enum value');
      assert.isFalse(validate('blue'), 'blue isn\'t a valid enum value');
    });

    it('should validate simple heterogeneous type', function () {
      const validate = compiler.compile({
        enum: ['red', 'amber', 'green', null, 42],
      });

      assert.isTrue(validate('red'), 'red is part of the collection');
      assert.isTrue(validate(null), 'its a null, which is part of the collection');
      assert.isFalse(validate(0), 'a zero is not ok!');
    });

    it('should validate string types only', function () {
      const validate = compiler.compile({
        type: 'string',
        enum: ['red', 'amber', 'green', null, 42],
      });

      assert.isTrue(validate('red'), 'red is a valid enum type');
      assert.isFalse(validate(null), 'null will not be accepted!');
    });

    it('should validate numbers only', function () {
      const validate = compiler.compile({ enum: [1, 2, 3] });

      assert.isTrue(validate(1), 'one member of enum is valid');
      assert.isFalse(validate(4), 'something else is invalid');
    });

    it('should deep validate heterogeneous types', function () {
      const validate = compiler.compile({ enum: [6, 'foo', [], true, { foo: 12 }] });

      assert.isTrue(validate([]), 'empty array is valid');
      assert.isFalse(validate([754, 285]), 'other array is invalid');
      assert.isFalse(validate(null), 'null is invalid');
      assert.isFalse(validate({ foo: false }), 'other object is invalid');
      assert.isTrue(validate({ foo: 12 }), 'same object is valid');
    });

    it('should validate enums in properties', function () {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          foo: { enum: ['foo'] },
          bar: { enum: ['bar'] },
        },
        required: ['bar'],
      });

      assert.isTrue(validate({ foo: 'foo', bar: 'bar' }), 'both properties are valid');
      assert.isTrue(validate({ bar: 'bar' }), 'missing optional property is valid');
      assert.isFalse(validate({ foo: 'foo' }), 'missing required property is invalid');
      assert.isFalse(validate({}), 'missing all properties is invalid');
    });

    it('should validate enum with escaped characters', function () {
      const validate = compiler.compile({ enum: ['foo\nbar', 'foo\rbar'] });

      assert.isTrue(validate('foo\nbar'), 'member 1 is valid');
      assert.isTrue(validate('foo\rbar'), 'member 2 is valid');
      assert.isFalse(validate('abc'), 'another string is invalid');
    });

    it('should validate enum with false', function () {
      const validate = compiler.compile({ enum: [false] });

      assert.isTrue(validate(false), 'false is valid');
      assert.isFalse(validate(0), 'integer zero is invalid');
      assert.isFalse(validate('0'), 'string zero character is invalid');
    });

    it('should validate enum with true', function () {
      const validate = compiler.compile({ enum: [true] });

      assert.isTrue(validate(true), 'true is valid');
      assert.isFalse(validate(1), 'integer one is invalid');
      assert.isFalse(validate('1'), 'string one character is invalid');
    });

    it('should validate enum with number 0', function () {
      const validate = compiler.compile({ enum: [0] });

      assert.isTrue(validate(0), '0 is valid');
      assert.isFalse(validate(false), 'integer zero is invalid');
      assert.isFalse(validate('0'), 'string zero character is invalid');
    });

    it('should validate enum with true', function () {
      const validate = compiler.compile({ enum: [1] });

      assert.isTrue(validate(1), '1 is valid');
      assert.isFalse(validate(true), 'bool true is invalid');
      assert.isFalse(validate('1'), 'string one character is invalid');
    });

  });

  describe('#consts()', function () {
    it('should validate a constant number', function () {
      const validate = compiler.compile({ const: 2 });

      assert.isTrue(validate(2), 'same value is valid');
      assert.isFalse(validate(5), 'another value is invalid');
      assert.isFalse(validate('ABC'), 'another type is invalid');
    });

    it('should deep validate a constant object', function () {
      const validate = compiler.compile({
        const: { foo: 'bar', baz: 'bax' },
      });

      assert.isTrue(validate({ foo: 'bar', baz: 'bax' }), 'same object is valid');
      assert.isTrue(validate({ baz: 'bax', foo: 'bar' }), 'same object with different property order is valid');
      assert.isFalse(validate({ foo: 'bar' }), 'another object is invalid');
      assert.isFalse(validate([1, 2, 3]), 'another type is invalid');
    });

    it('should deep validate a constant array', function () {
      const validate = compiler.compile({
        const: [{ foo: 'bar' }],
      });

      assert.isTrue(validate([{ foo: 'bar' }]), 'same array is valid');
      assert.isFalse(validate([2]), 'another array item is invalid');
      assert.isFalse(validate([1, 2, 3]), 'array with additional items is invalid');
    });

    it('should validate a const null', function () {
      const validate = compiler.compile({ const: null });

      assert.isTrue(validate(null), 'null is valid');
      assert.isFalse(validate(0), 'not null is invalid');
    });

    it('should validate const with false', function () {
      const validate = compiler.compile({ const: false });

      assert.isTrue(validate(false), 'false is valid');
      assert.isFalse(validate(0), 'integer zero is invalid');
      assert.isFalse(validate('0'), 'string zero character is invalid');
    });

    it('should validate const with true', function () {
      const validate = compiler.compile({ const: true });

      assert.isTrue(validate(true), 'true is valid');
      assert.isFalse(validate(1), 'integer one is invalid');
      assert.isFalse(validate('1'), 'string one character is invalid');
    });

    it('should validate const with number 0', function () {
      const validate = compiler.compile({ const: 0 });

      assert.isTrue(validate(0), '0 is valid');
      assert.isFalse(validate(false), 'integer zero is invalid');
      assert.isFalse(validate('0'), 'string zero character is invalid');
    });

    it('should validate const with true', function () {
      const validate = compiler.compile({ const: 1 });

      assert.isTrue(validate(1), '1 is valid');
      assert.isFalse(validate(true), 'bool true is invalid');
      assert.isFalse(validate('1'), 'string one character is invalid');
    });

    // https://json-schema.org/understanding-json-schema/reference/generic.html#const
    it('should be a republic!', function () {
      const validate = compiler.compile({
        properties: {
          country: {
            const: 'Amsterdam',
          },
        },
      });

      assert.isTrue(validate({ country: 'Amsterdam' }), 'data === Amsterdam');
      assert.isFalse(validate({ country: 'The Netherlands' }), 'data != Amsterdam');
    });
  });

  describe.skip('#content()', function () {
    // https://json-schema.org/understanding-json-schema/reference/non_json_data.html
    const validate = compiler.compile({
      type: 'string',
      contentMediaType: 'text/html',
    });

    //
    assert.isTrue(validate('<!DOCTYPE html><html xmlns=\"http://www.w3.org/1999/xhtml\"><head></head></html>'), 'valid html');
  });

  describe.skip('#encode()', function () {
    // https://json-schema.org/understanding-json-schema/reference/non_json_data.html
    const validate = compiler.compile({
      type: 'string',
      contentEncoding: 'base64',
      contentMediaType: 'image/png',
    });

    //
    assert.isTrue(validate('iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAABmJLR0QA/wD/AP+gvaeTAAAA...'), 'base64 png image');
  });
});
