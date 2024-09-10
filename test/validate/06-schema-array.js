import { describe, it } from 'node:test';
import * as assert from '@jaren/tools/assert';

import {
  compileSchemaValidator,
} from '@jaren/validate';

// https://json-schema.org/understanding-json-schema/reference/type.html

describe('Schema Array Type', function () {
  describe('#arrayBasic()', function () {
    it('should not exceed maxItems.', function () {
      const root = compileSchemaValidator({
        type: 'array',
        maxItems: 3,
      });

      assert.isFalse(root.validate('string'), 'a string is not allowed');
      assert.isFalse(root.validate({}), 'an object is not allowed');
      assert.isFalse(root.validate(75), 'a number is not allowed');
      assert.isTrue(root.validate([]), 'empty array is allowed');
      assert.isTrue(root.validate([1]), 'one item is valid');
      assert.isTrue(root.validate([1, 2]), 'two items are valid');
      assert.isTrue(root.validate([1, 2, 3]), 'max three items are valid');
      assert.isFalse(root.validate([1, 2, 3, 4]), 'four items are invalid');
    });

    it('should constraint length of array', function () {
      const root = compileSchemaValidator({
        type: 'array',
        minItems: 2,
        maxItems: 3,
      });

      assert.isFalse(root.validate({}), 'an object is not allowed');
      assert.isFalse(root.validate([]), 'empty array not allowed');
      assert.isFalse(root.validate([1]), 'one item is invalid');
      assert.isTrue(root.validate([1, 2]), 'min two items');
      assert.isTrue(root.validate([1, 2, 3]), 'min and max three items');
      assert.isFalse(root.validate([1, 2, 3, 4]), 'four items are invalid');
    });

    it('should ensure uniqueness of array', function () {
      const root = compileSchemaValidator({
        type: 'array',
        uniqueItems: true,
      });

      assert.isTrue(root.validate([1, 2, 3, 4, 5]), 'data is unique');
      assert.isFalse(root.validate([1, 2, 3, 4, 4]), 'data is not unique');
      assert.isTrue(root.validate([]), 'empty array passes');
    });

    it('should not trigger with a set as type', function () {
      const root = compileSchemaValidator({ type: 'set' });
      assert.isFalse(root.validate([]), 'does not validate an array');
      // assert.isTrue(root.validate(new Set([1,2,3,3,4,5])))
    });
  });

  describe('#arrayItems()', function () {
    it('should validate each item with a number', function () {
      const root = compileSchemaValidator({
        type: 'array',
        items: {
          type: 'number',
        },
      });

      assert.isTrue(root.validate([1, 2, 3, 4, 5]), 'array of numbers');
      assert.isFalse(root.validate([1, 2, '3', 4, 5]), 'A single “non-number” causes the whole array to be invalid');
      assert.isTrue(root.validate([]), 'an empty array is valid');
    });

    it('should validate max 3 items with a number', function () {
      const root = compileSchemaValidator({
        type: 'array',
        maxItems: 3,
        items: {
          type: 'number',
        },
      });

      assert.isTrue(root.validate([]), 'empty array');
      assert.isTrue(root.validate([1, 2]), 'array of 2 numbers');
      assert.isTrue(root.validate([1, 2, 3]), 'array with 3 numbers');
      assert.isFalse(root.validate([1, 2, 3, 4, 5]), 'array with 5 numbers');
      assert.isFalse(root.validate([1, 2, '3']), 'A single “non-number” causes the whole array to be invalid');
      assert.isFalse(root.validate([1, 2, 3, '4']), 'array with 4 numbers');
    });

    it('should validate min 2 and max 3 items with a number', function () {
      const root = compileSchemaValidator({
        type: 'array',
        minItems: 2,
        maxItems: 3,
        items: {
          type: 'number',
        },
      });

      assert.isFalse(root.validate([]), 'empty array is invalid');
      assert.isFalse(root.validate([1]), 'array with 1 number is invalid');
      assert.isTrue(root.validate([1, 2]), 'array of 2 numbers');
      assert.isTrue(root.validate([1, 2, 3]), 'array with 3 numbers');
      assert.isFalse(root.validate([1, 2, 3, 4, 5]), 'array with 5 numbers');
      assert.isFalse(root.validate([1, 2, '3']), 'A single “non-number” causes the whole array to be invalid');
      assert.isFalse(root.validate([1, 2, 3, '4']), 'array with 4 numbers');
    });

    it('should validate nested items', function () {
      const root = compileSchemaValidator({
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

      assert.isTrue(root.validate([[[[1]], [[2], [3]]], [[[4], [5], [6]]]]),
        'valid nested array');
      assert.isFalse(root.validate([[[['1']], [[2], [3]]], [[[4], [5], [6]]]]),
        'nested array with invalid type');
      assert.isFalse(root.validate([[[1], [2], [3]], [[4], [5], [6]]]),
        'not deep enough');

    });

    it('should validate items with boolean schema true', function () {
      const root = compileSchemaValidator({ items: true });

      assert.isTrue(root.validate([1, 'foo', true]), 'any array is valid');
      assert.isTrue(root.validate([]), 'an empty array is valid');
      assert.isTrue(root.validate('string'), 'a string is valid');

    });

    it('should validate items with boolean schema false', function () {
      const root = compileSchemaValidator({ items: false });

      assert.isFalse(root.validate([1, 'foo', true]), 'a non-empty array is invalid');
      assert.isTrue(root.validate([]), 'an empty array is valid');

    });
  });

  describe('#arrayContains()', function () {
    it('can contain number to validate', function () {
      const root = compileSchemaValidator({
        contains: {
          type: 'number',
        },
      });

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is valid');
      assert.isTrue(root.validate({}), 'object is ignored');
      assert.isTrue(root.validate(new Map([['a', 1]])), 'map is ignored');
      assert.isTrue(root.validate('validate this'), 'string is ignored');
      assert.isFalse(root.validate([]), 'an empty array is invalid');
      assert.isTrue(root.validate([1]), 'A single number is valid');
      assert.isTrue(root.validate([1, 2, 3, 4, 5]), 'All numbers is also okay');
      assert.isTrue(root.validate([1, 'foo']), 'a single number as first item is valid');
      assert.isTrue(root.validate(['life', 'universe', 'everything', 42]), 'A single number is enough to make this pass');
      assert.isFalse(root.validate(['life', 'universe', 'everything', 'forty-two']), 'But if we have no number, it fails');
      // assert.isFalse(root.validate({ '0': 'invalid', length: 1 }), 'Javascript pseudo array is valid');
    });

    it('should contain number to validate', function () {
      const root = compileSchemaValidator({
        type: 'array',
        contains: {
          type: 'number',
        },
      });

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isFalse(root.validate(null), 'null is not allowed');
      assert.isFalse(root.validate({}), 'object is invalid');
      assert.isFalse(root.validate(new Map([['a', 1]])), 'map is invalid');
      assert.isFalse(root.validate('validate this'), 'string is invalid');
      assert.isFalse(root.validate([]), 'an empty array is invalid');
      assert.isTrue(root.validate([1]), 'A single number is valid');
      assert.isTrue(root.validate([1, 2, 3, 4, 5]), 'All numbers is also okay');
      assert.isTrue(root.validate([1, 'foo']), 'a single number as first item is valid');
      assert.isTrue(root.validate(['life', 'universe', 'everything', 42]), 'A single number is enough to make this pass');
      assert.isFalse(root.validate(['life', 'universe', 'everything', 'forty-two']), 'But if we have no number, it fails');
      // assert.isFalse(root.validate({ '0': 'invalid', length: 1 }), 'Javascript pseudo array is valid');
    });

    it('should contain a minimum of 5 to validate', function () {
      const root = compileSchemaValidator({ contains: { minimum: 5 } });

      assert.isTrue(root.validate([3, 4, 5]), 'last item 5 is valid');
      assert.isTrue(root.validate([3, 4, 6]), 'last item 6 is valid');
      assert.isTrue(root.validate([3, 4, 5, 6]), 'last two items are valid');
      assert.isFalse(root.validate([2, 3, 4]), 'no matching lower items');
      assert.isFalse(root.validate([]), 'empty array is invalid');
      assert.isTrue(root.validate({}), 'not array is valid');
    });

    it('should contains const of 5 to validate', function () {
      const root = compileSchemaValidator({ contains: { const: 5 } });

      assert.isTrue(root.validate([3, 4, 5]), 'array contains number 5');
      assert.isTrue(root.validate([3, 4, 5, 5]), 'array with two items 5 is valid');
      assert.isFalse(root.validate([1, 2, 3, 4]), 'array does not contain number 5');
    });

    it('should validate contains with boolean schema true', function () {
      const root = compileSchemaValidator({ contains: true });

      assert.isTrue(root.validate(['foo']), 'any non empty array is valid');
      assert.isFalse(root.validate([]), 'any empty array is invalid');
    });

    it('should validate contains with boolean schema false', function () {
      const root = compileSchemaValidator({ contains: false });

      assert.isFalse(root.validate(['foo']), 'any non empty array is invalid');
      assert.isFalse(root.validate([]), 'any empty array is invalid');
      assert.isTrue(root.validate('contains does not apply'), 'non-arrays are valid');
    });

    it('should validate schema with items + contains properties', function () {
      const root = compileSchemaValidator({
        items: { multipleOf: 2 },
        contains: { multipleOf: 3 },
      });

      assert.isFalse(root.validate([2, 4, 8]), 'matches items, does not match contains');
      assert.isFalse(root.validate([3, 6, 9]), 'does not match items, matches contains');
      assert.isTrue(root.validate([6, 12]), 'matches both items and contains');
      assert.isFalse(root.validate([1, 5]), 'matches neither items nor contains');
    });

    it('should ignore maxContains without contains', function () {
      const root = compileSchemaValidator({ maxContains: 1 });

      assert.isTrue(root.validate([1]), 'one item valid agains lone maxContains');
      assert.isTrue(root.validate([1, 2]), 'two items still valid against lone maxContains');

    });

    it('should validate maxContains with contains property in schema', function () {
      const root = compileSchemaValidator({
        contains: { const: 1 },
        maxContains: 1,
      });

      assert.isFalse(root.validate([]), 'empty array');
      assert.isTrue(root.validate([1]), 'all elements match, valid maxContains');
      assert.isFalse(root.validate([1, 1]), 'all elements match, invalid maxContains');
      assert.isTrue(root.validate([1, 2]), 'some elements match, valid maxContains');
      assert.isFalse(root.validate([1, 2, 1]), 'some elements match, invalid maxContains');
    });

    it('should ignore minContains without contains', function () {
      const root = compileSchemaValidator({ minContains: 1 });

      assert.isTrue(root.validate([1]), 'one item valid agains lone minContains');
      assert.isTrue(root.validate([]), 'zero items still valid against lone minContains');

    });

    it('should validate minContains with contains property in schema', function () {
      const root = compileSchemaValidator({
        contains: { const: 1 },
        minContains: 2,
      });

      assert.isFalse(root.validate([]), 'empty data with minContains = 2');
      assert.isFalse(root.validate([2]), 'no elements match, invalid minContains');
      assert.isFalse(root.validate([1]), 'all elements match, invalid minContains');
      assert.isFalse(root.validate([1, 2]), 'some elements match, invalid minContains');
      assert.isTrue(root.validate([1, 1]), 'all elements match, exact valid minContains');
      assert.isTrue(root.validate([1, 1, 1]), 'all elements match with more then valid minContains');
      assert.isTrue(root.validate([1, 2, 1]), 'some elements match with valid minContains');

    });

    it('should validate minContains = 0 with no maxContains', function () {
      const root = compileSchemaValidator({
        contains: { const: 1 },
        minContains: 0,
      });

      assert.isTrue(root.validate([]), 'empty data is valid');
      assert.isTrue(root.validate([2]), 'minContains = 0 makes contains alwats pass when valid');

    });

    it('should validate minContains = 0 with maxContains = 1', function () {
      const root = compileSchemaValidator({
        contains: { const: 1 },
        minContains: 0,
        maxContains: 1,
      });

      assert.isTrue(root.validate([]), 'empty data is valid with minContains = 0');
      assert.isTrue(root.validate([1]), 'valid since data is not more then maxContains');
      assert.isFalse(root.validate([1, 1]), 'to many items in array');
    });

    it('should validate minContains = maxContains', function () {
      const root = compileSchemaValidator({
        contains: { const: 1 },
        maxContains: 2,
        minContains: 2,
      });

      assert.isFalse(root.validate([]), 'empty array is invalid');
      assert.isFalse(root.validate([1]), 'all elements match, invalid minContains');
      assert.isFalse(root.validate([1, 1, 1]), 'all elements match, invalid maxContains');
      assert.isTrue(root.validate([1, 1]), 'all elements match, valid minContains and maxContains');

    });

    it('should not validate maxContains < minContains with contains in schema', function () {
      const root = compileSchemaValidator({
        contains: { const: 1 },
        maxContains: 1,
        minContains: 3,
      });

      assert.isFalse(root.validate([]), 'empty array is invalid');
      assert.isFalse(root.validate([1]), 'invalid minContains');
      assert.isFalse(root.validate([1, 1, 1]), 'invalid maxContains');
      assert.isFalse(root.validate([1, 1]), 'invalid maxContains and minContains');
    });

    it('should validate minContains < maxContains with contains in schema', function () {
      const root = compileSchemaValidator({
        contains: { const: 1 },
        minContains: 1,
        maxContains: 3,
      });

      assert.isFalse(root.validate([]), 'actual < minContains < maxContains');
      assert.isTrue(root.validate([1, 1]), 'minContains < actual < maxContains');
      assert.isFalse(root.validate([1, 1, 1, 1, 1]), 'minContains < maxContains < actual');

    });
  });

  describe('#tupleItems()', function () {
    it('should validate each item with number', function () {
      const root = compileSchemaValidator({
        type: 'array',
        items: [
          { type: 'integer' },
          { type: 'string' },
        ],
      });

      assert.isTrue(root.validate([]), 'empty array');
      assert.isTrue(root.validate([1]), 'incomplete array of items');
      assert.isTrue(root.validate([1, 'foo']), 'correct types');
      assert.isTrue(root.validate([1, 'foo', true]), 'array with additional items');
      assert.isFalse(root.validate(['foo', 1]), 'wrong types as elements of array');
      assert.isFalse(root.validate(['foo']), 'wrong type as first element');
      // assert.isTrue(root.validate({ '0': 'invalid', '1': 'valid', length: 2 }), 'Javascript pseudo-array is valid');
    });

    it('should validate with boolean schemas', function () {
      const root = compileSchemaValidator({ items: [true, false] });


      assert.isTrue(root.validate([1]), 'array with one item is valid');
      assert.isFalse(root.validate([1, 'foo']), 'array with two items is invalid');
      assert.isTrue(root.validate([]), 'empty array is valid');
    });
  });

  describe('#tupleAdditionalItems', function () {
    it('should ignore additionalItems when items are not present', function () {
      const root = compileSchemaValidator({
        additionalItems: { type: 'integer' },
      });

      assert.isTrue(root.validate([null, {}, 3, 'foo']), 'additional items is ignored');
    });

    it('should validate additionalItems by when single schema is present in tuple', function () {
      const root = compileSchemaValidator({
        items: [{}],
        additionalItems: false,
      });

      assert.isTrue(root.validate([null]), 'additional items match schema');
      assert.isFalse(root.validate(['foo', 'bar', 37]), 'additional items do not match schema');
      // TODO: more assertion
    });

    it('should validate additionalItems by when single schema is present in tuple', function () {
      const root = compileSchemaValidator({
        items: [{}],
        additionalItems: { type: 'null' },
      });

      assert.isTrue(root.validate([null]), 'allows null elements');
      assert.isFalse(root.validate([null, 2, 3, 4]), 'doesnt allow anything else');
    });

    it('should validate additionalItems by when single schema is present in tuple', function () {
      const root = compileSchemaValidator({
        items: [{}],
        additionalItems: { type: 'integer' },
      });

      assert.isTrue(root.validate([null, 2, 3, 4]), 'additional items match schema');
      assert.isFalse(root.validate([null, 2, 3, 'foo']), 'additional items do not match schema');
    });

    it('should ignore additionalItems when items is a schema', function () {
      const root = compileSchemaValidator({
        items: {
          type: 'integer',
        },
        additionalItems: {
          type: 'string',
        },
      });

      assert.isTrue(root.validate([1, 2, 3]), 'valid with an array of type integers');
      assert.isFalse(root.validate([null, 2, 3, 'foo']), 'invalid with an array of mixed types');
    });

    it('should ignore additionalItems when items is an empty schema', function () {
      const root = compileSchemaValidator({
        items: {},
        additionalItems: false,
      });

      assert.isTrue(root.validate([1, 2, 3, 5, 8]), 'all items match schema');
    });

    it('should validate an array of schemas with no additionalItems permitted', function () {
      const root = compileSchemaValidator({
        items: [{}, {}, {}],
        additionalItems: false,
      });

      assert.isTrue(root.validate([]), 'empty array');
      assert.isTrue(root.validate([1]), 'one item present');
      assert.isTrue(root.validate([1, 2]), 'two items present');
      assert.isTrue(root.validate([1, 2, 3]), 'three items present');
      assert.isTrue(root.validate([null, 3, 'foo']), 'mixed types of valid length');
      assert.isFalse(root.validate([1, 2, 3, 4]), 'four items present');
    });

    it('should validate additionalItems as false without items', function () {
      const root = compileSchemaValidator({
        additionalItems: false,
      });

      assert.isTrue(root.validate([1, 2, 3, 4, 5]), 'items defaults to empty schema so everything is valid');
      assert.isTrue(root.validate({ foo: 'bar' }), 'ignores non-arrays');
    });

    it('additionalItems does not look in applicators (wtf is an applicator?), valid case', function () {
      const root = compileSchemaValidator({
        allOf: [
          { items: [{ type: 'integer' }] },
        ],
        additionalItems: { type: 'boolean' },
      });

      assert.isTrue(root.validate([1, null]), 'items defined in allOf are not examined');
    });

    it('additionalItems does not look in applicators, invalid case', function () {
      const root = compileSchemaValidator({
        allOf: [
          { items: [{ type: 'integer' }, { type: 'string' }] },
        ],
        items: [{ type: 'integer' }],
        additionalItems: { type: 'boolean' },
      });

      assert.isFalse(root.validate([1, 'hi']), 'items defined in allOf are not examined');
    });

    it('items validation adjusts the starting index for additionalItems', function () {
      const root = compileSchemaValidator({
        items: [{ type: 'string' }],
        additionalItems: { type: 'integer' },
      });

      assert.isTrue(root.validate(['x', 2, 3]), 'valid items');
      assert.isFalse(root.validate(['x', 'y']), 'wrong type of second item');
    });

    it('it should validate an array with address items', function () {
      const root = compileSchemaValidator({
        type: 'array',
        items: [
          { type: 'number' },
          { type: 'string' },
          { type: 'string', enum: ['Street', 'Avenue', 'Boulevard'] },
          { type: 'string', enum: ['NW', 'NE', 'SW', 'SE'] },
        ],
      });

      assert.isTrue(root.validate([1600, 'Pennsylvania', 'Avenue', 'NW']), 'valid address');
      assert.isTrue(root.validate([10, 'Downing', 'Street']), 'does not need all items');
      assert.isTrue(root.validate([1600, 'Pennsylvania', 'Avenue', 'NW', 'Washington']), 'additionalItems is default true');
      assert.isFalse(root.validate([24, 'Sussex', 'Drive']), 'invalid value at item 3');
      assert.isFalse(root.validate(['Palais de l\'Élysée']), 'missing street number');
    });

    it('should not allow additionalItems to an address item', function () {
      const root = compileSchemaValidator({
        type: 'array',
        items: [
          { type: 'number' },
          { type: 'string' },
          { type: 'string', enum: ['Street', 'Avenue', 'Boulevard'] },
          { type: 'string', enum: ['NW', 'NE', 'SW', 'SE'] },
        ],
        additionalItems: false,
      });

      assert.isTrue(root.validate([1600, 'Pennsylvania', 'Avenue', 'NW']), 'valid address');
      assert.isTrue(root.validate([1600, 'Pennsylvania', 'Avenue']), 'not all fields are necessary');
      assert.isFalse(root.validate([1600, 'Pennsylvania', 'Avenue', 'NW', 'Washington']), 'do not allow additional items');
    });

    it('should allow a string schema for address items', function () {
      const root = compileSchemaValidator({
        type: 'array',
        items: [
          { type: 'number' },
          { type: 'string' },
          { type: 'string', enum: ['Street', 'Avenue', 'Boulevard'] },
          { type: 'string', enum: ['NW', 'NE', 'SW', 'SE'] },
        ],
        additionalItems: { type: 'string' },
      });

      assert.isTrue(root.validate([1600, 'Pennsylvania', 'Avenue', 'NW', 'Washington']), 'additional string items are ok');
      assert.isFalse(root.validate([1600, 'Pennsylvania', 'Avenue', 'NW', 20500]), 'but nothing else');
    });

  });

  describe('TODO:#arrayUnevaluatedItems()', function () {
    it('unevaluatedItems is true', function () {
      const root = compileSchemaValidator({
        unevaluatedItems: true,
      });

      assert.isTrue(root.validate([]), 'with no evaluated items');
      assert.isTrue(root.validate(['foo']), 'with unevaluated items');
    });

    it.skip('unevaluatedItems is false', function () {
      const root = compileSchemaValidator({
        unevaluatedItems: false,
      });

      assert.isTrue(root.validate(undefined), 'ignores undefined');
      assert.isTrue(root.validate(null), 'ignores null');
      assert.isTrue(root.validate(true), 'ignores boolean true');
      assert.isTrue(root.validate(false), 'ignores boolean false');
      assert.isTrue(root.validate(123), 'ignores integer');
      assert.isTrue(root.validate(1.23), 'ignores float');
      assert.isTrue(root.validate('string'), 'ignores string');
      assert.isTrue(root.validate({}), 'ignores object');
      assert.isTrue(root.validate([]), 'with no evaluated items');
      assert.isFalse(root.validate(['foo']), 'with unevaluated items');
    });

    it('unevaluatedItems as schema null', function () {
      const root = compileSchemaValidator({
        unevaluatedItems: {
          type: 'null',
        },
      });

      assert.isTrue(root.validate(null), 'with no evaluated items');
      // TODO: add more tests
    });

    it.skip('unevaluatedItems as schema string', function () {
      const root = compileSchemaValidator({
        unevaluatedItems: {
          type: 'string',
        },
      });

      assert.isTrue(root.validate([]), 'with no evaluated items');
      assert.isTrue(root.validate(['foo']), 'with valid unevaluated items');
      assert.isFalse(root.validate([42]), 'with invalid unevaluated items');
    });

    it('unevaluatedItems with uniform items', function () {
      const root = compileSchemaValidator({
        items: { type: 'string' },
        unevaluatedItems: false,
      });

      assert.isTrue(root.validate(['foo', 'bar']), 'unevaluated items doesnt apply');
    });

    it.skip('unevaluatedItems with tuple', function () {
      const root = compileSchemaValidator({
        items: [{ type: 'string' }],
        unevaluatedItems: false,
      });

      assert.isTrue(root.validate(['foo']), 'with no unevaluated items');
      assert.isFalse(root.validate(['foo', 'bar']), 'with unevaluated items');
    });

    it('unevaluatedItems with tuple and additionalItems', function () {
      const root = compileSchemaValidator({
        items: [{ type: 'string' }],
        additionalItems: true,
        unevaluatedItems: false,
      });

      assert.isTrue(root.validate(['foo', 42]), 'unevaluated items doesnt apply');
    });

    it.skip('unevaluatedItems with ignored additionalItems', function () {
      const root = compileSchemaValidator({
        additionalItems: { type: 'number' },
        unevaluatedItems: { type: 'string' },
      });

      assert.isFalse(root.validate(['foo', 42]), 'additionalItems is entirely ignored when items isnt present');
      assert.isTrue(root.validate(['foo', 'bar', 'baz']), 'all valid under unevaluatedItems');
    });

    it.skip('unevaluatedItems with ignored allOf additionalItems', function () {
      const root = compileSchemaValidator({
        allOf: [{ additionalItems: { type: 'number' } }],
        unevaluatedItems: { type: 'string' },
      });

      assert.isFalse(root.validate(['foo', 42]), 'additionalItems is entirely ignored when items isnt present');
      assert.isTrue(root.validate(['foo', 'bar', 'baz']), 'all valid under unevaluatedItems');
    });

    it.skip('unevaluatedItems with nested allOf tuple', function () {
      const root = compileSchemaValidator({
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

      assert.isTrue(root.validate(['foo', 42]), 'with no unevaluated items');
      assert.isFalse(root.validate(['foo', 42, true]), 'with unevaluated items');
    });

    it.skip('unevaluatedItems with nested anyOf items', function () {
      const root = compileSchemaValidator({
        unevaluatedItems: { type: 'boolean' },
        anyOf: [
          { items: { type: 'string' } },
          true,
        ],
      });

      assert.isTrue(root.validate([true, false]), 'with only (valid) additional items');
      assert.isTrue(root.validate(['no', 'yes']), 'with no additional items');
      assert.isTrue(root.validate(['no', true]), 'with valid additional items');
      assert.isFalse(root.validate(['yes', false]), 'with invalid additional items');
    });

    it.skip('unevaluatedItems with nested allOf items and additionalItems', function () {
      const root = compileSchemaValidator({
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

      assert.isTrue(root.validate(['yes']), 'with no additional items');
      assert.isTrue(root.validate(['yes', 42, true]), 'with additional items');
    });

    it.skip('unevaluatedItems with nested allOf items and unevaluatedItems', function () {
      const root = compileSchemaValidator({
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

      assert.isTrue(root.validate(['yes']), 'with no additional items');
      assert.isTrue(root.validate(['yes', 42, true]), 'with additional items');
    });

    it.skip('unevaluatedItems with anyOf', function () {
      const root = compileSchemaValidator({
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

      assert.isTrue(root.validate(['foo', 'bar']), 'when one schema matches and has no unevaluated items');
      assert.isFalse(root.validate(['yes', 'no', 42]), 'when one schema matches and has unevaluated items');
      assert.isTrue(root.validate(['foo', 'bar', 'baz']), 'when two schemas match and has no unevaluated items');
      assert.isFalse(root.validate(['foo', 'bar', 'baz', 42]), 'when two schemas match and has unevaluated items');
    });

    it.skip('unevaluatedItems with oneOf', function () {
      const root = compileSchemaValidator({
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

      assert.isTrue(root.validate(['foo', 'bar']), 'with no unevaluated items');
      assert.isFalse(root.validate(['yes', 'no', 42]), 'with unevaluated items');
    });

    it.skip('unevaluatedItems with not', function () {
      const root = compileSchemaValidator({
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

      assert.isFalse(root.validate(['yes', 'no']), 'with unevaluated items');
    });

    it.skip('unevaluatedItems can see annotations from if without then and else', function () {
      const root = compileSchemaValidator({
        if: {
          items: [{ const: 'foo' }],
        },
        unevaluatedItems: false,
      });

      assert.isTrue(root.validate(['foo']), 'when if matches and it has no unevaluated items');
      assert.isFalse(root.validate(['bar']), 'invalid in case if is evaluated');
    });

    it.skip('unevaluatedItems with if/then/else', function () {
      const root = compileSchemaValidator({
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

      assert.isTrue(root.validate(['foo', 'bar', 'then']), 'when if matches and it has no unevaluated items');
      assert.isFalse(root.validate(['foo', 'bar', 'then', 'else']), 'when if matches and it has unevaluated items');
      assert.isTrue(root.validate(['foo', 21, 42, 'else']), 'when if doesnt match and it has no unevaluated items');
      assert.isFalse(root.validate(['foo', 21, 42, 'else', 64]), 'when if doesnt match and it has unevaluated items');
    });

    it.skip('unevaluatedItems with allof boolean true schemas', function () {
      const root = compileSchemaValidator({
        allOf: [true],
        unevaluatedItems: false,
      });

      assert.isTrue(root.validate([]), 'with no unevaluated items');
      assert.isFalse(root.validate(['foo']), 'with unevaluated item');
    });

    it.skip('unevaluatedItems with $ref', function () {
      const root = compileSchemaValidator({
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

      assert.isTrue(root.validate(['foo', 'bar']), 'with no unevaluated items');
      assert.isFalse(root.validate(['foo', 'bar', 'baz']), 'with unevaluated item');
    });

    it.skip('unevaluatedItems before $ref', function () {
      const root = compileSchemaValidator({
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

      assert.isTrue(root.validate(['foo', 'bar']), 'with no unevaluated items');
      assert.isFalse(root.validate(['foo', 'bar', 'baz']), 'with unevaluated item');
    });

    it.skip('should do something with unevaluated items', function () {
      const root = compileSchemaValidator({
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

      assert.isTrue(root.validate([1, 2, 3]), 'tuple of 3 integers is valid');
      assert.isTrue(root.validate([1, 2, true]), 'tuple with 2 integers and a bool is valid ');
      assert.isFalse(root.validate([1, 2]), 'third item is not present');
      assert.isFalse(root.validate([1, 2, '3']), 'third item is unevaluated');
    });
  });

  describe('#arrayPrefixItems() (not implemented)', function () {
    // prefixItems is the believe that you can break a spec,
    // cause you all of the sudden need to separate concerns in
    // another way. But this is a schema definition and compilers
    // do not mind, however it does require another keyword; this
    // can likely break many other user components in the field.
    // Also can this action indicate that those who define the spec,
    // are of such schooling that they can break the 'type' keyword
    // with the same reasoning. Since the engine doesn't mind, we
    // just add a little plaster on it and call it a day.
    it.skip('should not allow prefixItems and items to both be arrays.', function () {
      // only one of them can be a tuple.
    });
    it.skip('should ignore additionalItems', function () {
      // when prefix is defined as an array, additionalItems should not play a role.
    });
  });
});
