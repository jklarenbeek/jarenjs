//@ts-check
/**
 * @file The temporal seam (`@jarenjs/db/temporals`, MODEL-FORMAT §2): a
 * declared temporal member is keyed, refused and compared through the
 * subpath a host installs, and the store's queries read a calendar value
 * through the calendar it carries, so a store without it carries none of
 * that code. Without it a model declaring a temporal member is `JD0017` at
 * every door a store opens through, a query calling `$instant` or `$wall`
 * is `JQ0003` whether or not it is pushed, and a migration — which plans
 * with the seam always — still plans a model declaring one, as the model
 * migrated from too.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, prepareModel, normalizeModel, planModelMigration, introspectModel, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { storeTemporals } from '@jarenjs/db/temporals';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';

import { ENGINES, skipFor, withStore } from './store-core-engines.js';
import { tempDbPath } from './helpers.js';

const zoneProvider = createIntlZoneProvider({ revision: 'seam' });
const SCHEMA = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
/** @param {any[]} [temporals] */
const model = (temporals = [{ name: 'u', path: '$.u', kind: 'utc' }, { name: 'f', path: '$.f', kind: 'floating' }]) => ({
  $model: '0.1', collections: { ev: { schema: SCHEMA, key: '/id', temporals, indexes: [{ name: 'by_u', path: '$.u' }] } },
});
const PLAIN = { $model: '0.1', collections: { ev: { schema: SCHEMA, key: '/id' } } };
/** @param {string} code */
const coded = (code) => (/** @type {any} */ e) => {
  assert.equal(e.code, code, e.message);
  return true;
};
const unseamed = (/** @type {any} */ e) => {
  assert.equal(e.code, 'JD0017', e.message);
  assert.match(e.message, /temporals: storeTemporals\(\) from '@jarenjs\/db\/temporals'/);
  assert.equal(e.docPath, '/collections/ev/temporals');
  return true;
};

describe('a model declaring a temporal member needs the seam', () => {
  it('is JD0017 at openStore, prepareModel and normalizeModel without it, and opens with it', async () => {
    await assert.rejects(openStore(model(), { driver: nodeDriver() }), unseamed);
    assert.throws(() => prepareModel(model()), unseamed);
    assert.throws(() => normalizeModel(model()), unseamed);
    const store = await openStore(model(), { driver: nodeDriver(), temporals: storeTemporals() });
    try {
      await store.collection('ev').put({ id: 'a', u: { kind: 'utc', instant: '2026-01-01T00:00:00Z' } });
      assert.equal((await store.collection('ev').get('a')).u.instant, '2026-01-01T00:00:00Z');
    }
    finally { await store.close(); }
  });
  it('a model prepared with the seam opens only with it as well, since its queries read through it', async () => {
    const prepared = prepareModel(model(), { temporals: storeTemporals() });
    await assert.rejects(openStore(prepared, { driver: nodeDriver() }), unseamed);
    const store = await openStore(prepared, { driver: nodeDriver(), temporals: storeTemporals() });
    await store.close();
  });
  it('an empty or absent declaration needs nothing', async () => {
    for (const doc of [PLAIN, model([])]) {
      const store = await openStore(doc, { driver: nodeDriver() });
      await store.close();
    }
  });
  it('is what storeTemporals() answers, and nothing else', async () => {
    const fake = { hooks: {}, calendar: {} };
    await assert.rejects(openStore(PLAIN, { driver: nodeDriver(), temporals: fake }), coded('JD0009'));
    assert.throws(() => prepareModel(PLAIN, { temporals: fake }), coded('JD0009'));
    const store = await openStore(PLAIN, { driver: nodeDriver() });
    try {
      await assert.rejects(Promise.resolve().then(() => store.introspect({ temporals: fake })), coded('JD0013'));
    }
    finally { await store.close(); }
  });
});

describe('a migration plans with the seam always', () => {
  it('plans adding and dropping a declaration, the declared model as history too', () => {
    const add = planModelMigration(PLAIN, model(), { dialect: sqliteDialect });
    assert.ok(add.migration.steps.length > 0);
    const drop = planModelMigration(model(), PLAIN, { dialect: sqliteDialect });
    assert.ok(drop.migration.steps.length > 0);
    assert.ok(JSON.stringify(add.migration.steps).includes('u_temporal'), 'the added table carries the CHECK');
    assert.ok(!JSON.stringify(drop.migration.steps).includes('CONSTRAINT \\"u_temporal\\"'), 'the rebuilt table carries none');
  });
});

