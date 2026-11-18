//@ts-check
/**
 * @file A zoned calendar member of an entity (`x-entity: { temporal: { kind:
 * 'zoned', policy } }`, MODEL-FORMAT §9.3) compared with an instant: its key
 * and stamp narrow the rows a set residual fetches, as a collection's do, and
 * the engine decides each one. A row another zone provider stamped stays a
 * candidate; a conjunct after one that can raise, a root read a second time
 * and a negation keep every row, and so does a narrowing the dialect cannot
 * spell. Each answer is the engine's and the one
 * `pushdown: false` gives, on SQLite and PostgreSQL alike.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { compileJsonQuery } from '@jarenjs/json/query';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { storeTemporals } from '@jarenjs/db/temporals';
import { queryCalendar } from '@jarenjs/json/query/calendar';

import { ENGINES, skipFor, withPostgres } from './store-core-engines.js';
import { tempDbPath } from './helpers.js';

const zoneProvider = createIntlZoneProvider({ revision: 'test-a' });
const laterProvider = createIntlZoneProvider({ revision: 'test-b' });
const calendar = queryCalendar();

const MODEL = { $model: '0.1', entities: {
  Ev: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, n: { type: 'integer' },
    z: { type: 'object', 'x-entity': { temporal: { kind: 'zoned', policy: 'rfc5545' }, index: true } } } } },
  Tag: { schema: { type: 'object', properties: { name: { type: 'string', 'x-entity': { key: true } }, n: { type: 'integer' } } } } } };

const ZONES = ['Europe/Amsterdam', 'America/New_York', 'UTC', 'Asia/Kolkata'];
/** 48 events over a year in four zones, the fold and the gap of 2026 among them, and one with no member. */
const EVENTS = [
  ...Array.from({ length: 44 }, (_, i) => ({ id: `e${String(i).padStart(2, '0')}`, n: i % 7,
    z: { kind: 'zoned', date: `2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + ((i * 5) % 28)).padStart(2, '0')}`,
      time: ['10:00', '23:30:15', '00:00:00.5', '12:00'][i % 4], zone: ZONES[i % 4] } })),
  { id: 'fold', n: 1, z: { kind: 'zoned', date: '2026-10-25', time: '02:30', zone: 'Europe/Amsterdam' } },
  { id: 'gap', n: 2, z: { kind: 'zoned', date: '2026-03-29', time: '02:30', zone: 'Europe/Amsterdam' } },
  { id: 'london', n: 3, z: { kind: 'zoned', date: '2026-10-25', time: '01:50', zone: 'Europe/London' } },
  { id: 'none', n: 4 },
];
const TAGS = [{ name: 't1', n: 1 }, { name: 't3', n: 3 }];

const at = Date.parse;
const instant = { $instant: ['$it.z', 'rfc5545'] };
/** @param {any} where @param {any} [rest] */
const events = (where, rest = {}) => ({ $for: { it: '$.Ev[*]' }, $where: where, $return: '$it.id', ...rest });
/** [name, document, narrowed] — narrowed: the fetch of Ev takes the zoned key beside its stamp. Each
 * document is answered as one array (`[document]`), whatever its result. */
