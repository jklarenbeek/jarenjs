//@ts-check
/**
 * @file Online backup with atomic publication: `backupTo` copies a
 * live store page by page and publishes the copy by rename, so the
 * target path never holds a partial file, a target whose write-ahead log
 * or rollback journal is not empty is never replaced, and a cancelled or
 * failed backup leaves neither the target nor its temporary sibling (nor
 * that sibling's journal) behind. The Node and Bun bindings share the
 * publisher and one progress contract — no event after the final step,
 * none repeated; bindings without a backup primitive refuse by code.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { openStore, sqliteDialect } from '@jarenjs/db';
import { nodeDriver, adaptNodeDatabase } from '@jarenjs/db/node';
import { fromBunModule } from '@jarenjs/db/bun';
import { wasmDriver } from '@jarenjs/db/wasm';
import { temporaryPathFor } from '../../packages/db/src/backup.js';

import { BunShapedDatabase, declaringWasmHandle, tempDbPath } from './helpers.js';
import { assertCrash } from './fixtures/abrupt-exit.js';

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

/** Commit `n` documents of `size` characters in one transaction. */
async function fill(store, n, size) {
  await store.transaction(async (tx) => {
    const notes = tx.collection('notes');
    for (let i = 0; i < n; i++) await notes.insert({ id: `n${i}`, body: 'x'.repeat(size) });
  });
}

/** The Bun driver's own open path, `fromBunModule`, over the bun-shaped double. */
const bunDouble = (Database = BunShapedDatabase) => ({
  name: 'bun-sqlite-double', dialect: sqliteDialect,
  open: (/** @type {string} */ file) => fromBunModule({ Database }, file),
});

/** The tables a database file opens with, through whatever log sits beside it. */
const tablesOf = (file) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map((row) => row.name); }
  finally { db.close(); }
};

/** The descriptors this process holds on a database file and its side
 * files, where `/proc/self/fd` lists them; `null` elsewhere. While another
 * connection in the process holds locks on the file, SQLite parks a closed
 * connection's descriptor for the next open to reuse — count from after a
 * first copy. */
const descriptorsOn = (file) => {
  const fds = '/proc/self/fd';
  if (!fs.existsSync(fds)) return null;
  return fs.readdirSync(fds).filter((fd) => {
    try {
      const link = fs.readlinkSync(path.join(fds, fd));
      return link === file || link.startsWith(`${file}-`);
    }
    catch { return false; }
  }).length;
};

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const bunVersion = spawnSync('bun', ['--version'], { encoding: 'utf8' });
const bunMissing = bunVersion.error !== undefined || bunVersion.status !== 0;

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
    // a path that begins `file:` would reach SQLite as a URI naming
    // another file than the one published
    await assert.rejects(store.backupTo('file:copy.db'), TypeError);
    await store.close();
  });

  it('an abort raised while the backup waits for the store gate leaves the queue: JD2079, nothing written', async () => {
    for (const checkpoint of [false, 'passive']) {
      const source = tempDbPath();
      const target = tempDbPath();
      try {
        const store = await seeded(source.dbPath, 20, { queueTimeout: 400 });
        let release;
        const released = new Promise((resolve) => { release = resolve; });
        let entered;
        const holding = new Promise((resolve) => { entered = resolve; });
        const transaction = store.transaction(async () => { entered(); await released; });
        await holding;
        const controller = new AbortController();
        const backup = store.backupTo(target.dbPath, { checkpoint: /** @type {any} */ (checkpoint), signal: controller.signal });
        controller.abort(new Error('operator stop'));
        // settled while the transaction still holds the gate
        const error = await backup.then(() => null, (failure) => failure);
        release();
        await transaction;
        assert.strictEqual(error?.code, 'JD2079', `checkpoint ${checkpoint}: ${error?.code} ${error?.message}`);
        assert.strictEqual(error.cause?.message, 'operator stop');
        assert.strictEqual(fs.existsSync(target.dbPath), false);
        assert.deepStrictEqual(siblings(target.dbPath), []);
        await store.close();
      }
      finally {
        source.cleanup();
        target.cleanup();
      }
    }
  });
});

