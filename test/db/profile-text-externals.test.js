//@ts-check
/**
 * @file A store profile's mandatory predicate bound with a string the
 * database would not receive as written. A driver binds a lone surrogate
 * as U+FFFD, and PostgreSQL holds no U+0000, so a tenant predicate bound
 * with such a string would keep another tenant's rows (the one stored
 * under U+FFFD); a mandatory predicate runs in the database or not at all,
 * so every surface that binds it refuses `JD0011`, naming the external.
 * Ordinary strings, surrogate pairs and numbers answer as they did, and a
 * membership list, which crosses as JSON, binds such a string on SQLite.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ENGINES, skipFor, withStore } from './store-core-engines.js';

const MODEL = { $model: '0.1',
  collections: { t: { key: '/id', schema: { type: 'object', properties: { id: { type: 'string' }, tenant: { type: 'string' } } } } },
  entities: { E: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', 'x-entity': { key: true } },
    tenant: { type: 'string' } } } } } };
const EQ = { $eq: ['$it.tenant', '$tenant'] };
const PROFILE = { maxRows: 100, externals: ['tenant'], predicates: { t: EQ, E: EQ } };
const COLLECTION = { $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it.id' };
const ENTITY = { $for: { it: '$.E[*]' }, $orderby: ['$it.id'], $return: '$it.id' };

const sorted = (/** @type {any} */ value) => [value ?? []].flat().sort();
/** @param {AsyncIterable<any>} cursor */
const drain = async (cursor) => {
  const items = [];
  for await (const item of cursor) items.push(item);
  return items;
};

/**
 * Every surface that binds the profile's externals, each answering the ids it reads.
 * @param {any} store @param {any} externals @param {boolean} live - whether the engine runs a synchronous live query
 * @returns {Record<string, () => Promise<string[]>>}
 */
const surfaces = (store, externals, live) => {
  const options = { externals };
  const t = store.collection('t');
  const e = store.entity('E');
  /** @param {any} live */
  const settled = async (live) => {
    try { return sorted(live.result.rows); }
    finally { await live.close(); }
  };
  return {
    'collection execute': async () => sorted(await t.execute(COLLECTION, options)),
    'collection query': async () => drain(t.query(COLLECTION, options)),
    'collection explain': async () => [(await t.explain(COLLECTION, options)).mode],
    // PostgreSQL's live strategy is the resnapshot one, a host surface of its own (async-live)
    ...(live ? { 'collection live': async () => settled(await t.live(COLLECTION, options)) } : {}),
    'collection get': async () => sorted((await t.get('b1', options))?.id),
    'entity execute': async () => sorted(await e.execute(ENTITY, options)),
    'entity cursor': async () => drain(e.cursor(ENTITY, options)),
    'entity explain': async () => [(await e.explain(ENTITY, options)).mode],
    'entity get': async () => sorted((await e.get('b1', options))?.id),
    'store execute': async () => sorted(await store.execute(ENTITY, options)),
  };
};

/** Seed both tenants: one under a lone surrogate where the server holds it, one under U+FFFD. @param {any} store @param {string} engine */
async function seed(store, engine) {
  const rows = engine === 'sqlite' ? [['a1', 'x\uD800'], ['b1', 'x\uFFFD'], ['e1', '\u{1F600}'], ['n1', 'y\u0000z']]
    : [['b1', 'x\uFFFD'], ['e1', '\u{1F600}']];
  for (const [id, tenant] of rows) await store.collection('t').insert({ id, tenant });
  // a column stores well-formed text only
  for (const [id, tenant] of [['b1', 'x\uFFFD'], ['e1', '\u{1F600}']]) await store.entity('E').create({ id, tenant });
}

describe("a profile predicate's external the database would not receive as written", () => {
  for (const engine of ENGINES) {
    it(`on ${engine}: is refused JD0011 by every surface, never answering the U+FFFD tenant's row`, { skip: skipFor(engine) }, async () => {
      await withStore(engine, MODEL, async (store) => {
        await seed(store, engine);
        const refused = ['x\uD800', 'x\uDC00z', ...(engine === 'postgres' ? ['y\u0000z'] : [])];
        for (const tenant of refused) {
          for (const [surface, run] of Object.entries(surfaces(store, { tenant }, engine === 'sqlite'))) {
            await assert.rejects(run, { code: 'JD0011',
              message: /cannot bind '\$tenant' for this (call|point read) — it holds (a lone surrogate|U\+0000)/ },
            `${engine} ${surface} ${JSON.stringify(tenant)}`);
          }
        }
        // a load binds no externals: under this predicate it is refused, never answered
        await assert.rejects(async () => store.entity('E').load({}), { code: 'JD0032' });
      }, { profile: PROFILE, capture: true });
    });

    it(`on ${engine}: ordinary strings, surrogate pairs and numbers answer as they did`, { skip: skipFor(engine) }, async () => {
      await withStore(engine, MODEL, async (store) => {
        await seed(store, engine);
        for (const [tenant, collection, entity] of /** @type {[any, string[], string[]][]} */ ([
          ['x\uFFFD', ['b1'], ['b1']], ['\u{1F600}', ['e1'], ['e1']], ['nobody', [], []], [5, [], []],
          ...(engine === 'sqlite' ? [['y\u0000z', ['n1'], []]] : []),
        ])) {
          const answers = surfaces(store, { tenant }, engine === 'sqlite');
          const label = `${engine} ${JSON.stringify(tenant)}`;
          for (const surface of ['collection execute', 'collection query', 'collection live'].filter((name) => name in answers))
            assert.deepEqual(await answers[surface](), collection, `${label} ${surface}`);
          assert.deepEqual(await answers['collection get'](), collection.includes('b1') ? ['b1'] : [], `${label} collection get`);
          for (const surface of ['entity execute', 'entity cursor', 'store execute'])
            assert.deepEqual(await answers[surface](), entity, `${label} ${surface}`);
          assert.deepEqual(await answers['entity get'](), entity.includes('b1') ? ['b1'] : [], `${label} entity get`);
          assert.deepEqual(await answers['collection explain'](), ['native'], label);
        }
      }, { profile: PROFILE, capture: true });
    });
  }

  it('a membership list crosses as JSON: SQLite binds a lone surrogate there as written, PostgreSQL refuses it', async () => {
    for (const engine of ENGINES) {
      if (skipFor(engine)) continue;
      const profile = { maxRows: 100, externals: ['tenants'], predicates: { t: { $eq: ['$it.tenant', '$tenants[*]'] } } };
      await withStore(engine, MODEL, async (store) => {
        await seed(store, engine);
        const run = async () => store.collection('t').execute(COLLECTION, { externals: { tenants: ['x\uD800'] } });
        if (engine === 'sqlite') assert.deepEqual(await run(), 'a1');
        else await assert.rejects(run, { code: 'JD0011', message: /it holds a lone surrogate/ });
        assert.deepEqual(sorted(await store.collection('t').execute(COLLECTION, { externals: { tenants: ['x\uFFFD', '\u{1F600}'] } })),
          ['b1', 'e1'], engine);
      }, { profile });
    }
  });
});
