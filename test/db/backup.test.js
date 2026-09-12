//@ts-check
/**
 * @file Online backup with atomic publication: `backupTo` copies a
 * live store — writers proceeding meanwhile — and publishes the copy by
 * rename, so the target path never holds a partial file and a
 * cancelled or failed backup leaves neither the target nor its
 * temporary sibling behind. Node online backups and Bun serialized
 * snapshots share the publisher; bindings without either refuse by code.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { openStore, sqliteDialect } from '@jarenjs/db';
import { nodeDriver, adaptNodeDatabase } from '@jarenjs/db/node';
import { wasmDriver } from '@jarenjs/db/wasm';
import { temporaryPathFor } from '../../packages/db/src/backup.js';

import { BunShapedDatabase, declaringWasmHandle, tempDbPath } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    notes: {
      schema: { type: 'object', properties: { id: { type: 'string' }, body: { type: 'string' } } },
      key: '/id',
    },
  },
};

/** A store on a WAL file with `n` committed documents of ~400 bytes. */
async function seeded(dbPath, n, options = {}) {
  const store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath, ...options });
  const notes = store.collection('notes');
  for (let i = 0; i < n; i++) await notes.insert({ id: `n${i}`, body: 'x'.repeat(400) });
  return store;
}

/** The temporary siblings of a target path that still exist. */
const siblings = (targetPath) => fs.readdirSync(path.dirname(targetPath))
  .filter((name) => name.startsWith(`${path.basename(targetPath)}.jaren-tmp-`));

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Every committed document id of a backup file, read through a fresh store. */
async function idsOf(file) {
  const store = await openStore(MODEL, { driver: nodeDriver(), path: file, readOnly: true });
  const ids = [];
  for await (const doc of store.collection('notes').query({ $for: { it: '$[*]' }, $return: '$it.id' })) ids.push(doc);
  await store.close();
  return ids.sort();
}

describe('the capability', () => {
  it('the node driver declares backup; bindings without a snapshot primitive refuse JD2077', async () => {
    const node = await openStore(MODEL, { driver: nodeDriver() });
    assert.strictEqual(node.capabilities.maintenance.backup, true);
    assert.strictEqual(typeof node.backupTo, 'function');
    await node.transaction(async (tx) => { assert.strictEqual(tx.backupTo, undefined); });
    await node.close();
    const others = [
      wasmDriver(declaringWasmHandle({ userFunctions: true })),
      { name: 'bun-sqlite', dialect: sqliteDialect, open: (dbPath) => adaptBun(dbPath) },
    ];
    for (const driver of others) {
      const store = await openStore(MODEL, { driver });
      assert.strictEqual(store.capabilities.maintenance.backup, false, driver.name);
      await assert.rejects(store.backupTo('/tmp/never-written.db'),
        (error) => error.code === 'JD2077' && error.message.includes('backupTo'), driver.name);
      await store.close();
    }
  });
});

/** The bun adapter over the bun-shaped double, as the packed gate runs it. */
async function adaptBun(dbPath) {
  const { adaptBunDatabase } = await import('@jarenjs/db/bun');
  return adaptBunDatabase(new BunShapedDatabase(dbPath));
}

