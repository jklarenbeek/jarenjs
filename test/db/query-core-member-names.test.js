//@ts-check
/**
 * @file Member names the JSON path grammars treat specially. A name
 * holding a backslash is the member every path reads and writes on both
 * engines: the translated patch, the pushed-down FLWOR predicate and the
 * generated index column address the member literally named, and every
 * row stays readable. A name SQLite's path grammar cannot carry on every
 * qualified version (a double quote) runs in the engine there: an entity
 * query answers what PostgreSQL answers natively, and a statement with no
 * residual (a graph load) refuses it by code.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reasonId } from '@jarenjs/db';
import { onBothEngines } from './query-core-engines.js';

/** A member whose seven-character name spells, after an `a`, the JSON escape
 * of `A` — beside the member `aA` that escape would decode to. */
const ESCAPED = 'a\\u0041';

/** @param {boolean} indexed */
const collectionModel = (indexed) => ({ $model: '0.1', collections: { docs: {
  key: '/id',
  schema: { type: 'object', properties: { id: { type: 'string' }, [ESCAPED]: { type: 'integer' }, aA: { type: 'integer' } } },
  indexes: indexed ? [{ name: 'by_escaped', path: String.raw`$['a\\u0041']` }] : [],
} } });

describe('a member name holding a backslash', () => {
  for (const indexed of [true, false]) {
    it(`is the member every collection path reads and writes (${indexed ? 'indexed' : 'unindexed'})`, async () => {
      await onBothEngines(collectionModel(indexed), async (store, host) => {
        const docs = store.collection('docs');
        await docs.put({ id: 'p', o: {} });
        assert.deepEqual(await docs.patch('p', [{ op: 'add', path: '/o/back\\slash', value: 1 }]),
          { id: 'p', o: { 'back\\slash': 1 } }, host);
        assert.deepEqual(await docs.get('p'), { id: 'p', o: { 'back\\slash': 1 } }, host);

        await docs.put({ id: 'r', o: { 'back\\slash': 1, k: 0 } });
        assert.deepEqual(await docs.patch('r', [{ op: 'remove', path: '/o/back\\slash' }]), { id: 'r', o: { k: 0 } }, host);
        assert.deepEqual(await docs.get('r'), { id: 'r', o: { k: 0 } }, host);

        await docs.put({ id: 'm', [ESCAPED]: 1, aA: 2 });
        assert.deepEqual(await docs.patch('m', [{ op: 'replace', path: `/${ESCAPED}`, value: 5 }]),
          { id: 'm', [ESCAPED]: 5, aA: 2 }, host);
        assert.deepEqual(await docs.get('m'), { id: 'm', [ESCAPED]: 5, aA: 2 }, host);

        // a name ending in a backslash is a valid member like any other
        await docs.put({ id: 't', o: {} });
        assert.deepEqual(await docs.patch('t', [{ op: 'add', path: '/o/t\\', value: 1 }]), { id: 't', o: { 't\\': 1 } }, host);
        assert.deepEqual(await docs.get('t'), { id: 't', o: { 't\\': 1 } }, host);

        await docs.put({ id: 'q', [ESCAPED]: 1, aA: 2 });
        const byEscaped = { $for: { it: '$[*]' }, $where: { $eq: [String.raw`$it['a\\u0041']`, 1] }, $return: '$it.id' };
        const explained = await docs.explain(byEscaped);
        assert.equal(explained.mode, 'native', host);
        // indexed, the generated column answers: it holds the member literally
        // named, and the planner reads it through its index. PostgreSQL reads
        // a member by its decimal digits, so the literal binds as the interval
        // of decimals that round to its double, both edges on the column
        if (indexed) {
          assert.match(explained.sql, host === 'postgres'
            ? /"gx_a_u0041" >= \$1 AND "gx_a_u0041" <= \$2/ : /"gx_a_u0041" = \?/, host);
          assert.ok(!explained.sql.includes(String.raw`'{"a\\u0041"}'`), host);
          assert.match(explained.scanNarrative, /\bdocs_by_escaped\b/, host);
        }
        assert.equal(await docs.execute(byEscaped), 'q', host);
        const byOther = { $for: { it: '$[*]' }, $where: { $eq: ['$it.aA', 2] }, $orderby: '$it.id', $return: '$it.id' };
        assert.deepEqual(await docs.execute(byOther), ['m', 'q'], host);

        assert.deepEqual(await docs.all(), [
          { id: 'p', o: { 'back\\slash': 1 } },
          { id: 'r', o: { k: 0 } },
          { id: 'm', [ESCAPED]: 5, aA: 2 },
          { id: 't', o: { 't\\': 1 } },
          { id: 'q', [ESCAPED]: 1, aA: 2 },
        ], host);
      });
    });
  }
});

