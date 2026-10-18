//@ts-check
/**
 * @file A number comparison over an indexed member whose PostgreSQL column
 * is `jsonb` — a member the schema leaves untyped, or a union that lists a
 * container first beside no index that keys its numbers — ranges over the
 * column in JSON's own number order, which its index serves: a literal, an
 * external and a membership list. The edges are the interval of decimals that
 * round to the engine's double, spelled as JSON numbers, so another writer's
 * digits (`5.00000000000000000001`, `1152921504606846976`, `1e-400`, `-0`)
 * and a tie on an edge answer as the engine reads them; between two numbers a
 * `jsonb` range holds numbers alone, and a one-sided bound is kept to them by
 * the type test. Every answer equals the engine's (`pushdown: false`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decimalEdge, decimalIntervals } from '../../packages/db/src/double-interval.js';
import { PG_URL, withStore } from './store-core-engines.js';

const MODEL = { $model: '0.1', collections: { docs: { key: '/id',
  schema: { type: 'object', properties: { id: { type: 'string' }, u: {}, o: { type: ['object', 'number'] } } },
  indexes: [{ name: 'by_u', path: '$.u' }, { name: 'by_o', path: ['$.o', '$.id'] }] } } };
/** What each document's `u` (and `o`, where it is an object or a number) holds, as JSON text a raw writer spelled. */
const SPELLED = [['a', '5'], ['b', '5.00000000000000000001'], ['c', '4.99999999999999999999'], ['d', '"5"'],
  ['e', '1152921504606846976'], ['f', '1152921504606847000'], ['g', '0'], ['h', '-0'], ['i', '1e-400'],
  ['j', 'null'], ['k', 'true'], ['l', '[]'], ['m', '[5]'], ['n', '{"a":5}'], ['p', decimalEdge(5, 'high')],
  ['q', decimalEdge(5, 'highExclusive')], ['r', '-3'], ['s', '"abc"']];
/** The value a statement's slot binds for finite externals, as the store binds it.
 * @param {any} slot @param {Record<string, any>} externals */
const bound = (slot, externals) => ('literal' in slot ? slot.literal
  : slot.intervals === true ? decimalIntervals(externals[slot.external])
    : slot.decimal !== undefined ? decimalEdge(externals[slot.external], slot.decimal) : JSON.stringify(externals[slot.external]));
/** A sequence of one comes back as its item. @param {any} result @returns {any[]} */
const listOf = (result) => (result === undefined ? [] : Array.isArray(result) ? result : [result]);
/** @param {any} where */
const ids = (where) => ({ $for: { it: '$[*]' }, $where: where, $orderby: ['$it.id'], $return: '$it.id' });

