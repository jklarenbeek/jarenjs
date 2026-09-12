//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeProcessDriver } from '@jarenjs/db/node-process';
import { nodeDriver } from '@jarenjs/db/node';
import { openStore } from '@jarenjs/db';

const native = { skip: !!process.versions.bun };
const longRead = 'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000000) SELECT sum(x) AS n FROM n';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function fixture(body) {
  const folder = await mkdtemp(join(tmpdir(), 'jaren-process-'));
  const driver = nodeProcessDriver({ maxOwners: 1, timeoutMs: 100, closeTimeoutMs: 100 });
  let connection = await driver.open(join(folder, 'data.sqlite'));
  try { await body({ driver, connection, path: join(folder, 'data.sqlite'), replace: (next) => { connection = next; } }); }
  finally { await connection.close().catch(() => {}); await connection.settled(); await rm(folder, { recursive: true, force: true }); }
}

it('process cancellation fences replies before releasing owner credits, with a responsive parent', native, (t) => fixture(async ({ driver, connection }) => {
  const statement = await connection.prepare(longRead);
  const abort = new AbortController();
  let ticks = 0;
  const interval = setInterval(() => ticks++, 5);
  const started = performance.now();
  const work = connection.supervise(() => statement.get(), { signal: abort.signal, timeoutMs: 500 });
  setTimeout(() => abort.abort(), 30);
  await assert.rejects(work, { code: 'JD2097', retryable: false });
  clearInterval(interval);
  const responseMs = performance.now() - started;
  assert.ok(responseMs < 1000, 'caller response exceeds one second');
  assert.ok(ticks > 0, 'SQLite blocked the parent event loop');
  assert.equal(connection.capabilities.cancellation.midStatement, false);
  assert.equal(connection.settlement().safeToReplace, false);
  assert.equal(driver.metrics().quarantined, 1);
  await assert.rejects(driver.open(), { code: 'JD2091' });
  const settled = await connection.settled();
  assert.equal(settled.status, 'exited');
  assert.equal(settled.safeToReplace, true);
  assert.equal(driver.metrics().owners, 0);
  await assert.rejects(statement.get(), { code: 'JD2090' });
  assert.equal(connection.metrics().pending, 0);
  t.diagnostic(JSON.stringify({ fixture: 'native-read', node: process.versions.node, platform: process.platform,
    responseMs, exitMs: performance.now() - started, ticks, owners: driver.metrics().owners, pending: connection.metrics().pending }));
}));

it('killed explicit writes roll back receipts and rows before a replacement can acquire its lock', native, (t) => fixture(async ({ driver, connection, path, replace }) => {
  await connection.exec('PRAGMA journal_mode=WAL; CREATE TABLE rows(id INTEGER); CREATE TABLE receipts(id TEXT PRIMARY KEY)');
  const started = performance.now();
  await assert.rejects(connection.supervise(async (owner) => owner.transaction(async (scope) => {
    await scope.exec("INSERT INTO receipts VALUES('request-1')");
    await scope.exec(`INSERT INTO rows ${longRead}`);
  }), { timeoutMs: 50 }), { code: 'JD2097' });
  const responseMs = performance.now() - started;
  assert.ok(responseMs < 1000);
  assert.equal((await connection.settled()).transaction, 'rolled-back');
  const exitMs = performance.now() - started;
  const fresh = await driver.open(path); replace(fresh);
  assert.ok(fresh.generation > connection.generation);
  assert.deepEqual(await (await fresh.prepare('SELECT * FROM receipts')).all(), []);
  assert.deepEqual(await (await fresh.prepare('SELECT * FROM rows')).all(), []);
  assert.deepEqual(await (await fresh.prepare('PRAGMA integrity_check')).get(), { integrity_check: 'ok' });
  await fresh.exec('BEGIN IMMEDIATE; INSERT INTO rows VALUES(7); COMMIT');
  assert.deepEqual(await (await fresh.prepare('SELECT id FROM rows')).all(), [{ id: 7 }]);
  t.diagnostic(JSON.stringify({ fixture: 'native-write', responseMs, exitMs, transaction: 'rolled-back',
    oldRows: 0, oldReceipts: 0, reopenedRows: 1, integrity: 'ok', owners: driver.metrics().owners }));
}));