const ENTITY_MODEL = { $model: '0.1', entities: { E: { schema: { type: 'object', properties: {
  id: { type: 'string', 'x-entity': { key: true } },
  meta: { type: 'object', properties: { 'a"b': { type: 'integer' }, 'c\\d': { type: 'integer' } } },
} } } } };
const quoted = { $eq: ['$it.meta[\'a"b\']', 1] };
const backslashed = { $eq: [String.raw`$it.meta['c\\d']`, 2] };
/** @param {any} where */
const entityQuery = (where) => ({ $for: { it: '$.E[*]' }, $where: where, $return: '$it.id' });

describe('an entity member name the SQLite path grammar cannot carry', () => {
  it('answers from the engine on SQLite as PostgreSQL answers natively', async () => {
    await onBothEngines(ENTITY_MODEL, async (store, host) => {
      const set = store.entity('E');
      await set.create({ id: '1', meta: { 'a"b': 1, 'c\\d': 2 } });
      await set.create({ id: '2', meta: { 'a"b': 3, 'c\\d': 4 } });
      assert.equal(await set.execute(entityQuery(quoted)), '1', host);
      assert.equal(await set.execute(entityQuery(backslashed)), '1', host);
      const seen = [];
      for await (const id of set.cursor(entityQuery(quoted))) seen.push(id);
      assert.deepEqual(seen, ['1'], host);

      const explained = await set.explain(entityQuery(quoted));
      if (host === 'postgres') {
        assert.equal(explained.mode, 'native');
        assert.equal(await set.execute(entityQuery(quoted), { strict: true }), '1');
      }
      else {
        assert.equal(explained.mode, 'set');
        assert.deepEqual(explained.residual.reasons.map((/** @type {any} */ r) => reasonId(r.reason)), ['bind.path']);
        await assert.rejects(Promise.resolve().then(() => set.execute(entityQuery(quoted), { strict: true })),
          { code: 'JD0010' });
      }
      assert.equal((await set.explain(entityQuery(backslashed))).mode, 'native', host);
    });
  });

  it('is a coded refusal where the statement has no residual, on SQLite', async () => {
    await onBothEngines(ENTITY_MODEL, async (store, host) => {
      const set = store.entity('E');
      await set.create({ id: '1', meta: { 'a"b': 1, 'c\\d': 2 } });
      const expected = [{ id: '1', meta: { 'a"b': 1, 'c\\d': 2 } }];
      if (host === 'postgres') {
        assert.deepEqual(await set.load({ where: quoted }), expected);
        assert.deepEqual((await set.page({ where: quoted }, { limit: 5 })).items, expected);
      }
      else {
        await assert.rejects(Promise.resolve().then(() => set.load({ where: quoted })), { code: 'JD0032' });
        await assert.rejects(Promise.resolve().then(() => set.page({ where: quoted }, { limit: 5 })), { code: 'JD0032' });
        await assert.rejects(Promise.resolve().then(() => set.load({ orderBy: '$it.meta[\'a"b\']' })), { code: 'JD0032' });
      }
      assert.deepEqual(await set.load({ where: backslashed }), expected, host);
    });
  });

  it('is a coded refusal when a profile predicate needs it, on SQLite', async () => {
    await onBothEngines(ENTITY_MODEL, async (store, host) => {
      const set = store.entity('E');
      await set.create({ id: '1', meta: { 'a"b': 1, 'c\\d': 2 } });
      await set.create({ id: '2', meta: { 'a"b': 3, 'c\\d': 4 } });
      // a mandatory predicate runs in the database or not at all
      const profile = { predicates: { E: quoted } };
      const all = { $for: { it: '$.E[*]' }, $return: '$it.id' };
      if (host === 'postgres') {
        assert.equal(await set.execute(all, { profile }), '1');
        assert.deepEqual(await set.load({}, { profile }), [{ id: '1', meta: { 'a"b': 1, 'c\\d': 2 } }]);
      }
      else {
        await assert.rejects(Promise.resolve().then(() => set.execute(all, { profile })), { code: 'JD0011' });
        await assert.rejects(Promise.resolve().then(() => set.load({}, { profile })), { code: 'JD0032' });
      }
    });
  });
});
