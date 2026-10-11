//@ts-check
/**
 * @file A `$where` whose `$and` holds another `$and`. The query normalizer
 * reads the nest as one call, so the planner's conjuncts are the leaves of
 * the nest; a conjunct that runs as a registered function carries the
 * fragment the caller wrote at the place the caller wrote it, and an
 * answer that ran another conjunct's fragment is a different query's.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileJsonQuery } from '@jarenjs/json/query';
import { planQuery } from '@jarenjs/db';

import { onBothEngines } from './query-core-engines.js';

const SCHEMA = { type: 'object', properties: { id: { type: 'string' }, k: { type: 'integer' }, a: { type: ['string', 'integer'] }, o: {} } };
const DOCUMENTS = [{ id: 'r1', k: 3, a: 1, o: { p: 1 } }, { id: 'r2', k: 3, a: 2, o: { p: 2 } }, { id: 'r3', k: 1, a: 2, o: { p: 2 } }, { id: 'r4', k: 5, a: 9 }];
// `a` against a member the schema leaves untyped is a conjunct no statement spells
const SAME = { $eq: ['$it.a', '$it.o.p'] };
const WHERES = /** @type {Record<string, any>} */ ({
  flat: { $and: [{ $ne: ['$it.k', 1] }, SAME, { $gt: ['$it.k', 2.5] }] },
  'nested on the left': { $and: [{ $and: [{ $ne: ['$it.k', 1] }, SAME] }, { $gt: ['$it.k', 2.5] }] },
  'nested on the right': { $and: [{ $gt: ['$it.k', 2.5] }, { $and: [{ $ne: ['$it.k', 1] }, SAME] }] },
  'nested twice': { $and: [{ $and: [{ $and: [SAME, { $ne: ['$it.k', 1] }] }, { $gt: ['$it.k', 0] }] }, { $lt: ['$it.k', 9] }] },
});
const queryOf = (/** @type {any} */ where) => ({ $for: { it: '$[*]' }, $where: where, $return: '$it.id' });

describe('a registered-function conjunct inside a nested $and', () => {
  it('is planned with the fragment and the place the caller wrote', () => {
    const shape = { collection: 'rows', schema: SCHEMA, columnByCanonical: new Map() };
    /** @type {{ fragment: any, binding: string }[]} */
    const seen = [];
    const udf = (/** @type {any} */ fragment, /** @type {string} */ binding) => { seen.push({ fragment, binding }); return { name: 'registered_stub', key: `k${seen.length}` }; };
    const planned = planQuery(queryOf(WHERES['nested on the left']), shape, { udf });
    // the equality is the only conjunct a statement cannot spell, and the hook is handed exactly that
    assert.deepEqual(seen.map((entry) => entry.fragment), [SAME]);
    const filter = JSON.stringify(planned.plan.filter);
    assert.ok(filter.includes('"mount":"/$where/$and/0/$and/1"'), filter);
  });

  for (const [name, where] of Object.entries(WHERES)) {
    it(`${name}: answers what the engine answers`, async () => {
      const query = queryOf(where);
      const expected = compileJsonQuery(query)(structuredClone(DOCUMENTS));
      await onBothEngines({ $model: '0.1', collections: { rows: { key: null, identity: 'integer', indexes: [], schema: SCHEMA } } }, async (store, host) => {
        const rows = store.collection('rows');
        for (const document of DOCUMENTS) await rows.insert(document);
        assert.deepEqual(await rows.execute(query), expected, `${host}: ${name}`);
        assert.deepEqual(await rows.execute(query, { pushdown: false }), expected, `${host}: ${name} (engine)`);
      });
    });
  }
});