it('a commit hidden inside native work remains unknown and is reconciled by its durable receipt', native, () => fixture(async ({ driver, connection, path, replace }) => {
  await connection.exec('PRAGMA journal_mode=WAL; CREATE TABLE receipts(id TEXT PRIMARY KEY)');
  await assert.rejects(connection.supervise(() => connection.exec(
    `BEGIN; INSERT INTO receipts VALUES('request-2'); COMMIT; ${longRead}`), { timeoutMs: 50 }), { code: 'JD2097' });
  assert.equal((await connection.settled()).transaction, 'unknown');
  const fresh = await driver.open(path); replace(fresh);
  for (let i = 0; i < 2; i++) {
    const receipt = await (await fresh.prepare('SELECT id FROM receipts WHERE id=?')).get(['request-2']);
    assert.deepEqual(receipt, { id: 'request-2' });
  }
  assert.deepEqual(await (await fresh.prepare('SELECT count(*) AS n FROM receipts')).get(), { n: 1 });
}));

it('confirmed completion survives a caller cancellation and repeated restart releases process handles', native, () => fixture(async ({ connection, replace }) => {
  await connection.exec('CREATE TABLE receipts(id TEXT PRIMARY KEY)');
  await connection.transaction(async (scope) => scope.exec("INSERT INTO receipts VALUES('done')"));
  assert.equal(connection.settlement().transaction, 'committed');
  for (let i = 0; i < 3; i++) {
    const old = connection;
    const statement = await old.prepare(longRead);
    await assert.rejects(old.supervise(() => statement.get(), { timeoutMs: 20 }), { code: 'JD2097' });
    const exit = await old.settled();
    assert.equal(exit.transaction, i === 0 ? 'committed' : 'none');
    assert.throws(() => process.kill(exit.pid, 0), { code: 'ESRCH' });
    connection = await old.restart(); replace(connection);
    assert.deepEqual(await (await connection.prepare('SELECT id FROM receipts')).all(), [{ id: 'done' }]);
  }
  await connection.close(); await connection.close();
  assert.equal((await connection.settled()).safeToReplace, true);
}));

it('busy waits and cancelled queued transactions have distinct finite outcomes', native, () => fixture(async ({ connection, path }) => {
  await connection.exec('CREATE TABLE rows(id INTEGER); PRAGMA busy_timeout=30');
  const blocker = await nodeDriver().open(path);
  try {
    blocker.exec('BEGIN IMMEDIATE');
    const started = performance.now();
    await assert.rejects(connection.exec('INSERT INTO rows VALUES(1)'), /locked/);
    assert.ok(performance.now() - started < 1000);
    assert.equal(connection.settlement().status, 'healthy');
  }
  finally { blocker.exec('ROLLBACK'); blocker.close(); }
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  assert.equal(connection.mustQueue, false);
  const first = connection.transaction(async () => barrier);
  await wait(20);
  assert.equal(connection.mustQueue, true, 'unrelated callers must queue while the transaction awaits');
  const signal = new AbortController(); let ran = false;
  const queued = connection.transaction(() => { ran = true; }, signal.signal);
  signal.abort(); await assert.rejects(queued, { code: 'JD2064' });
  release(); await first; assert.equal(ran, false); assert.equal(connection.mustQueue, false);
}));

it('the process Driver uses ordinary Store transactions and validates unsupported hosts', async () => {
  if (process.versions.bun) {
    await assert.rejects(nodeProcessDriver().open(), { code: 'JD0003' }); return;
  }
  assert.throws(() => nodeProcessDriver({ maxOwners: 0 }), TypeError);
  const driver = nodeProcessDriver({ maxOwners: 1 });
  const store = await openStore({ $model: '0.1', collections: { notes: {
    schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, key: '/id',
  } } }, { driver });
  try {
    await store.transaction(async (tx) => { await tx.collection('notes').insert({ id: 'a' }); });
    assert.deepEqual(await store.collection('notes').get('a'), { id: 'a' });
    assert.equal(store.capabilities.process, true);
  }
  finally { await store.close(); }
  assert.equal(driver.metrics().owners, 0);
});

it('pre-admission refusals preserve the healthy owner and bound IPC payloads', native, async () => {
  const driver = nodeProcessDriver({ maxOwners: 1, maxRequestBytes: 256 });
  const connection = await driver.open();
  try {
    let ran = false;
    await assert.rejects(connection.supervise(() => { ran = true; }, { signal: AbortSignal.abort() }),
      { code: 'JD2097', class: 'cancelled', retryable: true });
    assert.equal(ran, false);
    await assert.rejects(connection.supervise(() => { throw new Error('host command rejected'); }), /host command rejected/);
    await assert.rejects(connection.exec(`SELECT '${'x'.repeat(256)}'`), { code: 'JD2092' });
    const statement = await connection.prepare('SELECT ? AS value');
    await assert.rejects(statement.get([{}]), { code: 'JD2093' });
    await assert.rejects(statement.get([new Uint8Array(256)]), { code: 'JD2092' });
    assert.deepEqual(await statement.get(['accepted']), { value: 'accepted' });
    assert.equal(connection.metrics().pending, 0);
    assert.equal(connection.settlement().status, 'healthy');
  } finally { await connection.close(); }
  assert.equal(driver.metrics().owners, 0);
});

