//@ts-check
/**
 * @file Groups ordered by an integer sum or average. An integer sum is exact
 * while every partial sum is, and the statement carries that proof beside
 * the aggregate, so the groups come out in the engine's order: ascending or
 * descending, a group with no value as zero (a sum) or as the empty key (an
 * average), equal values by first appearance. A group past the bound sends
 * the whole call to the engine, and a window never hides one. Floating
 * sums and averages, and an ordering that leaves two groups tied over a
 * compound physical key, stay in the engine under a name.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { reasonId, normalizeModel, planCollection, planQuery, emitPlan, sqliteDialect, typeOfPath } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver, postgresDialect } from '@jarenjs/db/postgres';

import {
  loadGroups, loadRelationGroups, storeForGroup, storeForEntityGroup, runCase, runEntityCase,
} from './oracle/harness.js';
import { onBothEngines, onBothEnginesPhysical } from './query-core-engines.js';

const URL = process.env.JAREN_PG_URL;
let schemas = 0;

/**
 * Run `fn` once per available host with a way to open a driver of it: SQLite
 * in memory, and PostgreSQL in schemas of its own (a pool of two, every
 * schema dropped afterwards) when `JAREN_PG_URL` names an endpoint.
 * @param {(host: 'sqlite' | 'postgres', driverOf: () => Promise<any>) => Promise<void>} fn
 */