const PROBES = /** @type {[string, any, boolean][]} */ ([
  ['<', events({ $lt: [instant, at('2026-03-01T00:00:00Z')] }), true],
  ['<= the fold', events({ $le: [instant, at('2026-10-25T00:30:00Z')] }), true],
  ['> a fraction', events({ $gt: [instant, at('2026-06-01T00:00:00Z') + 0.5] }), true],
  ['>= past every instant', events({ $ge: [instant, 9e15] }), true],
  ['= one instant', events({ $eq: [instant, at('2026-03-29T01:30:00Z')] }), true],
  ['a translated conjunct first', events({ $and: [{ $ge: ['$it.n', 3] }, { $lt: [instant, at('2026-07-01T00:00:00Z')] }] }), true],
  ['a refused conjunct after', events({ $and: [{ $lt: [instant, at('2026-07-01T00:00:00Z')] }, { $lt: [{ $instant: ['$it.z', 'later'] }, at('2026-05-01T00:00:00Z')] }] }), true],
  ['ordered and windowed', { $subsequence: [events({ $ge: [instant, at('2026-04-01T00:00:00Z')] }, { $orderby: [instant, '$it.id'] }), 1, 5] }, true],
  ['counted', { $count: events({ $lt: [instant, at('2026-05-01T00:00:00Z')] }) }, true],
  // a disjunction of a superset and a translated test is a superset
  ['inside an $or', events({ $or: [{ $lt: [instant, at('2026-03-01T00:00:00Z')] }, { $eq: ['$it.n', 6] }] }), true],
  ['joined to another entity', { $for: { it: '$.Ev[*]', t: '$.Tag[*]' }, $where: { $and: [{ $eq: ['$it.n', '$t.n'] },
    { $lt: [instant, at('2026-08-01T00:00:00Z')] }] }, $return: ['$it.id', '$t.name'] }, true],
  // the engine decides every row
  ['a disjunction across bindings', { $for: { it: '$.Ev[*]', t: '$.Tag[*]' }, $where: { $and: [{ $eq: ['$it.n', '$t.n'] },
    { $or: [{ $lt: [instant, at('2026-03-01T00:00:00Z')] }, { $eq: ['$t.name', 't3'] }] }] }, $return: ['$it.id', '$t.name'] }, false],
  ['a refused conjunct first', events({ $and: [{ $lt: [{ $instant: ['$it.z', 'later'] }, at('2026-05-01T00:00:00Z')] }, { $lt: [instant, at('2026-07-01T00:00:00Z')] }] }), false],
  ['≠', events({ $ne: [instant, at('2026-03-29T01:30:00Z')] }), false],
  ['under a $not', events({ $not: [{ $lt: [instant, at('2026-03-01T00:00:00Z')] }] }), false],
  ['the root read again', events({ $lt: [instant, at('2026-03-01T00:00:00Z')] }, { $return: { id: '$it.id', of: { $count: '$.Ev[*]' } } }), false],
  ['the entity bound twice', { $for: { it: '$.Ev[*]', o: '$.Ev[*]' }, $where: { $and: [{ $eq: ['$it.n', '$o.n'] },
    { $lt: [instant, at('2026-03-01T00:00:00Z')] }] }, $return: ['$it.id', '$o.id'] }, false],
  ['some', { $some: { it: '$.Ev[*]' }, $satisfies: { $lt: [instant, at('2026-01-02T00:00:00Z')] } }, true],
  // its negation, which no implied conjunct enters
  ['every', { $every: { it: '$.Ev[*]' }, $satisfies: { $lt: [instant, at('2026-12-31T00:00:00Z')] } }, false],
  ['ordered only', { $for: { it: '$.Ev[*]' }, $orderby: [instant, '$it.id'], $return: '$it.id' }, false],
].map(([name, document, narrowed]) => [name, [document], narrowed]));

/** The engine's own answer. @param {any} document @param {any} provider */
const engine = (document, provider) => compileJsonQuery(document, { zoneProvider: provider, calendar })({ Ev: EVENTS, Tag: TAGS });

/**
 * Open the model on `engine` twice in turn over one database — written under
 * the first zone provider, read under `readProvider` — and hand the reading
 * store to `fn`.
 * @param {string} engineName @param {any} readProvider @param {(store: any) => Promise<void>} fn
 */
async function written(engineName, readProvider, fn) {
  const open = (/** @type {any} */ driver, /** @type {any} */ provider, /** @type {any} */ path = undefined) =>
    openStore(MODEL, { driver, temporals: storeTemporals(), zoneProvider: provider, ...(path === undefined ? {} : { path }) });
  const seed = async (/** @type {any} */ store) => {
    await store.transaction(async (/** @type {any} */ tx) => {
      for (const row of EVENTS) await tx.entity('Ev').create(row);
      for (const row of TAGS) await tx.entity('Tag').create(row);
    });
    await store.close();
  };
  if (engineName === 'sqlite') {
    const { dbPath, cleanup } = tempDbPath();
    try {
      await seed(await open(nodeDriver(), zoneProvider, dbPath));
      const store = await open(nodeDriver(), readProvider, dbPath);
      try { await fn(store); }
      finally { await store.close(); }
    }
    finally { cleanup(); }
    return;
  }
  await withPostgres(async ({ driver }) => {
    await seed(await open(driver(), zoneProvider));
    const store = await open(driver(), readProvider);
    try { await fn(store); }
    finally { await store.close(); }
  });
}

