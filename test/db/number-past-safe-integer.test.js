//@ts-check
/**
 * @file A number past ±(2^53 - 1) compared natively answers as the engine
 * does. The engine compares the doubles both sides are; a document spells a
 * double past 2^53 by its shortest digits (2^60 is `1152921504606847000`),
 * which SQLite reads as the exact integer those digits name. A comparison or
 * a membership with an integer past 2^53 therefore reads the member as the
 * double — and only such a comparison: one with a safe integer or a
 * fraction answers alike either way, keeps its statement and still seeks.
 * Every operator is answered on both sides of 2^53, over unindexed and
 * indexed members of each declared kind, and over an entity's document
 * member and number column.
 *
 * The PostgreSQL half runs where `JAREN_PG_URL` names a server.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { ENGINES, skipFor, withStore } from './store-core-engines.js';

/** The stored rows: two integers past 2^53 whose shortest digits are not
 * the integers they are, one past 2^53 whose digits are, the largest safe
 * integer and a small one. */
const ROWS = [['p', 2 ** 60], ['n', -(2 ** 62)], ['b', 2 ** 53 + 2], ['m', 2 ** 53 - 1], ['s', 5]];

/** Every operator against each literal, as the engine answers it (the rows
 * named, sorted). */
const EXPECTED = [
  [2 ** 60, { $eq: ['p'], $ne: ['b', 'm', 'n', 's'], $lt: ['b', 'm', 'n', 's'], $le: ['b', 'm', 'n', 'p', 's'], $gt: [], $ge: ['p'] }],
  [-(2 ** 62), { $eq: ['n'], $ne: ['b', 'm', 'p', 's'], $lt: [], $le: ['n'], $gt: ['b', 'm', 'p', 's'], $ge: ['b', 'm', 'n', 'p', 's'] }],
  [2 ** 53, { $eq: [], $ne: ['b', 'm', 'n', 'p', 's'], $lt: ['m', 'n', 's'], $le: ['m', 'n', 's'], $gt: ['b', 'p'], $ge: ['b', 'p'] }],
  [2 ** 53 - 1, { $eq: ['m'], $ne: ['b', 'n', 'p', 's'], $lt: ['n', 's'], $le: ['m', 'n', 's'], $gt: ['b', 'p'], $ge: ['b', 'm', 'p'] }],
];

/** Memberships, as the engine answers them. */
const MEMBERSHIPS = [[[2 ** 60, 1], ['p']], [[-(2 ** 62), 5], ['n', 's']], [[2 ** 53, 1], []], [[2 ** 53 - 1, 5], ['m', 's']]];

const INDEX = [{ name: 'by_q', path: '$.q' }];
/** Each declared kind of the member, unindexed and indexed. */
const LAYOUTS = [
  ['an unindexed number', { type: 'number' }, []],
  ['an indexed number', { type: 'number' }, INDEX],
  ['an unindexed integer', { type: 'integer' }, []],
  ['an indexed integer', { type: 'integer' }, INDEX],
  ['an indexed string-first union', { type: ['string', 'number'] }, INDEX],
  ['an indexed number-first union', { type: ['number', 'string'] }, INDEX],
];

/** @param {any} q @param {any} indexes */
const collectionModel = (q, indexes) => ({ $model: '0.1', collections: { c: { key: '/id',
  schema: { type: 'object', properties: { id: { type: 'string' }, q } }, indexes } } });

/** @param {any} where @param {string} [root] */
const query = (where, root = '$[*]') => ({ $for: { it: root }, $where: where, $return: '$it.id' });

/** A call's answer as a sorted list of the ids it returns. @param {any} answer */
const ids = (answer) => (answer === undefined ? [] : Array.isArray(answer) ? answer : [answer]).sort();

/**
 * Every operator and membership over `member`, natively and in the engine.
 * @param {(doc: any, options?: any) => Promise<any>} execute @param {string} member @param {string} [root]
 */
async function assertEveryComparison(execute, member, root) {
  for (const [literal, answers] of EXPECTED) {
    for (const [op, expected] of Object.entries(answers)) {
      const doc = query({ [op]: [member, literal] }, root);
      assert.deepEqual(ids(await execute(doc)), expected, `${op} ${literal}`);
      assert.deepEqual(ids(await execute(doc, { pushdown: false })), expected, `${op} ${literal} in the engine`);
    }
  }
  for (const [list, expected] of MEMBERSHIPS) {
    const doc = query({ $eq: [member, { $seq: list }] }, root);
    assert.deepEqual(ids(await execute(doc)), expected, `$seq ${list}`);
    assert.deepEqual(ids(await execute(doc, { pushdown: false })), expected, `$seq ${list} in the engine`);
  }
}

