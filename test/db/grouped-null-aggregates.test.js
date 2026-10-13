//@ts-check
/**
 * @file A grouped sum, mean or extreme over a column whose policy reads a NULL
 * as a present `null`. The engine refuses a sequence holding a null
 * (`JQ2001`); SQL skips the NULL. The statement counts the NULLs of each such
 * aggregate beside it and the runtime refuses the answer when one is met, so
 * the grouping runs in SQL and answers as the engine does: the same value
 * where no NULL is read, the same refusal where one is.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defineModel, object, integer, string } from '@jarenjs/linq/model';
import { normalizeEntities, explainMapping } from '@jarenjs/db/model';
import { createEntityQueryEngine, createQueryState } from '@jarenjs/db/query';
import { nodeDriver } from '@jarenjs/db/node';

const column = (name, codec, nullPolicy) => ({ name, codec, null: nullPolicy });
const MODEL = defineModel({ entities: {
  Row: object({ id: integer().identity('auto'), g: string(), n: integer().nullable(), s: string().nullable() })
    .physical({ table: 'rows_t', columns: { id: column('id', 'integer', 'reject'), g: column('g', 'text', 'reject'),
      n: column('n', 'integer', 'null'), s: column('s', 'text', 'null') } }),
  Opt: object({ id: integer().identity('auto'), g: string(), a: integer().nullable(), r: integer().nullable() })
    .physical({ table: 'opt_t', columns: { id: column('id', 'integer', 'reject'), g: column('g', 'text', 'reject'),
      a: column('a', 'integer', 'absent'), r: column('r', 'integer', 'reject') } }),
  Tag: object({ id: integer().identity('auto'), rowId: integer() })
    .physical({ table: 'tags_t', columns: { id: column('id', 'integer', 'reject'), rowId: column('row_id', 'integer', 'reject') } }),
} });
const SEED = `CREATE TABLE rows_t(id INTEGER PRIMARY KEY, g TEXT NOT NULL, n INTEGER, s TEXT);
  INSERT INTO rows_t VALUES (1,'a',1,'p'),(2,'a',2,'q'),(3,'b',10,'r'),(4,'b',NULL,NULL),(5,'c',7,'s'),(6,'c',NULL,'t');
  CREATE TABLE tags_t(id INTEGER PRIMARY KEY, row_id INTEGER NOT NULL);
  INSERT INTO tags_t VALUES (1,1),(2,1),(3,3),(4,4),(5,5);
  CREATE TABLE opt_t(id INTEGER PRIMARY KEY, g TEXT NOT NULL, a INTEGER, r INTEGER NOT NULL);
  INSERT INTO opt_t VALUES (1,'a',1,4),(2,'a',NULL,5),(3,'b',3,6)`;

/** @param {(engine: any) => void} run */
async function fixture(run) {
  const connection = await nodeDriver().open(':memory:');
  connection.exec(SEED);
  const engine = createEntityQueryEngine({ connection, entities: normalizeEntities(MODEL),
    mapping: explainMapping(MODEL), state: createQueryState(8) });
  try { run(engine); }
  finally { connection.close(); }
}

/** @param {any} engine @param {any} document @param {any} [options] */
const answer = (engine, document, options) => {
  try { return JSON.stringify(engine.execute(document, options)); }
  catch (error) { return `throws ${error.code}`; }
};
const FUNCTIONS = [['sum', '$sum'], ['mean', '$avg'], ['least', '$min'], ['greatest', '$max']];
/** @param {string} aggregate @param {string} member @param {any} [where] */
const grouping = (aggregate, member, where = undefined) => ({ $for: { it: '$.Row[*]' },
  ...(where === undefined ? {} : { $where: where }), $groupby: { g: '$it.g' },
  $return: { g: '$g', v: { [aggregate]: `$it.${member}` } } });

