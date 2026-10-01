//@ts-check
/**
 * @file Host steps (MIGRATION-FORMAT §2): `{ kind: 'host', run, version }`
 * runs the host a run registers (`migrate(…, { hosts })`) inside the step's
 * savepoint of its link's transaction — and on the shadow's replay first.
 * Its scope reaches the transaction's document collections and a relational
 * engine bound to it, and nothing else outlives the step. A host that throws
 * rolls the link back with no history row; a missing host, one of another
 * version, a host step where no transaction exists (a documents-only run)
 * and a scope used after the step are `JD0025`. The step's document names
 * `run` and `version`, so the checksum an applied migration is held to
 * changes when the version does. Before, the only host code a migration
 * could run was a scalar function registered for a `sql` step: node and
 * wasm only, per row, and outside the checksum.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { openStore, migrate, migrationStatus, migrationChecksum, migrateDocuments, planPhysicalMigration, shapeHash, readSchema, sql } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { JarenValidator } from '@jarenjs/validate';
import { tempDbPath } from './helpers.js';

const compileSchema = (/** @type {any} */ schema) => {
  const validate = new JarenValidator({ collectErrors: true }).compile(schema);
  return (/** @type {any} */ doc) => validate(doc);
};
const V1 = { $model: '0.1', collections: { docs: { schema: { type: 'object', properties: { name: { type: 'string' } } }, key: '/id', indexes: [] } } };
const V2 = structuredClone(V1);
/** @type {any} */ (V2.collections.docs.schema.properties.name).maxLength = 3;
const HOST_STEP = { kind: 'host', run: 'truncate', version: '1' };
const REPAIR = { $migration: '0.1', id: 'repair', from: shapeHash(V1), to: shapeHash(V2), steps: [HOST_STEP] };
const coded = (/** @type {string} */ code, /** @type {RegExp} */ pattern = /./) =>
  (/** @type {any} */ error) => error.code === code && pattern.test(error.message);

/** A truncating host that records every call's context. @param {any[]} calls */
const truncate = (calls) => ({ truncate: { version: '1', run(/** @type {any} */ scope, /** @type {any} */ ctx) {
  calls.push({ ...ctx });
  return scope.collection('docs').update((/** @type {any} */ doc) =>
    (doc.name.length > 3 ? { ...doc, name: doc.name.slice(0, 3) } : undefined));
} } });

/** A file whose documents a narrowing refuses until repaired. @param {any} [driver] */
async function seeded(driver = nodeDriver()) {
  const temp = tempDbPath();
  const store = await openStore(V1, { driver, path: temp.dbPath });
  await store.collection('docs').put({ id: 'a', name: 'abcdef' });
  await store.collection('docs').put({ id: 'b', name: 'xy' });
  await store.close();
  return temp;
}