async function onHosts(fn) {
  await fn('sqlite', async () => nodeDriver());
  if (!URL) return;
  const { default: pg } = await import('pg');
  const { postgresDriver } = await import('@jarenjs/db/postgres');
  const pool = new pg.Pool({ connectionString: URL, max: 2 });
  /** @type {string[]} */
  const made = [];
  try {
    await fn('postgres', async () => {
      const schema = `group_order_${process.pid}_${++schemas}`;
      await pool.query(`CREATE SCHEMA "${schema}"`);
      made.push(schema);
      return postgresDriver(pool, { schema });
    });
  }
  finally {
    for (const schema of made) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
}

/** Whether a case orders its groups by an aggregate: its statement then names the aggregate's alias. */
const ordersByAggregate = (/** @type {any} */ query) =>
  /"\$(?:sum|avg|count|min|max)"/.test(JSON.stringify((query.$subsequence ? query.$subsequence[0] : query).$orderby ?? null));

/** What an aggregate-ordered group statement looks like: the groups by the aggregate's alias, ties by the
 * first row, or by the key and its type where the order also names the key, which ranks every two groups apart. */
const ORDERED_BY_AGGREGATE = /GROUP BY "vk0", "tk0" ORDER BY (?=.*"a\d" (?:ASC|DESC) NULLS (?:FIRST|LAST))(?:.*, MIN\(|.*"tk0" (?:ASC|DESC))/;

/** The cases of the collection groups the planner keeps in the engine, and the reason each names. */
const COLLECTION_KEPT = new Map([
  ['a window over groups ordered by a sum', 'plan.windowedAccumulation'],
  ['a window over groups ordered by an average', 'plan.windowedAccumulation'],
  ['a window cannot hide a group past the bound', 'plan.windowedAccumulation'],
  ['a window cannot hide a group past the bound, ascending', 'plan.windowedAccumulation'],
  ['a floating sum ordering stays in the engine', 'plan.floatingAccumulation'],
  ['a floating average ordering stays in the engine', 'plan.floatingAccumulation'],
  ['an integer sum ordering beside a floating sum return', 'plan.floatingAccumulation'],
  // members of other types: a null, two kinds, a boolean or no type at all is no sum the plan can prove
  ['a sum of a member that may be null', 'named'],
  ['an average of a member that may be null', 'named'],
  ['a sum of a member of two kinds', 'named'],
  ['a sum of a boolean member', 'named'],
  ['a sum of an untyped member', 'named'],
  // a member that may hold a fraction is a floating one whichever type it lists first
  ['a sum of a member that may hold a fraction', 'plan.floatingAccumulation'],
  ['an average of a member that may hold a fraction', 'plan.floatingAccumulation'],
  ['a sum of a member that may hold a fraction, returned', 'plan.floatingAccumulation'],
  ['a sum of a floating member', 'plan.floatingAccumulation'],
]);
/** The same for the entity groups: the entity planner has no window over groups and refuses a float by one name. */
const ENTITY_KEPT = new Map([
  ['a window over groups ordered by a sum', 'entity.projection'],
  ['a window over groups ordered by an average', 'entity.projection'],
  ['a floating sum ordering stays in the engine', 'entity.projection'],
  ['a floating average ordering stays in the engine', 'entity.projection'],
  ['an integer sum ordering beside a floating sum return', 'entity.projection'],
  ['a sum of a member that may be null', 'entity.projection'],
  ['an average of a member that may be null', 'entity.projection'],
  ['a sum of a boolean member', 'entity.projection'],
  ['a sum of a member that may hold a fraction', 'entity.projection'],
  ['an average of a member that may hold a fraction', 'entity.projection'],
  ['a sum of a member that may hold a fraction, returned', 'entity.projection'],
  ['a sum of a floating member', 'entity.projection'],
]);
/** The cases whose rows hold a group past the exactness bound: planned native, answered by the engine at run time. */
const PAST_THE_BOUND = new Set([
  'a sum past the exactness bound answers the engine',
  'an average past the exactness bound answers the engine',
  'a sum used only to order, past the bound',
  'a group past int64 orders by the engine sum',
  'every group orders by the engine sum',
]);

describe('collection groups ordered by an integer sum or average', () => {
  for (const name of ['group order by integer sums', 'group order past the exactness bound',
    'group order over members of other types']) {
    it(`${name}: native on every host, the engine's answer, side by side`, async () => {
      const group = loadGroups().find((entry) => entry.group === name);
      assert.ok(group, name);
      await onHosts(async (host, driverOf) => {
        for (const side of /** @type {const} */ (['indexed', 'unindexed'])) {
          const { store, collection } = await storeForGroup(group, await driverOf(), side);
          try {
            for (const kase of group.cases) {
              const label = `${host} ${side}: ${kase.name}`;
              const kept = COLLECTION_KEPT.get(kase.name);
              const explained = await collection.explain(kase.query);
              if (kept === undefined) {
                assert.equal(explained.mode, 'native', label);
                if (ordersByAggregate(kase.query)) assert.match(explained.sql, ORDERED_BY_AGGREGATE, label);
              }
              else {
                assert.equal(explained.mode, 'set', label);
                const ids = explained.residual.reasons.map((/** @type {any} */ entry) => reasonId(entry.reason));
                assert.ok(ids.every((id) => id !== null), `${label}: ${JSON.stringify(ids)}`);
                if (kept !== 'named') assert.equal(ids[0], kept, label);
              }
              assert.equal(await runCase(collection, group.documents, kase, 'native'), null, label);
              assert.equal(await runCase(collection, group.documents, kase, 'residual'), null, label);
              if (PAST_THE_BOUND.has(kase.name)) {
                const after = await collection.explain(kase.query);
                assert.equal(after.mode, 'native', `the plan still pushes: ${label}`);
                assert.equal(reasonId(after.fallback.reason), 'bind.accumulation', label);
                await assert.rejects(Promise.resolve().then(() => collection.execute(kase.query, { strict: true })),
                  { code: 'JD0010' }, label);
              }
            }
          }
          finally { await store.close(); }
        }
      });
    });
  }
});

describe('entity groups ordered by an integer sum or average', () => {
  for (const name of ['29 entity group order by integer sums', '30 entity group order past the exactness bound',
    '32 entity group order over members of other types']) {
    it(`${name}: native on SQLite, in the engine on PostgreSQL's store-owned tables, the engine's answer`, async () => {
      const group = loadRelationGroups().find((entry) => entry.group === name);
      assert.ok(group, name);
      await onHosts(async (host, driverOf) => {
        for (const side of /** @type {const} */ (['indexed', 'unindexed'])) {
          const { store } = await storeForEntityGroup(group, await driverOf(), side);
          try {
            for (const kase of group.cases) {
              const label = `${host} ${side}: ${kase.name}`;
              const kept = ENTITY_KEPT.get(kase.name)
                ?? (host === 'postgres' ? 'bind.entityGrouping' : undefined);
              const explained = await store.explain(kase.query);
              if (kept === undefined) {
                assert.equal(explained.mode, 'native', label);
                if (ordersByAggregate(kase.query)) assert.match(explained.sql, ORDERED_BY_AGGREGATE, label);
              }
              else {
                assert.equal(explained.mode, 'set', label);
                assert.equal(reasonId(explained.residual.reasons[0].reason), kept, label);
              }
              assert.equal(await runEntityCase(store, group.documents, kase, 'native'), null, label);
              assert.equal(await runEntityCase(store, group.documents, kase, 'residual'), null, label);
              if (host === 'sqlite' && PAST_THE_BOUND.has(kase.name)) {
                const after = await store.explain(kase.query);
                assert.equal(after.mode, 'set', label);
                assert.equal(reasonId(after.residual.reasons[0].reason), 'bind.accumulation', label);
              }
            }
          }
          finally { await store.close(); }
        }
      });
    });
  }
});

/** The engine's answers to some of the cases, written out so that agreeing with the engine is not agreeing on a shared mistake. */
const ANSWERS = new Map(/** @type {[string, any][]} */ ([
  ['a sum ascending', [{ g: 'neg', t: -6 }, { g: 'none', t: 0 }, { g: 'zero', t: 0 }, { t: 1 }, { g: 'pos', t: 7 },
    { g: 'tie1', t: 7 }, { g: 'tie2', t: 7 }]],
  ['a sum descending', [{ g: 'pos', t: 7 }, { g: 'tie1', t: 7 }, { g: 'tie2', t: 7 }, { t: 1 }, { g: 'none', t: 0 },
    { g: 'zero', t: 0 }, { g: 'neg', t: -6 }]],
  ['equal sums keep their first appearance', ['pos', 'tie1', 'tie2', 'none', 'zero', 'neg']],
  ['an average ascending puts a group with no value first', [{ g: 'none' }, { g: 'neg', a: -3 }, { g: 'zero', a: 0 },
    { a: 1 }, { g: 'pos', a: 3.5 }, { g: 'tie1', a: 7 }, { g: 'tie2', a: 7 }]],
  ['an average descending puts a group with no value last', [{ g: 'tie1', a: 7 }, { g: 'tie2', a: 7 }, { g: 'pos', a: 3.5 },
    { a: 1 }, { g: 'zero', a: 0 }, { g: 'neg', a: -3 }, { g: 'none' }]],
  ['an average with the empty greatest', [{ g: 'neg', a: -3 }, { g: 'zero', a: 0 }, { a: 1 }, { g: 'pos', a: 3.5 },
    { g: 'tie1', a: 7 }, { g: 'tie2', a: 7 }, { g: 'none' }]],
  ['averages that round to one double tie, descending', [{ g: 'B', a: 1000000000000000.625 }, { g: 'A', a: 1000000000000000.625 }]],
  ['averages that round to one double tie, ascending', [{ g: 'B', a: 1000000000000000.625 }, { g: 'A', a: 1000000000000000.625 }]],
  ['sums of the same groups differ', [{ g: 'B', t: 8000000000000005 }, { g: 'A', t: 3000000000000002 }]],
  ['a sum past the exactness bound answers the engine', [{ g: 'U', t: 1 }, { g: 'V', t: 1 }]],
  ['an average past the exactness bound answers the engine', [{ g: 'U', a: 0.3333333333333333 }, { g: 'V', a: 1 }]],
  ['a group past int64 orders by the engine sum', [{ g: 'X', t: 4611686018427387904 }, { g: 'Y', t: 5 }]],
  ['a window cannot hide a group past the bound', { g: 'X', t: 4611686018427387904 }],
  ['a window cannot hide a group past the bound, ascending', { g: 'U' }],
  // the nullable form of a sum is its own aggregate: a group with no value is `null` there and `0` in the order
  ['a sum order beside the nullable form of the same sum', [{ g: 'neg', s: -6 }, { g: 'none', s: null }, { g: 'zero', s: 0 },
    { s: 1 }, { g: 'pos', s: 7 }, { g: 'tie1', s: 7 }, { g: 'tie2', s: 7 }]],
  ['a sum order beside the nullable form of the same sum, descending', [{ g: 'pos', s: 7 }, { g: 'tie1', s: 7 },
    { g: 'tie2', s: 7 }, { s: 1 }, { g: 'none', s: null }, { g: 'zero', s: 0 }, { g: 'neg', s: -6 }]],
  ['a plain sum beside the nullable form of the same sum', [{ g: 'pos', t: 7, s: 7 }, { g: 'neg', t: -6, s: -6 },
    { g: 'none', t: 0, s: null }, { g: 'tie1', t: 7, s: 7 }, { g: 'tie2', t: 7, s: 7 }, { g: 'zero', t: 0, s: 0 }, { t: 1, s: 1 }]],
  ['the nullable form of a sum beside the plain sum', [{ s: 7, g: 'pos', t: 7 }, { s: -6, g: 'neg', t: -6 },
    { s: null, g: 'none', t: 0 }, { s: 7, g: 'tie1', t: 7 }, { s: 7, g: 'tie2', t: 7 }, { s: 0, g: 'zero', t: 0 }, { s: 1, t: 1 }]],
  // a number orders as a number, not as its digits
  ['groups ordered by a numeric key, ascending', [{ n: 1 }, { k: -10, n: 1 }, { k: -5, n: 1 }, { k: 2, n: 2 }, { k: 9, n: 2 },
    { k: 10, n: 2 }, { k: 100, n: 1 }]],
  ['groups ordered by a numeric key, descending', [{ k: 100, n: 1 }, { k: 10, n: 2 }, { k: 9, n: 2 }, { k: 2, n: 2 },
    { k: -5, n: 1 }, { k: -10, n: 1 }, { n: 1 }]],
  ['a numeric key, then a sum', [{ t: 1 }, { k: -10, t: -1 }, { k: -5, t: 7 }, { k: 2, t: -3 }, { k: 9, t: -2 },
    { k: 10, t: 10 }, { k: 100, t: 4 }]],
  ['distinct numeric values in order', [-10, -5, 2, 9, 10, 100]],
  ['distinct numeric values in descending order', [100, 10, 9, 2, -5, -10]],
  // 0.1 + 0.2 + 0.3 is 0.6000000000000001 added left to right, which is what a member that may hold a fraction answers
  ['a sum of a member that may hold a fraction', [{ g: 'B' }, { g: 'A' }]],
  ['a sum of a member that may hold a fraction, returned', [{ g: 'A', t: 0.6000000000000001 }, { g: 'B', t: 0.6 }]],
]));

describe('the answers the engine gives to groups ordered by a sum or an average', () => {
  it('are the answers of the store on every host', async () => {
    const groups = loadGroups().filter((entry) => ['group order by integer sums', 'group order past the exactness bound',
      'group order over members of other types'].includes(entry.group));
    await onHosts(async (host, driverOf) => {
      for (const group of groups) {
        const { store, collection } = await storeForGroup(group, await driverOf(), 'indexed');
        try {
          for (const kase of group.cases) {
            if (!ANSWERS.has(kase.name)) continue;
            assert.deepEqual(await collection.execute(kase.query), ANSWERS.get(kase.name), `${host}: ${kase.name}`);
          }
        }
        finally { await store.close(); }
      }
    });
  });
});

/** @param {string} prefix */
const ITEMS_DDL = (prefix) => `CREATE TABLE ${prefix}items (id integer PRIMARY KEY, g text NOT NULL, v bigint);
  INSERT INTO ${prefix}items VALUES (1,'pos',3),(2,'neg',-5),(3,'none',NULL),(4,'pos',4),(5,'tie1',7),(6,'tie2',7)`;
/** Eight rows of `B` first, then `A`, then a group past the bound and one that is not: keys ascend, as a table's do. */
const AB_DDL = (/** @type {string} */ prefix) => `CREATE TABLE ${prefix}items (id integer PRIMARY KEY, g text NOT NULL, v bigint);
  INSERT INTO ${prefix}items VALUES (1,'B',1000000000000001),(2,'B',1000000000000001),(3,'B',1000000000000001),
  (4,'B',1000000000000001),(5,'B',1000000000000001),(6,'B',1000000000000000),(7,'B',1000000000000000),
  (8,'B',1000000000000000),(9,'A',1000000000000000),(10,'A',1000000000000001),(11,'A',1000000000000001),
  (12,'U',9007199254740991),(13,'U',2),(14,'U',-9007199254740991),(15,'V',1)`;
/** The adopted table as an entity with `v` absent where the column holds NULL. @param {string | null} schema */
const itemsModel = (schema) => ({ $model: '0.1', entities: { Item: {
  schema: { type: 'object', properties: {
    id: { type: 'integer', 'x-entity': { key: true } }, g: { type: 'string' }, v: { type: 'integer' } } },
  physical: { ...(schema === null ? {} : { schema }), table: 'items', columns: {
    id: { name: 'id', codec: 'integer', null: 'reject' }, g: { name: 'g', codec: 'text', null: 'reject' },
    v: { name: 'v', codec: 'integer', null: 'absent' } } },
} } });

/** @param {any[]} order @param {any} ret @param {any} [where] */
const byItems = (order, ret, where) => ({ $for: { it: '$.Item[*]' }, ...(where === undefined ? {} : { $where: where }),
  $groupby: { g: '$it.g' }, $orderby: order, $return: ret });
const sumKey = (/** @type {string} */ dir) => ({ $key: { $sum: '$it.v' }, $dir: dir });
const avgKey = (/** @type {string} */ dir) => ({ $key: { $avg: '$it.v' }, $dir: dir });

describe('a physical table whose groups are ordered by an integer sum or average', () => {
  it('orders a group with no value as zero, ties by the key, natively on every host', async () => {
    await onBothEnginesPhysical(itemsModel, ITEMS_DDL, async (store, host) => {
      const total = { g: '$g', s: { $sum: '$it.v' } };
      const mean = { g: '$g', a: { $avg: '$it.v' } };
      const cases = /** @type {[string, any, any][]} */ ([
        ['a sum ascending', byItems([sumKey('asc')], total),
          [{ g: 'neg', s: -5 }, { g: 'none', s: 0 }, { g: 'pos', s: 7 }, { g: 'tie1', s: 7 }, { g: 'tie2', s: 7 }]],
        ['a sum descending', byItems([sumKey('desc')], total),
          [{ g: 'pos', s: 7 }, { g: 'tie1', s: 7 }, { g: 'tie2', s: 7 }, { g: 'none', s: 0 }, { g: 'neg', s: -5 }]],
        ['a sum used only to order', byItems([sumKey('asc')], '$g'), ['neg', 'none', 'pos', 'tie1', 'tie2']],
        ['an average ascending', byItems([avgKey('asc')], mean),
          [{ g: 'none' }, { g: 'neg', a: -5 }, { g: 'pos', a: 3.5 }, { g: 'tie1', a: 7 }, { g: 'tie2', a: 7 }]],
        ['an average descending', byItems([avgKey('desc')], mean),
          [{ g: 'tie1', a: 7 }, { g: 'tie2', a: 7 }, { g: 'pos', a: 3.5 }, { g: 'neg', a: -5 }, { g: 'none' }]],
      ]);
      for (const [name, query, answer] of cases) {
        const label = `${host}: ${name}`;
        const explained = await store.explain(query);
        assert.equal(explained.mode, 'native', label);
        assert.match(explained.sql, ORDERED_BY_AGGREGATE, label);
        assert.deepEqual(await store.execute(query, { strict: true }), answer, label);
        assert.deepEqual(await store.execute(query, { pushdown: false }), answer, `${label} (engine)`);
      }
    });
  });

  it('orders averages that round to one double by first appearance, and answers the engine past the bound', async () => {
    await onBothEnginesPhysical(itemsModel, AB_DDL, async (store, host) => {
      const mean = { g: '$g', a: { $avg: '$it.v' } };
      const ab = { $or: [{ $eq: ['$it.g', 'A'] }, { $eq: ['$it.g', 'B'] }] };
      const poison = { $or: [{ $eq: ['$it.g', 'U'] }, { $eq: ['$it.g', 'V'] }] };
      // the two averages are the same double, so the groups tie and B, whose rows come first, leads in both directions
      const tie = [{ g: 'B', a: 1000000000000000.625 }, { g: 'A', a: 1000000000000000.625 }];
      for (const dir of ['asc', 'desc']) {
        const query = byItems([avgKey(dir)], mean, ab);
        assert.equal((await store.explain(query)).mode, 'native', `${host} ${dir}`);
        assert.deepEqual(await store.execute(query, { strict: true }), tie, `${host} ${dir}`);
      }
      const bounded = byItems([sumKey('asc')], { g: '$g', s: { $sum: '$it.v' } }, poison);
      assert.equal((await store.explain(bounded)).mode, 'native', host);
      assert.deepEqual(await store.execute(bounded), [{ g: 'U', s: 1 }, { g: 'V', s: 1 }], host);
      const after = await store.explain(bounded);
      assert.equal(after.mode, 'set', host);
      assert.equal(reasonId(after.residual.reasons[0].reason), 'bind.accumulation', host);
      await assert.rejects(Promise.resolve().then(() => store.execute(bounded, { strict: true })), { code: 'JD0010' }, host);
    });
  });
});

/** @param {string} prefix */
const COMPOUND_DDL = (prefix) => `CREATE TABLE ${prefix}t (k1 integer NOT NULL, k2 integer NOT NULL, g text NOT NULL, PRIMARY KEY (k1, k2));
  INSERT INTO ${prefix}t VALUES (1,9,'A'),(2,0,'A'),(1,5,'B'),(3,3,'B')`;
/** @param {string | null} schema */
const compoundModel = (schema) => ({ $model: '0.1', entities: { T: {
  schema: { type: 'object', properties: {
    k1: { type: 'integer', 'x-entity': { key: true } }, k2: { type: 'integer', 'x-entity': { key: true } }, g: { type: 'string' } } },
  physical: { ...(schema === null ? {} : { schema }), table: 't', keys: ['k1', 'k2'], columns: {
    k1: { name: 'k1', codec: 'integer', null: 'reject' }, k2: { name: 'k2', codec: 'integer', null: 'reject' },
    g: { name: 'g', codec: 'text', null: 'reject' } } },
} } });

describe('groups over a compound physical key', () => {
  it('whose order leaves two groups tied are answered by the engine, whose first appearance is a key tuple', async () => {
    await onBothEnginesPhysical(compoundModel, COMPOUND_DDL, async (store, host) => {
      const count = { $count: '$t' };
      const grouped = (/** @type {any} */ order, /** @type {any} */ ret = { g: '$g', n: count }) =>
        ({ $for: { t: '$.T[*]' }, $groupby: { g: '$t.g' }, ...(order === null ? {} : { $orderby: order }), $return: ret });
      // each group has two rows, so the count ties; the rows are read in key order (1,5,B) (1,9,A) (2,0,A) (3,3,B),
      // so B appears first. The minima of the key columns, taken one by one, would put A (1, 0) before B (1, 3)
      const query = grouped([{ $key: count, $dir: 'desc' }]);
      const answer = [{ g: 'B', n: 2 }, { g: 'A', n: 2 }];
      const explained = await store.explain(query);
      assert.equal(explained.mode, 'set', host);
      assert.equal(reasonId(explained.residual.reasons[0].reason), 'entity.groupOrder', host);
      assert.deepEqual(await store.execute(query), answer, host);
      assert.deepEqual(await store.execute(query, { pushdown: false }), answer, `${host} (engine)`);
      await assert.rejects(Promise.resolve().then(() => store.execute(query, { strict: true })), { code: 'JD0010' }, host);
      // every other order that can tie two groups is the engine's too: a sum, an unordered grouping, a key that leaves another key unordered
      const refused = [
        grouped([{ $key: { $sum: '$t.k1' }, $dir: 'desc' }]),
        grouped(null),
        { $for: { t: '$.T[*]' }, $groupby: { g: '$t.g', a: '$t.k1' }, $orderby: ['$g'], $return: { g: '$g', a: '$a' } },
      ];
      for (const document of refused) {
        const reasons = (await store.explain(document)).residual?.reasons ?? [];
        assert.deepEqual(reasons.map((/** @type {any} */ entry) => reasonId(entry.reason)), ['entity.groupOrder'], `${host} ${JSON.stringify(document)}`);
        assert.deepEqual(await store.execute(document), await store.execute(document, { pushdown: false }), host);
      }
    });
  });

  it('whose order names every group key cannot tie, so the table answers it natively', async () => {
    await onBothEnginesPhysical(compoundModel, COMPOUND_DDL, async (store, host) => {
      const byKey = { $for: { t: '$.T[*]' }, $groupby: { g: '$t.g' }, $orderby: [{ $key: '$g', $dir: 'desc' }],
        $return: { g: '$g', n: { $count: '$t' } } };
      assert.equal((await store.explain(byKey)).mode, 'native', host);
      assert.deepEqual(await store.execute(byKey, { strict: true }), [{ g: 'B', n: 2 }, { g: 'A', n: 2 }], host);
      const byBoth = { $for: { t: '$.T[*]' }, $groupby: { g: '$t.g', a: '$t.k1' }, $orderby: ['$a', { $key: '$g', $dir: 'desc' }],
        $return: { g: '$g', a: '$a' } };
      assert.equal((await store.explain(byBoth)).mode, 'native', host);
      assert.deepEqual(await store.execute(byBoth, { strict: true }), await store.execute(byBoth, { pushdown: false }), host);
    });
  });
});

describe('a store-owned entity grouping', () => {
  it('is native on SQLite and, on PostgreSQL, in the engine under a name of its own', async () => {
    const model = { $model: '0.1', entities: { Item: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'integer', 'x-entity': { key: true } }, g: { type: 'string' }, v: { type: 'integer' } } } } } };
    await onBothEngines(model, async (store, host) => {
      for (const [id, g, v] of [[1, 'pos', 3], [2, 'neg', -5], [3, 'none', undefined], [4, 'pos', 4]])
        await store.entity('Item').create({ id, g, ...(v === undefined ? {} : { v }) });
      const grouped = byItems([sumKey('asc')], { g: '$g', s: { $sum: '$it.v' } });
      const explained = await store.explain(grouped);
      if (host === 'sqlite') assert.equal(explained.mode, 'native', host);
      else {
        assert.equal(explained.mode, 'set', host);
        assert.deepEqual(explained.residual.reasons.map((/** @type {any} */ entry) => reasonId(entry.reason)),
          ['bind.entityGrouping'], host);
        await assert.rejects(Promise.resolve().then(() => store.execute(grouped, { strict: true })), { code: 'JD0010' }, host);
      }
      assert.deepEqual(await store.execute(grouped), [{ g: 'neg', s: -5 }, { g: 'none', s: 0 }, { g: 'pos', s: 7 }], host);
    });
  });
});