for (const engineName of ENGINES) {
  describe(`${engineName}: a zoned entity comparison narrows the rows the engine decides`, { skip: skipFor(engineName) }, () => {
    it('answers every probe as the engine and pushdown: false do, fetching the candidates its key and stamp keep', async () => {
      await written(engineName, zoneProvider, async (store) => {
        const fetched = [];
        for (const [name, document, narrowed] of PROBES) {
          const expected = engine(document, zoneProvider);
          assert.deepEqual(await store.execute(document), expected, name);
          assert.deepEqual(await store.execute(document, { pushdown: false }), expected, `${name} (pushdown off)`);
          const explained = await store.explain(document);
          assert.equal(explained.mode, 'set', name);
          assert.equal(explained.prefilters.length > 0, narrowed, `${name}: ${JSON.stringify(explained.prefilters)}`);
          if (narrowed) assert.deepEqual(explained.prefilters.map((/** @type {any} */ prefilter) => [prefilter.entity, prefilter.columns]),
            [['Ev', ['tk_z$rfc5545', 'tk_z']]], name);
          // one statement per root read, and the rows of Ev it was handed
          const ev = explained.admitted.rows - (/\$\.Tag/.test(JSON.stringify(document)) ? TAGS.length : 0);
          fetched.push([name, explained.admitted.statements, narrowed ? ev < EVENTS.length : ev === EVENTS.length]);
          assert.deepEqual((await store.explain(document, { pushdown: false })).prefilters, [], `${name} (pushdown off)`);
        }
        assert.deepEqual(fetched, PROBES.map(([name, document]) => [name, /\$\.Tag/.test(JSON.stringify(document)) ? 2 : 1, true]));
        // the first probe hands the engine exactly the rows its key keeps, and the row keyed by none
        await store.execute(PROBES[0][1]);
        assert.equal((await store.explain(PROBES[0][1])).admitted.rows, engine(PROBES[0][1], zoneProvider).length + 1);
      });
    });

    it('narrows a cursor alike, and fetches every row where the dialect cannot spell the narrowing', async () => {
      await written(engineName, zoneProvider, async (store) => {
        const [, document] = PROBES[0];
        const items = [];
        // the document itself, whose items the cursor yields one by one
        for await (const item of store.entity('Ev').cursor(document[0])) items.push(item);
        assert.deepEqual(items, engine(document, zoneProvider));
        assert.equal((await store.explain(document[0])).admitted.rows, items.length + 1);
        // a member name SQLite's JSON path grammar cannot carry, a text PostgreSQL cannot hold
        const unspelled = [events({ $or: [{ $lt: [instant, at('2026-03-01T00:00:00Z')] }, { $eq: ['$it["q\\"t"]', 1] },
          { $eq: ['$it.id', 'x\u0000y'] }] })];
        assert.deepEqual(await store.execute(unspelled), engine(unspelled, zoneProvider));
        const explained = await store.explain(unspelled);
        assert.deepEqual([explained.mode, explained.prefilters, explained.admitted.rows], ['set', [], EVENTS.length]);
      });
    });

    it('keeps a row another zone provider stamped a candidate, and answers under the provider the store opened with', async () => {
      await written(engineName, laterProvider, async (store) => {
        for (const [name, document] of PROBES) {
          const expected = engine(document, laterProvider);
          assert.deepEqual(await store.execute(document), expected, name);
          assert.deepEqual(await store.execute(document, { pushdown: false }), expected, `${name} (pushdown off)`);
          // every row was keyed under the other revision, so every row is a candidate
          const ev = (await store.explain(document)).admitted.rows - (/\$\.Tag/.test(JSON.stringify(document)) ? TAGS.length : 0);
          assert.equal(ev, EVENTS.length, name);
        }
      });
    });
  });
}