describe('a complete backup', () => {
  it('copies a live store with writers proceeding, publishes atomically, and the copy opens with every committed document', async () => {
    const source = tempDbPath();
    const target = tempDbPath();
    try {
      const store = await seeded(source.dbPath, 400);
      const events = [];
      let writesDuring = 0;
      const notes = store.collection('notes');
      // writers keep going while the copy runs: each progress event
      // lands another committed document
      const result = await store.backupTo(target.dbPath, {
        rate: 8,
        onProgress: (progress) => {
          events.push(progress);
          writesDuring++;
          void notes.insert({ id: `during-${writesDuring}`, body: 'y'.repeat(400) });
        },
      });
      assert.strictEqual(result.path, target.dbPath);
      assert.ok(result.pages > 0);
      assert.deepStrictEqual(Object.keys(result.checkpoint).sort(), ['busy', 'checkpointedFrames', 'logFrames']);
      assert.ok(events.length > 1, 'progress was reported');
      for (const event of events) {
        assert.deepStrictEqual(Object.keys(event).sort(), ['remainingPages', 'totalPages']);
        assert.ok(event.remainingPages >= 0 && event.remainingPages < event.totalPages);
      }
      assert.deepStrictEqual(siblings(target.dbPath), []);
      assert.ok(fs.existsSync(target.dbPath));
      // let the in-flight writers land, then compare: the backup holds
      // every document committed BEFORE the copy completed, and is a
      // valid store on its own
      await store.checkpoint();
      const ids = await idsOf(target.dbPath);
      assert.ok(ids.length >= 400, `${ids.length} documents in the backup`);
      for (let i = 0; i < 400; i++) assert.ok(ids.includes(`n${i}`), `n${i}`);
      const copy = new DatabaseSync(target.dbPath, { readOnly: true });
      assert.strictEqual(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      copy.close();
      await store.close();
    }
    finally {
      source.cleanup();
      target.cleanup();
    }
  });

  it('two-run: two sequential backups of an unchanged store are byte-identical', async () => {
    const source = tempDbPath();
    const target = tempDbPath();
    try {
      const store = await seeded(source.dbPath, 50);
      const a = path.join(path.dirname(target.dbPath), 'a.db');
      const b = path.join(path.dirname(target.dbPath), 'b.db');
      const first = await store.backupTo(a);
      const second = await store.backupTo(b);
      assert.strictEqual(first.pages, second.pages);
      assert.strictEqual(sha256(a), sha256(b));
      assert.deepStrictEqual(siblings(a), []);
      // an existing target is replaced only at verified completion
      const third = await store.backupTo(a);
      assert.strictEqual(third.pages, first.pages);
      assert.strictEqual(sha256(a), sha256(b));
      await store.close();
    }
    finally {
      source.cleanup();
      target.cleanup();
    }
  });

  it('checkpoint: false skips the boundary and reports null; a read-only source skips it by default', async () => {
    const source = tempDbPath();
    const target = tempDbPath();
    try {
      const writer = await seeded(source.dbPath, 20);
      const skipped = await writer.backupTo(target.dbPath, { checkpoint: false });
      assert.strictEqual(skipped.checkpoint, null);
      await assert.rejects(writer.backupTo(target.dbPath, { checkpoint: /** @type {any} */ ('bogus') }), TypeError);
      await writer.close();
      const reader = await openStore(MODEL, { driver: nodeDriver(), path: source.dbPath, readOnly: true });
      assert.strictEqual(reader.capabilities.maintenance.backup, true);
      const fromReader = await reader.backupTo(target.dbPath);
      assert.strictEqual(fromReader.checkpoint, null);
      await assert.rejects(reader.backupTo(target.dbPath, { checkpoint: 'passive' }),
        (error) => error.code === 'JD2077');
      await reader.close();
      assert.deepStrictEqual(await idsOf(target.dbPath), Array.from({ length: 20 }, (_, i) => `n${i}`).sort());
    }
    finally {
      source.cleanup();
      target.cleanup();
    }
  });

  it('refuses a bad target path or rate before touching the file system', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    await assert.rejects(store.backupTo(''), TypeError);
    await assert.rejects(store.backupTo(/** @type {any} */ (null)), TypeError);
    await assert.rejects(store.backupTo('/tmp/x.db', { rate: 0 }), TypeError);
    await assert.rejects(store.backupTo('/tmp/x.db', { onProgress: /** @type {any} */ ('no') }), TypeError);
    await store.close();
  });
});