describe('a host step runs in its link, and on the shadow first', () => {
  it('repairs before the narrowing is validated; the shadow ran it too, and a repeat runs nothing', async () => {
    const { dbPath, cleanup } = await seeded();
    try {
      /** @type {any[]} */
      const calls = [];
      const outcome = await migrate({ driver: nodeDriver(), path: dbPath }, [REPAIR], { baseline: V1, model: V2, compileSchema, hosts: truncate(calls) });
      assert.deepEqual(/** @type {any} */ (outcome).applied, ['repair']);
      assert.deepEqual(calls.map((ctx) => ctx.shadow), [true, false], 'the shadow replays the host step before the store');
      assert.deepEqual(calls[1], { migration: 'repair', step: 0, version: '1', shadow: false });
      const store = await openStore(V2, { driver: nodeDriver(), path: dbPath });
      assert.deepEqual(await store.collection('docs').all(), [{ id: 'a', name: 'abc' }, { id: 'b', name: 'xy' }]);
      await store.close();
      calls.length = 0;
      const again = await migrate({ driver: nodeDriver(), path: dbPath }, [REPAIR], { baseline: V1, model: V2, compileSchema, hosts: truncate(calls) });
      assert.deepEqual(again, { applied: [], skipped: ['repair'], upToDate: true });
      assert.deepEqual(calls, [], 'an applied step never runs again');
    }
    finally { cleanup(); }
  });

  it('a host that throws rolls the link back with no history row: JD0023 names the step, the error is the cause', async () => {
    const { dbPath, cleanup } = await seeded();
    try {
      const boom = new Error('boom');
      const hosts = { truncate: { version: '1', run(/** @type {any} */ scope) {
        scope.collection('docs').update(() => ({ id: 'a', name: 'x' }));
        throw boom;
      } } };
      await assert.rejects(migrate({ driver: nodeDriver(), path: dbPath }, [REPAIR], { baseline: V1, model: V2, shadow: false, hosts }),
        (/** @type {any} */ error) => error.code === 'JD0023' && error.cause === boom && error.class === 'error'
          && error.retryable === false && /step 0 \(host 'truncate' 1\) failed: boom/.test(error.message));
      assert.deepEqual((await migrationStatus({ driver: nodeDriver(), path: dbPath }, [REPAIR], {})).applied, []);
      const db = new DatabaseSync(dbPath);
      assert.deepEqual(db.prepare(`SELECT json_extract("doc", '$.name') AS name FROM "docs" ORDER BY "key"`).all().map((r) => r.name),
        ['abcdef', 'xy'], 'the write before the throw rolled back with the step');
      db.close();
      // a host's own coded error is the cause, and its verdict is kept
      const busy = Object.assign(new Error('the host met a busy database'), { code: 'JD2005', class: 'busy', retryable: true });
      await assert.rejects(migrate({ driver: nodeDriver(), path: dbPath }, [REPAIR], { baseline: V1, model: V2, shadow: false,
        hosts: { truncate: { version: '1', run() { throw busy; } } } }),
      (/** @type {any} */ error) => error.code === 'JD0023' && error.cause === busy && error.class === 'busy' && error.retryable === true);
    }
    finally { cleanup(); }
  });

  it('the scope: every document as the transaction holds it, and a relational engine bound to it', async () => {
    const { dbPath, cleanup } = await seeded();
    try {
      /** @type {any} */
      const seen = {};
      const audit = { $migration: '0.1', id: 'audit', from: shapeHash(V1), to: shapeHash(V1), steps: [
        { kind: 'ddl', sql: 'CREATE TABLE "audit_log" ("id" TEXT PRIMARY KEY, "count" INTEGER NOT NULL)' },
        { kind: 'host', run: 'audit', version: '2' }] };
      const hosts = { audit: { version: '2', run(/** @type {any} */ scope) {
        seen.docs = scope.collection('docs').all();
        seen.affected = scope.relational.execute({ op: 'insert', table: 'audit_log', values: { id: 'n', count: seen.docs.length } }).affected;
        seen.read = scope.relational.all({ from: 'audit_log', columns: { id: sql.column('id'), count: sql.column('count') } });
      } } };
      await migrate({ driver: nodeDriver(), path: dbPath }, [audit], { baseline: V1, model: V1, shadow: false, hosts });
      assert.deepEqual(seen.docs, [{ id: 'a', name: 'abcdef' }, { id: 'b', name: 'xy' }]);
      assert.equal(seen.affected, 1);
      assert.deepEqual(seen.read.map((/** @type {any} */ row) => ({ ...row })), [{ id: 'n', count: 2 }]);
      const db = new DatabaseSync(dbPath);
      assert.deepEqual({ ...db.prepare('SELECT "id", "count" FROM "audit_log"').get() }, { id: 'n', count: 2 }, 'committed with the link');
      db.close();
    }
    finally { cleanup(); }
  });

  it('an entity row is updated WHOLE: mapped columns and the document alike', async () => {
    const MODEL = { $model: '0.1', entities: { User: { schema: { type: 'object', properties: {
      id: { type: 'string', 'x-entity': { key: true } }, name: { type: 'string' }, bio: { type: 'string', 'x-entity': { column: 'json' } } } } } } };
    const temp = tempDbPath();
    try {
      const store = await openStore(MODEL, { driver: nodeDriver(), path: temp.dbPath });
      await store.entity('User').create({ id: 'u1', name: 'ada', bio: 'engineer' });
      await store.close();
      const upper = { $migration: '0.1', id: 'upper', from: shapeHash(MODEL), to: shapeHash(MODEL), steps: [{ kind: 'host', run: 'upper', version: '1' }] };
      /** @type {any[]} */
      const read = [];
      const hosts = { upper: { version: '1', run(/** @type {any} */ scope) {
        const users = scope.collection('User');
        read.push(...users.all());
        return users.update((/** @type {any} */ user) => ({ ...user, name: user.name.toUpperCase(), bio: `${user.bio}!` }));
      } } };
      await migrate({ driver: nodeDriver(), path: temp.dbPath }, [upper], { baseline: MODEL, model: MODEL, hosts });
      assert.deepEqual(read, [{ id: 'u1', name: 'ada', bio: 'engineer' }]);
      const reopened = await openStore(MODEL, { driver: nodeDriver(), path: temp.dbPath });
      assert.deepEqual(await reopened.entity('User').get('u1'), { id: 'u1', name: 'ADA', bio: 'engineer!' });
      await reopened.close();
    }
    finally { temp.cleanup(); }
  });

  it('an asynchronous driver runs an async host; a synchronous one refuses its promise', async () => {
    const { dbPath, cleanup } = await seeded(nodeWorkerDriver());
    try {
      const hosts = { truncate: { version: '1', async run(/** @type {any} */ scope) {
        const docs = await scope.collection('docs').all();
        await Promise.resolve();
        return scope.collection('docs').update((/** @type {any} */ doc) => (docs.length === 2 && doc.name.length > 3 ? { ...doc, name: 'abc' } : undefined));
      } } };
      await migrate({ driver: nodeWorkerDriver(), path: dbPath }, [REPAIR], { baseline: V1, model: V2, compileSchema, shadow: false, hosts });
      const store = await openStore(V2, { driver: nodeWorkerDriver(), path: dbPath });
      assert.deepEqual(await store.collection('docs').get('a'), { id: 'a', name: 'abc' });
      await store.close();
    }
    finally { cleanup(); }
    const sync = await seeded();
    try {
      const hosts = { truncate: { version: '1', async run() {} } };
      await assert.rejects(migrate({ driver: nodeDriver(), path: sync.dbPath }, [REPAIR], { baseline: V1, model: V2, shadow: false, hosts }),
        coded('JD0025', /answered a promise on a synchronous connection/));
    }
    finally { sync.cleanup(); }
  });

  it('a scope used after its step is JD0025', async () => {
    const { dbPath, cleanup } = await seeded();
    try {
      /** @type {any} */
      let kept;
      const hosts = { truncate: { version: '1', run(/** @type {any} */ scope) { kept = scope; } } };
      const SAME = { ...REPAIR, to: shapeHash(V1) };
      await migrate({ driver: nodeDriver(), path: dbPath }, [SAME], { baseline: V1, model: V1, shadow: false, hosts });
      assert.throws(() => kept.collection('docs'), coded('JD0025', /used its scope after the step ended/));
      assert.throws(() => kept.relational.all({ from: 'docs' }), coded('JD0025'));
    }
    finally { cleanup(); }
  });
});

