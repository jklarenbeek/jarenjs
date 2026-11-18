//@ts-check
/**
 * @file A store opened with registered operators (`operators:`) or with the
 * calendar seam (`temporals: storeTemporals()`) carries one operator record,
 * which holds the planner's own members (the pushable subsets) beside what a
 * query's analysis takes. Every analysis a load, a page, a graph load, a
 * profile predicate, a point read and a live query runs sees only the latter:
 * each answers on such a store exactly what it answers on a plain store, on
 * SQLite and PostgreSQL alike.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { storeTemporals } from '@jarenjs/db/temporals';
import { createJsltRegistry, mathPack } from '@jarenjs/json/jslt';

import { ENGINES, skipFor, withStore } from './store-core-engines.js';

const ENTITIES = { $model: '0.1', entities: {
  Ev: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, n: { type: 'integer' },
    tags: { 'x-entity': { relation: { to: 'Tag', many: true } } } } } },
  Tag: { schema: { type: 'object', properties: { name: { type: 'string', 'x-entity': { key: true } } } } } } };
const NOTES = { $model: '0.1', collections: { notes: { schema: { type: 'object', properties: { id: { type: 'string' }, t: { type: 'string' } } }, key: '/id' } } };
const PROFILE = { predicates: { Ev: { $ge: ['$it.n', 2] }, Tag: { $ne: ['$it.name', 'zz'] }, notes: { $ne: ['$it.t', 'zz'] } } };
const EVENTS = [{ id: 'a', n: 3 }, { id: 'b', n: 1 }, { id: 'c', n: 2 }, { id: 'd', n: 5 }];

/** The stores whose operator record holds more than an analysis takes. */
const SEAMS = /** @type {[string, () => Record<string, any>][]} */ ([
  ['registered operators', () => ({ operators: createJsltRegistry().use(mathPack) })],
  ['the calendar seam', () => ({ temporals: storeTemporals() })],
  ['both', () => ({ operators: createJsltRegistry().use(mathPack), temporals: storeTemporals() })],
]);

/** Every entity read that analyses a document of its own, and what it answers. @param {any} store */
async function entityReads(store) {
  const ev = store.entity('Ev').asNoTracking();
  const ids = (/** @type {any[]} */ rows) => rows.map((row) => row.id);
  const pages = [];
  let continuation;
  do {
    const page = await store.entity('Ev').page({ orderBy: ['$it.n', '$it.id'], where: { $ge: ['$it.n', 1] } },
      { limit: 3, ...(continuation === undefined ? {} : { after: continuation }) });
    pages.push(ids(page.items));
    continuation = page.continuation;
  } while (continuation != null);
  const [graph] = await ev.load({ where: { $eq: ['$it.id', 'a'] },
    include: { tags: { where: { $ne: ['$it.name', 'y'] }, orderBy: ['$it.name'] } } });
  return {
    ordered: ids(await ev.load({ orderBy: [{ $key: '$it.n', $dir: 'desc' }] })),
    filtered: ids(await ev.load({ where: { $gt: ['$it.n', 1] }, orderBy: ['$it.id'] })),
    // a page ends where its continuation does
    pages: pages.filter((items) => items.length > 0),
    graph: graph.tags.map((/** @type {any} */ tag) => tag.name),
    profiled: await store.execute({ $for: { it: '$.Ev[*]' }, $orderby: ['$it.id'], $return: '$it.id' }, { profile: PROFILE }),
    explained: (await store.explain({ $for: { it: '$.Ev[*]' }, $return: '$it.id' }, { profile: PROFILE })).mode,
  };
}

/** @param {any} store */
async function seedEntities(store) {
  for (const name of ['x', 'y', 'z']) await store.entity('Tag').create({ name });
  for (const row of EVENTS) await store.entity('Ev').create(row);
  const ev = store.entity('Ev');
  ev.put({ ...(await ev.get('a')), tags: ['x', 'y', 'z'] });
  await store.saveChanges();
}

