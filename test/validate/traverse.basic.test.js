import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  storeSchemaIdsInMap,
  resolveRefSchemaShallow,
  encodeJsonPointerPath,
  decodeJsonPointerPath,
} from '../../packages/validate/src/traverse.js';

describe('Schema Traversal', function () {
  const rootSchema = {
    $id: 'http://example.com/schemas/root.json',
    type: 'object',
    properties: {
      $id: 'do not map this id!',
      foo: { $ref: 'http://jaren.com/definitions1.json#/definitions/foo' },
      bar: {
        $id: '/this/that.json',
        properties: {
          $id: { $comment: 'do not map this id either!' },
          baz: { type: 'number' },
        },
      },
    },
  };

  const definitionSchema1 = {
    $id: 'http://jaren.com/definitions1.json',
    definitions: {
      foo: { type: 'string' },
      'bar/baz': { type: 'number ' },
    },
  };

  it('should have some map keys', function () {
    const baseUri = 'http://nonexistent.void/';
    const map = new Map();
    storeSchemaIdsInMap(map, baseUri, rootSchema);
    storeSchemaIdsInMap(map, baseUri, definitionSchema1);

    assert.isTrue(map.has('http://example.com/schemas/root.json#'), 'has root');
    assert.isTrue(map.has('http://example.com/this/that.json#'), 'has that');
    assert.isTrue(map.has('http://jaren.com/definitions1.json#'), 'has definitions1');

    const foo = resolveRefSchemaShallow(map, 'http://jaren.com/definitions1.json#/definitions/foo', baseUri).schema;
    assert.isTrue(foo === definitionSchema1.definitions.foo, 'resolved \'foo\'');
    const bar = resolveRefSchemaShallow(map, 'http://jaren.com/definitions1.json#/definitions/bar~1baz', baseUri).schema;
    assert.isTrue(bar === definitionSchema1.definitions['bar/baz'], 'resolved \'bar/baz\'');
  });

  describe('JSON pointer key escaping (RFC 6901)', function () {
    it('escapes every occurrence, not just the first', function () {
      assert.deepEqual(encodeJsonPointerPath('#', 'a~b~c'), '#/a~0b~0c');
      assert.deepEqual(encodeJsonPointerPath('#', 'a/b/c'), '#/a~1b~1c');
    });

    it('decodes ~1 before ~0 so ~01 does not collapse to /', function () {
      assert.deepEqual(decodeJsonPointerPath('/~01'), ['~1']);
      assert.deepEqual(decodeJsonPointerPath('/~001'), ['~01']);
    });

    it('round-trips keys containing ~ and / sequences', function () {
      const keys = ['~1', '~01', 'a~b~c', 'a/b/c', 'a~b/c~d', '~~', '~0/~1'];
      for (const key of keys) {
        const path = encodeJsonPointerPath('#', key);
        const decoded = decodeJsonPointerPath(path);
        assert.isTrue(decoded.length === 1 && decoded[0] === key,
          `round-trip '${key}' via '${path}' gave '${decoded[0]}'`);
      }
    });

    it('resolves schema keys containing pointer escape sequences', function () {
      const map = new Map();
      const schema = {
        $id: 'http://jaren.com/tilde.json',
        definitions: {
          '~1': { type: 'string' },
          '~01': { type: 'number' },
        },
      };
      storeSchemaIdsInMap(map, 'http://nonexistent.void/', schema);
      const slashy = resolveRefSchemaShallow(map, 'http://jaren.com/tilde.json#/definitions/~01', null).schema;
      assert.isTrue(slashy === schema.definitions['~1'], 'resolved literal \'~1\' key');
      const tildy = resolveRefSchemaShallow(map, 'http://jaren.com/tilde.json#/definitions/~001', null).schema;
      assert.isTrue(tildy === schema.definitions['~01'], 'resolved literal \'~01\' key');
    });
  });
});