describe('PostgreSQL: a number comparison over a jsonb column seeks its index', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => {
  it('answers every comparison as the engine does, and names the index the statement reads', async () => {
    await withStore('postgres', MODEL, async (store, pg) => {
      const docs = store.collection('docs');
      for (const [id, json] of SPELLED) {
        // `o` holds what its union admits: a number or an object
        await pg?.pool.query(`INSERT INTO "${pg.schema}"."docs" ("key", "doc") VALUES ($1, $2::jsonb)`,
          [id, `{"id":"${id}","u":${json}${/^[-\d{]/.test(json) ? `,"o":${json}` : ''}}`]);
      }
      await docs.insert({ id: 'z' });
      /** @type {[any, any, string[]][]} */
      const cases = [
        [{ $eq: ['$it.u', 5] }, {}, ['a', 'b', 'c', 'p']],
        [{ $lt: ['$it.u', 5] }, {}, ['g', 'h', 'i', 'r']],
        [{ $le: ['$it.u', 0] }, {}, ['g', 'h', 'i', 'r']],
        [{ $gt: ['$it.u', 5] }, {}, ['e', 'f', 'q']],
        [{ $ge: ['$it.u', 2 ** 60] }, {}, ['e', 'f']],
        [{ $eq: ['$it.u', '$x'] }, { x: 5 }, ['a', 'b', 'c', 'p']],
        [{ $lt: ['$it.u', '$x'] }, { x: 5 }, ['g', 'h', 'i', 'r']],
        [{ $eq: ['$it.u', '$x'] }, { x: '5' }, ['d']],
        [{ $eq: ['$it.u', { $seq: [0, 2 ** 60] }] }, {}, ['e', 'f', 'g', 'h', 'i']],
        [{ $eq: ['$it.u', '$xs[*]'] }, { xs: [5, 'abc'] }, ['a', 'b', 'c', 'p', 's']],
        [{ $not: { $eq: ['$it.u', 5] } }, {}, ['d', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'q', 'r', 's', 'z']],
        [{ $ne: ['$it.u', 5] }, {}, ['d', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'q', 'r', 's']],
        [{ $eq: ['$it.o', 5] }, {}, ['a', 'b', 'c', 'p']],
        [{ $lt: ['$it.o', 0] }, {}, ['r']],
      ];
      for (const [where, externals, expected] of cases) {
        const label = JSON.stringify([where, externals]);
        assert.deepEqual(listOf(await docs.execute(ids(where), { externals, pushdown: false })), expected, `engine ${label}`);
        assert.deepEqual(listOf(await docs.execute(ids(where), { externals })), expected, label);
      }
      // the statement spells the column, so the index is named; a difference reads the document
      for (const [where, externals, index] of /** @type {[any, any, string[]][]} */ ([
        [{ $eq: ['$it.u', 5] }, {}, ['docs_by_u']], [{ $lt: ['$it.u', '$x'] }, { x: 5 }, ['docs_by_u']],
        [{ $eq: ['$it.u', { $seq: [5, 6] }] }, {}, ['docs_by_u']], [{ $ge: ['$it.o', 5] }, {}, ['docs_by_o']],
        [{ $ne: ['$it.u', 5] }, {}, []]])) {
        const explained = await docs.explain({ $for: { it: '$[*]' }, $where: where, $return: '$it.id' }, { externals });
        assert.equal(explained.mode, 'native');
        assert.deepEqual(explained.indexes, index, JSON.stringify(where));
      }
    });
  });

  it('leaves a member whose numbers an index beside its declared one keys to that index', async () => {
    const kinds = { $model: '0.1', collections: { kinds: { key: '/id',
      schema: { type: 'object', properties: { id: { type: 'string' }, k: { type: ['object', 'number'] } } },
      indexes: [{ name: 'by_k', path: '$.k' }] } } };
    await withStore('postgres', kinds, async (store) => {
      const sql = (await store.collection('kinds').explain({ $for: { it: '$[*]' }, $where: { $eq: ['$it.k', 5] }, $return: '$it.id' })).sql;
      // the read the index `kinds_by_k$number` keys, not the jsonb column
      assert.match(sql, /\(CASE WHEN jsonb_typeof\(\("doc" #> '\{"k"\}'\)\) = 'number' THEN \(\("doc" #> '\{"k"\}'\)\)::numeric END\) >= \$1/);
      assert.doesNotMatch(sql, /"gx_k" >=/);
    });
  });

  it('reads the range through the column\'s index, which a scan of the document never did', async () => {
    await withStore('postgres', MODEL, async (store, pg) => {
      const docs = store.collection('docs');
      await docs.insert({ id: 'a', u: 5 });
      const admin = await pg?.pool.connect();
      try {
        await admin.query(`SET search_path TO "${pg?.schema}"`);
        await admin.query('SET enable_seqscan = off');
        for (const [where, externals] of /** @type {[any, any][]} */ ([[{ $lt: ['$it.u', 5] }, {}], [{ $eq: ['$it.u', '$x'] }, { x: 5 }],
          [{ $eq: ['$it.u', { $seq: [5, 6] }] }, {}]])) {
          const explained = await docs.explain(ids(where), { externals });
          const plan = (await admin.query({ text: `EXPLAIN ${explained.sql}`, values: explained.params.map((/** @type {any} */ slot) => bound(slot, externals)) }))
            .rows.map((/** @type {any} */ row) => row['QUERY PLAN']).join('\n');
          assert.match(plan, /Index (Only )?Scan using docs_by_u|Bitmap Index Scan on docs_by_u/, plan);
          assert.match(plan, /Index Cond: .*\bgx_u [<>=]+ /, plan);
        }
      }
      finally {
        await admin.query('RESET enable_seqscan');
        await admin.query('RESET search_path');
        admin.release();
      }
    });
  });
});
