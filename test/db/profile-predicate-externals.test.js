//@ts-check
/**
 * @file The externals a store profile's mandatory predicate binds on a
 * collection (MODEL-FORMAT §8). A `null`, a boolean, an object or an array —
 * alone, or as an item of a membership list — is a value the database binds
 * otherwise than the engine compares it, so where the member can hold one the
 * predicate would keep other rows than it does: `execute`, `query` and
 * `explain` refuse it `JD0011`, as they refuse a missing one. Where the member
 * cannot hold it, the comparison matches nothing on either side, and the call
 * answers as it did. `explain` given externals refuses what the run it
 * explains refuses, on a collection, an entity and the store root; with none
 * it is the abstract plan. `all()` binds them from its own `externals`, and
 * names that option when one is missing.
 *
 * The PostgreSQL half runs where `JAREN_PG_URL` names a server.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { ENGINES, skipFor, withStore } from './store-core-engines.js';

/** @param {any} tenant - the schema of the member the predicate compares */
const modelOf = (tenant) => ({ $model: '0.1', collections: { t: { key: '/id',
  schema: { type: 'object', properties: { id: { type: 'string' }, tenant } } } } });
const NULLABLE = modelOf({ type: ['string', 'null'] });
const UNTYPED = modelOf({});
const TEXT = modelOf({ type: 'string' });
const ROWS = new Map([[NULLABLE, [['n1', null], ['a1', 'a']]], [UNTYPED, [['n1', null], ['a1', 'a'], ['b1', true]]],
  [TEXT, [['a1', 'a'], ['c1', 'c']]]]);

