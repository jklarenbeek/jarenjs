//@ts-check
/**
 * @file Journal capture of the database's foreign-key actions: a committed
 * delete records every row the declared foreign keys removed or nulled —
 * descendants at every depth, the foreign-key member of `setNull` rows, the
 * memberships of every removed row — exactly as session capture records them,
 * on every store delete path; a delete the database refuses records nothing,
 * nor does a create whose membership it refuses; under replication a delete
 * whose own rows exceed the replication bound refuses before it runs, and the
 * envelope of its whole transaction is bounded at commit.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { openStore, compileEntityModel } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { entityCore } from '@jarenjs/db/entity';
import { cascadeModel, seedCascade, cascadeWorkload, canonicalPatch, CASCADE_RECORDS } from './oracle/cascade.js';
import { replicationModel, replicaState } from './oracle/replication.js';
import { tempDbPath } from './helpers.js';

const key = { type: 'string', 'x-entity': { key: true } };
/** @param {any[]} records */
const canonicalRecords = (records) => records.map((record) => canonicalPatch(record.patch));

// a membership on one side, a child the database refuses to orphan on the other
const restrictModel = { $model: '0.1', entities: {
  Owner: { schema: { type: 'object', required: ['id'], properties: { id: key,
    tags: { 'x-entity': { relation: { to: 'Tag', many: true } } },
    kids: { 'x-entity': { relation: { to: 'Kid', many: true, via: 'ownerId', onDelete: 'restrict' } } } } } },
  Tag: { schema: { type: 'object', required: ['id'], properties: { id: key } } },
  Kid: { schema: { type: 'object', required: ['id', 'ownerId'], properties: { id: key, ownerId: { type: 'string' } } } },
} };

// two foreign keys from one child into one parent: a row both nulled and removed
const diamondModel = { $model: '0.1', entities: {
  Hub: { schema: { type: 'object', required: ['id'], properties: { id: key,
    loose: { 'x-entity': { relation: { to: 'Spoke', many: true, via: 'looseRef', onDelete: 'setNull' } } },
    tight: { 'x-entity': { relation: { to: 'Spoke', many: true, via: 'tightRef', onDelete: 'cascade' } } } } } },
  Spoke: { schema: { type: 'object', required: ['id'], properties: { id: key,
    looseRef: { type: ['string', 'null'] }, tightRef: { type: ['string', 'null'] } } } },
} };

// one row two set-null keys of one parent name, another a set-null self reference names
const nullingModel = { $model: '0.1', entities: {
  Owner: { schema: { type: 'object', required: ['id'], properties: { id: key,
    first: { 'x-entity': { relation: { to: 'Item', many: true, via: 'firstRef', onDelete: 'setNull' } } },
    second: { 'x-entity': { relation: { to: 'Item', many: true, via: 'secondRef', onDelete: 'setNull' } } } } } },
  Item: { schema: { type: 'object', required: ['id'], properties: { id: key, firstRef: { type: ['string', 'null'] },
    secondRef: { type: ['string', 'null'] }, upRef: { type: ['string', 'null'] },
    below: { 'x-entity': { relation: { to: 'Item', many: true, via: 'upRef', onDelete: 'setNull' } } } } } },
} };

/** Run `write` against a seeded corpus store per capture mode; the records each committed.
 * @param {(store: any) => Promise<void>} write */
const recordsPerMode = async (write) => {
  /** @type {Record<string, string[][]>} */
  const records = {};
  for (const mode of ['session', 'journal']) {
    const store = await openStore(cascadeModel(), { driver: nodeDriver(), capture: { mode } });
    try {
      await seedCascade(store);
      /** @type {any[]} */
      const seen = [];
      store.observe((record) => seen.push(record));
      await write(store);
      records[mode] = canonicalRecords(seen);
    }
    finally { await store.close(); }
  }
  return records;
};

