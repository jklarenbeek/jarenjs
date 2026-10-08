//@ts-check
/**
 * @file PostgreSQL replication of the rows foreign-key actions change: journal
 * capture on either engine carries them, so envelopes apply PostgreSQL to
 * PostgreSQL, PostgreSQL to SQLite and SQLite to PostgreSQL with equal
 * complete state and a second apply inert; an envelope missing a cascaded
 * row, a child added under a parent another replica deletes and a delete
 * beyond the replication bound refuse; and a row moved off a parent the same
 * envelope removes replays by `apply` and by `reset`.
 */
import { before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';
import { cascadeModel, seedCascade, cascadeWorkload, trialModel, storeState, randomWorkload } from './oracle/cascade.js';

const url = process.env.JAREN_PG_URL;
const CASCADE = cascadeModel();
const TRIAL = trialModel();
const key = { type: 'string', 'x-entity': { key: true } };
/** Authors and their books, whose author key acts `onDelete`. @param {string} onDelete */
const authors = (onDelete) => ({ $model: '0.1', entities: {
  Author: { schema: { type: 'object', required: ['id'], properties: { id: key,
    books: { 'x-entity': { relation: { to: 'Book', many: true, via: 'authorId', onDelete } } } } } },
  Book: { schema: { type: 'object', required: ['id'], properties: { id: key,
    authorId: { type: ['string', 'null'] }, title: { type: 'string' } } } } } });
/** Parents whose kids cascade. */
const kids = () => ({ $model: '0.1', entities: {
  Parent: { schema: { type: 'object', required: ['id'], properties: { id: key,
    kids: { 'x-entity': { relation: { to: 'Kid', many: true, via: 'parentId', onDelete: 'cascade' } } } } } },
  Kid: { schema: { type: 'object', required: ['id', 'parentId'], properties: { id: key,
    parentId: { type: 'string' } } } } } });
const KIDS = kids();
const CHILDREN = [{ $for: { c: '$.Child[*]' }, $return: '$c' }];

/** Every envelope `store` exported, in sequence order. @param {any} store @returns {Promise<any[]>} */
const exported = async (store) => {
  const envelopes = [];
  for (let after = 0; ;) {
    const page = await store.replication.page({ after });
    envelopes.push(...page.items);
    if (!page.hasMore) return envelopes;
    after = page.next;
  }
};

describe('PostgreSQL replication of foreign-key actions', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  /** @type {any} */
  let pg;
  let serial = 0;
  before(async () => { pg = (await import('pg')).default; });

  /**
   * Replicated stores, journal capture unless `mode` says otherwise, each
   * PostgreSQL one on its own schema of one
   * pool (at most three connections, so at most two such stores are open at
   * once); `close` releases a store early, and every store is closed and every
   * schema dropped after `fn`.
   * @param {(context: { open: (engine: string, model: any, replica: string, options?: any) => Promise<any>,
   *   close: (store: any) => Promise<void> }) => Promise<void>} fn
   */
  async function fixture(fn) {
    const prefix = `jaren_replcascade_${process.pid}_${serial++}`;
    const pool = new pg.Pool({ connectionString: url, max: 3 });
    /** @type {Set<any>} */
    const stores = new Set();
    /** @type {string[]} */
    const schemas = [];
    /** @param {string} engine @param {any} model @param {string} replica
     * @param {{ mode?: string, log?: boolean, maxOperations?: number }} [options] */
    const open = async (engine, model, replica, { mode = 'journal', log = false, ...config } = {}) => {
      let driver = nodeDriver();
      if (engine === 'postgres') {
        const schema = `${prefix}_${replica}`;
        await pool.query(`CREATE SCHEMA "${schema}"`);
        schemas.push(schema);
        driver = postgresDriver(pool, { schema });
      }
      const store = await openStore(model, { driver, capture: log ? { mode, log } : { mode },
        replication: { replica, ...config } });
      stores.add(store);
      return store;
    };
    /** @param {any} store */
    const close = async (store) => { stores.delete(store); await store.close(); };
    try { await fn({ open, close }); }
    finally {
      try { for (const store of stores) await store.close(); }
      finally {
        try { for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
        finally { await pool.end(); }
      }
    }
  }

  /**
   * Deliver what `origin` exported since the last delivery: each envelope
   * applies and a second apply of it answers `duplicate`; afterwards the
   * complete states are equal, so no duplicate changed anything.
   * @param {any} origin @param {any} replica @param {any} model @param {string} label
   */
  const courier = (origin, replica, model, label) => {
    let next = 0;
    return async () => {
      const page = await origin.replication.page({ after: next });
      for (const envelope of page.items) {
        assert.equal((await replica.replication.apply(envelope)).status, 'applied', label);
        assert.equal((await replica.replication.apply(envelope)).status, 'duplicate', label);
      }
      next = page.next;
      assert.deepEqual(await storeState(replica, model), await storeState(origin, model), label);
    };
  };

  for (const [from, to] of [['postgres', 'postgres'], ['postgres', 'sqlite'], ['sqlite', 'postgres']]) {
    it(`${from} to ${to}: the corpus workload and seeds 1-3 converge, and replays are inert`, async () => {
      await fixture(async ({ open, close }) => {
        const origin = await open(from, cascadeModel(), 'origin');
        const replica = await open(to, cascadeModel(), 'replica');
        const deliver = courier(origin, replica, CASCADE, 'the corpus workload');
        await seedCascade(origin);
        await deliver();
        await cascadeWorkload(origin, deliver);
        await origin.entity('Parent').delete('r');
        await deliver();
        await close(origin);
        await close(replica);
        for (let seed = 1; seed <= 3; seed += 1) {
          const source = await open(from, trialModel(), `origin${seed}`);
          const target = await open(to, trialModel(), `replica${seed}`);
          // a refused statement aborts a PostgreSQL transaction, so a refusal
          // inside one is taken in a savepoint of its own
          await randomWorkload(source, seed, 20, { savepointRefusals: true });
          await courier(source, target, TRIAL, `seed ${seed}`)();
          await close(source);
          await close(target);
        }
      });
    });
  }

  it('a PostgreSQL replica refuses an envelope missing a cascaded row', async () => {
    // a session origin's envelope is complete whatever the journal records, so
    // only the replica's own capture can find the row missing
    for (const mode of ['session', 'journal']) await fixture(async ({ open }) => {
      const origin = await open('sqlite', cascadeModel(), 'origin', { mode });
      const replica = await open('postgres', cascadeModel(), 'replica', { log: true });
      await seedCascade(origin);
      for (const envelope of await exported(origin)) await replica.replication.apply(envelope);
      const state = await storeState(replica, CASCADE);
      const frontier = await replica.replication.frontier();
      const changes = await replica.changes.page({ after: 0 });
      await origin.entity('Parent').delete('p');
      const [envelope] = (await origin.replication.page({ after: 17 })).items;
      const incomplete = { ...envelope, operations: envelope.operations.filter((/** @type {any} */ op) =>
        !(op.table === 'Child' && op.key === 'c2')) };
      assert.equal(incomplete.operations.length, envelope.operations.length - 1);
      await assert.rejects(replica.replication.apply(incomplete),
        { code: 'JD2104', reason: 'replication caused an undeclared row side effect' }, `from a ${mode} origin`);
      assert.deepEqual(await storeState(replica, CASCADE), state);
      assert.deepEqual(await replica.replication.frontier(), frontier);
      assert.deepEqual(await replica.changes.page({ after: 0 }), changes);
      assert.equal((await replica.replication.apply(envelope)).status, 'applied');
      assert.deepEqual(await storeState(replica, CASCADE), await storeState(origin, CASCADE));
      assert.deepEqual(await replica.execute(CHILDREN), await origin.execute(CHILDREN));
    });
  });

  it('a child added under a parent another replica deletes refuses on both sides', async () => {
    await fixture(async ({ open }) => {
      const a = await open('postgres', kids(), 'a');
      const b = await open('postgres', kids(), 'b');
      await a.entity('Parent').create({ id: 'p' });
      await a.entity('Kid').create({ id: 'k1', parentId: 'p' });
      for (const envelope of await exported(a)) await b.replication.apply(envelope);
      await b.entity('Kid').create({ id: 'k2', parentId: 'p' });
      await a.entity('Parent').delete('p');
      const [fromA] = (await a.replication.page({ after: 2 })).items;
      const [fromB] = (await b.replication.page()).items;
      const [stateA, stateB] = [await storeState(a, KIDS), await storeState(b, KIDS)];
      await assert.rejects(b.replication.apply(fromA),
        { code: 'JD2104', reason: 'replication caused an undeclared row side effect' });
      await assert.rejects(a.replication.apply(fromB), (/** @type {any} */ error) =>
        error.code === 'JD2005' && /violates foreign key constraint/.test(error.message));
      assert.deepEqual(await storeState(a, KIDS), stateA);
      assert.deepEqual(await storeState(b, KIDS), stateB);
    });
  });

  it('a cascading delete beyond replication capacity refuses before it runs', async () => {
    await fixture(async ({ open }) => {
      const store = await open('postgres', cascadeModel(), 'a', { maxOperations: 12 });
      await store.transaction(async (/** @type {any} */ tx) => {
        await tx.entity('Parent').create({ id: 'p' });
        for (let i = 0; i < 8; i++) await tx.entity('Child').create({ id: `c${i}`, parentId: 'p', n: i });
      });
      await store.transaction(async (/** @type {any} */ tx) => {
        for (let i = 0; i < 6; i++) await tx.entity('Note').create({ id: `n${i}`, parentId: 'p' });
      });
      const state = await storeState(store, CASCADE);
      const frontier = await store.replication.frontier();
      await assert.rejects(store.entity('Parent').delete('p'),
        { code: 'JD2106', reason: 'a cascading delete exceeds replication capacity' });
      assert.deepEqual(await storeState(store, CASCADE), state);
      assert.deepEqual(await store.replication.frontier(), frontier);
    });
  });

  it('replay releases a unique value before the write that takes it', async () => {
    /** @param {any} properties @param {string[]} [required] */
    const entity = (properties, required = ['id']) => ({ schema: { type: 'object', required, properties: { id: key, ...properties } } });
    // a passport moves to the person whose passport goes, and its old person goes;
    // a book moves to a new library and takes the isbn another book gives up
    /** @type {[string, any, [string, any][], (tx: any) => Promise<void>][]} */
    const shapes = [
      ['one-to-one cascade key', { $model: '0.1', entities: { Person: entity({}),
        Passport: entity({ personId: { type: 'string' },
          owner: { 'x-entity': { relation: { to: 'Person', via: 'personId', onDelete: 'cascade' } } } }, ['id', 'personId']) } },
      [['Person', { id: 'A' }], ['Person', { id: 'B' }], ['Passport', { id: 'p1', personId: 'B' }], ['Passport', { id: 'p2', personId: 'A' }]],
      async (tx) => {
        await tx.entity('Passport').delete('p1');
        await tx.entity('Passport').update('p2', { personId: 'B' });
        await tx.entity('Person').delete('A');
      }],
      ['unique member', { $model: '0.1', entities: {
        Library: entity({ books: { 'x-entity': { relation: { to: 'Book', many: true, via: 'libraryId', onDelete: 'cascade' } } } }),
        Book: entity({ libraryId: { type: 'string' }, isbn: { type: 'string', 'x-entity': { unique: true } } }, ['id', 'libraryId']) } },
      [['Library', { id: 'L1' }], ['Library', { id: 'L9' }], ['Book', { id: 'X', libraryId: 'L9', isbn: '1' }],
        ['Book', { id: 'Y', libraryId: 'L1', isbn: '2' }]],
      async (tx) => {
        await tx.entity('Library').create({ id: 'L2' });
        await tx.entity('Book').update('X', { isbn: '3' });
        await tx.entity('Book').update('Y', { libraryId: 'L2', isbn: '1' });
        await tx.entity('Library').delete('L1');
      }],
      // a row outside a partial index trades values with a row inside it; a row
      // moves off a parent it then takes the unindexed value of
      ['partial unique index, a row outside it', { $model: '0.1', entities: {
        M: { ...entity({ p: { type: 'string' }, st: { type: 'string' } }, ['id', 'p']),
          indexes: [{ name: 'on_p', path: '$.p', unique: true, where: { $eq: ['$.st', 'on'] } }] } } },
      [['M', { id: 'X', p: 'a' }], ['M', { id: 'Y', p: 'b', st: 'on' }]],
      async (tx) => {
        await tx.entity('M').update('Y', { p: 'tmp' });
        await tx.entity('M').update('X', { p: 'b', st: 'on' });
        await tx.entity('M').update('Y', { p: 'a' });
      }],
      ['partial unique index, a moved row taking its removed parent value', { $model: '0.1', entities: {
        N: { ...entity({ parentId: { type: ['string', 'null'] }, p: { type: 'string' }, st: { type: 'string' },
          kids: { 'x-entity': { relation: { to: 'N', many: true, via: 'parentId', onDelete: 'cascade' } } } }),
        indexes: [{ name: 'on_p', path: '$.p', unique: true, where: { $eq: ['$.st', 'on'] } }] } } },
      [['N', { id: 'a', parentId: null, p: 'x' }], ['N', { id: 'b', parentId: 'a', st: 'on' }], ['N', { id: 'q', parentId: null }]],
      async (tx) => {
        await tx.entity('N').update('b', { parentId: 'q', p: 'x' });
        await tx.entity('N').delete('a');
      }],
    ];
    await fixture(async ({ open, close }) => {
      for (const [at, [shape, model, seed, change]] of shapes.entries()) for (const how of ['apply', 'reset']) {
        const label = `${shape} ${how}`;
        const a = await open('sqlite', model, `u${at}${how}`);
        const b = await open('postgres', model, `v${at}${how}`);
        await a.transaction(async (/** @type {any} */ tx) => { for (const [name, doc] of seed) await tx.entity(name).create(doc); });
        for (const envelope of await exported(a)) await b.replication.apply(envelope);
        await a.transaction(change);
        const result = how === 'apply' ? await b.replication.apply((await a.replication.page({ after: 1 })).items[0])
          : await b.replication.reset(await a.replication.snapshot());
        assert.equal(result.status, how === 'apply' ? 'applied' : 'reset', label);
        assert.deepEqual(await storeState(b, model), await storeState(a, model), label);
        await close(a);
        await close(b);
      }
    });
  });

  it('replay writes a row moved off a parent before removing that parent', async () => {
    await fixture(async ({ open, close }) => {
      for (const onDelete of ['cascade', 'setNull']) for (const how of ['apply', 'reset']) {
        const label = `${onDelete} ${how}`;
        const model = authors(onDelete);
        const a = await open('sqlite', model, `a${onDelete}${how}`);
        const b = await open('postgres', model, `b${onDelete}${how}`);
        await a.entity('Author').create({ id: 'a' });
        await a.entity('Book').create({ id: 'b', authorId: 'a', title: 't' });
        for (const envelope of await exported(a)) await b.replication.apply(envelope);
        await a.transaction(async (/** @type {any} */ tx) => {
          await tx.entity('Author').create({ id: 'a2' });
          await tx.entity('Book').update('b', { authorId: 'a2' });
          await tx.entity('Author').delete('a');
        });
        const [envelope] = (await a.replication.page({ after: 2 })).items;
        const result = how === 'apply' ? await b.replication.apply(envelope)
          : await b.replication.reset(await a.replication.snapshot());
        assert.equal(result.status, how === 'apply' ? 'applied' : 'reset', label);
        assert.deepEqual(await b.entity('Book').get('b'), { id: 'b', authorId: 'a2', title: 't' }, label);
        assert.deepEqual(await storeState(b, model), await storeState(a, model), label);
        await close(a);
        await close(b);
      }
    });
  });
});