describe('a grouped aggregate over a column that reads a NULL as a present null', () => {
  it('answers in SQL, as the engine does, where its groups hold no NULL', async () => fixture((engine) => {
    const clean = { $lt: ['$it.id', 4] };
    const expected = { $sum: [{ g: 'a', v: 3 }, { g: 'b', v: 10 }], $avg: [{ g: 'a', v: 1.5 }, { g: 'b', v: 10 }],
      $min: [{ g: 'a', v: 1 }, { g: 'b', v: 10 }], $max: [{ g: 'a', v: 2 }, { g: 'b', v: 10 }] };
    for (const [name, aggregate] of FUNCTIONS) {
      const query = grouping(aggregate, 'n', clean);
      assert.equal(engine.explain(query).mode, 'native', `the ${name}`);
      assert.equal(answer(engine, query, { strict: true }), JSON.stringify(expected[aggregate]), `the ${name}`);
      assert.equal(answer(engine, query, { pushdown: false }), JSON.stringify(expected[aggregate]), `the ${name} (engine)`);
    }
    const text = { $lt: ['$it.id', 4] };
    for (const [aggregate, want] of [['$min', [{ g: 'a', v: 'p' }, { g: 'b', v: 'r' }]], ['$max', [{ g: 'a', v: 'q' }, { g: 'b', v: 'r' }]]]) {
      const query = grouping(aggregate, 's', text);
      assert.equal(engine.explain(query).mode, 'native', aggregate);
      assert.equal(answer(engine, query, { strict: true }), JSON.stringify(want), aggregate);
      assert.equal(answer(engine, query, { pushdown: false }), JSON.stringify(want), `${aggregate} (engine)`);
    }
  }));

  it('refuses with the engine\'s error where a group holds a NULL, even when another group is clean', async () => fixture((engine) => {
    for (const [name, aggregate] of FUNCTIONS) {
      for (const member of ['n', 's']) {
        if (member === 's' && (aggregate === '$sum' || aggregate === '$avg')) continue;
        const query = grouping(aggregate, member);
        const label = `the ${name} of ${member}`;
        assert.equal(engine.explain(query).mode, 'native', label);
        assert.equal(answer(engine, query, { pushdown: false }), 'throws JQ2001', `${label} (engine)`);
        assert.equal(answer(engine, query, { strict: true }), 'throws JQ2001', label);
        assert.equal(answer(engine, query), 'throws JQ2001', label);
      }
    }
    // the refusal is the query catalog's sentence, as a whole-set aggregate's is
    assert.throws(() => engine.execute(grouping('$max', 'n')), {
      code: 'JQ2001', messageId: 'query/aggregate-null', params: {}, message: 'JQ2001: an aggregate requires numbers or strings, got null' });
  }));

  it('refuses only for the rows the selection keeps', async () => fixture((engine) => {
    // rows 4 and 6 hold the NULLs of n: a selection that drops them answers, one that keeps either refuses
    const without = { $and: [{ $ne: ['$it.id', 4] }, { $ne: ['$it.id', 6] }] };
    const query = grouping('$sum', 'n', without);
    assert.equal(answer(engine, query, { strict: true }), JSON.stringify([{ g: 'a', v: 3 }, { g: 'b', v: 10 }, { g: 'c', v: 7 }]));
    assert.equal(answer(engine, query, { pushdown: false }), answer(engine, query, { strict: true }));
    const keeps = grouping('$sum', 'n', { $ne: ['$it.id', 4] });
    assert.equal(answer(engine, keeps, { strict: true }), 'throws JQ2001');
    assert.equal(answer(engine, keeps, { pushdown: false }), 'throws JQ2001');
    const none = grouping('$sum', 'n', { $lt: ['$it.id', 0] });
    assert.equal(answer(engine, none, { strict: true }), answer(engine, none, { pushdown: false }));
    assert.deepEqual(engine.execute(none, { strict: true }), engine.execute(none, { pushdown: false }));
  }));

  it('guards the aggregate over such a column beside aggregates of other columns, and an ordering by it', async () => fixture((engine) => {
    const beside = (member, where) => ({ $for: { it: '$.Row[*]' }, $where: where, $groupby: { g: '$it.g' },
      $return: { g: '$g', rows: { $count: '$it' }, ids: { $sum: '$it.id' }, v: { $max: `$it.${member}` } } });
    const clean = { $lt: ['$it.id', 4] };
    assert.equal(answer(engine, beside('n', clean), { strict: true }),
      JSON.stringify([{ g: 'a', rows: 2, ids: 3, v: 2 }, { g: 'b', rows: 1, ids: 3, v: 10 }]));
    assert.equal(answer(engine, beside('n', { $ge: ['$it.id', 1] }), { strict: true }), 'throws JQ2001');
    assert.equal(answer(engine, beside('n', { $ge: ['$it.id', 1] }), { pushdown: false }), 'throws JQ2001');
    // a grouping ordered by the aggregate meets the refusal before any order
    const ordered = { ...grouping('$max', 'n'), $orderby: [{ $key: { $max: '$it.n' }, $dir: 'desc' }] };
    assert.equal(engine.explain(ordered).mode, 'native');
    assert.equal(answer(engine, ordered, { pushdown: false }), 'throws JQ2001');
    assert.equal(answer(engine, ordered), 'throws JQ2001');
  }));

  it('guards a grouping over a join the same way', async () => fixture((engine) => {
    const joined = (where) => ({ $for: { a: '$.Row[*]', b: '$.Tag[*]' },
      $where: { $and: [{ $eq: ['$b.rowId', '$a.id'] }, ...where] }, $groupby: { g: '$a.g' },
      $return: { g: '$g', v: { $sum: '$a.n' }, tags: { $count: '$b' } } });
    // tags reach rows 1 (twice), 3, 4 and 5: row 4 holds a NULL
    const clean = joined([{ $ne: ['$a.id', 4] }]);
    assert.equal(engine.explain(clean).mode, 'native');
    assert.equal(answer(engine, clean, { strict: true }), JSON.stringify([{ g: 'a', v: 2, tags: 2 }, { g: 'b', v: 10, tags: 1 }, { g: 'c', v: 7, tags: 1 }]));
    assert.equal(answer(engine, clean, { pushdown: false }), answer(engine, clean, { strict: true }));
    const nulled = joined([{ $ge: ['$a.id', 1] }]);
    assert.equal(answer(engine, nulled, { pushdown: false }), 'throws JQ2001');
    assert.equal(answer(engine, nulled, { strict: true }), 'throws JQ2001');
  }));

  it('keeps a nullable column of another policy in the engine, which the count of NULLs does not cover', async () => fixture((engine) => {
    // a column whose NULL reads back as no member (`absent`), or whose policy
    // admits none (`reject`) under a schema that admits null, is not a column
    // this guard counts: the plan, its refusal and its answers are the engine's
    for (const [name, aggregate] of FUNCTIONS) {
      for (const member of ['a', 'r']) {
        const query = { $for: { it: '$.Opt[*]' }, $groupby: { g: '$it.g' }, $return: { g: '$g', v: { [aggregate]: `$it.${member}` } } };
        const label = `the ${name} of ${member}`;
        const explained = engine.explain(query);
        assert.equal(explained.mode, 'set', label);
        assert.equal(explained.reasons[0].construct, '$groupby', label);
        assert.throws(() => engine.execute(query, { strict: true }), { code: 'JD0010' }, label);
        assert.equal(answer(engine, query), answer(engine, query, { pushdown: false }), label);
      }
    }
  }));
});
