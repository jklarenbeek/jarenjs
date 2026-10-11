//@ts-check
/**
 * @file The members of an entity document that a path reads by a digit name.
 * PostgreSQL's `#>` takes the key `0` of an object and the element `0` of an
 * array for one step, so a statement reads such a path from a document
 * guarded for the container each step means. The differential corpus proves
 * the entity predicates, projections and orderings of a query; the orderings
 * of a graph load and of an included relation are statements of their own.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { onBothEngines } from './query-core-engines.js';

const MEMBER = {
  type: ['array', 'object', 'string', 'null'],
  items: { type: 'integer' },
  properties: { 0: { type: 'integer' }, '00': { type: 'integer' }, ' 1': { type: 'integer' } },
};
const MODEL = {
  $model: '0.1',
  entities: {
    A: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'integer', 'x-entity': { key: true } },
      bs: { 'x-entity': { relation: { to: 'B', many: true, via: 'aid', onDelete: 'cascade' } } } } } },
    B: { schema: { type: 'object', required: ['id', 'aid'], properties: {
      id: { type: 'integer', 'x-entity': { key: true } }, aid: { type: 'integer' }, u: MEMBER } } },
  },
};
/** A member holding an array, an object keyed `0`, a string, an object keyed `00`, an array again, and nothing. */
const ROWS = [{ id: 1, aid: 1, u: [7, 9] }, { id: 2, aid: 1, u: { 0: 3 } }, { id: 3, aid: 1, u: 'x' },
  { id: 4, aid: 1, u: { '00': 1 } }, { id: 5, aid: 1, u: [1, 7] }, { id: 6, aid: 1 }];
/** The order each path gives, absent values first: an index reads arrays alone and a name objects alone. */
const ORDERS = /** @type {[string, number[]][]} */ ([
  ['$it.u[0]', [2, 3, 4, 6, 5, 1]],
  ["$it.u['0']", [1, 3, 4, 5, 6, 2]],
  ["$it.u['00']", [1, 2, 3, 5, 6, 4]],
]);

describe('an ordering by a digit name over an entity document', () => {
  it('a graph load and an included relation read one container kind per step, on every host', async () => {
    await onBothEngines(MODEL, async (store, host) => {
      await store.entity('A').create({ id: 1 });
      for (const row of ROWS) await store.entity('B').create(row);
      for (const [path, ids] of ORDERS) {
        const loaded = await store.entity('B').load({ orderBy: path });
        assert.deepEqual(loaded.map((/** @type {any} */ row) => row.id), ids, `${host}: load by ${path}`);
        const included = await store.entity('A').load({ include: { bs: { orderBy: path } } });
        assert.deepEqual(included[0].bs.map((/** @type {any} */ row) => row.id), ids, `${host}: include by ${path}`);
      }
    });
  });
});