/** @param {string} prefix */
const FRACTIONS_DDL = (prefix) => `CREATE TABLE ${prefix}items (id integer PRIMARY KEY, g text NOT NULL, v ${prefix === '' ? 'REAL' : 'double precision'});
  INSERT INTO ${prefix}items VALUES (1,'A',0.1),(2,'A',0.2),(3,'A',0.3),(4,'B',0.6)`;
/** A table whose column holds doubles, under the declaration of `v` the test names. @param {any} type */
const fractionsModel = (type) => (/** @type {string | null} */ schema) => ({ $model: '0.1', entities: { Item: {
  schema: { type: 'object', properties: {
    id: { type: 'integer', 'x-entity': { key: true } }, g: { type: 'string' }, v: { type } } },
  physical: { ...(schema === null ? {} : { schema }), table: 'items', columns: {
    id: { name: 'id', codec: 'integer', null: 'reject' }, g: { name: 'g', codec: 'text', null: 'reject' },
    v: { name: 'v', codec: 'number', null: 'absent' } } },
} } });

describe('a physical column of doubles', () => {
  // 0.1 + 0.2 + 0.3 is 0.6000000000000001 added left to right and 0.6 on SQLite's compensated sum: the groups
  // A and B tie there and A leads, where the engine puts B first
  for (const [what, type] of /** @type {[string, any][]} */ ([
    ['declared number', 'number'], ['declared number, then integer', ['number', 'integer']],
    ['declared integer, then number', ['integer', 'number']],
    ['declared integer although its column holds doubles', 'integer'],
  ])) {
    it(`${what}: its sum orders the groups in the engine`, async () => {
      await onBothEnginesPhysical(fractionsModel(type), FRACTIONS_DDL, async (store, host) => {
        const query = byItems([sumKey('asc')], '$g');
        const explained = await store.explain(query);
        assert.equal(explained.mode, 'set', `${host}: ${what}`);
        assert.equal(reasonId(explained.residual.reasons[0].reason), 'entity.projection', `${host}: ${what}`);
        assert.deepEqual(await store.execute(query), ['B', 'A'], `${host}: ${what}`);
        await assert.rejects(Promise.resolve().then(() => store.execute(query, { strict: true })), { code: 'JD0010' }, `${host}: ${what}`);
        // the whole sum is the same engine's: 0.1 + 0.2 + 0.3 + 0.6 left to right
        const whole = { $sum: { $for: { it: '$.Item[*]' }, $return: '$it.v' } };
        const wholeExplained = await store.explain(whole);
        assert.equal(wholeExplained.mode, 'set', `${host}: ${what}, whole`);
        assert.equal(reasonId(wholeExplained.residual.reasons[0].reason), 'entity.scalarAggregate', `${host}: ${what}, whole`);
        assert.equal(await store.execute(whole), 1.2000000000000002, `${host}: ${what}, whole`);
      });
    });
  }
});

