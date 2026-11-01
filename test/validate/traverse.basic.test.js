import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  storeSchemaIdsInMap,
  resolveRefSchemaShallow,
  resolveRefSchemaDeep,
  decodeJsonPointerPath,
  createJsonPointer,
  withParsedPointers,
  TraverseOptions,
} from '../../packages/validate/src/traverse.js';
import { encodeJsonPointerPath } from '../../packages/validate/src/origin.js';

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

describe('the pointer parses a compile keeps', function () {
  const parses = () => [
    createJsonPointer('#foo', 'https://a.test/s.json', new TraverseOptions(undefined, true, true)),
    createJsonPointer('#foo', 'https://a.test/s.json'),
    createJsonPointer('#foo', 'https://a.test/s.json', new TraverseOptions(undefined, true, false, false)),
    createJsonPointer('#foo', 'https://a.test/t.json'),
    createJsonPointer('#/$defs/x', 'https://a.test/s.json'),
  ];

  it('answer every parse as a fresh one, whatever was parsed before', function () {
    const fresh = parses();
    assert.deepStrictEqual(fresh.map((pointer) => pointer.id), [
      '#foo', 'https://a.test/s.json#foo', 'https://a.test/s.json#', 'https://a.test/t.json#foo', 'https://a.test/s.json#/$defs/x',
    ]);
    assert.deepStrictEqual(withParsedPointers(() => [...parses(), ...parses()]), [...fresh, ...fresh]);
    assert.deepStrictEqual(withParsedPointers(() => withParsedPointers(parses)), fresh);
  });

  it('keep no refusal: each names its own place', function () {
    const refusal = (location) => {
      try {
        createJsonPointer('a b', 'urn:x', undefined, '$ref', location);
      }
      catch (error) {
        return [error.code, error.docPath];
      }
    };
    assert.deepStrictEqual(withParsedPointers(() => [refusal('#/a'), refusal('#/b')]), [['JK0010', '#/a'], ['JK0010', '#/b']]);
  });
});

describe('a tentative reference resolution', function () {
  const held = { $defs: { x: { type: 'string' }, hop: { $ref: 'https://b.test/t.json#/$defs/y' } } };
  const map = new Map([['https://a.test/s.json#', held]]);

  it('answers undefined where a hop names a document no schema the map holds', function () {
    assert.strictEqual(resolveRefSchemaShallow(map, '#/$defs/x', 'https://b.test/t.json', undefined, undefined, true), undefined);
    assert.throws(() => resolveRefSchemaShallow(map, '#/$defs/x', 'https://b.test/t.json'), { code: 'JK0009' });
    const chain = { $ref: 'https://a.test/s.json#/$defs/hop' };
    assert.strictEqual(resolveRefSchemaDeep(map, 'https://a.test/s.json', chain, undefined, undefined, undefined, null, true), undefined);
    assert.throws(() => resolveRefSchemaDeep(map, 'https://a.test/s.json', chain), { code: 'JK0009' });
  });

  it('resolves a reference to a held document as it always does', function () {
    assert.deepStrictEqual(resolveRefSchemaShallow(map, '#/$defs/x', 'https://a.test/s.json', undefined, undefined, true),
      { id: 'https://a.test/s.json#/$defs/x', schema: { type: 'string' } });
  });
});
