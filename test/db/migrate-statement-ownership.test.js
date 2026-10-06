//@ts-check
/** Borrowed migration temporaries release after their complete operation. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, migrationStatus, shapeHash, migrationChecksum, createModelShape } from '@jarenjs/db';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver } from '@jarenjs/db/node-pool';
import { nodeProcessDriver } from '@jarenjs/db/node-process';
import { wasmDriver } from '@jarenjs/db/wasm';
import { useStatementOnce } from '../../packages/db/src/driver.js';

const baseline = { $model: '0.1', collections: {} };
const model = { $model: '0.1', collections: { docs: { schema: { type: 'object' }, key: '/id' } } };
const link = (id, steps = [], from = baseline) => ({ $migration: '0.1', id, steps,
  from: shapeHash(from), to: shapeHash(from) });
const anchor = link('anchor');
const hosts = [
  ['worker', () => nodeWorkerDriver({ maxStatements: 4 })],
  ['pool', () => nodeWorkerPoolDriver({ readers: 0, worker: { maxStatements: 4 } })],
];
if (!process.versions.bun) hosts.push(['process', () => nodeProcessDriver({ maxStatements: 4 })]);
const all = (connection, sql) => useStatementOnce(connection, sql, (statement) => statement.all([]));

for (const [host, driver] of hosts) for (const applied of [false, true]) for (const transaction of [false, true])
  for (const status of [false, true])
    it(`${host}: 100 ${status ? 'status' : 'no-op migrate'} reads with ${applied ? 'applied' : 'empty'} history in a borrowed ${transaction ? 'transaction' : 'connection'}`, async () => {
      const connection = await driver().open(':memory:');
      try {
        if (applied) {
          await connection.exec('CREATE TABLE _jaren_migrations(id TEXT PRIMARY KEY, applied_at INTEGER, from_hash TEXT, to_hash TEXT, checksum TEXT, steps INTEGER) STRICT');
          await useStatementOnce(connection, 'INSERT INTO _jaren_migrations VALUES(?,?,?,?,?,?)',
            (statement) => statement.run([anchor.id, 17, anchor.from, anchor.to, migrationChecksum(anchor), 0]));
        }
        const documents = applied ? [anchor] : [];
        const work = async (scope) => {
          for (let n = 0; n < 100; n++) {
            const result = status ? await migrationStatus({ connection: scope }, documents)
              : await migrate({ connection: scope }, documents, { baseline, shadow: false });
            assert.equal(result.upToDate, true);
            assert.deepEqual(status ? result.applied : result.skipped, applied ? ['anchor'] : []);
          }
          assert.deepEqual(await all(scope, 'SELECT 41 AS n'), [{ n: 41 }], 'the caller still owns a usable scope');
        };
        if (transaction) await connection.transaction(work);
        else await work(connection);
        assert.deepEqual(await all(connection, 'SELECT 42 AS n'), [{ n: 42 }]);
      }
      finally { await connection.close(); }
    });

for (const method of ['get', 'all', 'execute', 'iterate'])
  it(`a migration host releases 100 finite ${method} operations or drained native cursors`, async () => {
    const connection = await nodeWorkerDriver({ maxStatements: 8, maxCursors: 1 }).open(':memory:');
    try {
      await connection.exec('CREATE TABLE item(n INTEGER)');
      const doc = link('host', [{ kind: 'host', run: 'read', version: '1' }]);
      const result = await migrate({ connection }, [doc], { baseline, shadow: false,
        hosts: { read: { version: '1', async run(scope) {
          for (let n = 0; n < 100; n++) {
            if (method === 'execute') assert.equal((await scope.relational.execute({ op: 'insert', table: 'item', values: { n } })).affected, 1);
            else if (method === 'iterate') {
              const cursor = scope.relational.iterate({ columns: { n } });
              assert.deepEqual(await cursor.next(), { done: false, value: { n } });
              assert.deepEqual(await cursor.next(), { done: true, value: undefined });
            }
            else assert.deepEqual(await scope.relational[method]({ columns: { n } }), method === 'all' ? [{ n }] : { n });
          }
        } } } });
      assert.deepEqual(result.applied, ['host']);
      assert.equal((await all(connection, 'SELECT COUNT(*) AS n FROM item'))[0].n, method === 'execute' ? 100 : 0);
    }
    finally { await connection.close(); }
  });

it('100 provider assertions release their private count plans even when the following step rolls back', async () => {
  const connection = await nodeWorkerDriver({ maxStatements: 8 }).open(':memory:');
  try {
    await createModelShape(connection, model);
    await connection.exec(`INSERT INTO docs(key,doc) VALUES('a',jsonb('{"id":"a"}'))`);
    const doc = link('count', [
      { kind: 'query', collection: 'docs', assert: { $count: '$[*]' }, expect: 'ebv' },
      { kind: 'sql', sql: 'INSERT INTO no_such_table VALUES(1)' },
    ], model);
    const plans = [];
    for (let n = 0; n < 100; n++) await assert.rejects(migrate({ connection }, [doc], {
      baseline: model, shadow: false, onAssertionPlan: (plan) => plans.push(plan.strategy),
    }), { code: 'JD0023', message: /no_such_table/ });
    assert.deepEqual(plans, Array(100).fill('provider'));
    assert.deepEqual((await migrationStatus({ connection }, [])).applied, []);
    assert.equal((await all(connection, 'SELECT COUNT(*) AS n FROM docs'))[0].n, 1);
  }
  finally { await connection.close(); }
});

/** Native SQL underneath value-or-promise statements, with observable ownership. */
async function traced(asynchronous, delayUpdates = false, failure = null) {
  const Native = process.versions.bun ? (await import('bun:sqlite')).Database
    : (await import('node:sqlite')).DatabaseSync;
  const database = new Native(':memory:');
  const records = [];
  let updateNumber = 0;
  let release, started;
  const updates = new Promise((resolve) => { release = resolve; });
  const firstUpdate = new Promise((resolve) => { started = resolve; });
  const answer = (value) => asynchronous ? Promise.resolve(value) : value;
  const raw = {
    exec: (sql) => database.exec(sql), close: () => database.close(),
    prepare(sql) {
      const statement = database.prepare(sql);
      const record = { sql, finalized: 0, active: 0, activeAtFinalize: [] };
      records.push(record);
      const call = (method) => (params = []) => {
        record.active++;
        if (delayUpdates && method === 'run' && /^UPDATE "docs"/.test(sql)) {
          started();
          const number = ++updateNumber;
          const pending = updates.then(() => {
            if (failure !== null && number === 2) throw failure;
            return statement[method](...params) ?? undefined;
          }).finally(() => { record.active--; });
          // The baseline runner ignored these promises. Observe their failures
          // in this harness too, so refusal/rollback assertions own the verdict.
          pending.catch(() => {});
          return pending;
        }
        const result = statement[method](...params) ?? undefined;
        record.active--;
        return answer(result);
      };
      return answer({ run: call('run'), get: call('get'), all: call('all'), finalize() {
        record.activeAtFinalize.push(record.active); record.finalized++;
        statement.finalize?.();
      } });
    },
  };
  const connection = await wasmDriver({ synchronous: !asynchronous, open: () => raw }).open(':memory:');
  await createModelShape(connection, model);
  await connection.exec(`INSERT INTO docs(key,doc) VALUES('a',jsonb('{"id":"a","n":1,"at":[4.9,52.37]}')),('b',jsonb('{"id":"b","n":2,"at":[4.9,52.37]}'))`);
  records.length = 0;
  return { connection, records, release, firstUpdate };
}