describe('the type the planner reads from a member that lists several', () => {
  it('is a number when the member may hold a fraction, whichever type comes first', () => {
    const schema = { type: 'object', properties: {
      a: { type: ['integer', 'number'] }, b: { type: ['number', 'integer'] }, c: { type: ['integer', 'null', 'number'] },
      d: { type: ['integer', 'null'] }, e: { type: ['integer', 'string'] }, f: { type: 'integer' }, g: { type: ['string', 'number'] },
    } };
    const typed = Object.fromEntries('abcdefg'.split('').map((name) => [name, typeOfPath(schema, [{ name }])]));
    assert.deepEqual(typed, { a: 'number', b: 'number', c: 'number', d: 'integer', e: 'integer', f: 'integer', g: 'string' });
  });
});

describe('a member that may hold a fraction, in a temporal bucket', () => {
  const T0 = 1767225600000;
  const MODEL = { $model: '0.1', collections: { sample: { key: null, identity: 'integer',
    schema: { type: 'object', properties: {
      series: { type: 'string' }, at: { type: 'integer' }, wide: { type: ['integer', 'number'] },
      hits: { type: 'integer' }, mean: { type: ['integer', 'number'] } } },
    indexes: [{ name: 'by_series_at', path: ['$.series', '$.at'] }, { name: 'by_series_wide', path: ['$.series', '$.wide'] }] } } };
  const sample = normalizeModel(MODEL).get('sample');
  const physical = planCollection('sample', sample, sqliteDialect);
  const shape = { collection: 'sample', schema: sample.schema, columnByCanonical: physical.columnByCanonical,
    virtualByStem: new Map(), indexes: physical.expected.indexes };
  /** @param {string} instant @param {any} aggregate */
  const bucket = (instant, aggregate) => planQuery({ $for: { s: '$[*]' },
    $where: { $and: [{ $eq: ['$s.series', 'a'] }, { $ge: [`$s.${instant}`, T0] }, { $lt: [`$s.${instant}`, T0 + 3600000] }] },
    $groupby: { b: { '$time-bucket': [`$s.${instant}`, 60000, T0] } }, $orderby: ['$b'],
    $return: { at: '$b', value: aggregate } }, shape);
  const codes = (/** @type {any} */ planned) => (planned.series?.reasons ?? []).map((/** @type {any} */ r) => r.code);

  it('is no whole epoch, and its sum or average is the engine\'s', () => {
    // the controls: a whole epoch and a sum of whole numbers are native
    assert.equal(bucket('at', { $sum: '$s.hits' }).mode, 'native');
    assert.deepEqual(codes(bucket('at', { $sum: '$s.hits' })), []);
    // an instant that may hold a fraction is not a whole epoch
    assert.deepEqual(codes(bucket('wide', { $sum: '$s.hits' })), ['instant-not-integer']);
    // a reading that may hold a fraction adds in the engine
    for (const aggregate of [{ $sum: '$s.mean' }, { $avg: '$s.mean' }]) {
      const planned = bucket('at', aggregate);
      assert.equal(planned.mode, 'set', JSON.stringify(aggregate));
      assert.deepEqual(codes(planned), ['floating-accumulation'], JSON.stringify(aggregate));
    }
    // the extremes have no accumulation order
    assert.equal(bucket('at', { $max: '$s.mean' }).mode, 'native');
  });
});

