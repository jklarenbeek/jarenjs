//@ts-check
/**
 * @file A conjunction's `$ne` against externals over one string column of an
 * entity: on PostgreSQL the statement spells two or more of them as the
 * column's presence and ONE negated membership in the strings among them,
 * each external bound once as its JSON text, so the server compiles one leaf
 * however many there are, and the planner counts the chain as one term. An
 * external of another type (a number, a boolean, null, an array, an object)
 * differs from every string, as the engine answers. Every answer equals
 * `pushdown: false` on both engines; SQLite keeps one comparison each.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINES, skipFor, withStore } from './store-core-engines.js';

const model = { $model: '0.1', entities: {
  Item: { schema: { type: 'object', required: ['id'], properties: {
    id: { type: 'string', 'x-entity': { key: true } }, tenant: { type: 'string' }, other: { type: 'string' }, n: { type: 'integer' } } } },
} };
const ROWS = [
  { id: 'a', tenant: 't1', other: 'x', n: 1 }, { id: 'b', tenant: 't2', other: 'y', n: 2 }, { id: 'c', n: 3 },
  { id: 'd', tenant: '', other: 't1', n: 4 }, { id: 'e', tenant: 'T1', n: 5 }, { id: 'f', tenant: 'é', other: 'x', n: 6 },
  { id: 'g', tenant: '5', n: 7 }];
const ne = (/** @type {string} */ member, /** @type {string[]} */ names) => names.map((name) => ({ $ne: [`$it.${member}`, `$${name}`] }));
const doc = (/** @type {any} */ where) => ({ $for: { it: '$.Item[*]' }, $where: where, $orderby: ['$it.id'], $return: '$it.id' });
/** Strings and numbers bind; null, a boolean, an array and an object send the call to the engine. */
const BOUND = { s1: 't1', s2: 't2', s3: 't1', empty: '', accent: 'é', five: 5, digits: '5' };
const EXTERNALS = { ...BOUND, nul: null, yes: true, list: ['t1'], obj: { t: 't2' } };
/** Each case: its title, its `$where`, and whether PostgreSQL spells its externals as one list. */
const CASES = /** @type {[string, any, boolean][]} */ ([
  ['two strings', { $and: ne('tenant', ['s1', 's2']) }, true],
  ['strings and a number', { $and: ne('tenant', Object.keys(BOUND)) }, true],
  ['a duplicate and the empty string', { $and: ne('tenant', ['s1', 's3', 'empty']) }, true],
  ['beside literal $ne and an ordering', { $and: [...ne('tenant', ['s1', 'accent']), { $ne: ['$it.tenant', 't2'] },
    { $ne: ['$it.tenant', 'zz'] }, { $ge: ['$it.n', 2] }] }, true],
  ['under a $not', { $not: { $and: ne('tenant', ['s1', 's2', 'five']) } }, true],
  ['inside an $or', { $or: [{ $and: ne('tenant', ['s1', 's2']) }, { $eq: ['$it.n', 1] }] }, true],
  ['two members, two lists', { $and: [...ne('tenant', ['s1', 'digits']), ...ne('other', ['s1', 'five'])] }, true],
  ['a lone $ne', { $and: [...ne('tenant', ['s1']), { $ge: ['$it.n', 0] }] }, false],
  ['a number column', { $and: ne('n', ['five', 'digits']) }, false],
]);
/** Every kind of external beside the strings, which the engine reads and the statement never meets. */
const UNBOUND = /** @type {[string, any][]} */ ([
  ['null, a boolean, an array and an object', { $and: ne('tenant', Object.keys(EXTERNALS)) }],
  ['an array beside a string', { $and: ne('tenant', ['s1', 'list']) }],
]);
const LIST = /unnest\(ARRAY\[/;

for (const engine of ENGINES) {
  describe(`a chain of $ne against externals over one entity column on ${engine}`, { skip: skipFor(engine) }, () => {
    /** @param {(store: any) => Promise<void>} fn */
    const seeded = (fn) => withStore(engine, model, async (store) => {
      for (const row of ROWS) store.entity('Item').create(row);
      await store.saveChanges();
      await fn(store);
    });

    it('answers every shape as the engine does, one list where PostgreSQL gathers them', () => seeded(async (store) => {
      for (const [title, where, gathered] of CASES) {
        const expected = await store.execute(doc(where), { externals: BOUND, pushdown: false });
        assert.deepEqual(await store.execute(doc(where), { externals: BOUND }), expected, title);
        const plan = await store.explain(doc(where), { externals: BOUND });
        assert.equal(plan.mode, 'native', title);
        assert.equal(LIST.test(plan.sql), engine === 'postgres' && gathered, title);
      }
      for (const [title, where] of UNBOUND) {
        assert.deepEqual(await store.execute(doc(where), { externals: EXTERNALS }),
          await store.execute(doc(where), { externals: EXTERNALS, pushdown: false }), title);
      }
    }));

    it('counts the chain as one term: 200 externals stay native, and strict answers', () => seeded(async (store) => {
      const many = Array.from({ length: 200 }, (_, i) => `x${i}`);
      const externals = Object.fromEntries(many.map((name, i) => [name, i % 2 === 0 ? `t${i}` : i]));
      const where = { $and: [...ne('tenant', many), { $ne: ['$it.n', 3] }] };
      const plan = await store.explain(doc(where), { externals });
      assert.equal(plan.mode, 'native');
      const expected = await store.execute(doc(where), { externals, pushdown: false });
      assert.deepEqual(expected, ['a', 'd', 'e', 'f', 'g']);
      assert.deepEqual(await store.execute(doc(where), { externals, strict: true }), expected);
      if (engine === 'postgres') assert.equal((plan.sql.match(/unnest\(ARRAY\[/g) ?? []).length, 1, 'one list of the 200');
    }));

    it('refuses a missing external as the engine does', () => seeded(async (store) => {
      const where = { $and: ne('tenant', ['s1', 'missing']) };
      const code = async (/** @type {any} */ options) => {
        try { await store.execute(doc(where), options); return null; }
        catch (error) { return /** @type {any} */ (error).code; }
      };
      const engineCode = await code({ externals: { s1: 't1' }, pushdown: false });
      assert.notEqual(engineCode, null);
      assert.equal(await code({ externals: { s1: 't1' } }), engineCode);
    }));
  });
}