describe('what a host step\'s scope hands back is checked as a stylesheet\'s, and ends with the step', () => {
  const SAME = { ...REPAIR, to: shapeHash(V1) };
  /** A link over V1 that runs one host step, then `more`. @param {string} id @param {any[]} [more] */
  const link = (id, more = []) => ({ $migration: '0.1', id, from: shapeHash(V1), to: shapeHash(V1),
    steps: [{ kind: 'host', run: 'h', version: '1' }, ...more] });

  it('a replacement that is no document, or that moves a key member, refuses JD0023; one that leaves the key out keeps it', async () => {
    for (const replacement of [null, [1, 2], 42, 'text']) {
      const { dbPath, cleanup } = await seeded();
      try {
        const hosts = { truncate: { version: '1', run: (/** @type {any} */ scope) => scope.collection('docs').update(() => replacement) } };
        await assert.rejects(migrate({ driver: nodeDriver(), path: dbPath }, [SAME], { baseline: V1, shadow: false, hosts }),
          (/** @type {any} */ error) => error.code === 'JD0023' && error.class === 'error' && error.retryable === false
            && /step 0 \(host 'truncate' 1\) failed: the transform produced a non-document for row/.test(error.message),
          JSON.stringify(replacement));
        const store = await openStore(V1, { driver: nodeDriver(), path: dbPath });
        assert.deepEqual(await store.collection('docs').get('a'), { id: 'a', name: 'abcdef' }, 'nothing was written');
        await store.close();
      }
      finally { cleanup(); }
    }
    const MODEL = { $model: '0.1', entities: { User: { schema: { type: 'object', properties: {
      id: { type: 'string', 'x-entity': { key: true } }, name: { type: 'string' } } } } } };
    const temp = tempDbPath();
    try {
      const store = await openStore(MODEL, { driver: nodeDriver(), path: temp.dbPath });
      await store.entity('User').create({ id: 'u1', name: 'ada' });
      await store.close();
      const run = (/** @type {string} */ id, /** @type {(user: any) => any} */ fn) => migrate({ driver: nodeDriver(), path: temp.dbPath },
        [{ $migration: '0.1', id, from: shapeHash(MODEL), to: shapeHash(MODEL), steps: [{ kind: 'host', run: 'h', version: '1' }] }],
        { baseline: MODEL, model: MODEL, shadow: false, hosts: { h: { version: '1', run: (/** @type {any} */ scope) => scope.collection('User').update(fn) } } });
      await assert.rejects(run('move', (user) => ({ ...user, id: 'u2' })),
        coded('JD0023', /changed the key member 'id' of row 1 — key changes are not supported/));
      await run('omit', (user) => ({ name: user.name.toUpperCase() }));
      const reopened = await openStore(MODEL, { driver: nodeDriver(), path: temp.dbPath });
      assert.deepEqual(await reopened.entity('User').load({}), [{ id: 'u1', name: 'ADA' }]);
      await reopened.close();
    }
    finally { temp.cleanup(); }
  });

  it('a cursor the scope opened is returned when the step ends: a later pull is JD0025, and a later step meets no open statement', async () => {
    const { dbPath, cleanup } = await seeded();
    try {
      /** @type {any} */
      let kept;
      const hosts = { h: { version: '1', run(/** @type {any} */ scope) {
        kept = scope.relational.iterate({ from: 'docs', columns: { key: sql.column('key') } });
        const first = kept.next();
        assert.deepEqual([first.done, { ...first.value }], [false, { key: 'a' }]);
      } } };
      // the DDL after the host step used to meet the cursor's open statement: "database table is locked"
      const outcome = await migrate({ driver: nodeDriver(), path: dbPath }, [link('peek', [
        { kind: 'ddl', sql: 'CREATE TABLE "scratch_t" ("x" INTEGER)' }, { kind: 'ddl', sql: 'DROP TABLE "scratch_t"' }])],
      { baseline: V1, shadow: false, hosts });
      assert.deepEqual(/** @type {any} */ (outcome).applied, ['peek']);
      assert.throws(() => kept.next(), coded('JD0025', /used its scope after the step ended/));
    }
    finally { cleanup(); }
  });

  it('a scope cursor iterates, breaks and disposes as any cursor does, on both drivers, and refuses a pull after its step', async () => {
    const select = { from: 'docs', columns: { key: sql.column('key') } };
    for (const driver of [nodeDriver, nodeWorkerDriver]) {
      const { dbPath, cleanup } = await seeded(driver());
      try {
        /** @type {any} */
        const seen = {};
        /** @type {any} */
        let kept;
        const run = driver === nodeDriver
          ? (/** @type {any} */ scope) => {
            const cursor = scope.relational.iterate(select);
            Object.assign(seen, { streaming: cursor.streaming, barrier: cursor.barrier, keys: [] });
            for (const row of cursor) { seen.keys.push(row.key); break; }
            seen.settled = cursor.settled;
            const disposed = scope.relational.iterate(select);
            disposed[Symbol.dispose]();
            seen.disposed = disposed.settled;
            kept = scope.relational.iterate(select);
          }
          : async (/** @type {any} */ scope) => {
            const cursor = scope.relational.iterate(select);
            Object.assign(seen, { streaming: cursor.streaming, barrier: cursor.barrier, keys: [] });
            for await (const row of cursor) { seen.keys.push(row.key); break; }
            seen.settled = cursor.settled;
            const disposed = scope.relational.iterate(select);
            await disposed[Symbol.asyncDispose]();
            seen.disposed = disposed.settled;
            kept = scope.relational.iterate(select);
          };
        await migrate({ driver: driver(), path: dbPath }, [link(`iterate-${driver.name}`)],
          { baseline: V1, shadow: false, hosts: { h: { version: '1', run } } });
        assert.deepEqual(seen, { streaming: 'row', barrier: null, keys: ['a'], settled: true, disposed: true }, driver.name);
        if (driver === nodeDriver) assert.throws(() => kept.next(), coded('JD0025'));
        else await assert.rejects(kept.next(), coded('JD0025'));
        // its return stays the cursor's own: idempotent after the step
        assert.deepEqual(await kept.return(), { done: true, value: undefined });
      }
      finally { cleanup(); }
    }
  });

  it('a cancellation or a deadline its walk met passes as it is: JD2080 and JD2075, never re-coded', async () => {
    for (const [code, options] of /** @type {[string, (hold: { now: number }) => any][]} */ ([
      ['JD2080', () => {
        const controller = new AbortController();
        return { signal: controller.signal, hosts: { h: { version: '1', run: (/** @type {any} */ scope) =>
          scope.collection('docs').update((/** @type {any} */ doc) => { controller.abort(); return { ...doc, name: 'X' }; }) } } };
      }],
      ['JD2075', (hold) => ({ deadline: 2000, runtime: { now: () => hold.now }, hosts: { h: { version: '1', run: (/** @type {any} */ scope) =>
        scope.collection('docs').update((/** @type {any} */ doc) => { hold.now = 5000; return { ...doc, name: 'Y' }; }) } } })],
    ])) {
      const { dbPath, cleanup } = await seeded();
      try {
        const hold = { now: 1000 };
        await assert.rejects(migrate({ driver: nodeDriver(), path: dbPath }, [link(`cancel-${code}`)],
          { baseline: V1, shadow: false, batchSize: 1, ...options(hold) }), (/** @type {any} */ error) => error.code === code);
        assert.deepEqual((await migrationStatus({ driver: nodeDriver(), path: dbPath }, [], {})).applied, []);
      }
      finally { cleanup(); }
    }
  });
});

