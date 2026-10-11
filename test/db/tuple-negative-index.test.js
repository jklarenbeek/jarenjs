//@ts-check
/**
 * @file A negative index counts from the end of an array, so against a tuple
 * (`prefixItems` beside `items`) it lands on a prefix item in a short array
 * and on an item past the prefix in a long one. No schema types it, so the
 * planner types it as unknown and every shape that needs a proven type (an
 * ordering, a string operator, a minimum) runs in the engine, which raises
 * where a statement would answer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileJsonQuery } from '@jarenjs/json/query';
import { schemaNodeAt } from '../../packages/db/src/ddl.js';

import { onBothEngines } from './query-core-engines.js';

const TUPLE = { type: 'array', prefixItems: [{ type: 'number' }], items: { type: 'string' } };

async function outcome(/** @type {() => any} */ call) {
  try { return { value: await call() }; }
  catch (error) { return { code: /** @type {any} */ (error).code }; }
}

function engineOutcome(/** @type {any} */ query, /** @type {any} */ documents) {
  try { return { value: compileJsonQuery(query)(structuredClone(documents)) }; }
  catch (error) { return { code: /** @type {any} */ (error).code }; }
}

describe('the schema node of an array element', () => {
  it('places a non-negative index through the prefix items and then the items', () => {
    const schema = { type: 'object', properties: { a: TUPLE } };
    const at = (/** @type {number} */ index) => schemaNodeAt(schema, [{ name: 'a' }, { index }])?.type;
    assert.equal(at(0), 'number');
    assert.equal(at(1), 'string');
    assert.equal(at(5), 'string');
  });

  it('places a negative index through items alone, and through no tuple', () => {
    const plain = { type: 'object', properties: { a: { type: 'array', items: { type: 'string' } } } };
    assert.equal(schemaNodeAt(plain, [{ name: 'a' }, { index: -1 }])?.type, 'string');
    const tuple = { type: 'object', properties: { a: TUPLE } };
    assert.equal(schemaNodeAt(tuple, [{ name: 'a' }, { index: -1 }]), undefined);
    assert.equal(schemaNodeAt(tuple, [{ name: 'a' }, { index: -2 }]), undefined);
  });
});

describe('a negative index through a tuple', () => {
  const documents = [{ id: 'r1', a: [1, 'y'] }, { id: 'r2', a: [5] }, { id: 'r3', a: [2, 'p', 'q'] }, { id: 'r4' }];
  const queries = {
    orderby: { $for: { it: '$[*]' }, $orderby: ['$it.a[-1]'], $return: '$it.id' },
    startsWith: { $for: { it: '$[*]' }, $where: { '$starts-with': ['$it.a[-1]', 'y'] }, $return: '$it.id' },
    minimum: { $min: { $for: { it: '$[*]' }, $return: '$it.a[-1]' } },
  };

  it('stays in the engine on a collection, which raises where the statement would answer', async () => {
    const model = { $model: '0.1', collections: { rows: { key: null, identity: 'integer', indexes: [{ name: 'by_id', path: '$.id' }],
      schema: { type: 'object', properties: { id: { type: 'string' }, a: TUPLE } } } } };
    await onBothEngines(model, async (store, host) => {
      const rows = store.collection('rows');
      for (const document of documents) await rows.insert(document);
      for (const [name, query] of Object.entries(queries)) {
        const label = `${host}: ${name}`;
        const engine = engineOutcome(query, documents);
        assert.ok(engine.code, label);
        if (name !== 'startsWith') assert.equal((await rows.explain(query)).mode, 'set', label);
        assert.deepEqual(await outcome(() => rows.execute(query)), engine, label);
      }
    });
  });

  it('stays in the engine on an entity', async () => {
    const model = { $model: '0.1', entities: { B: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'integer', 'x-entity': { key: true } }, p: TUPLE } } } } };
    const rowsOf = [{ id: 1, p: [1, 'y'] }, { id: 2, p: [5] }, { id: 3, p: [2, 'p', 'q'] }, { id: 4 }];
    await onBothEngines(model, async (store, host) => {
      for (const document of rowsOf) await store.entity('B').create(document);
      for (const [name, query] of /** @type {[string, any][]} */ ([
        ['orderby', { $for: { b: '$.B[*]' }, $orderby: ['$b.p[-1]'], $return: '$b.id' }],
        ['minimum', { $min: { $for: { b: '$.B[*]' }, $return: '$b.p[-1]' } }],
      ])) {
        const label = `${host}: ${name}`;
        const engine = await outcome(() => store.execute(query, { pushdown: false }));
        assert.ok(engine.code, label);
        assert.equal((await store.explain(query)).mode, 'set', label);
        assert.deepEqual(await outcome(() => store.execute(query)), engine, label);
      }
    });
  });

  it('keeps a non-negative index typed as the schema places it', async () => {
    const model = { $model: '0.1', collections: { rows: { key: null, identity: 'integer', indexes: [{ name: 'by_id', path: '$.id' }],
      schema: { type: 'object', properties: { id: { type: 'string' }, a: TUPLE } } } } };
    const query = { $for: { it: '$[*]' }, $orderby: ['$it.a[1]', '$it.id'], $return: '$it.id' };
    await onBothEngines(model, async (store, host) => {
      const rows = store.collection('rows');
      for (const document of documents) await rows.insert(document);
      assert.equal((await rows.explain(query)).mode, 'native', host);
      assert.deepEqual(await outcome(() => rows.execute(query)), engineOutcome(query, documents), host);
    });
  });
});
