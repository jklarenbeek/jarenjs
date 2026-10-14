//@ts-check
/**
 * @file An instant key kept as an epoch column (`column: "integer"` on a
 * `date-time` or `date` key): the column holds the epoch, the document the
 * string, and every statement that names one row binds the key as its column
 * holds it, on both engines. `get`, `update` and `delete` name the row by the
 * instant in any spelling of it (the epoch itself included), alone or as part
 * of a composite key; the unit of work files one record per instant; a
 * referencing entity and a membership store and read the instant; session and
 * journal capture render the row under the string its document keeps; and a
 * replicated store's envelopes apply. An append-only log keyed by the instant
 * is loaded, ordered and range-queried by it. A text-stored instant key, a
 * numeric key and a string key answer as they did.
 *
 * The PostgreSQL half runs where `JAREN_PG_URL` names a server.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEntities, openStore, planModelMigration, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { applyJSONPatch } from '@jarenjs/json/patch';
import { ENGINES, skipFor, withStore, counted } from './store-core-engines.js';

/** @param {boolean} epoch */
const model = (epoch) => ({ $model: '0.1', entities: { E: { schema: { type: 'object', properties: {
  at: { type: 'string', format: 'date-time', 'x-entity': { key: true, ...(epoch ? { column: 'integer' } : {}) } }, n: { type: 'integer' } } } } } });
const AT = ['2026-03-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'];

/** The instant every case keys by, its other spelling and the epoch its column holds. */
const INSTANT = '2026-03-01T00:00:00.000Z';
const SHORT = '2026-03-01T00:00:00Z';
const EPOCH = 1772323200000;
/** @param {Record<string, any>} [extra] */
const instantKey = (extra = {}) => ({ type: 'string', format: 'date-time', 'x-entity': { key: true, column: 'integer', ...extra } });

/** Instants with children that reference them, tags they are members of, a
 * date key and a composite key holding an instant. */
const KEYED = { $model: '0.1', entities: {
  E: { schema: { type: 'object', properties: { at: instantKey(), n: { type: 'integer' }, meta: { type: 'object' },
    kids: { 'x-entity': { relation: { to: 'C', many: true, via: 'eAt', onDelete: 'cascade' } } },
    tags: { 'x-entity': { relation: { to: 'T', many: true } } } } } },
  C: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } },
    eAt: { type: 'string', format: 'date-time', 'x-entity': { column: 'integer' } } } } },
  T: { schema: { type: 'object', properties: { name: { type: 'string', 'x-entity': { key: true } } } } },
  D: { schema: { type: 'object', properties: {
    day: { type: 'string', format: 'date', 'x-entity': { key: true, column: 'integer' } }, n: { type: 'integer' } } } },
  P: { schema: { type: 'object', properties: { at: instantKey(), k: { type: 'string', 'x-entity': { key: true } },
    n: { type: 'integer' } } } },
  U: { schema: { type: 'object', properties: { at: instantKey(), k: { type: 'string', 'x-entity': { key: true } },
    slug: { type: 'string', 'x-entity': { unique: true } } } } },
  M: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } },
    es: { 'x-entity': { relation: { to: 'E', many: true } } } } } },
} };

/** A numeric key and a string key. */
const PLAIN = { $model: '0.1', entities: {
  N: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, n: { type: 'integer' } } } },
  S: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, n: { type: 'integer' } } } } } };

/** A journal or session record's ops, sorted, each as one line. @param {any} record */
const opsOf = (record) => record.patch.map((/** @type {any} */ op) =>
  `${op.op} ${op.path}${op.value === undefined ? '' : ` ${JSON.stringify(op.value, Object.keys(op.value ?? {}).sort())}`}`).sort();

/** The capture workload: an instant row written and referenced, updated by
 * another spelling of its key in a column and in its document, made a member,
 * then deleted by its epoch with its child; a second one read and removed by
 * the unit of work under another spelling. @param {any} store */