describe('a host step that cannot run as its document names is JD0025, before anything runs', () => {
  it('a missing host, another version, and a documents-only run', async () => {
    const { dbPath, cleanup } = await seeded();
    try {
      await assert.rejects(migrate({ driver: nodeDriver(), path: dbPath }, [REPAIR], { baseline: V1, model: V2 }),
        coded('JD0025', /runs host 'truncate', which this run was not given/));
      await assert.rejects(migrate({ driver: nodeDriver(), path: dbPath }, [REPAIR], { baseline: V1, model: V2,
        hosts: { truncate: { version: '2', run() {} } } }), coded('JD0025', /version "1", and the host given is version "2"/));
      await assert.rejects(migrateDocuments({ docs: [{ id: 'a', name: 'abcdef' }] }, [REPAIR], {}),
        coded('JD0025', /needs a database transaction/));
      // the shadow replays the whole chain: an applied host step needs its host too
      await migrate({ driver: nodeDriver(), path: dbPath }, [REPAIR], { baseline: V1, model: V2, compileSchema, hosts: truncate([]) });
      const NEXT = { $migration: '0.1', id: 'next', from: shapeHash(V2), to: shapeHash(V2), steps: [] };
      await assert.rejects(migrate({ driver: nodeDriver(), path: dbPath }, [REPAIR, NEXT], { baseline: V1, model: V2 }),
        coded('JD0025', /migration 'repair' step 0/));
      const done = await migrate({ driver: nodeDriver(), path: dbPath }, [REPAIR, NEXT], { baseline: V1, model: V2, shadow: false });
      assert.deepEqual(/** @type {any} */ (done).applied, ['next'], 'without the shadow, only the pending steps need hosts');
      assert.equal((await migrationStatus({ driver: nodeDriver(), path: dbPath }, [REPAIR, NEXT], {})).upToDate, true);
    }
    finally { cleanup(); }
  });

  it("the step's version is in its checksum; a malformed step or hosts option is refused", () => {
    const bumped = { ...REPAIR, steps: [{ ...HOST_STEP, version: '2' }] };
    assert.notEqual(migrationChecksum(bumped), migrationChecksum(REPAIR));
    assert.throws(() => migrate({ connection: /** @type {any} */ ({ prepare() {}, transaction() {} }) }, [REPAIR],
      { baseline: V1, hosts: /** @type {any} */ ({ truncate: { version: '1' } }) }), TypeError);
    assert.throws(() => migrate({ connection: /** @type {any} */ ({ prepare() {}, transaction() {} }) }, [REPAIR],
      { baseline: V1, hosts: /** @type {any} */ ([]) }), TypeError);
  });

  it('a malformed host step is JD0023; a dry run names the host step; a physical plan may carry one', async () => {
    const { dbPath, cleanup } = await seeded();
    try {
      await assert.rejects(migrate({ driver: nodeDriver(), path: dbPath }, [{ ...REPAIR, steps: [{ kind: 'host', run: 'truncate' }] }],
        { baseline: V1, model: V2, hosts: truncate([]) }), coded('JD0023', /host step without its run and version/));
      const dry = /** @type {any} */ (await migrate({ driver: nodeDriver(), path: dbPath }, [{ ...REPAIR, steps: [{ ...HOST_STEP, note: 'cap names at 3' }] }],
        { baseline: V1, model: V2, dryRun: true, hosts: truncate([]), shadow: false }));
      assert.deepEqual(dry.statements, ["-- host step 'truncate' (version 1): cap names at 3"]);
      const connection = await nodeDriver().open(dbPath, {});
      try {
        const objects = readSchema(connection).objects;
        const plan = /** @type {any} */ (planPhysicalMigration(connection, V1, V1, { id: 'physical', steps: [{ kind: 'host', run: 'noop', version: '1' }],
          dispositions: Object.fromEntries(objects.map((o) => [`${o.type}:${o.name}`, 'preserve'])) }));
        assert.deepEqual(plan.steps.map((/** @type {any} */ s) => s.kind), ['host']);
      }
      finally { connection.close(); }
    }
    finally { cleanup(); }
  });
});
