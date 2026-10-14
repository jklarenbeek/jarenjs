//@ts-check
/**
 * @file A string literal the database would read as another string. A
 * driver binds a lone surrogate as U+FFFD, so a comparison or a string
 * operator over one stays in the engine (or runs as a registered function,
 * which reads the literal as written); PostgreSQL holds no U+0000 at all,
 * so a literal holding one stays in the engine there. SQLite's suffix test
 * compares bytes, which a U+0000 does not cut short, so it holds one on
 * either side and keeps answering natively. Every answer is the engine's
 * (`pushdown: false`); every operand without such a character keeps its
 * native plan, a seek staying a seek.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { reasonId } from '@jarenjs/db';

import { onBothEngines } from './query-core-engines.js';

const MODEL = {
  $model: '0.1',
  collections: {
    t: {
      key: '/id',
      schema: { type: 'object', properties: { id: { type: 'string' }, s: { type: 'string' } } },
      indexes: [{ name: 'by_s', path: '$.s' }],
    },
  },
};
// what both servers hold: PostgreSQL refuses a document holding U+0000 or a lone surrogate
const SHARED = [['c', 'xy'], ['d', '😀z'], ['e', 'z'], ['f', 'x�'], ['g', '']];
const SQLITE_ONLY = [['a', 'x\uD800'], ['b', 'y\u0000z']];

const over = (/** @type {any} */ where) => ({ $for: { e: '$[*]' }, $where: where, $return: '$e.id' });
const sorted = (/** @type {any} */ value) => [value ?? []].flat().sort();

/**
 * The native answer of each predicate against the engine's, with the plan.
 * @param {any} rows @param {any} where
 */
async function answers(rows, where) {
  const document = over(where);
  const engine = sorted(await rows.execute(document, { pushdown: false }));
  assert.deepEqual(sorted(await rows.execute(document)), engine, JSON.stringify(where));
  return { engine, plan: await rows.explain(document) };
}

describe('a string literal the database would read as another string', () => {
  it('answers what the engine answers, on SQLite and on PostgreSQL', async () => {
    await onBothEngines(MODEL, async (store, host) => {
      const rows = store.collection('t');
      for (const [id, s] of host === 'sqlite' ? [...SHARED, ...SQLITE_ONLY] : SHARED) await rows.insert({ id, s });
      const sqlite = host === 'sqlite';
      // a suffix beginning with U+0000 is no empty suffix; a lone surrogate is no U+FFFD
      assert.deepEqual((await answers(rows, { '$ends-with': ['$e.s', '\u0000z'] })).engine, sqlite ? ['b'] : []);
      assert.deepEqual((await answers(rows, { '$ends-with': ['$e.s', '\uD800'] })).engine, sqlite ? ['a'] : []);
      assert.deepEqual((await answers(rows, { $eq: ['$e.s', 'x\uD800'] })).engine, sqlite ? ['a'] : []);
      assert.deepEqual((await answers(rows, { $ne: ['$e.s', 'x\uD800'] })).engine, ['b', 'c', 'd', 'e', 'f', 'g'].filter((id) => sqlite || !'b'.includes(id)));
      assert.deepEqual((await answers(rows, { $lt: ['$e.s', 'x\uD800'] })).engine, ['c', 'g']);
      assert.deepEqual((await answers(rows, { '$starts-with': ['$e.s', 'x\uD800'] })).engine, sqlite ? ['a'] : []);
      // the engine matches a lone surrogate against half of a pair
      assert.deepEqual((await answers(rows, { $contains: ['$e.s', '\uDE00'] })).engine, ['d']);
      assert.deepEqual((await answers(rows, { $or: [{ $eq: ['$e.s', 'x\uD800'] }, { $eq: ['$e.s', 'z'] }] })).engine, sqlite ? ['a', 'e'] : ['e']);
      // a list item holding U+0000 or a lone surrogate
      assert.deepEqual((await answers(rows, { $eq: ['$e.s', { $seq: ['y\u0000z', 'x\uD800', 'xy'] }] })).engine, sqlite ? ['a', 'b', 'c'] : ['c']);
      for (const where of [{ $eq: ['$e.s', 'y\u0000z'] }, { $lt: ['$e.s', 'y\u0000z'] }, { $contains: ['$e.s', '\u0000'] }]) {
        const { plan } = await answers(rows, where);
        if (sqlite) assert.equal(plan.mode, 'native', JSON.stringify(where));
        else {
          assert.equal(plan.mode, 'set', JSON.stringify(where));
          assert.equal(reasonId((plan.reasons ?? plan.residual.reasons)[0].reason), 'bind.serverText');
        }
      }
    });
  });

  it('a stored U+0000 ends with what follows it, and an empty string under $not ends with nothing', async () => {
    await onBothEngines(MODEL, async (store, host) => {
      if (host !== 'sqlite') return;
      const rows = store.collection('t');
      for (const [id, s] of [...SHARED, ...SQLITE_ONLY]) await rows.insert({ id, s });
      const suffix = await answers(rows, { '$ends-with': ['$e.s', 'z'] });
      assert.deepEqual(suffix.engine, ['b', 'd', 'e']);
      assert.equal(suffix.plan.mode, 'native');
      assert.deepEqual((await answers(rows, { $not: { '$ends-with': ['$e.s', 'z'] } })).engine, ['a', 'c', 'f', 'g']);
      assert.deepEqual((await answers(rows, { '$ends-with': ['$e.s', 'y\u0000z'] })).engine, ['b']);
    });
  });

  it('an operand without such a character keeps its plan: a seek stays a seek', async () => {
    await onBothEngines(MODEL, async (store, host) => {
      const rows = store.collection('t');
      for (const [id, s] of SHARED) await rows.insert({ id, s });
      for (const where of [{ $eq: ['$e.s', 'xy'] }, { '$starts-with': ['$e.s', 'x'] }, { $lt: ['$e.s', '�'] },
        { '$ends-with': ['$e.s', 'z'] }, { $contains: ['$e.s', 'y'] }, { $eq: ['$e.s', { $seq: ['xy', 'z'] }] }]) {
        const { plan } = await answers(rows, where);
        assert.equal(plan.mode, 'native', `${host}: ${JSON.stringify(where)}`);
        assert.equal(plan.residual, null);
      }
      if (host === 'sqlite') {
        for (const where of [{ $eq: ['$e.s', 'xy'] }, { '$starts-with': ['$e.s', 'x'] }])
          assert.match((await rows.explain(over(where))).scanNarrative, /^SEARCH t USING INDEX t_by_s \(gx_s/, JSON.stringify(where));
      }
    });
  });
});

const RELATED = {
  $model: '0.1',
  entities: {
    User: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', 'x-entity': { key: true } },
      meta: { type: 'object', properties: { n: { type: 'string' } } } } } },
    Post: { schema: { type: 'object', required: ['pid'], properties: { pid: { type: 'integer', 'x-entity': { key: true } },
      authorId: { type: 'string' } } } },
  },
};