describe('the key of a group is ordered as the kind it is', () => {
  const MODEL = (/** @type {boolean} */ indexed) => ({ $model: '0.1', collections: { rows: { key: null, identity: 'integer',
    schema: { type: 'object', properties: { id: { type: 'string' }, s: { type: 'string' }, k: { type: 'integer' } } },
    indexes: indexed ? [{ name: 'by_s', path: '$.s' }, { name: 'by_k', path: '$.k' }] : [] } } });
  /** @param {any} dialect @param {string} key @param {boolean} [indexed] */
  const sqlOf = (dialect, key, indexed = false) => {
    const rows = normalizeModel(MODEL(indexed)).get('rows');
    const shape = { collection: 'rows', schema: rows.schema, columnByCanonical: planCollection('rows', rows, dialect).columnByCanonical };
    const planned = planQuery({ $for: { it: '$[*]' }, $groupby: { x: `$it.${key}` }, $orderby: ['$x'], $return: { x: '$x' } }, shape);
    assert.equal(planned.mode, 'native', key);
    return emitPlan(planned.plan, dialect, { table: 'rows', keyColumn: 'key', docColumn: 'doc' }).sql;
  };

  it('is read as a number, or as code points, by a statement whose projected key is text', () => {
    const pg = postgresDialect();
    // the order names the one key, which ranks the groups apart: no first row breaks a tie
    const tail = String.raw` ASC NULLS FIRST, "tk0" ASC$`;
    assert.match(sqlOf(pg, 'k'), new RegExp(String.raw`GROUP BY "vk0", "tk0" ORDER BY MIN\(\(CASE WHEN jsonb_typeof\(\("doc" #> '\{"k"\}'\)\) = 'number' THEN \(\("doc" #> '\{"k"\}'\)\)::numeric END\)\)${tail}`));
    assert.match(sqlOf(pg, 's'), new RegExp(String.raw`GROUP BY "vk0", "tk0" ORDER BY MIN\(\(\(CASE WHEN jsonb_typeof\(\("doc" #> '\{"s"\}'\)\) = 'string' THEN "doc" #>> '\{"s"\}' END\) COLLATE "C"\)\)${tail}`));
    // an indexed member reads its generated column, which is typed (and collated "C") already
    assert.match(sqlOf(pg, 'k', true), new RegExp(String.raw`ORDER BY MIN\("gx_k"\)${tail}`));
    assert.match(sqlOf(pg, 's', true), new RegExp(String.raw`ORDER BY MIN\("gx_s"\)${tail}`));
  });

  it('is the key itself where the projected key is typed already', () => {
    for (const key of ['k', 's'])
      assert.match(sqlOf(sqliteDialect, key), /GROUP BY "vk0", "tk0" ORDER BY "vk0" ASC NULLS FIRST, "tk0" ASC$/);
  });
});

