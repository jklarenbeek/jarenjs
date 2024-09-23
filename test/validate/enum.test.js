import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  compileSchemaValidator,
} from '@jarenjs/validate';

describe('Schema Generics', function () {
  // https://json-schema.org/understanding-json-schema/reference/generic.html
  describe('#enums()', function () {
    it('should validate a string enum type', function () {
      const root = compileSchemaValidator({
        type: 'string',
        enum: ['red', 'amber', 'green'],
      });

      assert.isTrue(root.validate('amber'), 'amber is a valid enum value');
      assert.isFalse(root.validate('blue'), 'blue isn\'t a valid enum value');
    });

    it('should validate simple heterogeneous type', function () {
      const root = compileSchemaValidator({
        enum: ['red', 'amber', 'green', null, 42],
      });

      assert.isTrue(root.validate('red'), 'red is part of the collection');
      assert.isTrue(root.validate(null), 'its a null, which is part of the collection');
      assert.isFalse(root.validate(0), 'a zero is not ok!');
    });

    it('should validate string types only', function () {
      const root = compileSchemaValidator({
        type: 'string',
        enum: ['red', 'amber', 'green', null, 42],
      });

      assert.isTrue(root.validate('red'), 'red is a valid enum type');
      assert.isFalse(root.validate(null), 'null will not be accepted!');
    });

    it('should validate numbers only', function () {
      const root = compileSchemaValidator({ enum: [1, 2, 3] });

      assert.isTrue(root.validate(1), 'one member of enum is valid');
      assert.isFalse(root.validate(4), 'something else is invalid');
    });

    it('should deep validate heterogeneous types', function () {
      const root = compileSchemaValidator({ enum: [6, 'foo', [], true, { foo: 12 }] });

      assert.isTrue(root.validate([]), 'empty array is valid');
      assert.isFalse(root.validate([754, 285]), 'other array is invalid');
      assert.isFalse(root.validate(null), 'null is invalid');
      assert.isFalse(root.validate({ foo: false }), 'other object is invalid');
      assert.isTrue(root.validate({ foo: 12 }), 'same object is valid');
    });

    it('should validate enums in properties', function () {
      const root = compileSchemaValidator({
        type: 'object',
        properties: {
          foo: { enum: ['foo'] },
          bar: { enum: ['bar'] },
        },
        required: ['bar'],
      });

      assert.isTrue(root.validate({ foo: 'foo', bar: 'bar' }), 'both properties are valid');
      assert.isTrue(root.validate({ bar: 'bar' }), 'missing optional property is valid');
      assert.isFalse(root.validate({ foo: 'foo' }), 'missing required property is invalid');
      assert.isFalse(root.validate({}), 'missing all properties is invalid');
    });

    it('should validate enum with escaped characters', function () {
      const root = compileSchemaValidator({ enum: ['foo\nbar', 'foo\rbar'] });

      assert.isTrue(root.validate('foo\nbar'), 'member 1 is valid');
      assert.isTrue(root.validate('foo\rbar'), 'member 2 is valid');
      assert.isFalse(root.validate('abc'), 'another string is invalid');
    });

    it('should validate enum with false', function () {
      const root = compileSchemaValidator({ enum: [false] });

      assert.isTrue(root.validate(false), 'false is valid');
      assert.isFalse(root.validate(0), 'integer zero is invalid');
      assert.isFalse(root.validate('0'), 'string zero character is invalid');
    });

    it('should validate enum with true', function () {
      const root = compileSchemaValidator({ enum: [true] });

      assert.isTrue(root.validate(true), 'true is valid');
      assert.isFalse(root.validate(1), 'integer one is invalid');
      assert.isFalse(root.validate('1'), 'string one character is invalid');
    });

    it('should validate enum with number 0', function () {
      const root = compileSchemaValidator({ enum: [0] });

      assert.isTrue(root.validate(0), '0 is valid');
      assert.isFalse(root.validate(false), 'integer zero is invalid');
      assert.isFalse(root.validate('0'), 'string zero character is invalid');
    });

    it('should validate enum with true', function () {
      const root = compileSchemaValidator({ enum: [1] });

      assert.isTrue(root.validate(1), '1 is valid');
      assert.isFalse(root.validate(true), 'bool true is invalid');
      assert.isFalse(root.validate('1'), 'string one character is invalid');
    });

  });

  describe('#consts()', function () {
    it('should validate a constant number', function () {
      const root = compileSchemaValidator({ const: 2 });

      assert.isTrue(root.validate(2), 'same value is valid');
      assert.isFalse(root.validate(5), 'another value is invalid');
      assert.isFalse(root.validate('ABC'), 'another type is invalid');
    });

    it('should deep validate a constant object', function () {
      const root = compileSchemaValidator({
        const: { foo: 'bar', baz: 'bax' },
      });

      assert.isTrue(root.validate({ foo: 'bar', baz: 'bax' }), 'same object is valid');
      assert.isTrue(root.validate({ baz: 'bax', foo: 'bar' }), 'same object with different property order is valid');
      assert.isFalse(root.validate({ foo: 'bar' }), 'another object is invalid');
      assert.isFalse(root.validate([1, 2, 3]), 'another type is invalid');
    });

    it('should deep validate a constant array', function () {
      const root = compileSchemaValidator({
        const: [{ foo: 'bar' }],
      });

      assert.isTrue(root.validate([{ foo: 'bar' }]), 'same array is valid');
      assert.isFalse(root.validate([2]), 'another array item is invalid');
      assert.isFalse(root.validate([1, 2, 3]), 'array with additional items is invalid');
    });

    it('should validate a const null', function () {
      const root = compileSchemaValidator({ const: null });

      assert.isTrue(root.validate(null), 'null is valid');
      assert.isFalse(root.validate(0), 'not null is invalid');
    });

    it('should validate const with false', function () {
      const root = compileSchemaValidator({ const: false });

      assert.isTrue(root.validate(false), 'false is valid');
      assert.isFalse(root.validate(0), 'integer zero is invalid');
      assert.isFalse(root.validate('0'), 'string zero character is invalid');
    });

    it('should validate const with true', function () {
      const root = compileSchemaValidator({ const: true });

      assert.isTrue(root.validate(true), 'true is valid');
      assert.isFalse(root.validate(1), 'integer one is invalid');
      assert.isFalse(root.validate('1'), 'string one character is invalid');
    });

    it('should validate const with number 0', function () {
      const root = compileSchemaValidator({ const: 0 });

      assert.isTrue(root.validate(0), '0 is valid');
      assert.isFalse(root.validate(false), 'integer zero is invalid');
      assert.isFalse(root.validate('0'), 'string zero character is invalid');
    });

    it('should validate const with true', function () {
      const root = compileSchemaValidator({ const: 1 });

      assert.isTrue(root.validate(1), '1 is valid');
      assert.isFalse(root.validate(true), 'bool true is invalid');
      assert.isFalse(root.validate('1'), 'string one character is invalid');
    });

    // https://json-schema.org/understanding-json-schema/reference/generic.html#const
    it('should be a republic!', function () {
      const root = compileSchemaValidator({
        properties: {
          country: {
            const: 'Amsterdam',
          },
        },
      });

      assert.isTrue(root.validate({ country: 'Amsterdam' }), 'data === Amsterdam');
      assert.isFalse(root.validate({ country: 'The Netherlands' }), 'data != Amsterdam');
    });
  });

  describe.skip('#content()', function () {
    // https://json-schema.org/understanding-json-schema/reference/non_json_data.html
    const root = compileSchemaValidator({
      type: 'string',
      contentMediaType: 'text/html',
    });

    //
    assert.isTrue(root.validate('<!DOCTYPE html><html xmlns=\"http://www.w3.org/1999/xhtml\"><head></head></html>'), 'valid html');
  });

  describe.skip('#encode()', function () {
    // https://json-schema.org/understanding-json-schema/reference/non_json_data.html
    const root = compileSchemaValidator({
      type: 'string',
      contentEncoding: 'base64',
      contentMediaType: 'image/png',
    });

    //
    assert.isTrue(root.validate('iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAABmJLR0QA/wD/AP+gvaeTAAAA...'), 'base64 png image');
  });
});
