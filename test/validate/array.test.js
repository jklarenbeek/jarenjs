import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  compileSchemaValidator,
  JarenValidator,
} from '@jarenjs/validate';

// https://json-schema.org/understanding-json-schema/reference/type.html
const compiler = new JarenValidator();

describe('Schema Array Type', function () {
  describe('#arrayBasic()', function () {
    it('should throw an error when maxItems is smaller then minItems', function () {
      assert.throws(() => compiler.compile({
        type: 'array',
        minItems: 3,
        maxItems: 2,
      }));
    });

    it('should not exceed maxItems.', function () {
      const validate = compiler.compile({
        type: 'array',
        maxItems: 3,
      });

      assert.isFalse(validate('string'), 'a string is not allowed');
      assert.isFalse(validate({}), 'an object is not allowed');
      assert.isFalse(validate(75), 'a number is not allowed');
      assert.isTrue(validate([]), 'empty array is allowed');
      assert.isTrue(validate([1]), 'one item is valid');
      assert.isTrue(validate([1, 2]), 'two items are valid');
      assert.isTrue(validate([1, 2, 3]), 'max three items are valid');
      assert.isFalse(validate([1, 2, 3, 4]), 'four items are invalid');
    });

    it('should constraint length of array', function () {
      const validate = compiler.compile({
        type: 'array',
        minItems: 2,
        maxItems: 3,
      });

      assert.isFalse(validate({}), 'an object is not allowed');
      assert.isFalse(validate([]), 'empty array not allowed');
      assert.isFalse(validate([1]), 'one item is invalid');
      assert.isTrue(validate([1, 2]), 'min two items');
      assert.isTrue(validate([1, 2, 3]), 'min and max three items');
      assert.isFalse(validate([1, 2, 3, 4]), 'four items are invalid');
    });

    it('should ensure uniqueness of array', function () {
      const validate = compiler.compile({
        type: 'array',
        uniqueItems: true,
      });

      assert.isTrue(validate([1, 2, 3, 4, 5]), 'data is unique');
      assert.isFalse(validate([1, 2, 3, 4, 4]), 'data is not unique');
      assert.isTrue(validate([]), 'empty array passes');
    });

    it('should not trigger with a set as type', function () {
      const validate = compiler.compile({ type: 'set' });
      assert.isFalse(validate([]), 'does not validate an array');
      // assert.isTrue(validate(new Set([1,2,3,3,4,5])))
    });
  });

  describe('#arrayItems()', function () {
    it('should validate each item with a number', function () {
      const validate = compiler.compile({
        type: 'array',
        items: {
          type: 'number',
        },
      });

      assert.isTrue(validate([1, 2, 3, 4, 5]), 'array of numbers');
      assert.isFalse(validate([1, 2, '3', 4, 5]), 'A single “non-number” causes the whole array to be invalid');
      assert.isTrue(validate([]), 'an empty array is valid');
    });

    it('should validate max 3 items with a number', function () {
      const validate = compiler.compile({
        type: 'array',
        maxItems: 3,
        items: {
          type: 'number',
        },
      });

      assert.isTrue(validate([]), 'empty array');
      assert.isTrue(validate([1, 2]), 'array of 2 numbers');
      assert.isTrue(validate([1, 2, 3]), 'array with 3 numbers');
      assert.isFalse(validate([1, 2, 3, 4, 5]), 'array with 5 numbers');
      assert.isFalse(validate([1, 2, '3']), 'A single “non-number” causes the whole array to be invalid');
      assert.isFalse(validate([1, 2, 3, '4']), 'array with 4 numbers');
    });

    it('should validate min 2 and max 3 items with a number', function () {
      const validate = compiler.compile({
        type: 'array',
        minItems: 2,
        maxItems: 3,
        items: {
          type: 'number',
        },
      });

      assert.isFalse(validate([]), 'empty array is invalid');
      assert.isFalse(validate([1]), 'array with 1 number is invalid');
      assert.isTrue(validate([1, 2]), 'array of 2 numbers');
      assert.isTrue(validate([1, 2, 3]), 'array with 3 numbers');
      assert.isFalse(validate([1, 2, 3, 4, 5]), 'array with 5 numbers');
      assert.isFalse(validate([1, 2, '3']), 'A single “non-number” causes the whole array to be invalid');
      assert.isFalse(validate([1, 2, 3, '4']), 'array with 4 numbers');
    });

    it('should validate nested items', function () {
      const validate = compiler.compile({
        type: 'array',
        items: {
          type: 'array',
          items: {
            type: 'array',
            items: {
              type: 'array',
              items: {
                type: 'number',
              },
            },
          },
        },
      });

      assert.isTrue(validate([[[[1]], [[2], [3]]], [[[4], [5], [6]]]]),
        'valid nested array');
      assert.isFalse(validate([[[['1']], [[2], [3]]], [[[4], [5], [6]]]]),
        'nested array with invalid type');
      assert.isFalse(validate([[[1], [2], [3]], [[4], [5], [6]]]),
        'not deep enough');

    });

    it('should validate items with boolean schema true', function () {
      const validate = compiler.compile({ items: true });

      assert.isTrue(validate([1, 'foo', true]), 'any array is valid');
      assert.isTrue(validate([]), 'an empty array is valid');
      assert.isTrue(validate('string'), 'a string is valid');

    });

    it('should validate items with boolean schema false', function () {
      const validate = compiler.compile({ items: false });

      assert.isFalse(validate([1, 'foo', true]), 'a non-empty array is invalid');
      assert.isTrue(validate([]), 'an empty array is valid');

    });
  });

  describe('#arrayContains()', function () {
    it('can contain number to validate', function () {
      const validate = compiler.compile({
        contains: {
          type: 'number',
        },
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is valid');
      assert.isTrue(validate({}), 'object is ignored');
      assert.isTrue(validate(new Map([['a', 1]])), 'map is ignored');
      assert.isTrue(validate('validate this'), 'string is ignored');
      assert.isFalse(validate([]), 'an empty array is invalid');
      assert.isTrue(validate([1]), 'A single number is valid');
      assert.isTrue(validate([1, 2, 3, 4, 5]), 'All numbers is also okay');
      assert.isTrue(validate([1, 'foo']), 'a single number as first item is valid');
      assert.isTrue(validate(['life', 'universe', 'everything', 42]), 'A single number is enough to make this pass');
      assert.isFalse(validate(['life', 'universe', 'everything', 'forty-two']), 'But if we have no number, it fails');
      // assert.isFalse(validate({ '0': 'invalid', length: 1 }), 'Javascript pseudo array is valid');
    });

    it('should contain number to validate', function () {
      const validate = compiler.compile({
        type: 'array',
        contains: {
          type: 'number',
        },
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isFalse(validate(null), 'null is not allowed');
      assert.isFalse(validate({}), 'object is invalid');
      assert.isFalse(validate(new Map([['a', 1]])), 'map is invalid');
      assert.isFalse(validate('validate this'), 'string is invalid');
      assert.isFalse(validate([]), 'an empty array is invalid');
      assert.isTrue(validate([1]), 'A single number is valid');
      assert.isTrue(validate([1, 2, 3, 4, 5]), 'All numbers is also okay');
      assert.isTrue(validate([1, 'foo']), 'a single number as first item is valid');
      assert.isTrue(validate(['life', 'universe', 'everything', 42]), 'A single number is enough to make this pass');
      assert.isFalse(validate(['life', 'universe', 'everything', 'forty-two']), 'But if we have no number, it fails');
      // assert.isFalse(validate({ '0': 'invalid', length: 1 }), 'Javascript pseudo array is valid');
    });

    it('should contain a minimum of 5 to validate', function () {
      const validate = compiler.compile({ contains: { minimum: 5 } });

      assert.isTrue(validate([3, 4, 5]), 'last item 5 is valid');
      assert.isTrue(validate([3, 4, 6]), 'last item 6 is valid');
      assert.isTrue(validate([3, 4, 5, 6]), 'last two items are valid');
      assert.isFalse(validate([2, 3, 4]), 'no matching lower items');
      assert.isFalse(validate([]), 'empty array is invalid');
      assert.isTrue(validate({}), 'not array is valid');
    });

    it('should contains const of 5 to validate', function () {
      const validate = compiler.compile({ contains: { const: 5 } });

      assert.isTrue(validate([3, 4, 5]), 'array contains number 5');
      assert.isTrue(validate([3, 4, 5, 5]), 'array with two items 5 is valid');
      assert.isFalse(validate([1, 2, 3, 4]), 'array does not contain number 5');
    });

    it('should validate contains with boolean schema true', function () {
      const validate = compiler.compile({ contains: true });

      assert.isTrue(validate(['foo']), 'any non empty array is valid');
      assert.isFalse(validate([]), 'any empty array is invalid');
    });

    it('should validate contains with boolean schema false', function () {
      const validate = compiler.compile({ contains: false });

      assert.isFalse(validate(['foo']), 'any non empty array is invalid');
      assert.isFalse(validate([]), 'any empty array is invalid');
      assert.isTrue(validate('contains does not apply'), 'non-arrays are valid');
    });

    it('should validate schema with items + contains properties', function () {
      const validate = compiler.compile({
        items: { multipleOf: 2 },
        contains: { multipleOf: 3 },
      });

      assert.isFalse(validate([2, 4, 8]), 'matches items, does not match contains');
      assert.isFalse(validate([3, 6, 9]), 'does not match items, matches contains');
      assert.isTrue(validate([6, 12]), 'matches both items and contains');
      assert.isFalse(validate([1, 5]), 'matches neither items nor contains');
    });

    it('should ignore maxContains without contains', function () {
      const validate = compiler.compile({ maxContains: 1 });

      assert.isTrue(validate([1]), 'one item valid agains lone maxContains');
      assert.isTrue(validate([1, 2]), 'two items still valid against lone maxContains');

    });

    it('should validate maxContains with contains property in schema', function () {
      const validate = compiler.compile({
        contains: { const: 1 },
        maxContains: 1,
      });

      assert.isFalse(validate([]), 'empty array');
      assert.isTrue(validate([1]), 'all elements match, valid maxContains');
      assert.isFalse(validate([1, 1]), 'all elements match, invalid maxContains');
      assert.isTrue(validate([1, 2]), 'some elements match, valid maxContains');
      assert.isFalse(validate([1, 2, 1]), 'some elements match, invalid maxContains');
    });

    it('should ignore minContains without contains', function () {
      const validate = compiler.compile({ minContains: 1 });

      assert.isTrue(validate([1]), 'one item valid agains lone minContains');
      assert.isTrue(validate([]), 'zero items still valid against lone minContains');

    });

    it('should validate minContains with contains property in schema', function () {
      const validate = compiler.compile({
        contains: { const: 1 },
        minContains: 2,
      });

      assert.isFalse(validate([]), 'empty data with minContains = 2');
      assert.isFalse(validate([2]), 'no elements match, invalid minContains');
      assert.isFalse(validate([1]), 'all elements match, invalid minContains');
      assert.isFalse(validate([1, 2]), 'some elements match, invalid minContains');
      assert.isTrue(validate([1, 1]), 'all elements match, exact valid minContains');
      assert.isTrue(validate([1, 1, 1]), 'all elements match with more then valid minContains');
      assert.isTrue(validate([1, 2, 1]), 'some elements match with valid minContains');

    });

    it('should validate minContains = 0 with no maxContains', function () {
      const validate = compiler.compile({
        contains: { const: 1 },
        minContains: 0,
      });

      assert.isTrue(validate([]), 'empty data is valid');
      assert.isTrue(validate([2]), 'minContains = 0 makes contains alwats pass when valid');

    });

    it('should validate minContains = 0 with maxContains = 1', function () {
      const validate = compiler.compile({
        contains: { const: 1 },
        minContains: 0,
        maxContains: 1,
      });

      assert.isTrue(validate([]), 'empty data is valid with minContains = 0');
      assert.isTrue(validate([1]), 'valid since data is not more then maxContains');
      assert.isFalse(validate([1, 1]), 'to many items in array');
    });

    it('should validate minContains = maxContains', function () {
      const validate = compiler.compile({
        contains: { const: 1 },
        maxContains: 2,
        minContains: 2,
      });

      assert.isFalse(validate([]), 'empty array is invalid');
      assert.isFalse(validate([1]), 'all elements match, invalid minContains');
      assert.isFalse(validate([1, 1, 1]), 'all elements match, invalid maxContains');
      assert.isTrue(validate([1, 1]), 'all elements match, valid minContains and maxContains');

    });

    it('should not validate maxContains < minContains with contains in schema', function () {
      const validate = compiler.compile({
        contains: { const: 1 },
        maxContains: 1,
        minContains: 3,
      });

      assert.isFalse(validate([]), 'empty array is invalid');
      assert.isFalse(validate([1]), 'invalid minContains');
      assert.isFalse(validate([1, 1, 1]), 'invalid maxContains');
      assert.isFalse(validate([1, 1]), 'invalid maxContains and minContains');
    });

    it('should validate minContains < maxContains with contains in schema', function () {
      const validate = compiler.compile({
        contains: { const: 1 },
        minContains: 1,
        maxContains: 3,
      });

      assert.isFalse(validate([]), 'actual < minContains < maxContains');
      assert.isTrue(validate([1, 1]), 'minContains < actual < maxContains');
      assert.isFalse(validate([1, 1, 1, 1, 1]), 'minContains < maxContains < actual');

    });
  });

  describe('#tupleItems()', function () {
    it('should validate each item with number', function () {
      const validate = compiler.compile({
        type: 'array',
        items: [
          { type: 'integer' },
          { type: 'string' },
        ],
      });

      assert.isTrue(validate([]), 'empty array');
      assert.isTrue(validate([1]), 'incomplete array of items');
      assert.isTrue(validate([1, 'foo']), 'correct types');
      assert.isTrue(validate([1, 'foo', true]), 'array with additional items');
      assert.isFalse(validate(['foo', 1]), 'wrong types as elements of array');
      assert.isFalse(validate(['foo']), 'wrong type as first element');
      // assert.isTrue(validate({ '0': 'invalid', '1': 'valid', length: 2 }), 'Javascript pseudo-array is valid');
    });

    it('should validate with boolean schemas', function () {
      const validate = compiler.compile({ items: [true, false] });


      assert.isTrue(validate([1]), 'array with one item is valid');
      assert.isFalse(validate([1, 'foo']), 'array with two items is invalid');
      assert.isTrue(validate([]), 'empty array is valid');
    });
  });

  describe('#tupleAdditionalItems', function () {
    it('should ignore additionalItems when items are not present', function () {
      const validate = compiler.compile({
        additionalItems: { type: 'integer' },
      });

      assert.isTrue(validate([null, {}, 3, 'foo']), 'additional items is ignored');
    });

    it('should validate additionalItems by when single schema is present in tuple', function () {
      const validate = compiler.compile({
        items: [{}],
        additionalItems: false,
      });

      assert.isTrue(validate([null]), 'additional items match schema');
      assert.isFalse(validate(['foo', 'bar', 37]), 'additional items do not match schema');
      // TODO: more assertion
    });

    it('should validate additionalItems by when single schema is present in tuple', function () {
      const validate = compiler.compile({
        items: [{}],
        additionalItems: { type: 'null' },
      });

      assert.isTrue(validate([null]), 'allows null elements');
      assert.isFalse(validate([null, 2, 3, 4]), 'doesnt allow anything else');
    });

    it('should validate additionalItems by when single schema is present in tuple', function () {
      const validate = compiler.compile({
        items: [{}],
        additionalItems: { type: 'integer' },
      });

      assert.isTrue(validate([null, 2, 3, 4]), 'additional items match schema');
      assert.isFalse(validate([null, 2, 3, 'foo']), 'additional items do not match schema');
    });

    it('should ignore additionalItems when items is a schema', function () {
      const validate = compiler.compile({
        items: {
          type: 'integer',
        },
        additionalItems: {
          type: 'string',
        },
      });

      assert.isTrue(validate([1, 2, 3]), 'valid with an array of type integers');
      assert.isFalse(validate([null, 2, 3, 'foo']), 'invalid with an array of mixed types');
    });

    it('should ignore additionalItems when items is an empty schema', function () {
      const validate = compiler.compile({
        items: {},
        additionalItems: false,
      });

      assert.isTrue(validate([1, 2, 3, 5, 8]), 'all items match schema');
    });

    it('should validate an array of schemas with no additionalItems permitted', function () {
      const validate = compiler.compile({
        items: [{}, {}, {}],
        additionalItems: false,
      });

      assert.isTrue(validate([]), 'empty array');
      assert.isTrue(validate([1]), 'one item present');
      assert.isTrue(validate([1, 2]), 'two items present');
      assert.isTrue(validate([1, 2, 3]), 'three items present');
      assert.isTrue(validate([null, 3, 'foo']), 'mixed types of valid length');
      assert.isFalse(validate([1, 2, 3, 4]), 'four items present');
    });

    it('should validate additionalItems as false without items', function () {
      const validate = compiler.compile({
        additionalItems: false,
      });

      assert.isTrue(validate([1, 2, 3, 4, 5]), 'items defaults to empty schema so everything is valid');
      assert.isTrue(validate({ foo: 'bar' }), 'ignores non-arrays');
    });

    it('additionalItems does not look in applicators (wtf is an applicator?), valid case', function () {
      const validate = compiler.compile({
        allOf: [
          { items: [{ type: 'integer' }] },
        ],
        additionalItems: { type: 'boolean' },
      });

      assert.isTrue(validate([1, null]), 'items defined in allOf are not examined');
    });

    it('additionalItems does not look in applicators, invalid case', function () {
      const validate = compiler.compile({
        allOf: [
          { items: [{ type: 'integer' }, { type: 'string' }] },
        ],
        items: [{ type: 'integer' }],
        additionalItems: { type: 'boolean' },
      });

      assert.isFalse(validate([1, 'hi']), 'items defined in allOf are not examined');
    });

    it('items validation adjusts the starting index for additionalItems', function () {
      const validate = compiler.compile({
        items: [{ type: 'string' }],
        additionalItems: { type: 'integer' },
      });

      assert.isTrue(validate(['x', 2, 3]), 'valid items');
      assert.isFalse(validate(['x', 'y']), 'wrong type of second item');
    });

    it('it should validate an array with address items', function () {
      const validate = compiler.compile({
        type: 'array',
        items: [
          { type: 'number' },
          { type: 'string' },
          { type: 'string', enum: ['Street', 'Avenue', 'Boulevard'] },
          { type: 'string', enum: ['NW', 'NE', 'SW', 'SE'] },
        ],
      });

      assert.isTrue(validate([1600, 'Pennsylvania', 'Avenue', 'NW']), 'valid address');
      assert.isTrue(validate([10, 'Downing', 'Street']), 'does not need all items');
      assert.isTrue(validate([1600, 'Pennsylvania', 'Avenue', 'NW', 'Washington']), 'additionalItems is default true');
      assert.isFalse(validate([24, 'Sussex', 'Drive']), 'invalid value at item 3');
      assert.isFalse(validate(['Palais de l\'Élysée']), 'missing street number');
    });

    it('should not allow additionalItems to an address item', function () {
      const validate = compiler.compile({
        type: 'array',
        items: [
          { type: 'number' },
          { type: 'string' },
          { type: 'string', enum: ['Street', 'Avenue', 'Boulevard'] },
          { type: 'string', enum: ['NW', 'NE', 'SW', 'SE'] },
        ],
        additionalItems: false,
      });

      assert.isTrue(validate([1600, 'Pennsylvania', 'Avenue', 'NW']), 'valid address');
      assert.isTrue(validate([1600, 'Pennsylvania', 'Avenue']), 'not all fields are necessary');
      assert.isFalse(validate([1600, 'Pennsylvania', 'Avenue', 'NW', 'Washington']), 'do not allow additional items');
    });

    it('should allow a string schema for address items', function () {
      const validate = compiler.compile({
        type: 'array',
        items: [
          { type: 'number' },
          { type: 'string' },
          { type: 'string', enum: ['Street', 'Avenue', 'Boulevard'] },
          { type: 'string', enum: ['NW', 'NE', 'SW', 'SE'] },
        ],
        additionalItems: { type: 'string' },
      });

      assert.isTrue(validate([1600, 'Pennsylvania', 'Avenue', 'NW', 'Washington']), 'additional string items are ok');
      assert.isFalse(validate([1600, 'Pennsylvania', 'Avenue', 'NW', 20500]), 'but nothing else');
    });

  });

  describe('TODO:#arrayUnevaluatedItems()', function () {
    it('unevaluatedItems is true', function () {
      const validate = compiler.compile({
        unevaluatedItems: true,
      });

      assert.isTrue(validate([]), 'with no evaluated items');
      assert.isTrue(validate(['foo']), 'with unevaluated items');
    });

    it.skip('unevaluatedItems is false', function () {
      const validate = compiler.compile({
        unevaluatedItems: false,
      });

      assert.isTrue(validate(undefined), 'ignores undefined');
      assert.isTrue(validate(null), 'ignores null');
      assert.isTrue(validate(true), 'ignores boolean true');
      assert.isTrue(validate(false), 'ignores boolean false');
      assert.isTrue(validate(123), 'ignores integer');
      assert.isTrue(validate(1.23), 'ignores float');
      assert.isTrue(validate('string'), 'ignores string');
      assert.isTrue(validate({}), 'ignores object');
      assert.isTrue(validate([]), 'with no evaluated items');
      assert.isFalse(validate(['foo']), 'with unevaluated items');
    });

    it('unevaluatedItems as schema null', function () {
      const validate = compiler.compile({
        unevaluatedItems: {
          type: 'null',
        },
      });

      assert.isTrue(validate(null), 'with no evaluated items');
      // TODO: add more tests
    });

    it.skip('unevaluatedItems as schema string', function () {
      const validate = compiler.compile({
        unevaluatedItems: {
          type: 'string',
        },
      });

      assert.isTrue(validate([]), 'with no evaluated items');
      assert.isTrue(validate(['foo']), 'with valid unevaluated items');
      assert.isFalse(validate([42]), 'with invalid unevaluated items');
    });

    it('unevaluatedItems with uniform items', function () {
      const validate = compiler.compile({
        items: { type: 'string' },
        unevaluatedItems: false,
      });

      assert.isTrue(validate(['foo', 'bar']), 'unevaluated items doesnt apply');
    });

    it.skip('unevaluatedItems with tuple', function () {
      const validate = compiler.compile({
        items: [{ type: 'string' }],
        unevaluatedItems: false,
      });

      assert.isTrue(validate(['foo']), 'with no unevaluated items');
      assert.isFalse(validate(['foo', 'bar']), 'with unevaluated items');
    });

    it('unevaluatedItems with tuple and additionalItems', function () {
      const validate = compiler.compile({
        items: [{ type: 'string' }],
        additionalItems: true,
        unevaluatedItems: false,
      });

      assert.isTrue(validate(['foo', 42]), 'unevaluated items doesnt apply');
    });

    it.skip('unevaluatedItems with ignored additionalItems', function () {
      const validate = compiler.compile({
        additionalItems: { type: 'number' },
        unevaluatedItems: { type: 'string' },
      });

      assert.isFalse(validate(['foo', 42]), 'additionalItems is entirely ignored when items isnt present');
      assert.isTrue(validate(['foo', 'bar', 'baz']), 'all valid under unevaluatedItems');
    });

    it.skip('unevaluatedItems with ignored allOf additionalItems', function () {
      const validate = compiler.compile({
        allOf: [{ additionalItems: { type: 'number' } }],
        unevaluatedItems: { type: 'string' },
      });

      assert.isFalse(validate(['foo', 42]), 'additionalItems is entirely ignored when items isnt present');
      assert.isTrue(validate(['foo', 'bar', 'baz']), 'all valid under unevaluatedItems');
    });

    it.skip('unevaluatedItems with nested allOf tuple', function () {
      const validate = compiler.compile({
        items: [
          { type: 'string' },
        ],
        allOf: [
          {
            items: [
              true,
              { type: 'number' },
            ],
          },
        ],
        unevaluatedItems: false,
      });

      assert.isTrue(validate(['foo', 42]), 'with no unevaluated items');
      assert.isFalse(validate(['foo', 42, true]), 'with unevaluated items');
    });

    it.skip('unevaluatedItems with nested anyOf items', function () {
      const validate = compiler.compile({
        unevaluatedItems: { type: 'boolean' },
        anyOf: [
          { items: { type: 'string' } },
          true,
        ],
      });

      assert.isTrue(validate([true, false]), 'with only (valid) additional items');
      assert.isTrue(validate(['no', 'yes']), 'with no additional items');
      assert.isTrue(validate(['no', true]), 'with valid additional items');
      assert.isFalse(validate(['yes', false]), 'with invalid additional items');
    });

    it.skip('unevaluatedItems with nested allOf items and additionalItems', function () {
      const validate = compiler.compile({
        allOf: [
          {
            items: [
              { type: 'string' },
            ],
            additionalItems: true,
          },
        ],
        unevaluatedItems: false,
      });

      assert.isTrue(validate(['yes']), 'with no additional items');
      assert.isTrue(validate(['yes', 42, true]), 'with additional items');
    });

    it.skip('unevaluatedItems with nested allOf items and unevaluatedItems', function () {
      const validate = compiler.compile({
        allOf: [
          {
            items: [
              { type: 'string' },
            ],
          },
          { unevaluatedItems: true },
        ],
        unevaluatedItems: false,
      });

      assert.isTrue(validate(['yes']), 'with no additional items');
      assert.isTrue(validate(['yes', 42, true]), 'with additional items');
    });

    it.skip('unevaluatedItems with anyOf', function () {
      const validate = compiler.compile({
        items: [
          { const: 'foo' },
        ],
        anyOf: [
          {
            items: [
              true,
              { const: 'bar' },
            ],
          },
          {
            items: [
              true,
              true,
              { const: 'baz' },
            ],
          },
        ],
        unevaluatedItems: false,
      });

      assert.isTrue(validate(['foo', 'bar']), 'when one schema matches and has no unevaluated items');
      assert.isFalse(validate(['yes', 'no', 42]), 'when one schema matches and has unevaluated items');
      assert.isTrue(validate(['foo', 'bar', 'baz']), 'when two schemas match and has no unevaluated items');
      assert.isFalse(validate(['foo', 'bar', 'baz', 42]), 'when two schemas match and has unevaluated items');
    });

    it.skip('unevaluatedItems with oneOf', function () {
      const validate = compiler.compile({
        items: [
          { const: 'foo' },
        ],
        oneOf: [
          {
            items: [
              true,
              { const: 'bar' },
            ],
          },
          {
            items: [
              true,
              { const: 'baz' },
            ],
          },
        ],
        unevaluatedItems: false,
      });

      assert.isTrue(validate(['foo', 'bar']), 'with no unevaluated items');
      assert.isFalse(validate(['yes', 'no', 42]), 'with unevaluated items');
    });

    it.skip('unevaluatedItems with not', function () {
      const validate = compiler.compile({
        items: [
          { const: 'foo' },
        ],
        not: {
          not: {
            items: [
              true,
              { const: 'bar' },
            ],
          },
        },
        unevaluatedItems: false,
      });

      assert.isFalse(validate(['yes', 'no']), 'with unevaluated items');
    });

    it.skip('unevaluatedItems can see annotations from if without then and else', function () {
      const validate = compiler.compile({
        if: {
          items: [{ const: 'foo' }],
        },
        unevaluatedItems: false,
      });

      assert.isTrue(validate(['foo']), 'when if matches and it has no unevaluated items');
      assert.isFalse(validate(['bar']), 'invalid in case if is evaluated');
    });

    it.skip('unevaluatedItems with if/then/else', function () {
      const validate = compiler.compile({
        items: [{ const: 'foo' }],
        if: {
          items: [
            true,
            { const: 'bar' },
          ],
        },
        then: {
          items: [
            true,
            true,
            { const: 'then' },
          ],
        },
        else: {
          items: [
            true,
            true,
            true,
            { const: 'else' },
          ],
        },
        unevaluatedItems: false,
      });

      assert.isTrue(validate(['foo', 'bar', 'then']), 'when if matches and it has no unevaluated items');
      assert.isFalse(validate(['foo', 'bar', 'then', 'else']), 'when if matches and it has unevaluated items');
      assert.isTrue(validate(['foo', 21, 42, 'else']), 'when if doesnt match and it has no unevaluated items');
      assert.isFalse(validate(['foo', 21, 42, 'else', 64]), 'when if doesnt match and it has unevaluated items');
    });

    it.skip('unevaluatedItems with allof boolean true schemas', function () {
      const validate = compiler.compile({
        allOf: [true],
        unevaluatedItems: false,
      });

      assert.isTrue(validate([]), 'with no unevaluated items');
      assert.isFalse(validate(['foo']), 'with unevaluated item');
    });

    it.skip('unevaluatedItems with $ref', function () {
      const validate = compiler.compile({
        $ref: '#/$defs/bar',
        items: [
          { type: 'string' },
        ],
        unevaluatedItems: false,
        $defs: {
          bar: {
            items: [
              true,
              { type: 'string' },
            ],
          },
        },
      });

      assert.isTrue(validate(['foo', 'bar']), 'with no unevaluated items');
      assert.isFalse(validate(['foo', 'bar', 'baz']), 'with unevaluated item');
    });

    it.skip('unevaluatedItems before $ref', function () {
      const validate = compiler.compile({
        unevaluatedItems: false,
        items: [
          { type: 'string' },
        ],
        $ref: '#/$defs/bar',
        $defs: {
          bar: {
            items: [
              true,
              { type: 'string' },
            ],
          },
        },
      });

      assert.isTrue(validate(['foo', 'bar']), 'with no unevaluated items');
      assert.isFalse(validate(['foo', 'bar', 'baz']), 'with unevaluated item');
    });

    it.skip('should do something with unevaluated items', function () {
      const validate = compiler.compile({
        type: 'array',
        items: [
          { type: 'number' },
          { type: 'number' },
        ],
        unevaluatedItems: false,
        anyOf: [
          { items: [true, true, { type: 'number' }] },
          { items: [true, true, { type: 'boolean' }] },
        ],
      });

      assert.isTrue(validate([1, 2, 3]), 'tuple of 3 integers is valid');
      assert.isTrue(validate([1, 2, true]), 'tuple with 2 integers and a bool is valid ');
      assert.isFalse(validate([1, 2]), 'third item is not present');
      assert.isFalse(validate([1, 2, '3']), 'third item is unevaluated');
    });
  });

  describe('#arrayPrefixItems()', function () {
    it.skip('should not allow prefixItems and items to both be arrays (ignore items keyword).', function () {
      // only one of them can be a tuple.
    });
    it.skip('should ignore additionalItems', function () {
      // when prefix is defined as an array, additionalItems should not play a role.
    });
  
    it('a schema given for prefixItems', function () {
      const validate = compiler.compile({
        prefixItems: [
          { type: 'integer' },
          { type: 'string' },
        ]
      });

      assert.isTrue(validate([1, 'foo']), 'tuple of 2 valid');
      assert.isFalse(validate(['foo', 42]), 'wrong types');
      assert.isTrue(validate([1]), 'incomplete array of items');
      assert.isTrue(validate([1, 'foo', true]), 'array with additional items');
      assert.isTrue(validate([]), 'empty array');
      assert.isTrue(validate({ '0': 'invalid', '1': 'valid', length: 2 }), 'Javascript pseudo-array is valid');
    });

    it('should allow prefixItems with boolean schemas', function () {
      const validate = compiler.compile({
        prefixItems: [true, false]
      });

      assert.isTrue(validate([1]), 'tuple of 1 is valid');
      assert.isFalse(validate([1, 'foo']), 'tuple with two items is invalid');
      assert.isTrue(validate([]), 'empty tuple is valid');
    });

    it('should allow additional items by default', function () {
      const validate = compiler.compile({
        prefixItems: [{ 'type': 'integer' }]
      });

      assert.isTrue(validate([1, 'foo', false]), 'only the first item is valid');
      assert.isFalse(validate(['foo', false]), 'the first item is invalid');
    });

    it('should allow prefixItems with null instance elements', function () {
      const validate = compiler.compile({
        prefixItems: [{'type': 'null' }]
      });

      assert.isTrue(validate([null]), 'allow null element');
      assert.isTrue(validate([null, 1]), 'first element is null with additional items');
      assert.isFalse(validate([1, null]), 'second element is null with additional items');
    })
  });
});
