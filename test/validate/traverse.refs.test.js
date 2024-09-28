import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  JarenValidator,
} from '@jarenjs/validate';

import {
  getSchemaDraftByVersion,
} from '@jarenjs/refs';

import * as formats from '@jarenjs/formats';

const defaultSchema = getSchemaDraftByVersion(7);

const compiler = new JarenValidator()
  .addFormats(formats.stringFormats)
  .addSchema(defaultSchema.schema);

describe('Schema References', function () {
  describe('#refIds()', function () {
    it.skip('should show invalid use of fragments in location-independent $id', function () {
      // TODO: not sure what is going wrong here when I added a validation pattern to $id
      // in draft-7. Its not really important!? so we leave it for later.
      const validate = compiler.compile({
        $ref: defaultSchema.draft
      });

      assert.isFalse(validate({
        $ref: '#foo',
        $defs: {
          A: {
            $id: '#foo',
            type: 'integer',
          },
        },
      }), 'Identifier name');
      assert.isFalse(validate({
        $defs: {
          A: { $id: '#foo' },
        },
      }), 'Identifier name and no ref');
      assert.isFalse(validate({
        $ref: '#/a/b',
        $defs: {
          A: {
            $id: '#/a/b',
            type: 'integer',
          },
        },
      }), 'Identifier path');
      assert.isFalse(validate({
        $ref: 'http://localhost:1234/bar#foo',
        $defs: {
          A: {
            $id: 'http://localhost:1234/bar#foo',
            type: 'integer',
          },
        },
      }), 'Identifier name with absolute URI');
      assert.isFalse(validate({
        $ref: 'http://localhost:1234/bar#/a/b',
        $defs: {
          A: {
            $id: 'http://localhost:1234/bar#/a/b',
            type: 'integer',
          },
        },
      }), 'Identifier path with absolute URI');
      assert.isFalse(validate({
        $id: 'http://localhost:1234/root',
        $ref: 'http://localhost:1234/nested.json#foo',
        $defs: {
          A: {
            $id: 'nested.json',
            $defs: {
              B: {
                $id: '#foo',
                type: 'integer',
              },
            },
          },
        },
      }), 'Identifier name with base URI change in subschema');
      assert.isFalse(validate({
        $id: 'http://localhost:1234/root',
        $ref: 'http://localhost:1234/nested.json#/a/b',
        $defs: {
          A: {
            $id: 'nested.json',
            $defs: {
              B: {
                $id: '#/a/b',
                type: 'integer',
              },
            },
          },
        },
      }), 'Identifier path with base URI change in subschema');

    });

    it('should show valid use of empty fragments in location-independent $id', function () {
      const validate = compiler.compile({
        $ref: defaultSchema.draft
      });

      assert.isTrue(validate({
        $ref: 'http://localhost:1234/bar',
        $defs: {
          A: {
            $id: 'http://localhost:1234/bar#',
            type: 'integer',
          },
        },
      }), 'Identifier name with absolute URI');
      assert.isTrue(validate({
        $id: 'http://localhost:1234/root',
        $ref: 'http://localhost:1234/nested.json#/$defs/B',
        $defs: {
          A: {
            $id: 'nested.json',
            $defs: {
              B: {
                $id: '#',
                type: 'integer',
              },
            },
          },
        },
      }), 'Identifier name with base URI change in subschema');

    });

    it('should show that unnormalized $ids are allowed but discouraged', function () {
      const validate = compiler.compile({
        $ref: defaultSchema.draft
      });

      assert.isTrue(validate({
        $ref: 'http://localhost:1234/foo/baz',
        $defs: {
          A: {
            $id: 'http://localhost:1234/foo/bar/../baz',
            type: 'integer',
          },
        },
      }), 'Unnormalized identifier');
      assert.isTrue(validate({
        $defs: {
          A: {
            $id: 'http://localhost:1234/foo/bar/../baz',
            type: 'integer',
          },
        },
      }), 'Unnormalized identifier and no ref');
      assert.isTrue(validate({
        $ref: 'http://localhost:1234/foo/baz',
        $defs: {
          A: {
            $id: 'http://localhost:1234/foo/bar/../baz#',
            type: 'integer',
          },
        },
      }), 'Unnormalized identifier with empty fragment');
      assert.isTrue(validate({
        $defs: {
          A: {
            $id: 'http://localhost:1234/foo/bar/../baz#',
            type: 'integer',
          },
        },
      }), 'Unnormalized identifier with empty fragment and no ref');
    });
  });

  describe('#refBasic()', function () {
    it('should validate a $ref to boolean schema to true', function () {
      const validate = compiler.compile({
        $ref: '#/$defs/bool',
        $defs: {
          bool: true,
        },
      });

      assert.isTrue(validate(undefined), 'undefined value is valid');
      assert.isTrue(validate(null), 'null value is valid');
      assert.isTrue(validate(false), 'false value is valid');
      assert.isTrue(validate(3.14), 'number value is valid');
      assert.isTrue(validate('string'), 'string value is valid');
      assert.isTrue(validate([]), 'array value is valid');
      assert.isTrue(validate({}), 'object value is valid');
    });

    it('should validate a $ref to boolean schema to false', function () {
      const validate = compiler.compile({
        $ref: '#/$defs/bool',
        $defs: {
          bool: false,
        },
      });

      assert.isFalse(validate(undefined), 'undefined value is invalid');
      assert.isFalse(validate(null), 'null value is invalid');
      assert.isFalse(validate(true), 'false value is invalid');
      assert.isFalse(validate(3.14), 'number value is invalid');
      assert.isFalse(validate('string'), 'string value is invalid');
      assert.isFalse(validate([]), 'array value is invalid');
      assert.isFalse(validate({}), 'object value is invalid');
    });

    it('should have a root pointer ref', function () {
      const validate = compiler.compile({
        properties: {
          foo: { $ref: '#' },
        },
        additionalProperties: false,
      });

      assert.isTrue(validate({ foo: false }), 'match root pointer');
      assert.isTrue(validate({ foo: { foo: false } }), 'recursive match root pointer');
      assert.isFalse(validate({ bar: false }), 'mismatch root pointer');
      assert.isFalse(validate({ foo: { bar: false } }), 'recursive mismatch root pointer');
    });

    it('should validate relative pointer ref to object', function () {
      const validate = compiler.compile({
        properties: {
          foo: { type: 'integer' },
          bar: { $ref: '#/properties/foo' },
        },
      });

      assert.isTrue(validate({ bar: 3 }), 'match relative pointer');
      assert.isTrue(validate({ bar: undefined }), 'match with undefined type');
      assert.isFalse(validate({ bar: null }), 'mismatch with null type');
      assert.isFalse(validate({ bar: true }), 'mismatch with boolean type');
      assert.isFalse(validate({ bar: 3.1415 }), 'mismatch with float type');
      assert.isFalse(validate({ bar: [3, 5] }), 'mismatch with array type');
      assert.isFalse(validate({ bar: { bar: 3 } }), 'mismatch with object type');
    });

    it('should validate relative pointer ref to array', function () {
      const validate = compiler.compile({
        items: [
          { type: 'integer' },
          { $ref: '#/items/0' },
        ],
      });

      assert.isTrue(validate([1, 2]), 'match array relative pointer');
      assert.isFalse(validate([1, 'foo']), 'mismatch array relative pointer');
    });

    it('should validate escaped pointer ref', function () {
      const validate = compiler.compile({
        $defs: {
          'tilde~field': { type: 'integer' },
          'slash/field': { type: 'integer' },
          'percent%field': { type: 'integer' },
        },
        properties: {
          tilde: { $ref: '#/$defs/tilde~0field' },
          slash: { $ref: '#/$defs/slash~1field' },
          percent: { $ref: '#/$defs/percent%25field' },
        },
      });

      assert.isFalse(validate({ slash: 'aoeu' }), 'slash invalid');
      assert.isFalse(validate({ tilde: 'aoeu' }), 'tilde invalid');
      assert.isFalse(validate({ percent: 'aoeu' }), 'percent invalid');
      assert.isTrue(validate({ slash: 123 }), 'slash valid');
      assert.isTrue(validate({ tilde: 123 }), 'tilde valid');
      assert.isTrue(validate({ percent: 123 }), 'percent valid');

    });

    it('should validate refs with quote', function () {
      const validate = compiler.compile({
        properties: {
          'foo"bar': { $ref: '#/$defs/foo%22bar' },
        },
        $defs: {
          'foo"bar': { type: 'number' },
        },
      });

      assert.isTrue(validate({ 'foo"bar': 1 }), 'object with numbers is valid');
      assert.isFalse(validate({ 'foo"bar': '1' }), 'object with strings is invalid');

    });

    it('should validate a property named $ref that is not a reference', function () {
      const validate = compiler.compile({
        properties: {
          $ref: { type: 'string' },
        },
      });

      assert.isTrue(validate({ $ref: 'a' }), 'property named $ref valid');
      assert.isFalse(validate({ $ref: 2 }), 'property named $ref invalid');
    });

    it('should validate a property named $ref, containing an actual $ref', function () {
      const validate = compiler.compile({
        properties: {
          $ref: { $ref: '#/$defs/is-string' },
        },
        $defs: {
          'is-string': {
            type: 'string',
          },
        },
      });

      assert.isTrue(validate({ $ref: 'a' }));
      assert.isFalse(validate({ $ref: 2 }), 'property named $ref invalid');
    });

    it('should validate nested refs', function () {
      const validate = compiler.compile({
        $defs: {
          a: { type: 'integer' },
          b: { $ref: '#/$defs/a' },
          c: { $ref: '#/$defs/b' },
        },
        $ref: '#/$defs/c',
      });

      assert.isTrue(validate(5), 'nested ref valid');
      assert.isFalse(validate('a'), 'nested ref invalid');
    });

    it('should show ref applies alongside sibling keywords', function () {
      const validate = compiler.compile({
        $defs: {
          reffed: {
            type: 'array',
          },
        },
        properties: {
          foo: {
            $ref: '#/$defs/reffed',
            maxItems: 2,
          },
        },
      });

      assert.isTrue(validate({ foo: [] }), 'ref valid, maxItems valid (0)');
      assert.isTrue(validate({ foo: [1] }), 'ref valid, maxItems valid (1)');
      assert.isTrue(validate({ foo: [1, 2] }), 'ref valid, maxItems valid (2)');
      assert.isFalse(validate({ foo: [1, 2, 3] }), 'ref valid maxItem invalid (3)');
      assert.isFalse(validate({ foo: 'string' }), 'ref invalid');
    });

    it('should validate recursive refernces between schemas', function () {
      const validate = compiler.compile({
        $id: 'http://localhost:1234/tree',
        description: 'tree of nodes',
        type: 'object',
        properties: {
          meta: { type: 'string' },
          nodes: {
            type: 'array',
            items: { $ref: 'node' },
          },
        },
        required: ['meta', 'nodes'],
        $defs: {
          node: {
            $id: 'http://localhost:1234/node',
            description: 'node',
            type: 'object',
            properties: {
              value: { type: 'number' },
              subtree: { $ref: 'tree' },
            },
            required: ['value'],
          },
        },
      });

      assert.isTrue(validate({
        meta: 'root',
        nodes: [
          {
            value: 1,
            subtree: {
              meta: 'child',
              nodes: [
                { value: 1.1 },
                { value: 1.2 },
              ],
            },
          },
          {
            value: 2,
            subtree: {
              meta: 'child',
              nodes: [
                { value: 2.1 },
                { value: 2.2 },
              ],
            },
          },
        ],
      }), 'valid tree');

      assert.isFalse(validate({
        meta: 'root',
        nodes: [
          {
            value: 1,
            subtree: {
              meta: 'child',
              nodes: [
                { value: 'string is invalid' },
                { value: 1.2 },
              ],
            },
          },
          {
            value: 2,
            subtree: {
              meta: 'child',
              nodes: [
                { value: 2.1 },
                { value: 2.2 },
              ],
            },
          },
        ],
      }), 'invalid tree');
    });

    it('should show that evaluating the same schema location against the same data location twice is not a sign of an infinite loop', function () {
      const validate = compiler.compile({
        $defs: {
          int: { type: 'integer' },
        },
        allOf: [
          {
            properties: {
              foo: {
                $ref: '#/$defs/int',
              },
            },
          },
          {
            additionalProperties: {
              $ref: '#/$defs/int',
            },
          },
        ],
      });

      assert.isTrue(validate({ foo: 1 }), 'passing case');
      assert.isFalse(validate({ foo: 'a string' }), 'failing case');

    });

  });

  describe('#refRemote()', function () {

    const integerSchema = {
      $id: '/integer.json',
      type: 'integer',
    };

    const subSchemas_defs = {
      $id: '/subSchemas-defs.json',
      $defs: {
        integer: {
          type: 'integer',
        },
        refToInteger: {
          $ref: '#/$defs/integer',
        },
      },
    };

    const name_defs = {
      $id: '/name-defs.json',
      $defs: {
        orNull: {
          anyOf: [
            {
              type: 'null',
            },
            {
              $ref: '#',
            },
          ],
        },
      },
      type: 'string',
    };

    const baseUriChange = {
      $id: '/baseUriChange/folderInteger.json',
      type: 'integer',
    };

    const baseUriChangeFolder = {
      $id: '/baseUriChangeFolder/folderInteger.json',
      type: 'integer',
    };

    const baseUriChangeFolderInSubschema = {
      $id: '/baseUriChangeFolderInSubschema/folderInteger.json',
      type: 'integer',
    };

    const includeSchemas = [
      integerSchema,
      subSchemas_defs,
      name_defs,
      baseUriChange,
      baseUriChangeFolder,
      baseUriChangeFolderInSubschema,
    ];

    it('should show remote ref, containing refs itself', function () {
      const validate = compiler.compile({
        $ref: defaultSchema.draft
      }, includeSchemas);

      assert.isTrue(validate({ minLength: 1 }), 'remote ref valid');
      assert.isFalse(validate({ minLength: -1 }), 'remote ref invalid');

    });

    it('should validate a remote ref', function () {
      const validate = compiler.compile({
        $ref: '/integer.json'
      }, includeSchemas);

      assert.isTrue(validate(1), 'remote ref valid');
      assert.isFalse(validate('a'), 'remote ref invalid');

    });

    it('should validate a fragment within remote ref', function () {
      const validate = compiler.compile({
        $ref: '/subSchemas-defs.json#/$defs/integer'
      }, includeSchemas);

      assert.isTrue(validate(1), 'remote fragment valid');
      assert.isFalse(validate('a'), 'remote fragment invalid');

    });

    it('should validate a fragment within remote ref to integer', function () {
      const validate = compiler.compile({
        $ref: '/subSchemas-defs.json#/$defs/refToInteger'
      }, includeSchemas);

      assert.isTrue(validate(1), 'ref within ref valid');
      assert.isFalse(validate('a'), 'ref within ref invalid');

    });

    it('should validate a base URI change', function () {
      const validate = compiler.compile({
        $id: 'http://localhost:1234/',
        items: {
          $id: 'baseUriChange/',
          items: { $ref: 'folderInteger.json' },
        },
      }, includeSchemas);

      assert.isTrue(validate([[1]]), 'base URI change ref valid');
      assert.isFalse(validate([['a']]), 'base URI change ref invalid');

    });

    it('should validate a base URI change - change folder', function () {
      const validate = compiler.compile({
        $id: 'http://localhost:1234/scope_change_defs1.json',
        type: 'object',
        properties: { list: { $ref: 'baseUriChangeFolder/' } },
        $defs: {
          baz: {
            $id: 'baseUriChangeFolder/',
            type: 'array',
            items: { $ref: 'folderInteger.json' },
          },
        },
      }, includeSchemas);

      assert.isTrue(validate({ list: [1] }), 'number is valid');
      assert.isFalse(validate({ list: ['a'] }), 'string is invalid');

    });

    it('should validate a base URI change - change folder in subschema', function () {
      const validate = compiler.compile({
        $id: 'http://localhost:1234/scope_change_defs2.json',
        type: 'object',
        properties: { list: { $ref: 'baseUriChangeFolderInSubschema/#/$defs/bar' } },
        $defs: {
          baz: {
            $id: 'baseUriChangeFolderInSubschema/',
            $defs: {
              bar: {
                type: 'array',
                items: { $ref: 'folderInteger.json' },
              },
            },
          },
        },
      }, includeSchemas);

      assert.isTrue(validate({ list: [1] }), 'number is valid');
      assert.isFalse(validate({ list: ['a'] }), 'string is invalid');

    });

    it('should validate a root ref in remote ref', function () {
      const validate = compiler.compile({
        $id: 'http://localhost:1234/object',
        type: 'object',
        properties: {
          name: { $ref: 'name-defs.json#/$defs/orNull' },
        },
      }, includeSchemas);

      assert.isTrue(validate({ name: 'foo' }), 'string is valid');
      assert.isTrue(validate({ name: null }), 'null is valid');
      assert.isFalse(validate({ name: { name: null } }), 'object is invalid');

    });

  });

  describe('#refCombine()', function () {
    // https://json-schema.org/understanding-json-schema/reference/combining.html
    it('should be a type of inheritance with allOf usage', function () {
      const validate = compiler.compile({
        definitions: {
          address: {
            type: 'object',
            properties: {
              street_address: { type: 'string' },
              city: { type: 'string' },
              state: { type: 'string' },
            },
            required: ['street_address', 'city', 'state'],
          },
        },
        allOf: [
          { $ref: '#/definitions/address' },
          {
            properties: {
              type: { enum: ['residential', 'business'] },
            },
          },
        ],
      });

      assert.isTrue(validate({
        street_address: '1600 Pennsylvania Avenue NW',
        city: 'Washington',
        state: 'DC',
        type: 'business',
      }), 'a valid address with reference');
    });

    it('should be a type of inheritance with allOf usage and additionalProperties off', function () {
      const validate = compiler.compile({
        definitions: {
          address: {
            type: 'object',
            properties: {
              street_address: { type: 'string' },
              city: { type: 'string' },
              state: { type: 'string' },
            },
            required: ['street_address', 'city', 'state'],
          },
        },
        allOf: [
          { $ref: '#/definitions/address' },
          {
            properties: {
              type: { enum: ['residential', 'business'] },
            },
          },
        ],
        additionalProperties: false,
      });

      assert.isFalse(validate({
        street_address: '1600 Pennsylvania Avenue NW',
        city: 'Washington',
        state: 'DC',
        type: 'business',
      }), 'same with no additional properties');
    });

  });

  describe('#refItems()', function () {
    it('should validate items and subitems', function () {
      // https://github.com/json-schema-org/JSON-Schema-Test-Suite/blob/master/tests/draft7/items.json
      const validate = compiler.compile({
        definitions: {
          item: {
            type: 'array',
            additionalItems: false,
            items: [
              { $ref: '#/definitions/sub-item' },
              { $ref: '#/definitions/sub-item' },
            ],
          },
          'sub-item': {
            type: 'object',
            required: ['foo'],
          },
        },
        type: 'array',
        additionalItems: false,
        items: [
          { $ref: '#/definitions/item' },
          { $ref: '#/definitions/item' },
          { $ref: '#/definitions/item' },
        ],
      });

      assert.isTrue(validate([
        [{ foo: null }, { foo: null }],
        [{ foo: null }, { foo: null }],
        [{ foo: null }, { foo: null }],
      ]), 'valid items');
      assert.isFalse(validate([
        [{ foo: null }, { foo: null }],
        [{ foo: null }, { foo: null }],
        [{ foo: null }, { foo: null }],
        [{ foo: null }, { foo: null }],
      ]), 'too many items');
      assert.isFalse(validate([
        [{ foo: null }, { foo: null }, { foo: null }],
        [{ foo: null }, { foo: null }],
        [{ foo: null }, { foo: null }],
      ]), 'too many sub-items');
      assert.isFalse(validate([
        { foo: null },
        [{ foo: null }, { foo: null }],
        [{ foo: null }, { foo: null }],
      ]), 'wrong item');
      assert.isFalse(validate([
        [{}, { foo: null }],
        [{ foo: null }, { foo: null }],
        [{ foo: null }, { foo: null }],
      ]), 'wrong sub-item');
      assert.isTrue(validate([
        [{ foo: null }],
        [{ foo: null }],
      ]), 'fewer items is valid');
    });
  });
});