/**
 * The server answers some statements with a transient refusal while other suites share it:
 * template0 in use by a concurrent CREATE DATABASE, or a backend terminated under the case.
 */
const TRANSIENT = new Set(['55006', '57P01', '57P02', '57P03']);

/** @param {import('node:test').TestContext} t */
async function icuCase(t) {
  const { default: pg } = await import('pg');
  const admin = new pg.Client({ connectionString: URL });
  // a backend the server ends under a sibling suite surfaces as an 'error' event;
  // the query that was waiting rejects with its code and the case retries
  admin.on('error', () => {});
  await admin.connect();
  const database = `group_order_icu_${process.pid}`;
  try {
    try {
      await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE 'en-US'`);
    }
    catch (error) {
      if (TRANSIENT.has(/** @type {any} */ (error).code)) throw error;
      t.skip(`no database with an ICU collation can be created here: ${/** @type {any} */ (error).message}`);
      return;
    }
    const url = new globalThis.URL(/** @type {string} */ (URL));
    url.pathname = `/${database}`;
    const pool = new pg.Pool({ connectionString: url.href, max: 2 });
    pool.on('error', () => {});
    let store;
    try {
      // without a collation of its own, 'a' sorts before 'B' here and after it by code point
      assert.equal((await pool.query(`SELECT 'a'::text < 'B'::text AS before`)).rows[0].before, true, 'the database default is not code point order');
      const schema = `group_order_icu_${process.pid}`;
      await pool.query(`CREATE SCHEMA "${schema}"`);
      const model = { $model: '0.1', collections: { rows: { key: null, identity: 'integer',
        schema: { type: 'object', properties: { g: { type: 'string' }, v: { type: 'integer' } } }, indexes: [] } } };
      const { openStore } = await import('@jarenjs/db');
      store = await openStore(model, { driver: postgresDriver(pool, { schema }) });
      const rows = store.collection('rows');
      for (const document of [{ g: 'a', v: 1 }, { g: 'B', v: 1 }, { g: 'b', v: 2 }]) await rows.insert(document);
      const grouped = (/** @type {any} */ order, ret = '$g') => ({ $for: { it: '$[*]' }, $groupby: { g: '$it.g' }, $orderby: order, $return: ret });
      for (const [name, order, answer] of /** @type {[string, any, string[]]} */ ([
        ['the key', ['$g'], ['B', 'a', 'b']],
        ['a sum, then the key', [{ $key: { $sum: '$it.v' } }, '$g'], ['B', 'a', 'b']],
        ['a count, then the key descending', [{ $key: { $count: '$it' } }, { $key: '$g', $dir: 'desc' }], ['b', 'a', 'B']],
      ])) {
        const query = grouped(order);
        assert.equal((await rows.explain(query)).mode, 'native', name);
        assert.deepEqual(await rows.execute(query), answer, name);
        assert.deepEqual(await rows.execute(query, { pushdown: false }), answer, `${name} (engine)`);
      }
    }
    finally {
      await store?.close();
      await pool.end();
    }
  }
  finally {
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  }
}

describe('a PostgreSQL database that is not C-collated', { skip: !URL && 'JAREN_PG_URL is not set' }, () => {
  it('orders string group keys by code point, as the engine does', async (t) => {
    for (let attempt = 1; ; attempt++) {
      try {
        await icuCase(t);
        return;
      }
      catch (error) {
        if (attempt >= 4 || !TRANSIENT.has(/** @type {any} */ (error).code)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
  });
});