const captureWorkload = async (store) => {
  await store.entity('E').create({ at: SHORT, n: 1 });
  await store.entity('C').create({ id: 1, eAt: SHORT });
  await store.entity('E').update(INSTANT, { n: 2 });
  await store.entity('E').update(EPOCH, { meta: { a: 1 } });
  await store.entity('T').create({ name: 't' });
  const row = await store.entity('E').get(EPOCH);
  store.entity('E').put({ ...row, tags: ['t'] });
  await store.saveChanges();
  assert.equal(await store.entity('E').delete(EPOCH), true);
  await store.entity('E').create({ at: '2026-04-01T00:00:00Z', n: 3 });
  await store.entity('E').get('2026-04-01T00:00:00.000Z');
  store.entity('E').remove('2026-04-01T00:00:00.000Z');
  assert.equal((await store.saveChanges()).deleted, 1);
};
const CAPTURED = [
  [`add /E/${SHORT} {"at":"${SHORT}","n":1}`],
  [`add /C/1 {"eAt":"${SHORT}","id":1}`],
  [`replace /E/${SHORT}/n 2`],
  [`add /E/${SHORT}/meta {"a":1}`],
  ['add /T/t {"name":"t"}'],
  [`add /E_T/[${EPOCH},"t"] {"E_key":${EPOCH},"T_key":"t"}`],
  ['remove /C/1', `remove /E/${SHORT}`, `remove /E_T/[${EPOCH},"t"]`],
  ['add /E/2026-04-01T00:00:00Z {"at":"2026-04-01T00:00:00Z","n":3}'],
  ['remove /E/2026-04-01T00:00:00Z'],
];

