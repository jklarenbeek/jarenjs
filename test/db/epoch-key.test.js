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