describe('killed mid-flight (D4)', () => {
  it('a backup cancelled from its first progress event rejects JD2079 and leaves no target and no temporary file', async () => {
    const source = tempDbPath();
    const target = tempDbPath();
    try {
      const store = await seeded(source.dbPath, 400);
      const controller = new AbortController();
      let events = 0;
      await assert.rejects(store.backupTo(target.dbPath, {
        rate: 4,
        signal: controller.signal,
        onProgress: () => { events++; controller.abort(new Error('operator stop')); },
      }), (error) => error.code === 'JD2079' && error.cause?.message === 'operator stop');
      assert.ok(events >= 1 && events <= 2, `${events} events before the cancellation took`);
      assert.strictEqual(fs.existsSync(target.dbPath), false);
      assert.deepStrictEqual(siblings(target.dbPath), []);
      // an already-aborted signal refuses before any file exists
      await assert.rejects(store.backupTo(target.dbPath, { signal: AbortSignal.abort() }),
        (error) => error.code === 'JD2079');
      assert.deepStrictEqual(siblings(target.dbPath), []);
      // and the store is unharmed: a later backup completes
      const result = await store.backupTo(target.dbPath);
      assert.ok(result.pages > 0);
      await store.close();
    }
    finally {
      source.cleanup();
      target.cleanup();
    }
  });

  it('a failed copy (unwritable destination) leaves no target and no temporary file, JD2078 with cause', async () => {
    const source = tempDbPath();
    try {
      const store = await seeded(source.dbPath, 10);
      const missing = path.join(source.dbPath + '-no-such-dir', 'backup.db');
      await assert.rejects(store.backupTo(missing),
        (error) => error.code === 'JD2078' && error.cause !== undefined);
      assert.strictEqual(fs.existsSync(missing), false);
      assert.strictEqual(fs.existsSync(path.dirname(missing)), false);
      await store.close();
    }
    finally {
      source.cleanup();
    }
  });

  it('a failed publication (rename refused) removes the temporary file and keeps the old target intact', async () => {
    const source = tempDbPath();
    const target = tempDbPath();
    try {
      // a driver whose rename fails: the copy is real, the publication is not
      const db = new DatabaseSync(source.dbPath);
      let renames = 0;
      const driver = {
        name: 'node-sqlite', dialect: sqliteDialect,
        open: async () => {
          const sqlite = await import('node:sqlite');
          const fsp = await import('node:fs/promises');
          return adaptNodeDatabase(db, { backup: {
            copy: (file, o) => sqlite.backup(db, file, o),
            rename: () => { renames++; return Promise.reject(new Error('EACCES: publication refused')); },
            remove: (file) => fsp.rm(file, { force: true }),
          } });
        },
      };
      const store = await openStore(MODEL, { driver, path: source.dbPath });
      fs.writeFileSync(target.dbPath, 'previous contents');
      await assert.rejects(store.backupTo(target.dbPath),
        (error) => error.code === 'JD2078' && /publication refused/.test(error.cause?.message));
      assert.strictEqual(renames, 1);
      assert.strictEqual(fs.readFileSync(target.dbPath, 'utf8'), 'previous contents');
      assert.deepStrictEqual(siblings(target.dbPath), []);
      await store.close();
    }
    finally {
      source.cleanup();
      target.cleanup();
    }
  });

  it('a removal that itself fails rides along as cleanupError rather than replacing the reason', async () => {
    const source = tempDbPath();
    const target = tempDbPath();
    try {
      const db = new DatabaseSync(source.dbPath);
      const driver = {
        name: 'node-sqlite', dialect: sqliteDialect,
        open: async () => {
          const sqlite = await import('node:sqlite');
          return adaptNodeDatabase(db, { backup: {
            copy: (file, o) => sqlite.backup(db, file, o),
            rename: () => Promise.reject(new Error('rename refused')),
            remove: () => Promise.reject(new Error('remove refused')),
          } });
        },
      };
      const store = await openStore(MODEL, { driver, path: source.dbPath });
      await assert.rejects(store.backupTo(target.dbPath),
        (error) => error.code === 'JD2078' && /rename refused/.test(error.cause?.message)
          && /remove refused/.test(error.cleanupError?.message));
      await store.close();
    }
    finally {
      source.cleanup();
      target.cleanup();
    }
  });
});

describe('the temporary path', () => {
  it('is a same-directory sibling named from the injected randomness', () => {
    let n = 0;
    const random = () => (++n) / 10;
    const tmp = temporaryPathFor('/data/store.db', random);
    assert.strictEqual(path.dirname(tmp), '/data');
    assert.match(path.basename(tmp), /^store\.db\.jaren-tmp-[0-9a-f]{16}$/);
    assert.strictEqual(n, 2);
  });
});


it('the Bun disk snapshot adapter never serializes and removes a cancelled temporary', async () => {
  const { fromBunModule } = await import('@jarenjs/db/bun');
  const source = tempDbPath(), destination = tempDbPath();
  let store;
  try {
    const seed = await seeded(source.dbPath, 2); await seed.close();
    // Any use of the unbounded serialization path must fail this test.
    class SerializedDatabase extends BunShapedDatabase {
      serialize() { throw new Error('unbounded serialization'); }
    }
    const driver = { name: 'bun-serialized-double', dialect: sqliteDialect,
      open: (file) => fromBunModule({ Database: SerializedDatabase }, file) };
    store = await openStore(MODEL, { driver, path: source.dbPath });
    assert.equal(store.capabilities.maintenance.backup, true);
    await store.backupTo(destination.dbPath, { checkpoint: false });
    assert.deepEqual(await idsOf(destination.dbPath), ['n0', 'n1']);
    const hash = sha256(destination.dbPath);
    const abort = new AbortController();
    await assert.rejects(store.backupTo(destination.dbPath, { checkpoint: false, signal: abort.signal,
      onProgress: (progress) => { if (progress.remainingPages === 0) abort.abort(); },
    }), { code: 'JD2079' });
    assert.equal(sha256(destination.dbPath), hash);
    assert.deepEqual(siblings(destination.dbPath), []);
  }
  finally { await store?.close(); source.cleanup(); destination.cleanup(); }
});
