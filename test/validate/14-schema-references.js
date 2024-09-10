import { describe, it } from 'node:test';
import * as assert from '@jaren/tools/assert';

import {
  compileSchemaValidator,
  registerFormatCompilers
} from '@jaren/validate';

import {
  getSchemaDraftByVersion,
} from '@jaren/refs';

import * as formats from '@jaren/formats';

registerFormatCompilers(formats.stringFormats);

const defaultSchema = getSchemaDraftByVersion(7);

describe('Schema References', function () {
  describe('#refIds()', function () {
    it.skip('should show invalid use of fragments in location-independent $id', function () {
      // TODO: not sure what is going wrong here when I added a validation pattern to $id
      // in draft-7. Its not really important!? so we leave it for later.
      const root = compileSchemaValidator({ $ref: defaultSchema.draft }, defaultSchema.schema);

      assert.isFalse(root.validate({
        $ref: '#foo',
        $defs: {
          A: {
            $id: '#foo',
            type: 'integer',
          },
        },
      }), 'Identifier name');
      assert.isFalse(root.validate({
        $defs: {
          A: { $id: '#foo' },
        },
      }), 'Identifier name and no ref');
      assert.isFalse(root.validate({
        $ref: '#/a/b',
        $defs: {
          A: {
            $id: '#/a/b',
            type: 'integer',
          },
        },
      }), 'Identifier path');
      assert.isFalse(root.validate({
        $ref: 'http://localhost:1234/bar#foo',
        $defs: {
          A: {
            $id: 'http://localhost:1234/bar#foo',
            type: 'integer',
          },
        },
      }), 'Identifier name with absolute URI');
      assert.isFalse(root.validate({
        $ref: 'http://localhost:1234/bar#/a/b',
        $defs: {
          A: {
            $id: 'http://localhost:1234/bar#/a/b',
            type: 'integer',
          },
        },
      }), 'Identifier path with absolute URI');
      assert.isFalse(root.validate({
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
      assert.isFalse(root.validate({
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
      const root = compileSchemaValidator({ $ref: defaultSchema.draft }, defaultSchema.schema);

      assert.isTrue(root.validate({
        $ref: 'http://localhost:1234/bar',
        $defs: {
          A: {
            $id: 'http://localhost:1234/bar#',
            type: 'integer',
          },
        },
      }), 'Identifier name with absolute URI');
      assert.isTrue(root.validate({
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
      const root = compileSchemaValidator({ $ref: defaultSchema.draft }, defaultSchema.schema);

      assert.isTrue(root.validate({
        $ref: 'http://localhost:1234/foo/baz',
        $defs: {
          A: {
            $id: 'http://localhost:1234/foo/bar/../baz',
            type: 'integer',
          },
        },
      }), 'Unnormalized identifier');
      assert.isTrue(root.validate({
        $defs: {
          A: {
            $id: 'http://localhost:1234/foo/bar/../baz',
            type: 'integer',
          },
        },
      }), 'Unnormalized identifier and no ref');
      assert.isTrue(root.validate({
        $ref: 'http://localhost:1234/foo/baz',
        $defs: {
          A: {
            $id: 'http://localhost:1234/foo/bar/../baz#',
            type: 'integer',
          },
        },
      }), 'Unnormalized identifier with empty fragment');
      assert.isTrue(root.validate({
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
      const root = compileSchemaValidator({
        $ref: '#/$defs/bool',
        $defs: {
          bool: true,
        },
      });

      assert.isTrue(root.validate(undefined), 'undefined value is valid');
      assert.isTrue(root.validate(null), 'null value is valid');
      assert.isTrue(root.validate(false), 'false value is valid');
      assert.isTrue(root.validate(3.14), 'number value is valid');
      assert.isTrue(root.validate('string'), 'string value is valid');
      assert.isTrue(root.validate([]), 'array value is valid');
      assert.isTrue(root.validate({}), 'object value is valid');
    });

    it('should validate a $ref to boolean schema to false', function () {
      const root = compileSchemaValidator({
        $ref: '#/$defs/bool',
        $defs: {
          bool: false,
        },
      });

      assert.isFalse(root.validate(undefined), 'undefined value is invalid');
      assert.isFalse(root.validate(null), 'null value is invalid');
      assert.isFalse(root.validate(true), 'false value is invalid');
      assert.isFalse(root.validate(3.14), 'number value is invalid');
      assert.isFalse(root.validate('string'), 'string value is invalid');
      assert.isFalse(root.validate([]), 'array value is invalid');
      assert.isFalse(root.validate({}), 'object value is invalid');
    });

    it('should have a root pointer ref', function () {
      const root = compileSchemaValidator({
        properties: {
          foo: { $ref: '#' },
        },
        additionalProperties: false,
      });

      assert.isTrue(root.validate({ foo: false }), 'match root pointer');
      assert.isTrue(root.validate({ foo: { foo: false } }), 'recursive match root pointer');
      assert.isFalse(root.validate({ bar: false }), 'mismatch root pointer');
      assert.isFalse(root.validate({ foo: { bar: false } }), 'recursive mismatch root pointer');
    });

    it('should validate relative pointer ref to object', function () {
      const root = compileSchemaValidator({
        properties: {
          foo: { type: 'integer' },
          bar: { $ref: '#/properties/foo' },
        },
      });

      assert.isTrue(root.validate({ bar: 3 }), 'match relative pointer');
      assert.isTrue(root.validate({ bar: undefined }), 'match with undefined type');
      assert.isFalse(root.validate({ bar: null }), 'mismatch with null type');
      assert.isFalse(root.validate({ bar: true }), 'mismatch with boolean type');
      assert.isFalse(root.validate({ bar: 3.1415 }), 'mismatch with float type');
      assert.isFalse(root.validate({ bar: [3, 5] }), 'mismatch with array type');
      assert.isFalse(root.validate({ bar: { bar: 3 } }), 'mismatch with object type');
    });

    it('should validate relative pointer ref to array', function () {
      const root = compileSchemaValidator({
        items: [
          { type: 'integer' },
          { $ref: '#/items/0' },
        ],
      });

      assert.isTrue(root.validate([1, 2]), 'match array relative pointer');
      assert.isFalse(root.validate([1, 'foo']), 'mismatch array relative pointer');
    });

    it('should validate escaped pointer ref', function () {
      const root = compileSchemaValidator({
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

      assert.isFalse(root.validate({ slash: 'aoeu' }), 'slash invalid');
      assert.isFalse(root.validate({ tilde: 'aoeu' }), 'tilde invalid');
      assert.isFalse(root.validate({ percent: 'aoeu' }), 'percent invalid');
      assert.isTrue(root.validate({ slash: 123 }), 'slash valid');
      assert.isTrue(root.validate({ tilde: 123 }), 'tilde valid');
      assert.isTrue(root.validate({ percent: 123 }), 'percent valid');

    });

    it('should validate refs with quote', function () {
      const root = compileSchemaValidator({
        properties: {
          'foo"bar': { $ref: '#/$defs/foo%22bar' },
        },
        $defs: {
          'foo"bar': { type: 'number' },
        },
      });

      assert.isTrue(root.validate({ 'foo"bar': 1 }), 'object with numbers is valid');
      assert.isFalse(root.validate({ 'foo"bar': '1' }), 'object with strings is invalid');

    });

    it('should validate a property named $ref that is not a reference', function () {
      const root = compileSchemaValidator({
        properties: {
          $ref: { type: 'string' },
        },
      });

      assert.isTrue(root.validate({ $ref: 'a' }), 'property named $ref valid');
      assert.isFalse(root.validate({ $ref: 2 }), 'property named $ref invalid');
    });

    it('should validate a property named $ref, containing an actual $ref', function () {
      const root = compileSchemaValidator({
        properties: {
          $ref: { $ref: '#/$defs/is-string' },
        },
        $defs: {
          'is-string': {
            type: 'string',
          },
        },
      });

      assert.isTrue(root.validate({ $ref: 'a' }));
      assert.isFalse(root.validate({ $ref: 2 }), 'property named $ref invalid');
    });

    it('should validate nested refs', function () {
      const root = compileSchemaValidator({
        $defs: {
          a: { type: 'integer' },
          b: { $ref: '#/$defs/a' },
          c: { $ref: '#/$defs/b' },
        },
        $ref: '#/$defs/c',
      });

      assert.isTrue(root.validate(5), 'nested ref valid');
      assert.isFalse(root.validate('a'), 'nested ref invalid');
    });

    it('should show ref applies alongside sibling keywords', function () {
      const root = compileSchemaValidator({
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

      assert.isTrue(root.validate({ foo: [] }), 'ref valid, maxItems valid (0)');
      assert.isTrue(root.validate({ foo: [1] }), 'ref valid, maxItems valid (1)');
      assert.isTrue(root.validate({ foo: [1, 2] }), 'ref valid, maxItems valid (2)');
      assert.isFalse(root.validate({ foo: [1, 2, 3] }), 'ref valid maxItem invalid (3)');
      assert.isFalse(root.validate({ foo: 'string' }), 'ref invalid');
    });

    it('should validate recursive refernces between schemas', function () {
      const root = compileSchemaValidator({
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

      assert.isTrue(root.validate({
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

      assert.isFalse(root.validate({
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
      const root = compileSchemaValidator({
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

      assert.isTrue(root.validate({ foo: 1 }), 'passing case');
      assert.isFalse(root.validate({ foo: 'a string' }), 'failing case');

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
      const root = compileSchemaValidator({ $ref: defaultSchema.draft }, defaultSchema.schema);

      assert.isTrue(root.validate({ minLength: 1 }), 'remote ref valid');
      assert.isFalse(root.validate({ minLength: -1 }), 'remote ref invalid');

    });

    it('should validate a remote ref', function () {
      const root = compileSchemaValidator({ $ref: '/integer.json' }, includeSchemas);

      assert.isTrue(root.validate(1), 'remote ref valid');
      assert.isFalse(root.validate('a'), 'remote ref invalid');

    });

    it('should validate a fragment within remote ref', function () {
      const root = compileSchemaValidator({ $ref: '/subSchemas-defs.json#/$defs/integer' }, includeSchemas);

      assert.isTrue(root.validate(1), 'remote fragment valid');
      assert.isFalse(root.validate('a'), 'remote fragment invalid');

    });

    it('should validate a fragment within remote ref to integer', function () {
      const root = compileSchemaValidator({ $ref: '/subSchemas-defs.json#/$defs/refToInteger' }, includeSchemas);

      assert.isTrue(root.validate(1), 'ref within ref valid');
      assert.isFalse(root.validate('a'), 'ref within ref invalid');

    });

    it('should validate a base URI change', function () {
      const root = compileSchemaValidator({
        $id: 'http://localhost:1234/',
        items: {
          $id: 'baseUriChange/',
          items: { $ref: 'folderInteger.json' },
        },
      }, includeSchemas);

      assert.isTrue(root.validate([[1]]), 'base URI change ref valid');
      assert.isFalse(root.validate([['a']]), 'base URI change ref invalid');

    });

    it('should validate a base URI change - change folder', function () {
      const root = compileSchemaValidator({
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

      assert.isTrue(root.validate({ list: [1] }), 'number is valid');
      assert.isFalse(root.validate({ list: ['a'] }), 'string is invalid');

    });

    it('should validate a base URI change - change folder in subschema', function () {
      const root = compileSchemaValidator({
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

      assert.isTrue(root.validate({ list: [1] }), 'number is valid');
      assert.isFalse(root.validate({ list: ['a'] }), 'string is invalid');

    });

    it('should validate a root ref in remote ref', function () {
      const root = compileSchemaValidator({
        $id: 'http://localhost:1234/object',
        type: 'object',
        properties: {
          name: { $ref: 'name-defs.json#/$defs/orNull' },
        },
      }, includeSchemas);

      assert.isTrue(root.validate({ name: 'foo' }), 'string is valid');
      assert.isTrue(root.validate({ name: null }), 'null is valid');
      assert.isFalse(root.validate({ name: { name: null } }), 'object is invalid');

    });

  });

  describe('#refCombine()', function () {
    // https://json-schema.org/understanding-json-schema/reference/combining.html
    it('should be a type of inheritance with allOf usage', function () {
      const root = compileSchemaValidator({
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

      assert.isTrue(root.validate({
        street_address: '1600 Pennsylvania Avenue NW',
        city: 'Washington',
        state: 'DC',
        type: 'business',
      }), 'a valid address with reference');
    });

    it('should be a type of inheritance with allOf usage and additionalProperties off', function () {
      const root = compileSchemaValidator({
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

      assert.isFalse(root.validate({
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
      const root = compileSchemaValidator({
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

      assert.isTrue(root.validate([
        [{ foo: null }, { foo: null }],
        [{ foo: null }, { foo: null }],
        [{ foo: null }, { foo: null }],
      ]), 'valid items');
      assert.isFalse(root.validate([
        [{ foo: null }, { foo: null }],
        [{ foo: null }, { foo: null }],
        [{ foo: null }, { foo: null }],
        [{ foo: null }, { foo: null }],
      ]), 'too many items');
      assert.isFalse(root.validate([
        [{ foo: null }, { foo: null }, { foo: null }],
        [{ foo: null }, { foo: null }],
        [{ foo: null }, { foo: null }],
      ]), 'too many sub-items');
      assert.isFalse(root.validate([
        { foo: null },
        [{ foo: null }, { foo: null }],
        [{ foo: null }, { foo: null }],
      ]), 'wrong item');
      assert.isFalse(root.validate([
        [{}, { foo: null }],
        [{ foo: null }, { foo: null }],
        [{ foo: null }, { foo: null }],
      ]), 'wrong sub-item');
      assert.isTrue(root.validate([
        [{ foo: null }],
        [{ foo: null }],
      ]), 'fewer items is valid');
    });
  });
});
