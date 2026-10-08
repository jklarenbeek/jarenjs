//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const bunVersion = spawnSync('bun', ['--version'], { encoding: 'utf8' });
const bunMissing = bunVersion.error !== undefined || bunVersion.status !== 0;

/** The running runtime's own driver entry and driver: Bun's under Bun, Node's otherwise. */
async function host() {
  const runtime = process.versions.bun ? await import('@jarenjs/db/bun') : await import('@jarenjs/db/node');
  return { runtime, driver: process.versions.bun ? runtime.bunDriver() : runtime.nodeDriver() };
}

/** The page numbers on a database file's freelist: its trunk pages (the
 * first one named by header bytes 32-35) and the leaves each one lists.
 * @param {Buffer} file @param {number} pageSize @returns {Set<number>} */
function freePages(file, pageSize) {
  const pages = new Set();
  for (let trunk = file.readUInt32BE(32); trunk !== 0; trunk = file.readUInt32BE((trunk - 1) * pageSize)) {
    pages.add(trunk);
    const at = (trunk - 1) * pageSize;
    for (let leaf = 0; leaf < file.readUInt32BE(at + 4); leaf++) pages.add(file.readUInt32BE(at + 8 + 4 * leaf));
  }
  return pages;
}

it('standalone snapshots include committed WAL, raw text and BLOB bytes and never replace a target', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jaren-snapshot-'));
  const { runtime, driver } = await host();
  const source = await driver.open(join(directory, 'source.db'));
  try {
    source.exec("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;CREATE TABLE history(id INTEGER PRIMARY KEY,data BLOB,raw TEXT);INSERT INTO history VALUES(1,X'0000FF',' { \"a\":1 } ')");
    const destination = join(directory, 'copy.db');
    const answer = await runtime.snapshotDatabase(source, destination);
    assert.ok(answer.pages > 0);
    const copy = await driver.open(destination, { readOnly: true });
    try {
      const row = copy.prepare('SELECT * FROM history').get([]);
      assert.deepEqual([...row.data], [0, 0, 255]); assert.equal(row.raw, ' { "a":1 } ');
    }
    finally { copy.close(); }
    const bytes = readFileSync(destination);
    await assert.rejects(runtime.snapshotDatabase(source, destination), { code: 'EEXIST' });
    assert.deepEqual(readFileSync(destination), bytes);
    const empty = join(directory, 'empty.db'); writeFileSync(empty, '');
    await assert.rejects(runtime.snapshotDatabase(source, empty), { code: 'EEXIST' });
    assert.equal(readFileSync(empty).length, 0);
    // SQLite reads a name that begins `file:` as a URI and `:memory:` as a
    // memory database: neither is the reserved file, and a page copy would
    // replace an existing database the URI names
    const workingDirectory = process.cwd();
    process.chdir(directory);
    try {
      await assert.rejects(runtime.snapshotDatabase(source, 'file:copy.db'), TypeError);
      await assert.rejects(runtime.snapshotDatabase(source, ':memory:'), TypeError);
    }
    finally { process.chdir(workingDirectory); }
    assert.deepEqual(readFileSync(destination), bytes);
    assert.equal(existsSync(join(directory, 'file:copy.db')), false);
    assert.equal(existsSync(join(directory, ':memory:')), false);
    const failed = join(directory, 'failed.db');
    await assert.rejects(source.transaction(async () => runtime.snapshotDatabase(source, failed)),
      { code: 'JD0038', message: /transaction/ });
    assert.equal(existsSync(failed), false);
    // while another caller's transaction holds the connection, a bad target
    // is refused at once, and a snapshot waits: it is not inside that
    // transaction, so it copies once the transaction has ended
    const gate = Promise.withResolvers();
    const held = source.transaction(() => gate.promise);
    await assert.rejects(runtime.snapshotDatabase(source, ''), TypeError);
    const waited = runtime.snapshotDatabase(source, join(directory, 'waited.db'));
    gate.resolve(undefined);
    await held;
    assert.ok((await waited).pages > 0);
    // a statement in progress on the connection neither stops a snapshot nor
    // is stopped by one
    source.exec('INSERT INTO history VALUES(2,NULL,NULL)');
    const ids = source.prepare('SELECT id FROM history ORDER BY id').iterate([]);
    assert.equal(ids.next().value.id, 1);
    assert.ok((await runtime.snapshotDatabase(source, join(directory, 'reading.db'))).pages > 0);
    assert.equal(ids.next().value.id, 2);
    ids.return(undefined);
  }
  finally { source.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('a snapshot copies every page of its source, page 1\'s header aside, and keeps unaliased rowids', async () => {
  const { runtime, driver } = await host();
  for (const mode of ['wal', 'delete']) {
    const directory = mkdtempSync(join(tmpdir(), 'jaren-snapshot-'));
    const path = join(directory, 'source.db');
    const source = await driver.open(path);
    try {
      // a table without an INTEGER PRIMARY KEY keeps its rowids unaliased,
      // and its index takes the schema cookie past 1; under WAL every change
      // stays in the log until the snapshot is taken
      source.exec(`PRAGMA journal_mode=${mode};PRAGMA wal_autocheckpoint=0;CREATE TABLE plain(a TEXT,b BLOB);CREATE INDEX plain_a ON plain(a)`);
      source.exec("WITH RECURSIVE g(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM g WHERE i<3000) INSERT INTO plain SELECT 'r'||i,randomblob(300) FROM g");
      source.exec('DELETE FROM plain WHERE rowid % 3 = 0 OR rowid < 500');
      source.exec("INSERT INTO plain(rowid,a) VALUES(9000000,'far')");
      const target = join(directory, 'copy.db');
      const answer = await runtime.snapshotDatabase(source, target);
      if (mode === 'wal') source.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const original = readFileSync(path);
      const copy = readFileSync(target);
      // the header's bytes 36-39 count the free pages
      assert.equal(copy.length, original.length, `${mode}: the copy has ${copy.length} bytes and ${copy.readUInt32BE(36)} `
        + `free pages, the source ${original.length} bytes and ${original.readUInt32BE(36)} free pages`);
      const encoded = original.readUInt16BE(16);
      const pageSize = encoded === 1 ? 65536 : encoded;
      const free = freePages(original, pageSize);
      assert.ok(free.size > 0);
      assert.deepEqual(freePages(copy, pageSize), free);
      // a copy of a WAL database is a rollback-journal file (bytes 18-19),
      // and SQLite's backup gives a new copy the schema cookie 1 (bytes 40-43)
      assert.deepEqual([copy[18], copy[19]], [1, 1], `${mode}: the copy's file format bytes`);
      assert.ok(original.readUInt32BE(40) > 1);
      assert.equal(copy.readUInt32BE(40), 1);
      // besides those, only the change counter (24-27) and version-valid-for
      // number (92-95) may differ on page 1; another page may differ only
      // when it is free, its bytes the copying connection's image of it
      const header = new Set([...(mode === 'wal' ? [18, 19] : []), 24, 25, 26, 27, 40, 41, 42, 43, 92, 93, 94, 95]);
      for (let page = 1; page <= original.length / pageSize; page++) {
        const start = (page - 1) * pageSize;
        if (original.subarray(start, start + pageSize).equals(copy.subarray(start, start + pageSize))) continue;
        if (page > 1) assert.ok(free.has(page), `${mode}: page ${page} differs and is not free`);
        else for (let at = 0; at < pageSize; at++)
          if (original[at] !== copy[at]) assert.ok(header.has(at), `${mode}: byte ${at} of page 1 differs`);
      }
      const facts = (/** @type {any} */ connection) => ({
        free: connection.prepare('PRAGMA freelist_count').get([]).freelist_count,
        rows: connection.prepare('SELECT rowid,a FROM plain ORDER BY rowid').all([]),
      });
      const copied = await driver.open(target, { readOnly: true });
      try {
        const kept = facts(source);
        const copiedFacts = facts(copied);
        assert.equal(copiedFacts.free, kept.free);
        assert.deepEqual(copiedFacts.rows.slice(0, 4).map((/** @type {any} */ row) => row.rowid), [500, 502, 503, 505]);
        assert.equal(copiedFacts.rows.at(-1).rowid, 9000000);
        assert.deepEqual(copiedFacts.rows, kept.rows);
        assert.equal(answer.pages, copied.prepare('PRAGMA page_count').get([]).page_count);
      }
      finally { copied.close(); }
      // opening the copy, read-only, created nothing beside it
      assert.deepEqual(readdirSync(directory).filter((name) => name.startsWith('copy.db')), ['copy.db']);
    }
    finally { source.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});

it('a failed copy removes the reserved file and its journal', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jaren-snapshot-'));
  const { runtime, driver } = await host();
  const source = await driver.open(join(directory, 'source.db'));
  try {
    source.exec('CREATE TABLE t(a)');
    const failure = new Error('copy failed');
    // the copy leaves a journal beside its partial file, as an I/O failure does
    const failing = { ...source, backup: { ...source.backup, copy: async (/** @type {string} */ target) => {
      writeFileSync(`${target}-journal`, 'partial');
      throw failure;
    } } };
    const target = join(directory, 'copy.db');
    await assert.rejects(runtime.snapshotDatabase(failing, target), (error) => error === failure);
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(`${target}-journal`), false);
    // a copy that wrote somewhere else leaves the reservation empty: that is
    // no snapshot either
    const elsewhere = { ...source, backup: { ...source.backup, copy: async () => undefined } };
    await assert.rejects(runtime.snapshotDatabase(elsewhere, target), { code: 'JD2078' });
    assert.equal(existsSync(target), false);
  }
  finally { source.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('a snapshot finishes while another connection keeps committing', async () => {
  const { runtime, driver } = await host();
  for (const mode of ['wal', 'delete']) {
    const directory = mkdtempSync(join(tmpdir(), 'jaren-snapshot-'));
    const path = join(directory, 'source.db');
    const source = await driver.open(path);
    const writer = await driver.open(path);
    let writing = true;
    /** @type {any} */
    let watchdog;
    try {
      // about 1,000 pages: ten steps at the online backup's default rate
      source.exec(`PRAGMA journal_mode=${mode};CREATE TABLE blobs(v BLOB);CREATE TABLE beats(v)`);
      source.exec('WITH RECURSIVE g(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM g WHERE i<1000) INSERT INTO blobs SELECT randomblob(4000) FROM g');
      // the other connection commits on every turn of the event loop; under a
      // rollback journal its commits fail busy while the copy reads
      const beat = () => {
        if (!writing) return;
        try { writer.exec('INSERT INTO beats VALUES(1)'); }
        catch { /* busy */ }
        setImmediate(beat);
      };
      beat();
      const snapshot = runtime.snapshotDatabase(source, join(directory, 'copy.db'));
      const finished = await Promise.race([snapshot.then(() => true),
        new Promise((resolve) => { watchdog = setTimeout(resolve, 5000, false); })]);
      writing = false;
      // a copy the commits kept restarting ends once they stop
      await snapshot;
      assert.equal(finished, true, `${mode}: the snapshot did not finish while another connection kept committing`);
    }
    finally {
      writing = false;
      clearTimeout(watchdog);
      writer.close();
      source.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

it('a snapshot of a source another connection has locked fails busy and leaves nothing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jaren-snapshot-'));
  const { runtime, driver } = await host();
  const path = join(directory, 'source.db');
  const source = await driver.open(path);
  const locker = await driver.open(path);
  try {
    source.exec('CREATE TABLE t(a);INSERT INTO t VALUES(1)');
    // the rollback journal's exclusive lock keeps every reader out
    locker.exec('BEGIN EXCLUSIVE');
    const target = join(directory, 'copy.db');
    await assert.rejects(runtime.snapshotDatabase(source, target), /database is locked/);
    assert.equal(existsSync(target), false);
    locker.exec('ROLLBACK');
    assert.ok((await runtime.snapshotDatabase(source, target)).pages > 0);
  }
  finally { locker.close(); source.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('a snapshot never writes over the database it copies or one of its side files', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jaren-snapshot-'));
  const { runtime, driver } = await host();
  const path = join(directory, 'app.db');
  // a rollback journal: the side files do not exist between transactions
  const source = await driver.open(path);
  // a database whose own name is another path's journal
  const odd = await driver.open(join(directory, 'odd.db-journal'));
  // the directory under another name
  symlinkSync(directory, join(directory, 'alias'));
  try {
    source.exec('CREATE TABLE t(a);INSERT INTO t VALUES(1)');
    odd.exec('CREATE TABLE precious(v);INSERT INTO precious VALUES(1)');
    for (const target of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`, join(directory, 'alias', 'app.db-journal')])
      await assert.rejects(runtime.snapshotDatabase(source, target), { code: 'JD2078' }, target);
    // SQLite deletes a journal it finds beside an empty file: here, the database
    await assert.rejects(runtime.snapshotDatabase(odd, join(directory, 'odd.db')), { code: 'JD2078' });
    assert.deepEqual(readdirSync(directory).sort(), ['alias', 'app.db', 'odd.db-journal']);
    assert.equal(odd.prepare('SELECT count(*) AS n FROM precious').get([]).n, 1);
  }
  finally { odd.close(); source.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('a write on the connection during a snapshot never stalls it, and the connection writes again after', async () => {
  const { runtime, driver } = await host();
  for (const mode of ['wal', 'delete']) {
    const directory = mkdtempSync(join(tmpdir(), 'jaren-snapshot-'));
    const source = await driver.open(join(directory, 'source.db'));
    let writing = true;
    /** @type {any} */
    let watchdog;
    try {
      // about 1,000 pages: ten steps at the online backup's default rate
      source.exec(`PRAGMA journal_mode=${mode};CREATE TABLE blobs(v BLOB);CREATE TABLE beats(v)`);
      source.exec('WITH RECURSIVE g(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM g WHERE i<1000) INSERT INTO blobs SELECT randomblob(4000) FROM g');
      // an ungated write through the snapshot's own connection on every turn
      // of the event loop; one that meets the copy is refused
      const beat = () => {
        if (!writing) return;
        try { source.exec('INSERT INTO beats VALUES(1)'); }
        catch { /* refused while the copy reads */ }
        setImmediate(beat);
      };
      beat();
      const snapshot = runtime.snapshotDatabase(source, join(directory, 'copy.db'));
      const finished = await Promise.race([snapshot.then(() => true),
        new Promise((resolve) => { watchdog = setTimeout(resolve, 5000, false); })]);
      writing = false;
      // a copy that a joined write stalls waits for this commit
      if (!finished) { try { source.exec('COMMIT'); } catch { /* nothing open */ } }
      await snapshot.catch(() => undefined);
      assert.equal(finished, true, `${mode}: the snapshot stalled behind a write on its own connection`);
      assert.equal(source.transactionState(), false);
      source.exec('INSERT INTO beats VALUES(2)');
    }
    finally {
      writing = false;
      clearTimeout(watchdog);
      source.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

it('a relative snapshot target names a file in the working directory of the call', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jaren-snapshot-'));
  const { runtime, driver } = await host();
  const source = await driver.open(join(directory, 'source.db'));
  const here = join(directory, 'here');
  const there = join(directory, 'there');
  mkdirSync(here);
  mkdirSync(there);
  const workingDirectory = process.cwd();
  try {
    source.exec('CREATE TABLE t(a);INSERT INTO t VALUES(1)');
    process.chdir(here);
    const snapshot = runtime.snapshotDatabase(source, 'copy.db');
    // the working directory moves before the call has reserved its target
    process.chdir(there);
    await snapshot;
    assert.equal(existsSync(join(here, 'copy.db')), true);
    assert.equal(existsSync(join(there, 'copy.db')), false);
  }
  finally { process.chdir(workingDirectory); source.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('the same file under Bun',
  { skip: process.versions.bun ? 'already running under Bun' : bunMissing ? 'bun is not on PATH' : false }, () => {
    const run = spawnSync('bun', ['test', fileURLToPath(import.meta.url)], { encoding: 'utf8', cwd: repositoryRoot });
    assert.equal(run.status, 0, [run.stdout, run.stderr, run.error].filter(Boolean).join('\n'));
  });