const jslt = { kind: 'jslt', collection: 'docs', stylesheet: [{ match: '$',
  body: { id: '$.id', n: { $add: ['$.n', 1] }, at: '$.at' } }] };
const derive = { kind: 'derive', collection: 'docs', columns: [
  { name: 'cell', derive: 'geohash', precision: 5, segments: [{ name: 'at' }] },
] };

for (const asynchronous of [false, true]) for (const failure of [false, true])
  it(`${asynchronous ? 'Promise' : 'sync'} transform temporaries release exactly once after ${failure ? 'rollback' : 'success'}`, async () => {
    const { connection, records } = await traced(asynchronous);
    try {
      const doc = link('transform', [jslt, ...(failure ? [{ kind: 'sql', sql: 'INSERT INTO no_such_table VALUES(1)' }] : [])], model);
      const run = () => migrate({ connection }, [doc], { baseline: model, shadow: false, batchSize: 1 });
      if (failure) await assert.rejects(async () => run(), { code: 'JD0023' });
      else {
        const result = run();
        if (!asynchronous) assert.equal(result?.then, undefined);
        assert.deepEqual((await result).applied, ['transform']);
      }
      const owned = records.slice();
      assert.ok(owned.some((record) => /^UPDATE/.test(record.sql)));
      assert.equal(owned.filter((record) => /FROM "docs"/.test(record.sql)).length, 2, 'the two page statements are reused across every batch');
      for (const record of owned) {
        assert.equal(record.finalized, 1, record.sql);
        assert.deepEqual(record.activeAtFinalize, [0], record.sql);
      }
      assert.deepEqual((await all(connection, "SELECT json_extract(doc,'$.n') AS n FROM docs ORDER BY key")).map((row) => row.n), failure ? [1, 2] : [2, 3]);
    }
    finally { await connection.close(); }
  });