it('native close deadlines and unsolicited crashes fence work and release file locks after exit', native, () => fixture(async ({ connection, replace }) => {
  await connection.exec('CREATE TABLE receipts(id TEXT PRIMARY KEY)');
  for (const mode of ['close', 'crash']) {
    await connection.exec('BEGIN IMMEDIATE');
    await connection.exec("INSERT INTO receipts VALUES('unfinished')");
    const statement = await connection.prepare(longRead);
    const work = assert.rejects(statement.get(), { code: 'JD2090', retryable: false });
    const started = performance.now();
    if (mode === 'close') await assert.rejects(connection.close(), { code: 'JD2090' });
    else process.kill(connection.settlement().pid, 'SIGKILL');
    await work;
    assert.ok(performance.now() - started < 1000);
    assert.equal((await connection.settled()).transaction, 'rolled-back');
    connection = await connection.restart(); replace(connection);
    assert.deepEqual(await (await connection.prepare('SELECT * FROM receipts')).all(), []);
    await connection.exec('BEGIN IMMEDIATE'); await connection.exec('ROLLBACK');
  }
}));

it('failed startup returns its capacity and acknowledged SQL programs never invent a commit', native, () => fixture(async ({ connection, path }) => {
  const other = nodeProcessDriver({ maxOwners: 1 });
  const started = performance.now();
  await assert.rejects(other.open(join(path, 'missing.sqlite')), /unable to open/);
  while (other.metrics().owners && performance.now() - started < 1000) await wait(5);
  assert.equal(other.metrics().owners, 0);
  const healthy = await other.open(); await healthy.close();
  await connection.exec('CREATE TABLE receipts(id TEXT PRIMARY KEY)');
  await connection.exec("BEGIN; INSERT INTO receipts VALUES('rolled'); ROLLBACK");
  assert.equal(connection.settlement().transaction, 'unknown');
  assert.deepEqual(await (await connection.prepare('SELECT * FROM receipts')).all(), []);
  assert.equal(connection.settlement().transaction, 'unknown');
  await connection.exec('BEGIN');
  await assert.rejects(connection.exec("INSERT INTO receipts VALUES('committed'); COMMIT; SELECT * FROM missing"), /no such table/);
  assert.equal(connection.settlement().transaction, 'unknown');
  assert.deepEqual(await (await connection.prepare('SELECT id FROM receipts')).all(), [{ id: 'committed' }]);
  await connection.exec('BEGIN');
  await (await connection.prepare('ROLLBACK')).run();
  assert.equal(connection.settlement().transaction, 'rolled-back');
}));

it('startup deadlines reject separately from eventual owner-credit release', native, async () => {
  const driver = nodeProcessDriver({ maxOwners: 1, startupTimeoutMs: 1 });
  const started = performance.now();
  await assert.rejects(driver.open(), { code: 'JD2090' });
  assert.ok(performance.now() - started < 1000);
  assert.ok(driver.metrics().owners <= 1);
  while (driver.metrics().owners && performance.now() - started < 1000) await wait(5);
  assert.equal(driver.metrics().owners, 0);
});

it('lazy mutation cursors cannot acknowledge completion before their final native frame', native, async () => {
  const connection = await nodeProcessDriver({ windowRows: 1 }).open();
  try {
    await connection.exec('CREATE TABLE rows(id INTEGER)');
    const cursor = await (await connection.prepare('INSERT INTO rows VALUES(1),(2) RETURNING id')).iterate();
    assert.equal(connection.settlement().transaction, 'unknown');
    assert.deepEqual(await cursor.next(), { done: false, value: { id: 1 } });
    assert.equal(connection.settlement().transaction, 'unknown');
    assert.deepEqual(await cursor.next(), { done: false, value: { id: 2 } });
    assert.equal(connection.settlement().transaction, 'unknown');
    assert.deepEqual(await cursor.next(), { done: true, value: undefined });
    assert.equal(connection.settlement().transaction, 'committed');
    const cancelled = await (await connection.prepare('INSERT INTO rows VALUES(3),(4) RETURNING id')).iterate();
    await cancelled.next(); await cancelled.return();
    assert.equal(connection.settlement().transaction, 'unknown');
    assert.deepEqual(await (await connection.prepare('SELECT id FROM rows ORDER BY id')).all(), [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
    assert.equal(connection.settlement().transaction, 'unknown', 'receipt observation is not a cursor completion acknowledgement');
  } finally { await connection.close(); }
});