describe('journal capture of foreign-key actions', () => {
  it('journal capture records the rows foreign keys remove or null as session capture does', async () => {
    for (const mode of ['session', 'journal']) {
      const store = await openStore(cascadeModel(), { driver: nodeDriver(), capture: { mode } });
      try {
        assert.equal(store.capabilities.capture, mode);
        await seedCascade(store);
        /** @type {any[]} */
        const seen = [];
        store.observe((record) => seen.push(record));
        await cascadeWorkload(store);
        // the synchronous surface stays synchronous: the answer, not a promise of it
        assert.equal(store.sync.entity('Parent').delete('r'), true, mode);
        assert.deepEqual(canonicalRecords(seen), CASCADE_RECORDS, mode);
      }
      finally { await store.close(); }
    }
  });

  it('a delete the database refuses records nothing, directly or through a save', async () => {
    for (const replicated of [false, true]) for (const path of ['delete', 'saveChanges']) {
      const label = `${replicated ? 'replicated' : 'capture-only'} ${path}`;
      const store = await openStore(restrictModel, { driver: nodeDriver(), capture: { mode: 'journal' },
        ...(replicated ? { replication: { replica: 'o' } } : {}) });
      try {
        await store.entity('Tag').create({ id: 't' });
        await store.entity('Owner').create({ id: 'o', tags: ['t'] });
        await store.entity('Kid').create({ id: 'k', ownerId: 'o' });
        /** @type {any[]} */
        const seen = [];
        store.observe((record) => seen.push(record));
        let refused;
        await store.transaction(async (/** @type {any} */ tx) => {
          try {
            if (path === 'delete') await tx.entity('Owner').delete('o');
            else {
              tx.entity('Owner').remove('o');
              await tx.saveChanges();
            }
          }
          catch (error) {
            refused = /** @type {any} */ (error).code;
            if (path === 'saveChanges') tx.entity('Owner').discard('o');
          }
          await tx.entity('Tag').create({ id: 'u' });
        });
        assert.equal(refused, 'JD2005', label);
        assert.deepEqual(canonicalRecords(seen), [['add /Tag/u {"id":"u"}']], label);
      }
      finally { await store.close(); }
    }
  });

  it('a create whose membership the database refuses records nothing, on either surface', async () => {
    for (const replicated of [false, true]) for (const surface of ['async', 'sync']) {
      const label = `${replicated ? 'replicated' : 'capture-only'} ${surface}`;
      const store = await openStore(restrictModel, { driver: nodeDriver(), capture: { mode: 'journal' },
        ...(replicated ? { replication: { replica: 'o' } } : {}) });
      try {
        await store.entity('Tag').create({ id: 't' });
        /** @type {any[]} */
        const seen = [];
        store.observe((record) => seen.push(record));
        let refused;
        // the row and its first join row are stored before the second join
        // row, which names no tag, is refused: all three go with the failure
        const doc = { id: 'o', tags: ['t', 'missing'] };
        if (surface === 'async') {
          await store.transaction(async (/** @type {any} */ tx) => {
            try { await tx.entity('Owner').create(doc); }
            catch (error) { refused = /** @type {any} */ (error).code; }
            await tx.entity('Tag').create({ id: 'u' });
          });
        }
        else {
          store.sync.transaction(() => {
            try { store.sync.entity('Owner').create(doc); }
            catch (error) { refused = /** @type {any} */ (error).code; }
            store.sync.entity('Tag').create({ id: 'u' });
          });
        }
        assert.equal(refused, 'JD2005', label);
        assert.deepEqual(canonicalRecords(seen), [['add /Tag/u {"id":"u"}']], label);
        assert.equal(await store.entity('Owner').get('o'), undefined, label);
      }
      finally { await store.close(); }
    }
  });

  it('a delete whose membership rows exceed replication capacity refuses before it runs', async () => {
    for (const memberships of [11, 12, 13]) {
      const store = await openStore(replicationModel, { driver: nodeDriver(), capture: { mode: 'journal' },
        replication: { replica: 'a', maxOperations: 12 } });
      try {
        await store.entity('Tag').create({ id: 't' });
        for (let i = 0; i < memberships; i++) await store.entity('Parent').create({ id: `p${i}`, tags: ['t'] });
        const state = await replicaState(store);
        const frontier = await store.replication.frontier();
        assert.deepEqual(frontier, { a: memberships + 1 });
        if (memberships === 11) {
          // the delete and its eleven memberships are the twelve operations the bound admits
          assert.equal(await store.entity('Tag').delete('t'), true);
          assert.equal((await store.replication.page({ after: memberships + 1 })).items[0].operations.length, 12);
          continue;
        }
        await assert.rejects(store.entity('Tag').delete('t'),
          { code: 'JD2106', reason: 'a cascading delete exceeds replication capacity' }, `${memberships}`);
        assert.deepEqual(await replicaState(store), state, `${memberships}: nothing changed`);
        assert.deepEqual(await store.replication.frontier(), frontier, `${memberships}: no envelope`);
      }
      finally { await store.close(); }
    }
  });

  it('a bounded closure counts a membership met from both endpoints once and reads every row up to the credit', async () => {
    // deleting `a` removes `b`, whose memberships are read once `a`'s were:
    // [a,b] again first, then the two the credit has to count
    const model = { $model: '0.1', entities: {
      A: { schema: { type: 'object', required: ['id'], properties: { id: key,
        kids: { 'x-entity': { relation: { to: 'B', many: true, via: 'aRef', onDelete: 'cascade' } } },
        bs: { 'x-entity': { relation: { to: 'B', many: true } } } } } },
      B: { schema: { type: 'object', required: ['id'], properties: { id: key, aRef: { type: ['string', 'null'] } } } },
    } };
    for (const maxOperations of [4, 5]) {
      const store = await openStore(model, { driver: nodeDriver(), capture: { mode: 'journal' },
        replication: { replica: 'a', maxOperations } });
      try {
        await store.entity('B').create({ id: 'b' });
        for (const id of ['a', 'x', 'y']) await store.entity('A').create({ id, bs: ['b'] });
        await store.entity('B').update('b', { aRef: 'a' });
        const frontier = await store.replication.frontier();
        // the root, `b` and three memberships
        if (maxOperations === 4) {
          await assert.rejects(store.entity('A').delete('a'),
            { code: 'JD2106', reason: 'a cascading delete exceeds replication capacity' });
          assert.deepEqual(await store.replication.frontier(), frontier);
          continue;
        }
        assert.equal(await store.entity('A').delete('a'), true);
        const [envelope] = (await store.replication.page({ after: frontier.a })).items;
        assert.deepEqual(envelope.operations.map((/** @type {any} */ op) => `${op.table}/${op.key}`),
          ['A/a', 'A_B/["a","b"]', 'A_B/["x","b"]', 'A_B/["y","b"]', 'B/b']);
      }
      finally { await store.close(); }
    }
  });

  it('each delete counts its own rows; the envelope of their transaction is bounded at commit', async () => {
    const store = await openStore(replicationModel, { driver: nodeDriver(), capture: { mode: 'journal' },
      replication: { replica: 'a', maxOperations: 12 } });
    try {
      await store.entity('Tag').create({ id: 't' });
      await store.entity('Tag').create({ id: 'u' });
      for (let i = 0; i < 6; i++) await store.entity('Parent').create({ id: `p${i}`, tags: ['t', 'u'] });
      const state = await replicaState(store);
      const frontier = await store.replication.frontier();
      // seven rows each, within the credit alone; fourteen together
      await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
        assert.equal(await tx.entity('Tag').delete('t'), true);
        assert.equal(await tx.entity('Tag').delete('u'), true);
      }), { code: 'JD2106', reason: 'replication operation bound exceeded' });
      assert.deepEqual(await replicaState(store), state);
      assert.deepEqual(await store.replication.frontier(), frontier);
    }
    finally { await store.close(); }
  });

  it('a tracked save records the stored row when a foreign-key action of its transaction changed it', async () => {
    // the tracked snapshot still names the member the delete's set-null key
    // nulled; a write through the unit of work would have refreshed it
    const variants = [
      ['direct delete', ['add /Note/n2/body "edited"', 'remove /Note/n2/parentId'], async (/** @type {any} */ tx) => {
        const note = await tx.entity('Note').get('n2');
        await tx.entity('Parent').delete('q');
        tx.entity('Note').put({ ...note, body: 'edited' });
        await tx.saveChanges();
      }],
      ['saved delete', ['add /Note/n2/body "edited"', 'remove /Note/n2/parentId'], async (/** @type {any} */ tx) => {
        const note = await tx.entity('Note').get('n2');
        tx.entity('Parent').remove('q');
        await tx.saveChanges();
        tx.entity('Note').put({ ...note, body: 'edited' });
        await tx.saveChanges();
      }],
    ];
    for (const [name, notes, write] of variants) {
      const records = await recordsPerMode((store) => store.transaction(write));
      assert.deepEqual(records.journal, records.session, `${name}`);
      assert.deepEqual(records.journal[0].filter((line) => line.includes('/Note/')), notes, `${name}`);
    }
  });

  it('a row several set-null keys name is one update without every nulled member', async () => {
    /** @type {Record<string, string[][]>} */
    const records = {};
    for (const mode of ['session', 'journal']) {
      const store = await openStore(nullingModel, { driver: nodeDriver(), capture: { mode } });
      try {
        await store.entity('Owner').create({ id: 'o' });
        await store.entity('Item').create({ id: 'i1', firstRef: 'o', secondRef: 'o' });
        await store.entity('Item').create({ id: 'i2', upRef: 'i1' });
        /** @type {any[]} */
        const seen = [];
        store.observe((record) => seen.push(record));
        await store.entity('Owner').delete('o');
        await store.entity('Item').delete('i1');
        records[mode] = canonicalRecords(seen);
      }
      finally { await store.close(); }
    }
    assert.deepEqual(records.journal, records.session);
    assert.deepEqual(records.journal, [
      ['remove /Item/i1/firstRef', 'remove /Item/i1/secondRef', 'remove /Owner/o'],
      ['remove /Item/i1', 'remove /Item/i2/upRef'],
    ]);
  });

  it('a cascade inside a rolled-back savepoint records nothing', async () => {
    const store = await openStore(cascadeModel(), { driver: nodeDriver(), capture: { mode: 'journal' } });
    try {
      await seedCascade(store);
      /** @type {any[]} */
      const seen = [];
      store.observe((record) => seen.push(record));
      await store.transaction(async (/** @type {any} */ tx) => {
        await assert.rejects(tx.transaction(async (/** @type {any} */ inner) => {
          await inner.entity('Parent').delete('p');
          throw new Error('undone');
        }), /undone/);
        await tx.entity('Tag').create({ id: 'u' });
      });
      assert.deepEqual(canonicalRecords(seen), [['add /Tag/u {"id":"u"}']]);
      assert.equal((await store.entity('Child').get('c1'))?.parentId, 'p');
    }
    finally { await store.close(); }
  });

  it('a bounded closure counts a row met through two foreign keys once and reads every row up to the credit', async () => {
    const { createCascadeClosure } = await import('../../packages/db/src/cascade.js');
    const temp = tempDbPath();
    let connection;
    try {
      const store = await openStore(diamondModel, { driver: nodeDriver(), path: temp.dbPath });
      try {
        await store.entity('Hub').create({ id: 'h' });
        // the row both foreign keys name sorts and is stored first, so a read
        // limited to the credit alone would meet it again and stop short of `c`
        await store.entity('Spoke').create({ id: 'a', looseRef: 'h', tightRef: 'h' });
        await store.entity('Spoke').create({ id: 'b', tightRef: 'h' });
        await store.entity('Spoke').create({ id: 'c', tightRef: 'h' });
      }
      finally { await store.close(); }
      connection = await nodeDriver().open(temp.dbPath);
      const { entities, mapping } = compileEntityModel(diamondModel);
      /** @type {Map<string, any>} */
      const cores = new Map();
      const entityCoreFor = (/** @type {string} */ name) => {
        if (!cores.has(name)) cores.set(name, entityCore(connection, entities.get(name), mapping.entities[name], null));
        return cores.get(name);
      };
      const predict = (/** @type {any} */ bound) =>
        createCascadeClosure({ connection, mapping, entityCoreFor, bound }).predict('Hub', ['h']);
      const unbounded = predict(null);
      assert.deepEqual(unbounded.root, { id: 'h' });
      // nulled through `looseRef`, then removed through `tightRef`: removed, once
      assert.deepEqual(unbounded.entries.map((/** @type {any} */ entry) => [entry.table, entry.keyParts, entry.after]),
        [['Spoke', ['a'], null], ['Spoke', ['b'], null], ['Spoke', ['c'], null]]);
      const bytes = [unbounded.root, ...unbounded.entries.map((/** @type {any} */ entry) => entry.before)]
        .reduce((sum, doc) => sum + Buffer.byteLength(JSON.stringify(doc)), 0);
      const exceeds = { code: 'JD2106', reason: 'a cascading delete exceeds replication capacity' };
      // the root and three rows: exactly at either credit passes, one below refuses
      assert.deepEqual(predict({ maxOperations: 4, maxBytes: bytes }), unbounded);
      assert.throws(() => predict({ maxOperations: 3, maxBytes: bytes }), exceeds);
      assert.throws(() => predict({ maxOperations: 4, maxBytes: bytes - 1 }), exceeds);
    }
    finally {
      await connection?.close();
      temp.cleanup();
    }
  });
});