describe('a number past 2^53 compares as the engine compares it', () => {
  for (const engine of ENGINES) {
    describe(`on ${engine}`, { skip: skipFor(engine) }, () => {
      for (const [label, q, indexes] of LAYOUTS) {
        it(`over ${label} member, every operator and a membership`, async () => {
          await withStore(engine, collectionModel(q, indexes), async (store) => {
            const c = store.collection('c');
            for (const [id, value] of ROWS) await c.insert({ id, q: value });
            await assertEveryComparison((doc, options) => c.execute(doc, options), '$it.q');
          });
        });
      }

      it('over an entity\'s document member and its number column', async () => {
        const model = { $model: '0.1', entities: { T: { schema: { type: 'object', required: ['id'], properties: {
          id: { type: 'string', 'x-entity': { key: true } }, n: { type: 'number' },
          d: { type: 'object', properties: { q: { type: 'number' } } } } } } } };
        await withStore(engine, model, async (store) => {
          for (const [id, value] of ROWS) await store.entity('T').create({ id, n: value, d: { q: value } });
          const execute = (/** @type {any} */ doc, /** @type {any} */ options) => store.execute(doc, options);
          await assertEveryComparison(execute, '$it.d.q', '$.T[*]');
          await assertEveryComparison(execute, '$it.n', '$.T[*]');
        });
      });
    });
  }
});

describe('an integer text past 2^53 written beside the store', () => {
  it('compares as the double it reads as: 2^53 itself is past the safe range', async () => {
    for (const indexes of [[], INDEX]) {
      const dir = mkdtempSync(join(tmpdir(), 'jaren-past-safe-'));
      const path = join(dir, 'store.sqlite');
      try {
        const store = await openStore(collectionModel({ type: 'integer' }, indexes), { driver: nodeDriver(), path });
        try {
          const c = store.collection('c');
          await c.insert({ id: 'r', q: 1 });
          const db = new DatabaseSync(path);
          try { db.exec(`UPDATE "c" SET "doc" = jsonb('{"id":"r","q":9007199254740993}')`); }
          finally { db.close(); }
          for (const [where, expected] of [[{ $eq: ['$it.q', 2 ** 53] }, ['r']], [{ $ne: ['$it.q', 2 ** 53] }, []],
            [{ $lt: ['$it.q', 2 ** 53] }, []], [{ $le: ['$it.q', 2 ** 53] }, ['r']], [{ $gt: ['$it.q', 2 ** 53] }, []],
            [{ $ge: ['$it.q', 2 ** 53] }, ['r']], [{ $eq: ['$it.q', { $seq: [2 ** 53, 1] }] }, ['r']],
            [{ $gt: ['$it.q', 2 ** 53 - 1] }, ['r']]]) {
            assert.deepEqual(ids(await c.execute(query(where))), expected, JSON.stringify(where));
            assert.deepEqual(ids(await c.execute(query(where), { pushdown: false })), expected, `${JSON.stringify(where)} in the engine`);
          }
        }
        finally { await store.close(); }
      }
      finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });
});

describe('a comparison with a safe number keeps its statement, and its seek', () => {
  /** The statement a comparison runs and SQLite's plan for it, over an
   * indexed member of `type`. @param {any} type @param {any} where */
  const planOf = async (type, where) => {
    const dir = mkdtempSync(join(tmpdir(), 'jaren-past-safe-'));
    const path = join(dir, 'store.sqlite');
    try {
      const store = await openStore(collectionModel({ type }, INDEX), { driver: nodeDriver(), path });
      let explained;
      try {
        for (let i = 0; i < 200; i++) await store.collection('c').insert({ id: `k${i}`, q: i });
        explained = await store.collection('c').explain(query(where));
      }
      finally { await store.close(); }
      const db = new DatabaseSync(path);
      try {
        db.exec('ANALYZE');
        const values = explained.params.map((/** @type {any} */ slot) => slot.literal);
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${explained.sql}`).all(...values).map((row) => String(row.detail));
        return { sql: explained.sql, plan };
      }
      finally { db.close(); }
    }
    finally { rmSync(dir, { recursive: true, force: true }); }
  };

  for (const type of ['integer', 'number']) {
    it(`an equality and a membership with a safe integer over an indexed ${type} seek through its index`, async () => {
      for (const where of [{ $eq: ['$it.q', 2 ** 53 - 1] }, { $eq: ['$it.q', { $seq: [5, 6] }] }]) {
        const { sql, plan } = await planOf(type, where);
        assert.ok(!sql.includes('CAST('), sql);
        assert.match(plan[0], /^SEARCH c USING INDEX c_by_q \(gx_q=\?\)$/, JSON.stringify(where));
      }
    });
  }

  it('one with an integer past 2^53 reads an integer column as the double, and a number column bare', async () => {
    const wide = { $eq: ['$it.q', 2 ** 60] };
    assert.ok((await planOf('integer', wide)).sql.includes('CAST("gx_q" AS REAL) = ?'));
    const number = await planOf('number', wide);
    assert.ok(!number.sql.includes('CAST('), number.sql);
    assert.match(number.plan[0], /^SEARCH c USING INDEX c_by_q \(gx_q=\?\)$/);
  });
});