describe('killed mid-flight', () => {
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

describe('publication and cleanup', () => {
  it('a write-ahead log with frames or a hot journal at the target refuses publication and leaves both untouched', async () => {
    for (const mode of ['wal', 'journal']) {
      for (const driver of [nodeDriver(), bunDouble()]) {
        const what = `${driver.name}, ${mode}`;
        const side = `${mode === 'wal' ? '-wal' : '-journal'}`;
        const source = tempDbPath();
        const target = tempDbPath();
        try {
          // a writer that crashed with its log unmerged: SQLite would replay
          // that log into whatever file is renamed onto the path
          assertCrash(spawnSync(process.execPath, [fixture('crashed-writer.mjs'), target.dbPath, mode], { encoding: 'utf8' }),
            `crashed-${mode}`);
          assert.ok(fs.statSync(`${target.dbPath}${side}`).size > 0, what);
          const store = await seeded(source.dbPath, 20, { driver });
          const before = {
            target: sha256(target.dbPath), side: sha256(`${target.dbPath}${side}`),
            listing: fs.readdirSync(path.dirname(target.dbPath)).sort(),
          };
          const error = await store.backupTo(target.dbPath).then(() => null, (failure) => failure);
          if (error === null)
            assert.fail(`${what}: published beside a stale log; the target opens with tables ${tablesOf(target.dbPath)}`);
          assert.strictEqual(error.code, 'JD2078', what);
          assert.ok(error.message.includes(side), what);
          assert.strictEqual(sha256(target.dbPath), before.target, what);
          assert.strictEqual(sha256(`${target.dbPath}${side}`), before.side, what);
          assert.deepStrictEqual(siblings(target.dbPath), [], what);
          assert.deepStrictEqual(fs.readdirSync(path.dirname(target.dbPath)).sort(), before.listing, what);
          await store.close();
        }
        finally {
          source.cleanup();
          target.cleanup();
        }
      }
    }
  });

  it('a journal a clean close left beside the target does not block publication', async () => {
    const source = tempDbPath();
    const target = tempDbPath();
    try {
      // persist mode keeps the journal file after every commit, its header
      // zeroed: SQLite never replays it
      const previous = new DatabaseSync(target.dbPath);
      previous.exec('PRAGMA journal_mode=PERSIST; CREATE TABLE other(x); INSERT INTO other VALUES (1)');
      previous.close();
      assert.ok(fs.statSync(`${target.dbPath}-journal`).size > 0);
      const store = await seeded(source.dbPath, 5);
      await store.backupTo(target.dbPath);
      await store.close();
      assert.deepStrictEqual(await idsOf(target.dbPath), ['n0', 'n1', 'n2', 'n3', 'n4']);
    }
    finally {
      source.cleanup();
      target.cleanup();
    }
  });

  it('a full disk leaves no temporary file and no journal beside the target',
    { skip: process.platform === 'win32' ? 'no file-size limit on Windows' : false }, async (t) => {
      const source = tempDbPath();
      const target = tempDbPath();
      try {
        const store = await openStore(MODEL, { driver: nodeDriver(), path: source.dbPath });
        await fill(store, 3000, 4000);
        await store.checkpoint({ mode: 'truncate' });
        await store.close();
        // the copy needs about 12 MiB; the limit allows 2 to 4, by shell
        const runtimes = [['node', process.versions.bun ? 'node' : process.execPath]];
        if (bunMissing) t.diagnostic('the Bun leg is skipped: bun is not on PATH');
        else runtimes.push(['bun', process.versions.bun ? process.execPath : 'bun']);
        for (const [name, runtime] of runtimes) {
          const run = spawnSync('/bin/sh', ['-c', 'ulimit -f 4096 && exec "$0" "$@"', runtime,
            fixture('backup-full-disk.mjs'), source.dbPath, target.dbPath], { encoding: 'utf8', cwd: repositoryRoot });
          assert.strictEqual(run.status, 0, `${name}: ${run.stderr}`);
          const report = JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}');
          assert.deepStrictEqual(report, { code: 'JD2078', cleanupError: null, siblings: [] }, name);
        }
      }
      finally {
        source.cleanup();
        target.cleanup();
      }
    });

  it('a store closed during the copy rejects JD2063 and removes its temporary file', async () => {
    for (const driver of [nodeDriver(), bunDouble()]) {
      const source = tempDbPath();
      const target = tempDbPath();
      try {
        const store = await seeded(source.dbPath, 400, { driver });
        let events = 0;
        let closing;
        const error = await store.backupTo(target.dbPath, {
          rate: 4, onProgress: () => { if (++events === 2) closing = store.close(); },
        }).then(() => null, (failure) => failure);
        assert.strictEqual(error?.code, 'JD2063', driver.name);
        assert.strictEqual(error.cleanupError, undefined, driver.name);
        assert.deepStrictEqual(siblings(target.dbPath), [], driver.name);
        assert.strictEqual(fs.existsSync(target.dbPath), false, driver.name);
        await closing;
      }
      finally {
        source.cleanup();
        target.cleanup();
      }
    }
  });
});

describe('one progress contract', () => {
  it('a copy started while a store transaction holds a write waits for it instead of failing', async () => {
    const source = tempDbPath();
    const target = tempDbPath();
    try {
      const store = await seeded(source.dbPath, 300);
      let release;
      const released = new Promise((resolve) => { release = resolve; });
      let inserted;
      const holding = new Promise((resolve) => { inserted = resolve; });
      const transaction = store.transaction(async (tx) => {
        await tx.collection('notes').insert({ id: 'held', body: 'h' });
        inserted();
        await released;
      });
      await holding;
      const backup = store.backupTo(target.dbPath, { rate: 20, checkpoint: false });
      setTimeout(release, 30);
      const error = await backup.then(() => null, (failure) => failure);
      await transaction;
      assert.strictEqual(error, null, `${error?.code}: ${error?.message} (cause: ${error?.cause?.message})`);
      assert.ok((await idsOf(target.dbPath)).includes('held'));
      assert.deepStrictEqual(siblings(target.dbPath), []);
      await store.close();
    }
    finally {
      source.cleanup();
      target.cleanup();
    }
  });

  it('a busy source repeats no progress event', async () => {
    const source = tempDbPath();
    const target = tempDbPath();
    try {
      const store = await openStore(MODEL, { driver: nodeDriver(), path: source.dbPath });
      await fill(store, 1500, 2000);
      const events = [];
      let writer;
      // a write held mid-copy: every step that meets it is reported again
      // by the platform with the same pair
      const result = await store.backupTo(target.dbPath, {
        rate: 20,
        onProgress: (event) => {
          events.push(event);
          if (events.length === 2) {
            writer = store.transaction(async (tx) => {
              await tx.collection('notes').insert({ id: 'during', body: 'd' });
              await new Promise((resolve) => setTimeout(resolve, 40));
            });
          }
        },
      });
      await writer;
      const repeats = events.filter((event, i) => i > 0 && event.totalPages === events[i - 1].totalPages
        && event.remainingPages === events[i - 1].remainingPages).length;
      assert.strictEqual(repeats, 0, `${repeats} of ${events.length} events repeat the one before`);
      assert.ok(result.pages > 0);
      assert.deepStrictEqual(siblings(target.dbPath), []);
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


describe('the Bun binding', () => {
  it('the Bun adapter copies pages through a dedicated read-only connection: progress between steps and an in-callback abort', async () => {
    const source = tempDbPath(), destination = tempDbPath();
    let store;
    try {
      const seed = await seeded(source.dbPath, 400); await seed.close();
      // Any use of the unbounded serialization path must fail this test.
      class SerializedDatabase extends BunShapedDatabase {
        serialize() { throw new Error('unbounded serialization'); }
      }
      store = await openStore(MODEL, { driver: bunDouble(SerializedDatabase), path: source.dbPath });
      assert.equal(store.capabilities.maintenance.backup, true);
      const events = [];
      const full = await store.backupTo(destination.dbPath, { rate: 4, checkpoint: false, onProgress: (event) => events.push(event) });
      const steady = descriptorsOn(source.dbPath);
      assert.strictEqual(events.length, Math.ceil(full.pages / 4) - 1, JSON.stringify(events.slice(0, 3)));
      assert.ok(events.every((event) => event.remainingPages >= 1));
      assert.deepEqual(await idsOf(destination.dbPath), Array.from({ length: 400 }, (_, i) => `n${i}`).sort());
      const hash = sha256(destination.dbPath);
      const abort = new AbortController();
      let calls = 0;
      await assert.rejects(store.backupTo(destination.dbPath, { rate: 4, checkpoint: false, signal: abort.signal,
        onProgress: () => { if (++calls === 3) abort.abort(); },
      }), { code: 'JD2079' });
      assert.strictEqual(calls, 3);
      assert.equal(sha256(destination.dbPath), hash);
      assert.deepEqual(siblings(destination.dbPath), []);
      // each copy's connection is gone with it: no descriptor accumulates
      // on the source (counted where /proc/self/fd lists them)
      assert.strictEqual(descriptorsOn(source.dbPath), steady, 'a copy left its connection open on the source');
    }
    finally { await store?.close(); source.cleanup(); destination.cleanup(); }
  });

  it('a Bun backup settles while timers never fire', async () => {
    const source = tempDbPath(), destination = tempDbPath();
    const timers = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval, setImmediate: globalThis.setImmediate };
    let store;
    let watchdog;
    try {
      store = await openStore(MODEL, { driver: bunDouble(), path: source.dbPath });
      await fill(store, 40, 400);
      // a fake clock that is never advanced: no timer callback runs
      const never = /** @type {any} */ (() => ({ ref() { return this; }, unref() { return this; } }));
      Object.assign(globalThis, { setTimeout: never, setInterval: never, setImmediate: never });
      const watched = new Promise((resolve) => { watchdog = timers.setTimeout(() => resolve('never settled'), 5000); });
      const outcome = await Promise.race([
        store.backupTo(destination.dbPath, { checkpoint: false }).then(() => 'settled', (error) => error.code), watched]);
      assert.strictEqual(outcome, 'settled');
      Object.assign(globalThis, timers);
      assert.deepStrictEqual(await idsOf(destination.dbPath), Array.from({ length: 40 }, (_, i) => `n${i}`).sort());
      await store.close();
    }
    finally {
      Object.assign(globalThis, timers);
      clearTimeout(watchdog);
      source.cleanup();
      destination.cleanup();
    }
  });

  it('under Bun: progress, cancellation, cleanup, point-in-time and page identity of a file backup',
    { skip: process.versions.bun ? 'already running under Bun' : bunMissing ? 'bun is not on PATH' : false }, () => {
      const scratch = tempDbPath();
      try {
        const run = spawnSync('bun', [fixture('backup-bun.mjs'), path.dirname(scratch.dbPath)],
          { encoding: 'utf8', cwd: repositoryRoot });
        assert.strictEqual(run.status, 0, run.stderr || String(run.error));
        const report = JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}');
        assert.strictEqual(report.full.events, Math.ceil(report.full.pages / 100) - 1, JSON.stringify(report.full));
        assert.strictEqual(report.full.zero, 0);
        assert.deepStrictEqual(report.abort, { code: 'JD2079', events: 3, siblings: [] });
        // a timer abort can fire only after the last page, and still lands
        // before publication
        assert.deepStrictEqual(report.timer, { code: 'JD2079', events: report.full.events, published: false, siblings: [] });
        assert.deepStrictEqual(report.deadline, { code: 'JD2075', calls: 6 });
        assert.deepStrictEqual(report.thrown, { code: 'JD2078', cause: 'refused', siblings: [] });
        assert.deepStrictEqual(report.closed, { code: 'JD2063', cleanupError: null, siblings: [] });
        assert.deepStrictEqual(report.pointInTime, { copyHasDuring: false, storeHasDuring: true });
        // page identity: at most page 1 differs, and only in its change
        // counter (bytes 24-27) and version-valid-for number (92-95)
        assert.ok(report.identity.differingPages <= 1, JSON.stringify(report.identity));
        for (const offset of report.identity.offsets)
          assert.ok((offset >= 24 && offset <= 27) || (offset >= 92 && offset <= 95), `byte ${offset} differs`);
        assert.strictEqual(report.identity.freelist[1], report.identity.freelist[0]);
        assert.ok(report.identity.freelist[0] > 0, 'the source has free pages to keep');
        assert.strictEqual(report.twoRun, true);
        assert.deepStrictEqual(report.memory, { events: 0, resolved: true });
        assert.deepStrictEqual(report.stale, { code: 'JD2078', targetUnchanged: true });
        // no descriptor outlives a copy, and the source closes clean
        // (counted where /proc/self/fd lists them)
        if (process.platform === 'linux')
          assert.deepStrictEqual(report.descriptors, { grew: 0, afterClose: 0, sideFiles: [] });
        assert.strictEqual(report.stoppedTimers, 'settled');
      }
      finally {
        scratch.cleanup();
      }
    });

  it('a Bun adapter on a different SQLite library, or on a memory database, copies in one step', async () => {
    // a library whose source id differs from node:sqlite's: two SQLite
    // copies on one file in one process would break each other's locks,
    // so node:sqlite must never open the file — here it could not
    class OtherLibraryDatabase extends BunShapedDatabase {
      /** @param {string} file */
      constructor(file) {
        super(file);
        this.file = file;
      }
      /** @param {string} sql */
      prepare(sql) {
        const answer = (row) => ({ run: () => ({}), get: () => row, all: () => [row] });
        if (sql.includes('sqlite_source_id()')) return answer({ id: 'another SQLite library' });
        if (sql.includes('pragma_database_list')) return answer({ file: path.join(path.dirname(this.file), 'unopenable', 'store.db') });
        return super.prepare(sql);
      }
    }
    for (const [name, Database, onDisk] of [['another library', OtherLibraryDatabase, true], ['a memory database', BunShapedDatabase, false]]) {
      const source = tempDbPath();
      const target = tempDbPath();
      let store;
      try {
        store = await openStore(MODEL, { driver: bunDouble(Database), ...(onDisk ? { path: source.dbPath } : {}) });
        await fill(store, 40, 400);
        const events = [];
        const result = await store.backupTo(target.dbPath, { rate: 1, checkpoint: false, onProgress: (event) => events.push(event) });
        assert.deepStrictEqual(events, [], name);
        assert.ok(result.pages > 1, name);
        assert.deepStrictEqual(await idsOf(target.dbPath), Array.from({ length: 40 }, (_, i) => `n${i}`).sort(), name);
        assert.deepStrictEqual(siblings(target.dbPath), [], name);
      }
      finally {
        await store?.close();
        source.cleanup();
        target.cleanup();
      }
    }
  });
});
