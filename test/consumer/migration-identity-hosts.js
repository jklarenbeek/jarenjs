//@ts-check
/**
 * Public migration identity proof for installed DB and LINQ consumers.
 * Four physical statement slots preserve the existing ownership-test bound:
 * migration operations hold their one-shot preparations only to settlement;
 * this raw connection has no Store's fixed prepared statements. A pool uses
 * a writer only, and its connection-owned setup fits within those four slots.
 * Every 100-call series exceeds the entire host limit without GC or retries.
 * The injected author changes only how exact planner documents are edited.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrationHistory, migrationStatus, migrate, adoptMigrationHistory,
  planModelMigration, shapeHash, migrationChecksum, createModelShape, sqliteDialect } from '@jarenjs/db';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver } from '@jarenjs/db/node-pool';
import { nodeProcessDriver } from '@jarenjs/db/node-process';

const MODEL = { $model: '0.1', collections: { items: { schema: { type: 'object' }, key: '/id' } } };
const EMPTY = { $model: '0.1', collections: {} };
const collisionModel = value => ({ $model: '0.1', collections: { items: { key: '/id', schema: {
  type: 'object', properties: { id: { type: 'string' }, n: { const: value } },
} } } });
/** @param {(from: any, to: any, id: string) => any} [author] */
export async function qualifyMigrationIdentityHosts(author = (from, to, id) =>
  planModelMigration(from, to, { dialect: sqliteDialect, id }).migration) {
  const native = process.versions.bun ? (await import('@jarenjs/db/bun')).bunDriver()
    : (await import('@jarenjs/db/node')).nodeDriver();
  /** @type {[string, () => any][]} */
  const drivers = [
    ['native', () => native],
    ['worker', () => nodeWorkerDriver({ maxStatements: 4 })],
    ['pool', () => nodeWorkerPoolDriver({ readers: 0, worker: { maxStatements: 4 } })],
  ];
  if (!process.versions.bun) drivers.push(['process', () => nodeProcessDriver({ maxStatements: 4 })]);
  const query = async (connection, sql, params = []) => {
    const statement = await connection.prepare(sql);
    try { return (await statement.all(params)).map(row => ({ ...row })); }
    finally { await statement.finalize?.(); }
  };
  const run = async (connection, sql, params = []) => {
    const statement = await connection.prepare(sql);
    try { return await statement.run(params); }
    finally { await statement.finalize?.(); }
  };
  const refuses = (call, code) => assert.rejects(async () => call(), { code });
  const results = [];
  for (const [host, makeDriver] of drivers) {
    const directory = mkdtempSync(join(tmpdir(), 'jaren-mi03-public-'));
    const driver = makeDriver();
    const withConnection = async (name, f) => {
      const connection = await driver.open(join(directory, `${name}.sqlite`), {});
      try { return await f(connection, { connection }); }
      finally { await connection.close(); }
    };
    try {
      await withConnection('empty', async (connection, target) => {
        const expected = { version: 1, dialect: 'sqlite', order: 'rowid',
          history: { present: false, rows: [] }, identity: { present: false, rows: [] } };
        for (let i = 0; i < 100; i++) {
          assert.deepEqual(await migrationHistory(target), expected);
          assert.deepEqual(await migrationStatus(target, []), {
            applied: [], pending: [], drift: null, upToDate: true, baseline: null,
          });
          assert.deepEqual(await migrate(target, [], { baseline: EMPTY, model: EMPTY, shadow: false }),
            { applied: [], skipped: [], upToDate: true });
        }
        assert.deepEqual(await migrationHistory(target), expected);
        assert.deepEqual(await query(connection, 'SELECT 1 AS alive'), [{ alive: 1 }]);
      });
      await withConnection('fresh', async (connection, target) => {
        await createModelShape(connection, MODEL);
        const current = { $model: '0.1', collections: { ...MODEL.collections,
          events: { schema: { type: 'object' }, key: '/id' } } };
        const document = author(MODEL, current, 'fresh');
        assert.equal(document.$migration, '0.2');
        assert.notEqual(document.identity.from, document.identity.to);
        const pending = await migrationStatus(target, [document]);
        assert.deepEqual(pending.pending, ['fresh']);
        assert.equal(pending.upToDate, false);
        const applied = await migrate(target, [document], { baseline: MODEL, model: current, shadowDriver: driver });
        assert.deepEqual(applied.applied, ['fresh']);
        const initial = await migrationHistory(target);
        assert.equal(initial.history.rows.length, 1);
        assert.equal(initial.identity.rows.length, 2);
        for (let i = 0; i < 100; i++) {
          assert.deepEqual((await migrate(target, [document], { baseline: MODEL, model: current, shadow: false })).applied, []);
          assert.equal((await migrationStatus(target, [document])).upToDate, true);
          assert.deepEqual(await migrationHistory(target), initial);
        }
        assert.deepEqual(await query(connection, 'SELECT 1 AS alive'), [{ alive: 1 }]);
      });
      await withConnection('legacy', async (connection, target) => {
        await createModelShape(connection, MODEL);
        const collision = ['p6oqx0', 'e6rrp7'].map(suffix => ({ $migration: '0.1', id: 'same',
          from: shapeHash(MODEL), to: shapeHash(MODEL), steps: [
            { kind: 'sql', sql: `CREATE TABLE IF NOT EXISTS collision_example_${suffix} (id INTEGER)` },
          ] }));
        assert.deepEqual(collision.map(migrationChecksum), ['fiebr3', 'fiebr3']);
        const bytes = collision.map(JSON.stringify);
        await connection.exec(collision[0].steps[0].sql);
        await connection.exec(`CREATE TABLE IF NOT EXISTS "_jaren_migrations" ("id" TEXT PRIMARY KEY, "applied_at" INTEGER, "from_hash" TEXT, "to_hash" TEXT, "checksum" TEXT, "steps" INTEGER) STRICT`);
        await run(connection, `INSERT INTO "_jaren_migrations" (rowid,id,applied_at,from_hash,to_hash,checksum,steps)
          VALUES (-7,?,9007199254740993,?,?,?,1)`, ['same', collision[0].from, collision[0].to, migrationChecksum(collision[0])]);
        const observed = JSON.parse(JSON.stringify(await migrationHistory(target)));
        assert.equal(observed.history.rows[0].rowid, '-7');
        assert.equal(observed.history.rows[0].applied_at, '9007199254740993');
        assert.equal(observed.history.rows[0].steps, '1');
        await refuses(() => migrationStatus(target, [collision[0]]), 'JD0028');
        await refuses(() => migrate(target, [collision[0]], { baseline: MODEL, model: MODEL, shadow: false }), 'JD0028');
        const options = { observed, model: MODEL };
        assert.deepEqual(await adoptMigrationHistory(target, [collision[0]], options), { adopted: 1, unchanged: 0 });
        const initial = await migrationHistory(target);
        for (let i = 0; i < 100; i++) {
          assert.deepEqual(await adoptMigrationHistory(target, [collision[0]], options), { adopted: 0, unchanged: 1 });
          await refuses(() => migrationStatus(target, [collision[1]]), 'JD0022');
          await refuses(() => migrate(target, [collision[1]], { baseline: MODEL, model: MODEL, shadow: false }), 'JD0022');
          await refuses(() => adoptMigrationHistory(target, [collision[1]], options), 'JD0022');
          assert.deepEqual(await migrationHistory(target), initial);
        }
        const plannedTail = author(MODEL, MODEL, 'tail');
        const tail = { ...plannedTail, steps: [...plannedTail.steps,
          { kind: 'sql', sql: 'INSERT INTO collision_example_p6oqx0 VALUES(42)' }] };
        const chain = [collision[0], tail];
        assert.deepEqual((await migrate(target, chain, { baseline: MODEL, model: MODEL, shadowDriver: driver })).applied, ['tail']);
        const complete = await migrationHistory(target);
        assert.deepEqual({ ...complete.history.rows[0] }, observed.history.rows[0]);
        for (let i = 0; i < 100; i++) {
          assert.deepEqual((await migrate(target, chain, { baseline: MODEL, model: MODEL, shadow: false })).applied, []);
          assert.equal((await migrationStatus(target, chain)).upToDate, true);
          await refuses(() => adoptMigrationHistory(target, [collision[0]], options), 'JD0022');
          assert.deepEqual(await migrationHistory(target), complete);
        }
        assert.deepEqual(await query(connection, 'SELECT id FROM collision_example_p6oqx0'), [{ id: 42 }]);
        assert.deepEqual(await query(connection, "SELECT name FROM sqlite_schema WHERE name='collision_example_e6rrp7'"), []);
        assert.deepEqual(collision.map(JSON.stringify), bytes);
      });
      await withConnection('model-collision', async (connection, target) => {
        const left = collisionModel('159koso'), right = collisionModel('gnt19f');
        assert.deepEqual([shapeHash(left), shapeHash(right)], ['15ta7pe', '15ta7pe']);
        await createModelShape(connection, left);
        const document = author(left, left, 'model-collision');
        await refuses(() => migrate(target, [document], { baseline: right, model: left, shadow: false }), 'JD0020');
        await refuses(() => migrate(target, [document], { baseline: left, model: right, shadow: false }), 'JD0020');
        assert.deepEqual(await migrationHistory(target), { version: 1, dialect: 'sqlite', order: 'rowid',
          history: { present: false, rows: [] }, identity: { present: false, rows: [] } });
        assert.deepEqual((await migrate(target, [document], { baseline: left, model: left, shadow: false })).applied, [document.id]);
        const beforeWrong = await migrationHistory(target);
        for (let i = 0; i < 100; i++) {
          await refuses(() => migrationStatus(target, [document], { model: right, shadowDriver: driver }), 'JD0020');
          assert.deepEqual(await migrationHistory(target), beforeWrong);
        }
      });
      await withConnection('status-baseline', async (connection, target) => {
        const left = collisionModel('159koso'), right = collisionModel('gnt19f');
        await createModelShape(connection, left);
        // The empty collection needs no data transform, but this zero-step
        // authored link still changes the exact model and is not a baseline.
        const document = { ...author(left, right, 'changed-model'), steps: [] };
        assert.deepEqual((await migrate(target, [document], { baseline: left, model: right, shadow: false })).applied, ['changed-model']);
        assert.equal((await migrationStatus(target, [document])).baseline, null);
      });
      results.push({ host, scenarios: 5, callsPerSeries: 100, maxStatements: host === 'native' ? null : 4 });
    }
    finally { rmSync(directory, { recursive: true, force: true }); }
  }
  return results;
}