for (const engineName of ENGINES) {
  describe(`${engineName}: a calendar operator needs the seam, pushed or not`, { skip: skipFor(engineName) }, () => {
    const queries = [
      ['$instant', { $for: { e: '$[*]' }, $orderby: { $instant: ['$e.u'] }, $return: '$e.id' }],
      ['$wall', { $for: { e: '$[*]' }, $where: { $lt: [{ $wall: '$e.f' }, '2026-07-01T10:00:00.000'] }, $return: '$e.id' }],
    ];
    it('is JQ0003 on a store without it, with pushdown on and off', async () => {
      await withStore(engineName, PLAIN, async (store) => {
        const ev = store.collection('ev');
        await ev.put({ id: 'a', u: { kind: 'utc', instant: '2026-01-01T00:00:00Z' }, f: { kind: 'floating', date: '2026-07-01', time: '09:00' } });
        for (const [name, doc] of queries) {
          for (const options of [undefined, { pushdown: false }]) {
            await assert.rejects(Promise.resolve().then(() => ev.execute(doc, options)), (/** @type {any} */ e) => {
              assert.equal(e.code, 'JQ0003', `${name} ${JSON.stringify(options)}: ${e.message}`);
              assert.match(e.message, new RegExp(`'\\${name}' reads a calendar value`));
              return true;
            });
          }
        }
      });
    });
    it('answers with it, a plain collection through the engine and a declared one through its keys', async () => {
      for (const doc of [PLAIN, model()]) {
        await withStore(engineName, doc, async (store) => {
          const ev = store.collection('ev');
          await ev.put({ id: 'a', u: { kind: 'utc', instant: '2026-01-01T00:00:00.5Z' }, f: { kind: 'floating', date: '2026-07-01', time: '09:00' } });
          await ev.put({ id: 'b', u: { kind: 'utc', instant: '2026-01-01T00:00:00Z' }, f: { kind: 'floating', date: '2026-07-01', time: '10:00' } });
          for (const options of [undefined, { pushdown: false }]) {
            assert.deepEqual(await ev.execute(queries[0][1], options), ['b', 'a']);
            assert.deepEqual([await ev.execute(queries[1][1], options)].flat(), ['a']);
          }
        }, { zoneProvider, temporals: storeTemporals() });
      }
    });
  });
}

describe('the seam moves no plan of a query that reads no calendar value', () => {
  it('explains every query alike with it and without it, a UDF fragment and a registry-free residual included', async () => {
    const doc = { $model: '0.1', collections: { ev: { schema: SCHEMA, key: '/id', indexes: [{ name: 'by_n', path: '$.n' }] } } };
    const queries = [
      { $for: { e: '$[*]' }, $where: { $lt: ['$e.n', 3] }, $orderby: '$e.n', $return: '$e.id' },
      { $for: { e: '$[*]' }, $where: { $eq: [{ '$lower-case': '$e.s' }, 'x'] }, $return: '$e.id' },
      { $for: { e: '$[*]' }, $where: { $eq: [{ $concat: ['$e.s', '!'] }, 'x!'] }, $return: '$e.id' },
      { $for: { e: '$[*]' }, $where: { $gt: [{ '$string-length': '$e.s' }, 0] }, $return: { $count: '$e.id' } },
      { $count: '$[*]' },
    ];
    const explained = async (/** @type {any} */ options) => {
      const store = await openStore(doc, { driver: nodeDriver(), ...options });
      try {
        const ev = store.collection('ev');
        await ev.put({ id: 'a', n: 1, s: 'X' });
        return await Promise.all(queries.map((query) => Promise.resolve().then(() => ev.explain(query)).catch((e) => e.code)));
      }
      finally { await store.close(); }
    };
    const bare = await explained({});
    assert.ok(bare.some((/** @type {any} */ plan) => plan?.udfs?.length > 0), 'one fragment is a UDF on this driver');
    assert.deepEqual(await explained({ temporals: storeTemporals() }), bare);
  });
});

describe('introspection reads a declaration back through the seam', () => {
  it('reads the CHECK as the declaration with it, and as a CHECK no model declares without it', async () => {
    const { dbPath: path, cleanup } = tempDbPath();
    try {
      const store = await openStore(model(), { driver: nodeDriver(), path, temporals: storeTemporals() });
      let own;
      try { own = (await store.introspect({ keys: { ev: '/id' } })).model; }
      finally { await store.close(); }
      assert.deepEqual(own.collections.ev.temporals.map((/** @type {any} */ t) => t.name).sort(), ['f', 'u']);
      const connection = await nodeDriver().open(path, {});
      try {
        const bare = await introspectModel(connection, { keys: { ev: '/id' } });
        assert.equal(bare.model.collections?.ev?.temporals, undefined);
        const seamed = await introspectModel(connection, { keys: { ev: '/id' }, temporals: storeTemporals() });
        assert.deepEqual(seamed.model.collections.ev.temporals, own.collections.ev.temporals);
      }
      finally { await connection.close(); }
    }
    finally { cleanup(); }
  });
});
