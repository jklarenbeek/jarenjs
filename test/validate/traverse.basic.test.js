import { describe, it } from 'node:test';
import * as assert from '@jaren/tools/assert';

import {
  storeSchemaIdsInMap,
  resolveRefSchemaShallow
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
});