for (const engineName of ENGINES) {
  describe(`${engineName}: a store's operator record reaches each analysis as query options only`, { skip: skipFor(engineName) }, () => {
    it('answers every load, page, graph load and profiled entity query as a plain store does', async () => {
      const expected = await withStore(engineName, ENTITIES, async (store) => { await seedEntities(store); return entityReads(store); });
      assert.deepEqual(expected, { ordered: ['d', 'a', 'c', 'b'], filtered: ['a', 'c', 'd'], pages: [['b', 'c', 'a'], ['d']],
        graph: ['x', 'z'], profiled: ['a', 'c', 'd'], explained: 'native' });
      for (const [seam, options] of SEAMS) {
        const answered = await withStore(engineName, ENTITIES, async (store) => { await seedEntities(store); return entityReads(store); }, options());
        assert.deepEqual(answered, expected, seam);
      }
    });

    it('answers a profiled collection query, a point read and a live query under a store profile as a plain store does', async () => {
      const reads = async (/** @type {any} */ store) => {
        const notes = store.collection('notes');
        for (const [id, t] of [['a', 'x'], ['b', 'zz'], ['c', 'y']]) await notes.insert({ id, t });
        const answered = { executed: await notes.execute([{ $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it.id' }]),
          hidden: await notes.get('b'), shown: await notes.get('a') };
        // a live query's own analysis (PostgreSQL's live queries take the async host: not this file's)
        if (engineName !== 'sqlite') return answered;
        const live = await notes.live([{ $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it.id' }]);
        try {
          // a live document's own compared externals are read as its analysis reads them: a bigint is no number
          const compared = [{ $for: { it: '$[*]' }, $where: { $eq: ['$it.t', '$x'] }, $return: '$it.id' }];
          await assert.rejects(notes.live(compared, { externals: { x: 5n } }), { code: 'JD0041' });
          return { ...answered, live: live.result.rows };
        }
        finally { await live.close(); }
      };
      const base = { profile: PROFILE, ...(engineName === 'sqlite' ? { capture: true } : {}) };
      const expected = await withStore(engineName, NOTES, reads, base);
      assert.deepEqual(expected, { executed: ['a', 'c'], hidden: undefined, shown: { id: 'a', t: 'x' },
        ...(engineName === 'sqlite' ? { live: ['a', 'c'] } : {}) });
      for (const [seam, options] of SEAMS)
        assert.deepEqual(await withStore(engineName, NOTES, reads, { ...base, ...options() }), expected, seam);
      for (const [seam, options] of SEAMS) {
        const entityPoint = await withStore(engineName, ENTITIES, async (store) => {
          await seedEntities(store);
          return [await store.entity('Ev').asNoTracking().get('a'), await store.entity('Ev').asNoTracking().get('b')];
        }, { profile: PROFILE, ...options() });
        assert.deepEqual(entityPoint, [{ id: 'a', n: 3 }, undefined], seam);
      }
    });

    it('keys a calendar comparison in a load through the seam, and refuses a registered operator there by the load rule (JD0032)', async () => {
      const model = { $model: '0.1', entities: { Ev: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } },
        n: { type: 'number' }, u: { type: 'object', 'x-entity': { temporal: { kind: 'utc' }, index: true } } } } } } };
      await withStore(engineName, model, async (store) => {
        const ev = store.entity('Ev');
        for (const [id, instant, n] of /** @type {const} */ ([['a', '2026-01-02T00:00:00Z', 4], ['b', '2026-01-01T00:00:00.5Z', 9], ['c', '2026-01-03T00:00:00Z', 16]]))
          await ev.create({ id, n, u: { kind: 'utc', instant } });
        const before = { $lt: [{ $instant: ['$it.u'] }, Date.parse('2026-01-02T12:00:00Z')] };
        assert.deepEqual((await ev.asNoTracking().load({ where: before, orderBy: ['$it.id'] })).map((row) => row.id), ['a', 'b']);
        const page = await ev.page({ where: before, orderBy: ['$it.id'] }, { limit: 1 });
        assert.deepEqual(page.items.map((/** @type {any} */ row) => row.id), ['a']);
        await assert.rejects(ev.asNoTracking().load({ where: { $gt: [{ $sqrt: '$it.n' }, 2.5] } }),
          (/** @type {any} */ error) => error.code === 'JD0032' && /is not translatable/.test(error.message));
        // the query engine, which has a residual, runs the same operator
        assert.deepEqual(await ev.execute([{ $for: { it: '$.Ev[*]' }, $where: { $gt: [{ $sqrt: '$it.n' }, 2.5] }, $orderby: ['$it.id'], $return: '$it.id' }]), ['b', 'c']);
      }, { temporals: storeTemporals(), operators: createJsltRegistry().use(mathPack) });
    });
  });
}
