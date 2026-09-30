//@ts-check
/**
 * @file The nullable normalizer's boundary: readers whose reading is PERSISTED
 * keep it. The db column mapper still keeps a union spelling in the
 * document and gives the type-array spelling a column; a contract's
 * `revision()` bytes do not move; and the schema pen writes the same
 * document for every unchanged authoring call. Every literal below was
 * produced by 0.92.0 (`59ff8857`) — before the normalizer existed — so a
 * reader that starts normalizing a persisted reading fails here, and a
 * move between the spellings stays what it is: a planned migration.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileContract } from '@jarenjs/contract';
import { explainMapping } from '@jarenjs/db';
import * as s from '@jarenjs/linq/schema';
import { load } from '../contract/helpers.js';

describe('persisted readings do not move with the nullable normalizer', () => {
  it('the db mapper: a union spelling lives in the document, the type-array spelling gets a column', () => {
    const mapping = explainMapping({ $model: '0.1', entities: { Person: { schema: { type: 'object', properties: {
      id: { type: 'string', 'x-entity': { key: true } },
      union: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      array: { type: ['string', 'null'] },
      unionInt: { oneOf: [{ type: 'null' }, { type: 'integer' }] },
    } } } } });
    assert.deepStrictEqual(mapping.entities.Person, {
      table: 'Person',
      keys: ['id'],
      columns: [
        { name: 'id', storage: 'string', source: 'document', key: true },
        { name: 'array', storage: 'string', source: 'document', key: false },
      ],
      foreignKeys: [],
      indexes: [],
      document: ['union', 'unionInt'],
      version: null,
    });
  });

  it('revision() of an unchanged contract is the 0.92.0 digest, both spellings included', async () => {
    assert.strictEqual(await compileContract(load('./fixtures/shop.contract.json')).revision(),
      'bee4f62caa656bbd58fa214f423eaaab87238090e6d480f1eec69e6feaea4fc5');
    const nullable = { $contract: '0.1', operations: { 'a.b': { kind: 'command',
      input: { type: 'object', required: ['x'], properties: {
        x: { anyOf: [{ type: 'string' }, { type: 'null' }] }, y: { type: ['string', 'null'] } } },
      output: { type: 'object', properties: { z: { oneOf: [{ type: 'null' }, { type: 'integer' }] } } },
      http: { method: 'POST', path: '/a' } } } };
    assert.strictEqual(await compileContract(nullable).revision(),
      '3909ecd33f2cf7389742084eab32186674f0ac41f4c44b7e670048c7e8427df1');
  });

  it('the schema pen writes the same bytes for every unchanged nullable authoring call', () => {
    assert.strictEqual(JSON.stringify(s.union([s.string(), s.nil()]).schema), '{"anyOf":[{"type":"string"},{"type":"null"}]}');
    assert.strictEqual(JSON.stringify(s.string().nullable().schema), '{"type":["string","null"]}');
    assert.strictEqual(JSON.stringify(s.from({ type: 'string' }).nullable().schema), '{"anyOf":[{"type":"string"},{"type":"null"}]}');
    assert.strictEqual(JSON.stringify(s.object({ a: s.string() }).nullable().schema), '{"type":["object","null"],"properties":{"a":{"type":"string"}},"required":["a"],"additionalProperties":false}');
    assert.strictEqual(JSON.stringify(s.enumOf(['a', 'b']).nullable().schema), '{"enum":["a","b",null]}');
    assert.strictEqual(JSON.stringify(s.literal(1).nullable().schema), '{"enum":[1,null]}');
  });
});