describe('an instant key kept as an epoch column', () => {
  it('opens, and an append-only log is loaded, ordered and range-queried by the instant', async () => {
    assert.equal(normalizeEntities(model(true)).get('E').properties.get('at').column, 'integer');
    const store = await openStore(model(true), { driver: nodeDriver() });
    try {
      for (const [n, at] of AT.entries()) await store.entity('E').create({ at, n });
      assert.deepEqual((await store.entity('E').load({ orderBy: '$it.at' })).map((row) => row.at), [AT[1], AT[2], AT[0]]);
      assert.deepEqual(await store.execute([{ $for: { e: '$.E[*]' }, $where: { $gt: ['$e.at', '2026-01-15T00:00:00.000Z'] },
        $orderby: ['$e.at'], $return: '$e.n' }]), [2, 0]);
    }
    finally { await store.close(); }
  });

  it('a baseline keyed by the epoch plans to a text key and back', () => {
    for (const [from, to] of [[true, false], [false, true]]) {
      const plan = planModelMigration(model(from), model(to), { dialect: sqliteDialect });
      assert.equal(plan.migration.$migration, '0.2');
      assert.notEqual(plan.migration.from, plan.migration.to);
    }
  });

  it('session and journal capture render the row under the string its document keeps, and their envelopes apply', async () => {
    /** @type {Record<string, string[][]>} */
    const seen = {};
    for (const mode of ['session', 'journal']) {
      const store = await openStore(KEYED, { driver: nodeDriver(), capture: { mode }, replication: { replica: 'a' } });
      const replica = await openStore(KEYED, { driver: nodeDriver(), replication: { replica: 'b' } });
      try {
        const records = [];
        store.observe((/** @type {any} */ record) => records.push(opsOf(record)));
        await captureWorkload(store);
        seen[mode] = records;
        for (const envelope of (await store.replication.page({ after: 0 })).items)
          assert.equal((await replica.replication.apply(envelope)).status, 'applied');
        assert.deepEqual(await replica.entity('T').asNoTracking().load({}), [{ name: 't' }]);
      }
      finally {
        await replica.close();
        await store.close();
      }
    }
    assert.deepEqual(seen.journal, CAPTURED);
    assert.deepEqual(seen.session, CAPTURED);
  });

  it('a row stored again under another spelling of its instant is removed under the one it had and added under the new one', async () => {
    const plain = { $model: '0.1', entities: { E: { schema: { type: 'object', properties: { at: instantKey(), n: { type: 'integer' } } } } } };
    for (const how of ['delete and create', 'put']) {
      for (const mode of ['session', 'journal']) {
        const store = await openStore(plain, { driver: nodeDriver(), capture: { mode } });
        try {
          /** @type {any[]} */
          const patches = [];
          store.observe((/** @type {any} */ record) => patches.push(record.patch));
          const rows = store.entity('E');
          await rows.create({ at: INSTANT, n: 1 });
          if (how === 'put') {
            rows.put({ ...(await rows.get(INSTANT)), at: SHORT });
            await store.saveChanges();
          }
          else {
            await store.transaction(async (/** @type {any} */ tx) => {
              await tx.entity('E').delete(INSTANT);
              await tx.entity('E').create({ at: SHORT, n: 1 });
            });
          }
          await rows.update(EPOCH, { n: 5 });
          assert.deepEqual(patches.map((patch) => opsOf({ patch })), [
            [`add /E/${INSTANT} {"at":"${INSTANT}","n":1}`],
            [`add /E/${SHORT} {"at":"${SHORT}","n":1}`, `remove /E/${INSTANT}`],
            [`replace /E/${SHORT}/n 5`],
          ], `${how}, ${mode}`);
          // a mirror that applies every record holds what the store holds
          let mirror = { E: {} };
          for (const patch of patches) mirror = applyJSONPatch(mirror, patch);
          assert.deepEqual(mirror, { E: { [SHORT]: { at: SHORT, n: 5 } } }, `${how}, ${mode}`);
        }
        finally { await store.close(); }
      }
    }
  });

  it('a replicated store refuses a row stored again under another spelling of its instant, and keeps replicating', async () => {
    const plain = { $model: '0.1', entities: { E: { schema: { type: 'object', properties: { at: instantKey(), n: { type: 'integer' } } } } } };
    for (const how of ['delete and create', 'put']) {
      for (const mode of ['session', 'journal']) {
        const store = await openStore(plain, { driver: nodeDriver(), capture: { mode }, replication: { replica: 'a' } });
        const replica = await openStore(plain, { driver: nodeDriver(), replication: { replica: 'b' } });
        try {
          const rows = store.entity('E');
          await rows.create({ at: INSTANT, n: 1 });
          const respell = how === 'put'
            ? async () => {
              rows.put({ ...(await rows.get(INSTANT)), at: SHORT });
              await store.saveChanges();
            }
            : () => store.transaction(async (/** @type {any} */ tx) => {
              await tx.entity('E').delete(INSTANT);
              await tx.entity('E').create({ at: SHORT, n: 1 });
            });
          await assert.rejects(respell, { code: 'JD2104', reason: `the row '${INSTANT}' of 'E' was stored again under another `
            + 'spelling of its key, which replication cannot carry — store it under the spelling it holds' }, `${how}, ${mode}`);
          assert.deepEqual(await rows.asNoTracking().load({}), [{ at: INSTANT, n: 1 }], `${how}, ${mode}`);
          await rows.create({ at: '2026-04-01T00:00:00Z', n: 2 });
          for (const envelope of (await store.replication.page({ after: 0 })).items)
            assert.equal((await replica.replication.apply(envelope)).status, 'applied', `${how}, ${mode}`);
          assert.deepEqual(await replica.entity('E').asNoTracking().load({}),
            [{ at: INSTANT, n: 1 }, { at: '2026-04-01T00:00:00Z', n: 2 }], `${how}, ${mode}`);
        }
        finally {
          await replica.close();
          await store.close();
        }
      }
    }
  });

  it('a numeric key deleted by another spelling of it is recorded under its own in both modes', async () => {
    const numbered = { $model: '0.1', entities: { N: { schema: { type: 'object', properties: {
      id: { type: 'integer', 'x-entity': { key: true } } } } } } };
    for (const mode of ['session', 'journal']) {
      const store = await openStore(numbered, { driver: nodeDriver(), capture: { mode } });
      try {
        const records = [];
        store.observe((/** @type {any} */ record) => records.push(opsOf(record)));
        await store.entity('N').create({ id: 16 });
        await store.entity('N').create({ id: 17 });
        assert.equal(await store.entity('N').delete('16.0'), true);
        await store.entity('N').get(17);
        store.entity('N').remove('17.0');
        await store.saveChanges();
        assert.deepEqual(records, [['add /N/16 {"id":16}'], ['add /N/17 {"id":17}'], ['remove /N/16'], ['remove /N/17']], mode);
      }
      finally { await store.close(); }
    }
  });

  it('a collection row written by another spelling of its numeric key is recorded under its own in both modes', async () => {
    const keyed = { $model: '0.1', collections: { t: { key: '/n',
      schema: { type: 'object', properties: { n: { type: 'integer' }, p: { type: 'integer' } } } } } };
    const numbered = { $model: '0.1', collections: { t: { key: null, identity: 'integer',
      schema: { type: 'object', properties: { p: { type: 'integer' } } } } } };
    const named = { $model: '0.1', collections: { t: { key: '/n',
      schema: { type: 'object', properties: { n: { type: 'string' }, p: { type: 'integer' } } } } } };
    for (const mode of ['session', 'journal']) {
      /** @param {any} definition @param {(t: any, store: any) => Promise<void>} work */
      const recorded = async (definition, work) => {
        const store = await openStore(definition, { driver: nodeDriver(), capture: { mode }, replication: { replica: 'a' } });
        const replica = await openStore(definition, { driver: nodeDriver(), replication: { replica: 'b' } });
        try {
          const records = [];
          store.observe((/** @type {any} */ record) => records.push(opsOf(record)));
          await work(store.collection('t'), store);
          for (const envelope of (await store.replication.page({ after: 0 })).items)
            assert.equal((await replica.replication.apply(envelope)).status, 'applied', mode);
          assert.deepEqual(await replica.collection('t').all(), await store.collection('t').all(), mode);
          return records;
        }
        finally {
          await replica.close();
          await store.close();
        }
      };
      assert.deepEqual(await recorded(keyed, async (t) => {
        await t.insert({ n: 16, p: 1 });
        assert.equal(await t.delete('16.0'), true);
      }), [['add /t/16 {"n":16,"p":1}'], ['remove /t/16']], mode);
      // deleted and stored again in one transaction: the row moved to the end, under its own key
      assert.deepEqual(await recorded(keyed, async (t, store) => {
        for (const n of [16, 17]) await t.insert({ n, p: 1 });
        await store.transaction(async (/** @type {any} */ tx) => {
          await tx.collection('t').delete('16.0');
          await tx.collection('t').insert({ n: 16, p: 1 });
        });
      }), [['add /t/16 {"n":16,"p":1}'], ['add /t/17 {"n":17,"p":1}'], ['replace /t/16 {"n":16,"p":1}']], mode);
      assert.deepEqual(await recorded(numbered, async (t) => {
        assert.equal(await t.insert({ p: 1 }), 1);
        await t.put({ p: 2 }, '1.0');
        assert.equal(await t.delete(' 1'), true);
      }), [['add /t/1 {"p":1}'], ['replace /t/1/p 2'], ['remove /t/1']], mode);
      // a text key column holds '16.0' as a key of its own
      assert.deepEqual(await recorded(named, async (t) => {
        await t.insert({ n: '16.0', p: 1 });
        assert.equal(await t.delete('16'), false);
        assert.equal(await t.delete('16.0'), true);
      }), [['add /t/16.0 {"n":"16.0","p":1}'], ['remove /t/16.0']], mode);
    }
  });

  for (const engine of ENGINES) {
    it(`on ${engine}, the journal records an instant row stored again under another spelling as removed and added, and replication refuses it`,
      { skip: skipFor(engine) }, async () => {
        const plain = { $model: '0.1', entities: { E: { schema: { type: 'object', properties: { at: instantKey(), n: { type: 'integer' } } } } } };
        for (const how of ['delete and create', 'put']) {
          for (const replicated of [false, true]) {
            await withStore(engine, plain, async (store) => {
              /** @type {any[]} */
              const patches = [];
              store.observe((/** @type {any} */ record) => patches.push(record.patch));
              const rows = store.entity('E');
              await rows.create({ at: INSTANT, n: 1 });
              const respell = how === 'put'
                ? async () => {
                  rows.put({ ...(await rows.get(INSTANT)), at: SHORT });
                  await store.saveChanges();
                }
                : () => store.transaction(async (/** @type {any} */ tx) => {
                  await tx.entity('E').delete(INSTANT);
                  await tx.entity('E').create({ at: SHORT, n: 1 });
                });
              if (replicated) {
                await assert.rejects(respell, { code: 'JD2104', reason: `the row '${INSTANT}' of 'E' was stored again under `
                  + 'another spelling of its key, which replication cannot carry — store it under the spelling it holds' }, how);
                assert.deepEqual(await rows.asNoTracking().load({}), [{ at: INSTANT, n: 1 }], how);
                return;
              }
              await respell();
              await rows.update(EPOCH, { n: 5 });
              assert.deepEqual(patches.map((patch) => opsOf({ patch })), [
                [`add /E/${INSTANT} {"at":"${INSTANT}","n":1}`],
                [`add /E/${SHORT} {"at":"${SHORT}","n":1}`, `remove /E/${INSTANT}`],
                [`replace /E/${SHORT}/n 5`],
              ], how);
              let mirror = { E: {} };
              for (const patch of patches) mirror = applyJSONPatch(mirror, patch);
              assert.deepEqual(mirror, { E: { [SHORT]: { at: SHORT, n: 5 } } }, how);
            }, { capture: { mode: 'journal' }, ...(replicated ? { replication: { replica: 'a' } } : {}) });
          }
        }
      });
  }

  for (const engine of ENGINES) {
    it(`on ${engine}, the journal records a collection row deleted by another spelling of its key under its own`,
      { skip: skipFor(engine) }, async () => {
        const keyed = { $model: '0.1', collections: { t: { key: '/n',
          schema: { type: 'object', properties: { n: { type: 'integer' }, p: { type: 'integer' } } } } } };
        await withStore(engine, keyed, async (store) => {
          const records = [];
          store.observe((/** @type {any} */ record) => records.push(opsOf(record)));
          const t = store.collection('t');
          await t.insert({ n: 16, p: 1 });
          assert.equal(await t.delete('16.0'), true);
          assert.deepEqual(records, [['add /t/16 {"n":16,"p":1}'], ['remove /t/16']]);
        }, { capture: { mode: 'journal' } });
      });
  }

  for (const engine of ENGINES) {
    describe(`on ${engine}`, { skip: skipFor(engine) }, () => {
      it('get, update and delete name the row by its instant, in any spelling of it', () => withStore(engine, KEYED, async (store) => {
        const rows = store.entity('E');
        assert.deepEqual(await rows.create({ at: INSTANT, n: 1 }), { at: INSTANT, n: 1 });
        for (const key of [INSTANT, SHORT, EPOCH]) assert.deepEqual(await rows.get(key), { at: INSTANT, n: 1 });
        // no row is stored under a text the column cannot hold
        for (const key of ['2026-03-01T01:00:00+01:00', 'junk']) assert.equal(await rows.get(key), undefined);
        assert.deepEqual(await rows.update(SHORT, { n: 2 }), { at: INSTANT, n: 2 });
        assert.deepEqual(await rows.get(INSTANT), { at: INSTANT, n: 2 });
        await assert.rejects(async () => rows.create({ at: SHORT, n: 9 }), { code: 'JD2001',
          message: `JD2001: a 'E' already exists under key "${SHORT}" at /entities/E` });
        // a collision on the key and on a unique member at once is the duplicate key
        await store.entity('U').create({ at: INSTANT, k: 'a', slug: 's' });
        await assert.rejects(async () => store.entity('U').create({ at: SHORT, k: 'a', slug: 's' }), { code: 'JD2001',
          message: `JD2001: a 'U' already exists under key {"at":"${SHORT}","k":"a"} at /entities/U` });
        assert.equal(await rows.delete(SHORT), true);
        assert.equal(await rows.get(INSTANT), undefined);
        assert.equal(await rows.delete(INSTANT), false);
        await assert.rejects(async () => rows.update(INSTANT, { n: 3 }), { code: 'JD2006' });
      }));

      it('a date key and a composite key holding an instant name their rows', () => withStore(engine, KEYED, async (store) => {
        const days = store.entity('D');
        await days.create({ day: '2026-03-01', n: 1 });
        assert.deepEqual(await days.get('2026-03-01'), { day: '2026-03-01', n: 1 });
        assert.deepEqual(await days.get(EPOCH), { day: '2026-03-01', n: 1 });
        assert.deepEqual(await days.update('2026-03-01', { n: 2 }), { day: '2026-03-01', n: 2 });
        assert.equal(await days.delete('2026-03-01'), true);
        assert.equal(await days.get('2026-03-01'), undefined);
        const pairs = store.entity('P');
        await pairs.create({ at: INSTANT, k: 'a', n: 1 });
        await pairs.create({ at: INSTANT, k: 'b', n: 2 });
        assert.deepEqual(await pairs.get({ at: SHORT, k: 'a' }), { at: INSTANT, k: 'a', n: 1 });
        assert.deepEqual(await pairs.update({ at: INSTANT, k: 'b' }, { n: 3 }), { at: INSTANT, k: 'b', n: 3 });
        assert.equal(await pairs.delete({ at: INSTANT, k: 'a' }), true);
        assert.deepEqual(await pairs.load({}), [{ at: INSTANT, k: 'b', n: 3 }]);
      }));

      it('the unit of work files one record per instant and writes it by its column', () => withStore(engine, KEYED, async (store) => {
        await store.entity('E').create({ at: INSTANT, n: 1 });
        const row = await store.entity('E').get(SHORT);
        store.entity('E').put({ ...row, n: 2 });
        assert.deepEqual(counted(await store.saveChanges()), { inserted: 0, updated: 1, deleted: 0 });
        assert.deepEqual(await store.entity('E').asNoTracking().get(INSTANT), { at: INSTANT, n: 2 });
        // a key no row is stored under is refused where the removal is staged, never at every save after it
        assert.throws(() => store.entity('E').remove('2026-03-01T01:00:00+01:00'), { code: 'JD2003' });
        assert.throws(() => store.entity('E').link('junk', 'tags', 't'), { code: 'JD2003' });
        store.entity('E').remove(EPOCH);
        assert.deepEqual(counted(await store.saveChanges()), { inserted: 0, updated: 0, deleted: 1 });
        assert.equal(await store.entity('E').asNoTracking().get(INSTANT), undefined);
      }));

      it('a referencing entity and a membership name the row by its instant', () => withStore(engine, KEYED, async (store) => {
        await store.entity('E').create({ at: INSTANT, n: 1 });
        await store.entity('T').create({ name: 't' });
        assert.deepEqual(await store.entity('C').create({ id: 1, eAt: INSTANT }), { id: 1, eAt: INSTANT });
        assert.deepEqual(await store.entity('C').asNoTracking().load({}), [{ id: 1, eAt: INSTANT }]);
        assert.deepEqual(await store.execute([{ $for: { c: '$.C[*]' }, $return: '$c.eAt' }]), [INSTANT]);
        // a membership array on create, then one the unit of work writes, then the same one again
        await store.entity('E').create({ at: '2026-04-01T00:00:00.000Z', n: 2, tags: ['t'] });
        const row = await store.entity('E').get(SHORT);
        store.entity('E').put({ ...row, tags: ['t'] });
        assert.equal((await store.saveChanges()).joinInserted, 1);
        const again = await store.entity('E').get(SHORT);
        store.entity('E').put({ ...again, tags: [{ name: 't' }] });
        const second = await store.saveChanges();
        assert.deepEqual([second.joinInserted, second.joinDeleted], [0, 0]);
        assert.deepEqual(await store.entity('E').asNoTracking().load({ include: { kids: true, tags: true }, orderBy: '$it.at' }), [
          { at: INSTANT, n: 1, kids: [{ id: 1, eAt: INSTANT }], tags: [{ name: 't' }] },
          { at: '2026-04-01T00:00:00.000Z', n: 2, kids: [], tags: [{ name: 't' }] },
        ]);
        assert.equal(await store.entity('E').delete(SHORT), true);
        assert.deepEqual(await store.entity('C').asNoTracking().load({}), []);
      }));

      it('a membership whose target is the instant row links, compares and unlinks it by its epoch', () => withStore(engine, KEYED, async (store) => {
        await store.entity('E').create({ at: INSTANT, n: 1 });
        await store.entity('M').create({ id: 1, es: [INSTANT] });
        for (let run = 0; run < 2; run++) {
          const member = await store.entity('M').get(1);
          store.entity('M').put({ ...member, es: [SHORT] });
          const saved = await store.saveChanges();
          assert.deepEqual([saved.joinInserted, saved.joinDeleted], [0, 0], `run ${run}`);
        }
        assert.deepEqual(await store.entity('M').asNoTracking().load({ include: { es: true } }), [{ id: 1, es: [{ at: INSTANT, n: 1 }] }]);
        assert.throws(() => store.entity('M').link(1, 'es', 'junk'), { code: 'JD2003' });
        store.entity('M').unlink(1, 'es', EPOCH);
        assert.equal((await store.saveChanges()).joinDeleted, 1);
        assert.deepEqual(await store.entity('M').asNoTracking().load({ include: { es: true } }), [{ id: 1, es: [] }]);
      }));

      it('envelopes a SQLite origin exported apply to a replica here', () => withStore(engine, KEYED, async (replica) => {
        const origin = await openStore(KEYED, { driver: nodeDriver(), replication: { replica: 'a' }, capture: { mode: 'journal' } });
        try {
          await captureWorkload(origin);
          await origin.entity('E').create({ at: '2026-05-01T00:00:00Z', n: 5 });
          await origin.entity('E').update('2026-05-01T00:00:00.000Z', { n: 6, meta: { b: 2 } });
          const page = await origin.replication.page({ after: 0 });
          for (const envelope of page.items) assert.equal((await replica.replication.apply(envelope)).status, 'applied');
          assert.deepEqual(await replica.entity('E').asNoTracking().load({}), [{ at: '2026-05-01T00:00:00Z', n: 6, meta: { b: 2 } }]);
          assert.deepEqual(await replica.entity('C').asNoTracking().load({}), []);
        }
        finally { await origin.close(); }
      }, { replication: { replica: 'b' } }));

      it('journal capture renders the row under its string, and its envelopes apply', () => withStore(engine, KEYED, async (store) => {
        const records = [];
        store.observe((/** @type {any} */ record) => records.push(opsOf(record)));
        await captureWorkload(store);
        assert.deepEqual(records, CAPTURED);
        const replica = await openStore(KEYED, { driver: nodeDriver(), replication: { replica: 'b' } });
        try {
          const page = await store.replication.page({ after: 0 });
          assert.equal(page.items.length, CAPTURED.length);
          for (const envelope of page.items) assert.equal((await replica.replication.apply(envelope)).status, 'applied');
          assert.deepEqual(await replica.entity('E').asNoTracking().load({}), []);
          assert.deepEqual(await replica.entity('T').asNoTracking().load({}), [{ name: 't' }]);
        }
        finally { await replica.close(); }
      }, { replication: { replica: 'a' }, capture: { mode: 'journal' } }));

      it('a member naming the row without its own epoch column is refused, never stored as the epoch', () => withStore(engine, {
        $model: '0.1', entities: {
          E: { schema: { type: 'object', properties: { at: instantKey(),
            kids: { 'x-entity': { relation: { to: 'C', many: true, via: 'eAt', onDelete: 'cascade' } } } } } },
          C: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } },
            eAt: { type: 'string', format: 'date-time' } } } } } }, async (store) => {
        await store.entity('E').create({ at: INSTANT });
        await assert.rejects(async () => store.entity('C').create({ id: 1, eAt: INSTANT }), { code: 'JD2005' });
        assert.deepEqual(await store.entity('C').asNoTracking().load({}), []);
      }));

      it('a text-stored instant key answers as it did', () => withStore(engine, model(false), async (store) => {
        const rows = store.entity('E');
        await rows.create({ at: INSTANT, n: 1 });
        assert.deepEqual(await rows.get(INSTANT), { at: INSTANT, n: 1 });
        // the text is the key: another spelling names no row
        assert.equal(await rows.get(SHORT), undefined);
        assert.deepEqual(await rows.update(INSTANT, { n: 2 }), { at: INSTANT, n: 2 });
        assert.equal(await rows.delete(INSTANT), true);
      }));

      it('a numeric key answers as it did', () => withStore(engine, PLAIN, async (store) => {
        const numbers = store.entity('N');
        await numbers.create({ id: 16, n: 1 });
        assert.deepEqual(await numbers.get('16'), { id: 16, n: 1 });
        assert.equal(await numbers.get('0x10'), undefined);
        assert.deepEqual(await numbers.update(16, { n: 2 }), { id: 16, n: 2 });
        assert.equal(await numbers.delete(16), true);
      }));

      it('a string key answers as it did', () => withStore(engine, PLAIN, async (store) => {
        const strings = store.entity('S');
        await strings.create({ id: '2026-03-01', n: 1 });
        assert.deepEqual(await strings.get('2026-03-01'), { id: '2026-03-01', n: 1 });
        assert.deepEqual(await strings.update('2026-03-01', { n: 2 }), { id: '2026-03-01', n: 2 });
        assert.equal(await strings.delete('2026-03-01'), true);
        assert.equal(await strings.get('2026-03-01'), undefined);
      }));
    });
  }
});