describe('a string literal the database would read as another string, inside a hop to a related entity', () => {
  it('answers what the engine answers, and the conjunct runs in the residual', async () => {
    await onBothEngines(RELATED, async (store, host) => {
      // PostgreSQL holds no lone surrogate, so there only U+FFFD is stored
      const users = host === 'sqlite' ? [['u1', 'x\uD800'], ['u2', 'x�']] : [['u2', 'x�']];
      for (const [id, n] of users) await store.entity('User').create({ id, meta: { n } });
      for (const [pid, authorId] of [[1, 'u1'], [2, 'u2']]) await store.entity('Post').create({ pid, authorId });
      const posts = store.entity('Post');
      const over = (/** @type {any} */ where) => ({ $for: { it: '$.Post[*]' }, $where: where, $return: '$it.pid' });
      const authors = (/** @type {any} */ where) => ({ $for: { r1: '$.User[*]' },
        $where: { $and: [{ $eq: ['$r1.id', '$it.authorId'] }, where] }, $return: '$r1' });
      const sqlite = host === 'sqlite';
      for (const [where, expected] of /** @type {[any, number[]][]} */ ([
        [{ $gt: [{ $count: authors({ $eq: ['$r1.meta.n', 'x\uD800'] }) }, 0] }, sqlite ? [1] : []],
        [{ $exists: authors({ '$starts-with': ['$r1.meta.n', 'x\uD800'] }) }, sqlite ? [1] : []],
        [{ $exists: authors({ $eq: ['$r1.meta.n', 'x\uD800'] }) }, sqlite ? [1] : []],
        [{ $empty: authors({ $eq: ['$r1.meta.n', 'x\uD800'] }) }, sqlite ? [2] : [1, 2]],
        [{ $eq: [{ $for: { r1: '$.User[*]' }, $where: { $eq: ['$r1.id', '$it.authorId'] }, $return: '$r1.meta.n' }, 'x\uD800'] },
          sqlite ? [1] : []],
      ])) {
        const document = over(where);
        assert.deepEqual(sorted(await posts.execute(document, { pushdown: false })), expected, JSON.stringify(where));
        assert.deepEqual(sorted(await posts.execute(document)), expected, JSON.stringify(where));
        const plan = await posts.explain(document);
        assert.equal(plan.mode, 'set', JSON.stringify(where));
        assert.deepEqual(plan.reasons.map((/** @type {any} */ reason) => reasonId(reason.reason)), ['predicate.loneSurrogate']);
        await assert.rejects(async () => posts.execute(document, { strict: true }), { code: 'JD0010' });
      }
      // the same hop with a well-formed literal keeps its native plan
      assert.equal((await posts.explain(over({ $exists: authors({ $eq: ['$r1.meta.n', 'x�'] }) }))).mode, 'native');
    });
  });
});
