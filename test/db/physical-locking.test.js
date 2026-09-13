//@ts-check
/** Native writer admission for physical changes on both SQLite hosts. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planSchemaChange, applySchemaChange, planTableMigration, applyTableMigration, withForeignKeysSuspended } from '@jarenjs/db';

const driver = async () => process.versions.bun
  ? (await import('@jarenjs/db/bun')).bunDriver() : (await import('@jarenjs/db/node')).nodeDriver();
const settings = (db) => [db.prepare('PRAGMA foreign_keys').get([]).foreign_keys,
  db.prepare('PRAGMA legacy_alter_table').get([]).legacy_alter_table];
const busy = (error) => error.errcode === 5 || error.code === 'SQLITE_BUSY';

async function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'jaren-physical-lock-'));
  const path = join(directory, 'data.sqlite');
  const host = await driver();
  let db, other;
  try {
    db = await host.open(path, { timeout: 2000 });
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE marker(id INTEGER PRIMARY KEY,n INTEGER); INSERT INTO marker VALUES(1,0); CREATE TABLE item(id INTEGER PRIMARY KEY); INSERT INTO item VALUES(1)');
    other = await host.open(path, { timeout: 0 });
    await run(db, other, path);
  }
  finally { other?.close(); db?.close(); rmSync(directory, { recursive: true, force: true }); }
}

for (const kind of ['schema', 'fresh', 'rebuild', 'scope']) {
  it(`${kind} reserves a WAL writer before its body while readers remain available`, async () => fixture((db, other) => {
    let depth = 0, bodies = 0, roots = 0;
    const connection = { ...db, get mustQueue() { return db.mustQueue; },
      transaction(fn, signal, mode) {
        assert.equal(signal, undefined);
        assert.equal(mode, 'immediate');
        return db.transaction((scope) => {
          bodies++;
          if (depth === 0) {
            roots++;
            assert.equal(other.prepare('SELECT n FROM marker').get([]).n, 0, 'WAL readers see the committed snapshot');
            assert.throws(() => other.exec('UPDATE marker SET n=1'), busy, 'the owner already holds the writer lock');
          }
          depth++;
          try { return fn(scope); }
          finally { depth--; }
        }, signal, mode);
      },
    };
    let result, plan;
    if (kind === 'schema') {
      plan = planSchemaChange(connection, { op: 'addColumn', table: 'item', column: { name: 'extra', type: 'TEXT' } });
      result = applySchemaChange(connection, plan);
    }
    else if (kind === 'scope') {
      result = withForeignKeysSuspended(connection, () => {
        assert.deepEqual(settings(db), [0, 1]);
        db.exec('UPDATE marker SET n=10');
        return { changed: 1 };
      });
    }
    else {
      plan = planTableMigration(connection, { name: kind === 'fresh' ? 'fresh' : 'item', primaryKey: ['id'],
        columns: [{ name: 'id', type: 'INTEGER' }, { name: 'extra', type: 'TEXT' }] },
      { id: kind, allowRebuild: true });
      result = applyTableMigration(connection, plan);
    }
    assert.ok(result.changed > 0);
    assert.equal(roots, 1, 'the admitted root body runs exactly once');
    assert.equal(bodies, kind === 'rebuild' ? 2 : 1, 'a rebuild adds one nested savepoint');
    assert.deepEqual(settings(db), [1, 0]);
    if (kind === 'fresh' || kind === 'rebuild') {
      assert.deepEqual(applyTableMigration(connection, plan), { changed: 0 });
      assert.equal(roots, 1, 'repeated completed plans do not rerun the body');
    }
    assert.equal(other.prepare('SELECT n FROM marker').get([]).n, kind === 'scope' ? 10 : 0);
    other.exec('UPDATE marker SET n=n+1');
  }));
}

it('configured admission waits for a child process writer, then runs once', async () => fixture(async (db, _other, path) => {
  assert.equal(db.prepare('PRAGMA busy_timeout').get([]).timeout, 2000);
  const plan = planSchemaChange(db, { op: 'addColumn', table: 'item', column: { name: 'extra', type: 'TEXT' } });
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/physical-writer.mjs', import.meta.url)), path],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stderr.on('data', (data) => { errors += data; });
  child.stdout.on('data', (data) => { output += data; });
  const stopped = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const waitFor = (message) => new Promise((resolve, reject) => {
    const cleanup = () => { child.stdout.off('data', received); child.off('exit', exited); child.off('error', failed); };
    const received = () => { if (output.includes(message)) { cleanup(); resolve(undefined); } };
    const failed = (error) => { cleanup(); reject(error); };
    const exited = () => failed(new Error(`writer exited before ${message.trim()}: ${errors}`));
    child.once('error', failed);
    child.once('exit', exited);
    child.stdout.on('data', received);
    received();
  });
  try {
    await waitFor('ready\n');
    assert.equal(db.prepare('SELECT n FROM marker').get([]).n, 0, 'a reader continues under the held writer');
    let bodies = 0;
    const connection = { ...db, get mustQueue() { return db.mustQueue; },
      transaction(fn, ...args) { return db.transaction((scope) => { bodies++; return fn(scope); }, ...args); },
    };
    // Wait for the child to receive the pipe write before blocking this
    // runtime in SQLite; Bun flushes that write through its event loop.
    const releasing = waitFor('releasing\n');
    child.stdin.end('release\n');
    await releasing;
    assert.deepEqual(applySchemaChange(connection, plan), { changed: 1 });
    assert.equal(bodies, 1);
    assert.equal(db.prepare('SELECT n FROM marker').get([]).n, 1, 'the other transaction committed before admission');
    assert.deepEqual(await stopped, { code: 0, signal: null }, errors);
  }
  finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await stopped; }
}));

it('nested rollback restores every original FK/legacy setting and retains borrowed timeouts', async () => fixture((db) => {
  db.exec('PRAGMA busy_timeout=321');
  for (const foreignKeys of [0, 1]) for (const legacy of [0, 1]) {
    db.exec(`PRAGMA foreign_keys=${foreignKeys}; PRAGMA legacy_alter_table=${legacy}`);
    let bodies = 0;
    assert.throws(() => withForeignKeysSuspended(db, () => {
      bodies++;
      db.exec('UPDATE marker SET n=10');
      withForeignKeysSuspended(db, () => {
        bodies++;
        db.transaction((scope) => scope.exec('UPDATE marker SET n=20'));
      });
      assert.deepEqual(settings(db), [0, 1]);
      throw new Error('rollback outer');
    }), /rollback outer/);
    assert.equal(bodies, 2, 'neither admitted body is retried');
    assert.equal(db.prepare('SELECT n FROM marker').get([]).n, 0);
    assert.deepEqual(settings(db), [foreignKeys, legacy]);
    assert.equal(db.prepare('PRAGMA busy_timeout').get([]).timeout, 321);
  }
}));

it('queued cancellation never enters a body and synchronous helpers refuse before changing settings', async () => fixture(async (db) => {
  let release;
  const owner = db.transaction(() => new Promise((resolve) => { release = resolve; }), undefined, 'immediate');
  const controller = new AbortController();
  let bodies = 0;
  const queued = db.transaction(() => { bodies++; }, controller.signal, 'immediate');
  controller.abort();
  try {
    await assert.rejects(queued, { code: 'JD2064' });
    assert.throws(() => withForeignKeysSuspended(db, () => { bodies++; }), /available synchronous/);
    assert.equal(bodies, 0);
    assert.deepEqual(settings(db), [1, 0]);
  }
  finally { release(); await owner; }
  assert.throws(() => withForeignKeysSuspended(db, async () => { bodies++; }), /synchronous callback/);
  assert.equal(bodies, 0);
  assert.throws(() => withForeignKeysSuspended(db, () => {
    db.exec('UPDATE marker SET n=9');
    return Promise.resolve();
  }), /settle synchronously/);
  assert.equal(db.prepare('SELECT n FROM marker').get([]).n, 0);
  assert.deepEqual(settings(db), [1, 0]);
}));