for (const step of [jslt, derive]) it(`${step.kind} awaits every asynchronous update before releasing its writer and reporting completion`, async () => {
  const { connection, records, release, firstUpdate } = await traced(true, true);
  let result;
  try {
    await connection.exec('ALTER TABLE docs ADD COLUMN cell TEXT');
    let settled = false;
    result = migrate({ connection }, [link('write', [step], model)], { baseline: model, shadow: false, batchSize: 1 });
    result.then(() => { settled = true; }, () => { settled = true; });
    await Promise.race([firstUpdate, result.then(() => assert.fail('migration completed without an update'), (error) => { throw error; })]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'pending statement work is part of the migration outcome');
    assert.equal(records.some((record) => record.activeAtFinalize.some((active) => active !== 0)), false);
    release();
    assert.deepEqual((await result).applied, ['write']);
    for (const record of records) {
      assert.equal(record.finalized, 1, record.sql);
      assert.deepEqual(record.activeAtFinalize, [0], record.sql);
    }
    if (step.kind === 'derive') assert.deepEqual((await all(connection, 'SELECT cell FROM docs ORDER BY key')).map((row) => row.cell), ['u173z', 'u173z']);
    else assert.deepEqual((await all(connection, "SELECT json_extract(doc,'$.n') AS n FROM docs ORDER BY key")).map((row) => row.n), [2, 3]);
  }
  finally { release(); await result?.catch(() => {}); await connection.close(); }
});

for (const step of [jslt, derive]) it(`${step.kind} rolls back prior rows and writes no receipt when a delayed update rejects`, async () => {
  const failure = new Error('the second delayed update was refused');
  const { connection, records, release, firstUpdate } = await traced(true, true, failure);
  let result;
  try {
    await connection.exec('ALTER TABLE docs ADD COLUMN cell TEXT');
    result = migrate({ connection }, [link('write', [step], model)], { baseline: model, shadow: false, batchSize: 1 });
    const refused = assert.rejects(result, (error) => error.code === 'JD0023' && error.cause === failure);
    await Promise.race([firstUpdate, result.then(() => assert.fail('migration completed without an update'), (error) => { throw error; })]);
    release();
    await refused;
    for (const record of records) {
      assert.equal(record.finalized, 1, record.sql);
      assert.deepEqual(record.activeAtFinalize, [0], record.sql);
    }
    assert.deepEqual((await migrationStatus({ connection }, [])).applied, []);
    assert.deepEqual((await all(connection, "SELECT json_extract(doc,'$.n') AS n,cell FROM docs ORDER BY key"))
      .map((row) => ({ ...row })), [{ n: 1, cell: null }, { n: 2, cell: null }]);
  }
  finally { release(); await result?.catch(() => {}); await connection.close(); }
});
