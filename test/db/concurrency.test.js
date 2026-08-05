//@ts-check
/**
 * @file Optimistic concurrency: the `version: true` vocabulary, the
 * engine-owned bump on both write modes, `JD2040` when a rival store
 * changes (or deletes) the row under a save, tracker-unchanged
 * failure semantics with discard-and-retry recovery, and the honest
 * capability flag when no version property exists.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore, normalizeEntities } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { tempDbPath } from './helpers.js';

const VERSIONED = {
  $model: '0.1',
  entities: {
    Doc: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', 'x-entity': { key: true } },
          body: { type: 'string' },
          rev: { type: 'integer', 'x-entity': { version: true } },
        },
      },
    },
  },
};
const PLAIN = {
  $model: '0.1',
  entities: {
    Note: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', 'x-entity': { key: true } },
          body: { type: 'string' },
        },
      },
    },
  },
};

describe('the version vocabulary', () => {
  it('a version property is a plain integer column, one per entity', () => {
    const bad = (properties) => ({
      $model: '0.1',
      entities: { E: { schema: { type: 'object', properties } } },
    });
    assert.throws(() => normalizeEntities(bad({
      id: { type: 'string', 'x-entity': { key: true } },
      rev: { type: 'string', 'x-entity': { version: true } },
    })), (error) => /** @type {any} */ (error).code === 'JD0005');
    assert.throws(() => normalizeEntities(bad({
      id: { type: 'integer', 'x-entity': { key: true, version: true } },
    })), (error) => /** @type {any} */ (error).code === 'JD0005');
    assert.throws(() => normalizeEntities(bad({
      id: { type: 'string', 'x-entity': { key: true } },
      a: { type: 'integer', 'x-entity': { version: true } },
      b: { type: 'integer', 'x-entity': { version: true } },
    })), (error) => /** @type {any} */ (error).code === 'JD0005');
    const ok = normalizeEntities(VERSIONED);
    assert.strictEqual(ok.get('Doc').version, 'rev');
  });
});

describe('the bump and the conflict', () => {
  it('both write modes move the token; saveChanges guards with it', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(VERSIONED, { driver: nodeDriver(), path: dbPath });
      const docs = store.entity('Doc');
      await docs.create({ id: 'd1', body: 'a', rev: 0 });
      const updated = await docs.update('d1', { body: 'b' });
      assert.strictEqual(updated.rev, 1, 'the explicit mode bumps too');
      const read = await docs.get('d1');
      docs.put({ ...read, body: 'c' });
      const report = await store.saveChanges();
      assert.strictEqual(report.concurrency.checked, 1);
      assert.deepStrictEqual(report.concurrency.unversioned, []);
      assert.strictEqual((await docs.asNoTracking().get('d1')).rev, 2);
      await store.close();
    }
    finally {
      cleanup();
    }
  });

  it('a rival write surfaces as JD2040; the tracker survives for a retry', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(VERSIONED, { driver: nodeDriver(), path: dbPath });
      const docs = store.entity('Doc');
      await docs.create({ id: 'd1', body: 'a', rev: 0 });
      const mine = await docs.get('d1');

      const rival = await openStore(VERSIONED, { driver: nodeDriver(), path: dbPath });
      await rival.entity('Doc').update('d1', { body: 'rival' });
      await rival.close();

      docs.put({ ...mine, body: 'mine' });
      const failing = () => store.saveChanges();
      await assert.rejects(failing, (error) => {
        assert.strictEqual(/** @type {any} */ (error).code, 'JD2040');
        assert.strictEqual(/** @type {any} */ (error).collection, 'Doc');
        assert.strictEqual(/** @type {any} */ (error).key, 'd1');
        return true;
      });
      // the tracker is exactly as it was: the same save fails the same way
      await assert.rejects(failing,
        (error) => /** @type {any} */ (error).code === 'JD2040');
      assert.strictEqual((await docs.asNoTracking().get('d1')).body, 'rival',
        'nothing half-applied');

      // recovery: discard, re-read, reapply
      docs.discard('d1');
      const fresh = await docs.get('d1');
      docs.put({ ...fresh, body: 'mine, rebased' });
      const report = await store.saveChanges();
      assert.strictEqual(report.updated, 1);
      assert.strictEqual((await docs.asNoTracking().get('d1')).body, 'mine, rebased');
      await store.close();
    }
    finally {
      cleanup();
    }
  });

  it('a guarded delete conflicts too; a rival hard-delete conflicts an update', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(VERSIONED, { driver: nodeDriver(), path: dbPath });
      const docs = store.entity('Doc');
      await docs.create({ id: 'd1', body: 'a', rev: 0 });
      await docs.get('d1');
      const rival = await openStore(VERSIONED, { driver: nodeDriver(), path: dbPath });
      await rival.entity('Doc').update('d1', { body: 'rival' });
      docs.remove('d1');
      await assert.rejects(() => store.saveChanges(),
        (error) => /** @type {any} */ (error).code === 'JD2040');

      // the row vanishing entirely conflicts an update as well
      const fresh = await rival.entity('Doc').get('d1');
      await rival.entity('Doc').delete('d1');
      await rival.close();
      const other = await openStore(VERSIONED, { driver: nodeDriver(), path: dbPath });
      assert.strictEqual(await other.entity('Doc').get('d1'), undefined);
      await other.close();
      assert.ok(fresh.rev >= 1);
      await store.close();
    }
    finally {
      cleanup();
    }
  });

  it('without a version property the capability flag says so', async () => {
    const store = await openStore(PLAIN, { driver: nodeDriver() });
    const notes = store.entity('Note');
    await notes.create({ id: 'n1', body: 'a' });
    const read = await notes.get('n1');
    notes.put({ ...read, body: 'b' });
    const report = await store.saveChanges();
    assert.strictEqual(report.concurrency.checked, 0);
    assert.deepStrictEqual(report.concurrency.unversioned, ['Note'],
      'last-write-wins, named, never silent');
    // an unguarded delete of a missing row is a no-op, not an error
    notes.remove('ghost');
    const second = await store.saveChanges();
    assert.strictEqual(second.deleted, 0);
    await store.close();
  });
});