const EQ = { $eq: ['$it.tenant', '$tenant'] };
const NE = { $ne: ['$it.tenant', '$tenant'] };
const IN = { $eq: ['$it.tenant', '$tenants[*]'] };
const DOCUMENT = { $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it.id' };

/**
 * What the predicate answers under the profile (`execute`, `query`, and
 * `explain` when it refuses), beside what the engine answers for it as a
 * `$where` with no profile.
 * @param {'sqlite' | 'postgres'} engine @param {any} model @param {any} predicate @param {any} externals
 */
async function answers(engine, model, predicate, externals) {
  const oracle = await withStore(engine, model, async (store) => {
    for (const [id, tenant] of ROWS.get(model) ?? []) await store.collection('t').insert({ id, tenant });
    return store.collection('t').execute({ ...DOCUMENT, $where: predicate }, { externals, pushdown: false });
  });
  return withStore(engine, model, async (store) => {
    const rows = store.collection('t');
    for (const [id, tenant] of ROWS.get(model) ?? []) await rows.insert({ id, tenant });
    /** @param {() => any} fn */
    const outcome = async (fn) => {
      try { return await fn(); }
      catch (error) { return /** @type {any} */ (error).code; }
    };
    const executed = await outcome(() => rows.execute(DOCUMENT, { externals }));
    const queried = await outcome(async () => {
      const out = [];
      for await (const id of rows.query(DOCUMENT, { externals })) out.push(id);
      return out;
    });
    const explained = await outcome(async () => (await rows.explain(DOCUMENT, { externals })).mode);
    return { oracle, executed, queried, explained };
  }, { profile: { maxRows: 100, externals: ['tenant', 'tenants'], predicates: { t: predicate } } });
}

describe('a collection profile predicate\'s external the database compares otherwise than the engine', () => {
  for (const engine of ENGINES) {
    describe(`on ${engine}`, { skip: skipFor(engine) }, () => {
      it('is refused JD0011 where the member can hold it: the predicate would keep other rows than it does', async () => {
        for (const [model, predicate, externals, oracle] of /** @type {[any, any, any, any][]} */ ([
          [NULLABLE, EQ, { tenant: null }, 'n1'],
          [NULLABLE, NE, { tenant: null }, 'a1'],
          [NULLABLE, IN, { tenants: [null] }, 'n1'],
          [NULLABLE, IN, { tenants: ['a', null] }, ['a1', 'n1']],
          [UNTYPED, EQ, { tenant: true }, 'b1'],
          [UNTYPED, NE, { tenant: true }, ['a1', 'n1']],
          [UNTYPED, EQ, { tenant: ['a'] }, undefined],
          [UNTYPED, IN, { tenants: [true] }, 'b1'],
          [UNTYPED, IN, { tenants: { x: 'a', y: null } }, ['a1', 'n1']],
        ])) {
          const label = `${JSON.stringify(model.collections.t.schema.properties.tenant)} ${JSON.stringify(predicate)} ${JSON.stringify(externals)}`;
          assert.deepEqual(await answers(engine, model, predicate, externals),
            { oracle, executed: 'JD0011', queried: 'JD0011', explained: 'JD0011' }, label);
        }
        await withStore(engine, NULLABLE, async (store) => {
          await assert.rejects(async () => store.collection('t').execute(DOCUMENT, { externals: { tenants: ['a', null] } }), {
            code: 'JD0011', message: 'JD0011: the profile\'s predicate for \'t\' cannot bind \'$tenants\' for this call — it holds '
              + 'a null, which the engine compares with the same value in \'tenant\' and the database does not, so the '
              + 'predicate would keep other rows than it does; bind strings and numbers at /collections/t' });
        }, { profile: { externals: ['tenants'], predicates: { t: IN } } });
      });

      it('answers as it did where the member cannot hold it, and for strings and numbers', async () => {
        for (const [model, predicate, externals, expected] of /** @type {[any, any, any, any][]} */ ([
          [NULLABLE, EQ, { tenant: 'a' }, 'a1'],
          [NULLABLE, IN, { tenants: ['a'] }, 'a1'],
          [NULLABLE, IN, { tenants: [true] }, undefined],
          [NULLABLE, IN, { tenants: 'a' }, undefined],
          [NULLABLE, IN, { tenants: null }, undefined],
          [TEXT, EQ, { tenant: null }, undefined],
          [TEXT, NE, { tenant: null }, ['a1', 'c1']],
          [TEXT, IN, { tenants: [null] }, undefined],
          [TEXT, IN, { tenants: ['a', null] }, 'a1'],
          [TEXT, IN, { tenants: ['c', ['a']] }, 'c1'],
        ])) {
          const label = `${JSON.stringify(model.collections.t.schema.properties.tenant)} ${JSON.stringify(predicate)} ${JSON.stringify(externals)}`;
          const listed = expected === undefined ? [] : [expected].flat();
          assert.deepEqual(await answers(engine, model, predicate, externals),
            { oracle: expected, executed: expected, queried: listed, explained: 'native' }, label);
        }
      });
    });
  }
});

describe('explain() given externals refuses what the run it explains refuses', () => {
  const MODEL = { $model: '0.1', collections: { t: { key: '/id',
    schema: { type: 'object', properties: { id: { type: 'string' }, tenant: { type: 'string' } } } } },
  entities: { E: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, tenant: { type: 'string' } } } } } };
  const profile = { maxRows: 100, externals: ['tenant', 'since'],
    predicates: { t: { $eq: ['$it.tenant', '$tenant'] }, E: { $eq: ['$it.tenant', '$tenant'] } } };
  const collectionDocument = { $for: { it: '$[*]' }, $where: { $gt: ['$it.id', '$since'] }, $return: '$it.id' };
  const entityDocument = { $for: { it: '$.E[*]' }, $where: { $gt: ['$it.id', '$since'] }, $return: '$it.id' };

  for (const engine of ENGINES) {
    it(`on ${engine}: a collection, an entity and the store root, with the predicate's external left out`, { skip: skipFor(engine) }, async () => {
      await withStore(engine, MODEL, async (store) => {
        const partial = { externals: { since: 'x' } };
        for (const [run, explain] of [
          [() => store.collection('t').execute(collectionDocument, partial), () => store.collection('t').explain(collectionDocument, partial)],
          [() => store.entity('E').execute(entityDocument, partial), () => store.entity('E').explain(entityDocument, partial)],
          [() => store.execute(entityDocument, partial), () => store.explain(entityDocument, partial)],
        ]) {
          await assert.rejects(async () => run(), { code: 'JD0011' });
          await assert.rejects(async () => explain(), { code: 'JD0011', message: /cannot bind '\$tenant' for this call/ });
        }
        // no externals at all is the abstract plan
        assert.equal((await store.collection('t').explain(collectionDocument)).mode, 'native');
        assert.equal((await store.entity('E').explain(entityDocument)).mode, 'native');
        assert.equal((await store.explain(entityDocument)).mode, 'native');
        // bound in full, the plan is the run's
        const bound = { externals: { since: 'x', tenant: 'a' } };
        assert.equal((await store.collection('t').explain(collectionDocument, bound)).mode, 'native');
        assert.equal((await store.entity('E').explain(entityDocument, bound)).mode, 'native');
      }, { profile });
    });
  }
});

describe('all() under a predicate that names an external', () => {
  it('is refused without the external, naming the option that binds it, and answers with it', async () => {
    const store = await openStore(TEXT, { driver: nodeDriver(),
      profile: { maxRows: 100, externals: ['tenant'], predicates: { t: EQ } } });
    try {
      const rows = store.collection('t');
      for (const [id, tenant] of ROWS.get(TEXT) ?? []) await rows.insert({ id, tenant });
      await assert.rejects(async () => rows.all(), { code: 'JD0011', message: 'JD0011: the profile\'s predicate for \'t\' cannot bind '
        + '\'$tenant\' for this call — it is missing, and a mandatory predicate runs in the database or not at all — pass it as '
        + 'all({ externals }) at /collections/t' });
      assert.deepEqual(await rows.all({ externals: { tenant: 'c' } }), [{ id: 'c1', tenant: 'c' }]);
      const read = [];
      for await (const document of rows.query('$[*]', { externals: { tenant: 'c' } })) read.push(document);
      assert.deepEqual(read, [{ id: 'c1', tenant: 'c' }]);
    }
    finally { await store.close(); }
  });
});
