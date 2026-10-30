//@ts-check
/**
 * @file `prefixItems` is a keyword from draft 2020-12 on: a document that
 * declares an older draft reads it as an unknown keyword, as the validator
 * and the normalizer do, so its `items` types every item.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileEmitModel, emitTypeScript } from '@jarenjs/emit';
import { JarenValidator } from '@jarenjs/validate';
import { readsPrefixItems } from '@jarenjs/validate/normalize';

const D07 = 'http://json-schema.org/draft-07/schema#';
const D19 = 'https://json-schema.org/draft/2019-09/schema';
const D20 = 'https://json-schema.org/draft/2020-12/schema';
const TUPLE = { kind: 'tuple', items: [{ kind: 'optional', item: { kind: 'ref', ref: 'RootItem1' } }], rest: { kind: 'unknown' } };
/** @param {object} schema */
const rootType = (schema) => compileEmitModel(schema).declarations.at(-1).type;

describe('prefixItems under a draft before 2020-12', () => {
  it('the reported input: an array of anything, as the validator reads it (was a tuple of an integer)', () => {
    const schema = { $schema: D07, type: 'array', prefixItems: [{ type: 'integer' }] };
    assert.equal(emitTypeScript(schema).split('\n').filter((line) => line.startsWith('export')).join('\n'),
      'export type Root = Array<unknown>;');
    assert.equal(new JarenValidator().compile(schema)(['x']), true);
  });

  it('in draft-07 and 2019-09 types every item by items, a closed one included', () => {
    for (const $schema of [D07, D19]) {
      assert.deepEqual(rootType({ $schema, type: 'array', prefixItems: [{ type: 'integer' }] }), { kind: 'array', items: { kind: 'unknown' } }, $schema);
      assert.deepEqual(rootType({ $schema, type: 'array', prefixItems: [{ type: 'integer' }], items: false }), { kind: 'array', items: { kind: 'never' } }, $schema);
    }
  });

  it('reads the gate the validator and the normalizer read', () => {
    assert.deepEqual([6, 7, 2019, 2020, null].map(readsPrefixItems), [false, false, false, true, true]);
  });

  it('in 2020-12, and where no draft is declared, is a tuple as before', () => {
    for (const $schema of [D20, undefined]) {
      assert.deepEqual(rootType({ ...($schema ? { $schema } : {}), type: 'array', prefixItems: [{ type: 'integer' }] }), TUPLE, String($schema));
      // an empty closed prefix is the empty tuple
      assert.deepEqual(rootType({ ...($schema ? { $schema } : {}), type: 'array', prefixItems: [], items: false }), { kind: 'tuple', items: [] }, String($schema));
    }
  });
});
