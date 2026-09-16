//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, migrationStatus, planPhysicalMigration, readSchema, physicalObjectKey, classifyDriverError,
  planTableMigration, applyTableMigration, planSchemaChange, applySchemaChange } from '@jarenjs/db';
import { postgresDialect, postgresDriver } from '@jarenjs/db/postgres';
import { physicalTargetOf, comparePhysicalTarget, verifyShadowOwnership } from '../../packages/db/src/migration-target.js';
import { sqlTokens } from '../../packages/db/src/dialects/check-read.js';
import { postgresSqlToken } from '../../packages/db/src/dialects/postgres-migration.js';

const model = { $model: '0.1', collections: {} };
it('guards native transaction boundaries without interpreting dollar bodies, strings or nested comments', () => {
  const guard = postgresDialect({ searchPath: 'tenant' }).migration.checkSql;
  for (const sql of [
    "CREATE FUNCTION message() RETURNS text LANGUAGE plpgsql AS $b$ BEGIN RETURN 'COMMIT;  keep'; END $b$;",
    "COMMENT ON TABLE items IS E'quote\\'; COMMIT; still literal'",
    'CREATE /* outer /* COMMIT; */ comment */ INDEX by_id ON items(id);',
    "CREATE FUNCTION message() RETURNS text LANGUAGE sql AS $$ SELECT $inner$ two  spaces $inner$ $$",
    'ALTER TABLE items ADD COLUMN "COMMIT;" text',
  ]) assert.doesNotThrow(() => guard(sql));
  for (const sql of [
    'COMMIT', 'CREATE INDEX CONCURRENTLY by_id ON items(id)', 'DROP INDEX CONCURRENTLY by_id',
    'CREATE DATABASE forbidden', 'ALTER SYSTEM SET work_mem=1000',
    'CREATE TABLE a(id integer); COMMIT', 'CREATE TABLE a(id integer); CREATE TABLE b(id integer)',
    'CREATE FUNCTION x() RETURNS text AS $body$ unterminated', 'CREATE /* never closed',
    'CREATE TABLE a(id integer); /* nested /* hidden */ COMMIT;',
  ]) assert.throws(() => guard(sql), { code: 'JD0021' });
  assert.equal(sqlTokens("SELECT E'a\\'b', $$COMMIT;$$", postgresSqlToken).filter((t) => t.kind === 'string').length, 2);
});

it('compares complete native targets using owner-qualified keys and exact program bytes', async () => {
  const column = (owner) => ({ schema: 'tenant', type: 'column', owner, name: 'id', sql: null, metadata: { ordinal: 1 } });
  const objects = [column('a'), column('b')];
  assert.notEqual(physicalObjectKey(objects[0]), physicalObjectKey(objects[1]));
  const target = { dialect: 'postgres', schema: 'tenant', catalog: objects };
  assert.deepEqual(physicalTargetOf(target), target);
  assert.throws(() => physicalTargetOf({ ...target, catalog: [...objects, objects[0]] }), { code: 'JD0021' });
  const dialect = postgresDialect({ searchPath: 'tenant' });
  const connection = { dialect, prepare: async (text) => ({ all: async () => text === dialect.introspect.catalog() ? objects : [] }) };
  assert.equal(await comparePhysicalTarget(connection, target), null);
  objects[0].sql = "'a  b'";
  const saved = structuredClone(target); saved.catalog[0].sql = "'a b'";
  assert.match(await comparePhysicalTarget(connection, saved), /^different/);
});

it('keeps native plan admission asynchronous, checks allocation and refuses aliases before host work', async () => {
  const dialect = postgresDialect({ searchPath: 'tenant' });
  let catalog = [{ schema: 'tenant', type: 'table', name: 'items', owner: 'items', sql: null, metadata: {} },
    { schema: 'tenant', type: 'sequence', name: 'allocator', owner: 'items', sql: null, metadata: { cycle: false, increment: '1' } }];
  const source = structuredClone(catalog);
  const target = { dialect: 'postgres', schema: 'tenant', catalog: [...catalog,
    { schema: 'tenant', type: 'column', name: 'note', owner: 'items', sql: null, metadata: { ordinal: 2 } }] };
  let admitted = false, locks = 0, writes = 0;
  const scope = { dialect, prepare: async (text) => ({
    all: async () => text === dialect.introspect.catalog() ? structuredClone(catalog) : [],
    get: async () => {
      if (text === dialect.migration.settings) return { strings: 'on', lock_timeout: '1s' };
      if (text === dialect.migration.lock) { locks++; return {}; }
      return { value: '9007199254740993', called: 'true' };
    },
  }), exec: async () => { writes++; catalog = structuredClone(target.catalog); },
  transaction: async (fn) => fn(scope) };
  const connection = { ...scope, prepare: () => { throw new Error('root work must use its admitted scope'); },
    exclusively: async (fn) => {
      assert.equal(admitted, false); admitted = true;
      try { return await fn(scope); } finally { admitted = false; }
    } };
  const operation = { op: 'native', table: 'items', sql: 'ALTER TABLE items ADD COLUMN note text', target,
    dispositions: Object.fromEntries(source.map((object) => [physicalObjectKey(object), 'preserve'])) };
  const plan = await planSchemaChange(connection, operation);
  assert.equal(writes, 0);
  assert.deepEqual(await applySchemaChange(connection, JSON.parse(JSON.stringify(plan))), { changed: 1 });
  assert.deepEqual(await applySchemaChange(connection, plan), { changed: 0 });
  assert.equal(writes, 1); assert.equal(locks, 2); assert.equal(admitted, false);
  catalog = structuredClone(source);
  catalog[1].metadata.cycle = true;
  const cycle = await planTableMigration(connection, target, { id: 'cycle', table: 'items', statements: [operation.sql], dispositions: operation.dispositions });
  await assert.rejects(applyTableMigration(connection, cycle), { code: 'JD0021' });
  assert.equal(writes, 1); assert.equal(admitted, false);
  const identity = (schema, database = 'primary') => ({ dialect, prepare: async () => ({
    get: async () => ({ database, address: 'server', port: 5432, schema }),
  }) });
  await assert.rejects(verifyShadowOwnership(identity('tenant'), identity('tenant'), {}), { code: 'JD0021' });
  await verifyShadowOwnership(identity('tenant'), identity('other'), {});
  await assert.rejects(verifyShadowOwnership(identity('tenant'), identity('other'), {}, true), { code: 'JD0021' });
  await verifyShadowOwnership(identity('tenant'), identity('tenant', 'shadow'), {}, true);
});

const url = process.env.JAREN_PG_URL;
async function fixture(name, run) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const schema = `jaren_migration_${name}_${process.pid}`;
  let connection;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const driver = postgresDriver(pool, { schema });
    connection = await driver.open();
    await connection.exec('CREATE TABLE items(id integer PRIMARY KEY,label text); INSERT INTO items VALUES(1,\'original\')');
    return await run({ pool, schema, connection, driver });
  } finally { await connection?.close(); await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool.end(); }
}
const snapshot = async (connection, schema) => ({ dialect: 'postgres', schema, catalog: (await readSchema(connection)).catalog });
const preservation = async (connection, target, steps, id = 'change') => planPhysicalMigration(connection, model, model, {
  id, steps, physicalTarget: target,
  dispositions: Object.fromEntries((await readSchema(connection)).catalog.map((object) => [physicalObjectKey(object), 'preserve'])),
});
describe('PostgreSQL reviewed physical migrations', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  it('replays the exact native artifact on an independent database before applying deferred foreign-key work', async () => fixture('shadow', async ({ connection, pool, schema, driver }) => {
    const { default: pg } = await import('pg');
    const database = `jaren_shadow_${process.pid}`;
    let shadowPool;
    const setup = `CREATE TABLE parent(id integer PRIMARY KEY);
      CREATE TABLE child(id integer PRIMARY KEY,parent integer REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)`;
    await connection.exec(setup);
    const target = await snapshot(connection, schema);
    const plan = JSON.parse(JSON.stringify(await preservation(connection, target, [
      { kind: 'sql', sql: `INSERT INTO "${schema}".child VALUES(1,2)` },
      { kind: 'sql', sql: `INSERT INTO "${schema}".parent VALUES(2)` },
    ])));
    try {
      await pool.query(`CREATE DATABASE "${database}"`);
      const endpoint = new URL(url); endpoint.pathname = `/${database}`;
      shadowPool = new pg.Pool({ connectionString: endpoint.href, max: 2 });
      await shadowPool.query(`CREATE SCHEMA "${schema}"`);
      const shadowDriver = postgresDriver(shadowPool, { schema });
      let initialized = 0;
      const result = await migrate({ connection }, [plan], { baseline: model, shadowDriver, shadowFixture: async (shadow) => {
        initialized++;
        await shadow.exec("CREATE TABLE items(id integer PRIMARY KEY,label text); INSERT INTO items VALUES(1,'original')");
        await shadow.exec(setup);
      } });
      assert.equal(initialized, 1);
      assert.deepEqual(result.applied, ['change']);
      await connection.close();
      const reopened = await driver.open();
      try {
        assert.deepEqual((await migrate({ connection: reopened }, [plan], { baseline: model, shadow: false })).applied, []);
        assert.equal((await (await reopened.prepare('SELECT count(*) AS n FROM child JOIN parent ON parent.id=child.parent')).get([])).n, 1);
      } finally { await reopened.close(); }
    } finally { await shadowPool?.end(); await pool.query(`DROP DATABASE IF EXISTS "${database}"`); }
  }));

  it('refuses sequence allocation rewind and keeps external view dependencies and schema policy visible', async () => fixture('allocation', async ({ connection, pool, schema }) => {
    const external = `${schema}_external`;
    try {
      await connection.exec('CREATE SEQUENCE allocator START 100; SELECT nextval(\'allocator\')');
      await pool.query(`CREATE SCHEMA "${external}"; CREATE VIEW "${external}".retained AS SELECT id FROM "${schema}".items`);
      const target = await snapshot(connection, schema);
      assert.ok(target.catalog.some((object) => object.type === 'schema' && object.metadata.owner));
      assert.ok(target.catalog.some((object) => object.type === 'dependency'
        && object.metadata.dependent.schema === external && object.sql.includes('items')));
      const reset = await preservation(connection, target, [{ kind: 'ddl', sql: 'ALTER SEQUENCE allocator RESTART WITH 1' }], 'rewind');
      await assert.rejects(migrate({ connection }, [reset], { baseline: model, shadow: false }), { code: 'JD0023' });
      assert.equal((await (await connection.prepare("SELECT nextval('allocator')::text AS value")).get([])).value, '101');
      const destructive = await preservation(connection, target, [{ kind: 'ddl', sql: 'DROP TABLE items CASCADE' }], 'cascade');
      await assert.rejects(migrate({ connection }, [destructive], { baseline: model, shadow: false }), { code: 'JD0023' });
      assert.deepEqual((await pool.query(`SELECT id FROM "${external}".retained`)).rows, [{ id: 1 }]);
      const rename = await preservation(connection, target, [{ kind: 'sql', sql: "UPDATE items SET label='changed'" }]);
      await pool.query(`CREATE OR REPLACE VIEW "${external}".retained AS SELECT id FROM "${schema}".items WHERE id>0`);
      await assert.rejects(migrate({ connection }, [rename], { baseline: model, shadow: false }), { code: 'JD0020' });
      assert.equal((await (await connection.prepare('SELECT label FROM items')).get([])).label, 'original');
    } finally { await pool.query(`DROP SCHEMA IF EXISTS "${external}" CASCADE`); }
  }));

  it('applies a serialized native table plan through the shared executor and preserves a checked no-op', async () => fixture('table', async ({ connection, schema }) => {
    const before = await snapshot(connection, schema);
    let target;
    const sql = 'ALTER TABLE items ADD COLUMN extra integer DEFAULT 7';
    await assert.rejects(connection.transaction(async (tx) => {
      await tx.exec(sql); target = await snapshot(tx, schema); throw new Error('review only');
    }), /review only/);
    const plan = JSON.parse(JSON.stringify(await planTableMigration(connection, target, { id: 'widen', table: 'items', statements: [sql],
      dispositions: Object.fromEntries(before.catalog.map((object) => [physicalObjectKey(object), 'preserve'])) })));
    assert.deepEqual(await snapshot(connection, schema), before, 'planning itself executes no DDL');
    assert.deepEqual(await applyTableMigration(connection, plan), { changed: 1 });
    assert.deepEqual(await applyTableMigration(connection, plan), { changed: 0 });
    assert.equal((await (await connection.prepare('SELECT extra FROM items')).get([])).extra, 7);
    const edited = structuredClone(plan); edited.statements[0] += ' ';
    await assert.rejects(async () => applyTableMigration(connection, edited), { code: 'JD0021' });
    const nextSource = await snapshot(connection, schema);
    const nextSql = 'ALTER TABLE items ADD COLUMN note text';
    await assert.rejects(connection.transaction(async (tx) => {
      await tx.exec(nextSql); target = await snapshot(tx, schema); throw new Error('review only');
    }), /review only/);
    const next = JSON.parse(JSON.stringify(await planSchemaChange(connection, { op: 'native', table: 'items', sql: nextSql,
      target, dispositions: Object.fromEntries(nextSource.catalog.map((object) => [physicalObjectKey(object), 'preserve'])) })));
    assert.deepEqual(await snapshot(connection, schema), nextSource);
    assert.deepEqual(await applySchemaChange(connection, next), { changed: 1 });
    assert.deepEqual(await applySchemaChange(connection, next), { changed: 0 });
    const forged = structuredClone(next); forged.operation.table = 'other';
    await assert.rejects(async () => applySchemaChange(connection, forged), { code: 'JD0021' });
    await connection.exec('ALTER TABLE items ADD COLUMN drift text');
    await assert.rejects(async () => applyTableMigration(connection, plan), { code: 'JD0021' });
  }));

  it('holds one migration writer, bounds a lock waiter and rejects stale contender history without replay', async () => fixture('locking', async ({ connection, pool, schema }) => {
    const target = await snapshot(connection, schema);
    const change = "UPDATE items SET label=label || '!' WHERE id=1";
    const plan = await preservation(connection, target, [{ kind: 'sql', sql: change }]);
    await connection.close();
    const changed = Promise.withResolvers(), release = Promise.withResolvers(), locking = Promise.withResolvers();
    const connections = [];
    let firstWork, writes = 0;
    const source = (role) => ({ connect: async () => {
      const client = await pool.connect();
      return { getTransactionStatus: () => client.getTransactionStatus(), release: (error) => client.release(error),
        query: async (query, values) => {
          const text = typeof query === 'string' ? query : query.text;
          if (role === 'contender' && text.includes('pg_advisory_xact_lock')) locking.resolve();
          const result = await client.query(query, values);
          if (text === change) {
            writes++;
            if (role === 'writer') { changed.resolve(); await release.promise; }
          }
          return result;
        } };
    } });
    try {
      const writer = await postgresDriver(source('writer'), { schema }).open(); connections.push(writer);
      const timed = await postgresDriver(source('timed'), { schema, lockTimeoutMs: 50 }).open(); connections.push(timed);
      const contender = await postgresDriver(source('contender'), { schema }).open(); connections.push(contender);
      firstWork = migrate({ connection: writer }, [plan], { baseline: model, shadow: false });
      await changed.promise;
      await assert.rejects(migrate({ connection: timed }, [plan], { baseline: model, shadow: false }),
        (error) => error.code === '55P03' && classifyDriverError(error).code === 'JD2005');
      const waiting = migrate({ connection: contender }, [plan], { baseline: model, shadow: false });
      const rejected = assert.rejects(waiting, { code: 'JD0022' });
      await locking.promise;
      release.resolve();
      assert.deepEqual((await firstWork).applied, ['change']);
      await rejected;
      assert.deepEqual((await migrate({ connection: contender }, [plan], { baseline: model, shadow: false })).applied, []);
      assert.equal(writes, 1);
      assert.equal((await (await timed.prepare('SELECT label FROM items')).get([])).label, 'original!');
    } finally {
      release.resolve(); await firstWork?.catch(() => {});
      for (const current of connections) await current.close();
    }
  }));

  it('rolls back destructive drift and rejects primary aliases before fixture hooks or cleanup', async () => fixture('rollback', async ({ connection, driver, schema }) => {
    const target = await snapshot(connection, schema);
    const plan = await preservation(connection, target, [{ kind: 'ddl', sql: 'DROP TABLE items' }]);
    await assert.rejects(migrate({ connection }, [plan], { baseline: model, shadow: false }), { code: 'JD0023' });
    assert.equal((await (await connection.prepare('SELECT label FROM items')).get([])).label, 'original');
    assert.equal(await (await connection.prepare(connection.dialect.introspect.tableExists())).get(['_jaren_migrations']), undefined);
    let called = 0;
    for (const shadowDriver of [{ open: async () => connection }, driver]) {
      await assert.rejects(migrate({ connection }, [plan], { baseline: model, shadowDriver,
        shadowFixture: () => { called++; } }), { code: 'JD0021' });
    }
    assert.equal(called, 0);
    assert.equal((await (await connection.prepare('SELECT 1 AS n')).get([])).n, 1);
    await connection.exec('ALTER TABLE items ADD COLUMN drift integer');
    await assert.rejects(migrate({ connection }, [plan], { baseline: model, shadow: false }), { code: 'JD0020' });
  }));

  it('keeps receipt failures atomic and reconciles an actually committed lost reply without replay', async () => fixture('receipts', async ({ connection, pool, schema, driver }) => {
    const target = await snapshot(connection, schema);
    const plan = await preservation(connection, target, [{ kind: 'sql', sql: "UPDATE items SET label='changed' WHERE id=1" }]);
    await connection.close();
    for (const point of ['receipt', 'commit']) {
      let receiptSeen = false, faults = 0;
      const source = { connect: async () => {
        const client = await pool.connect();
        return { getTransactionStatus: () => client.getTransactionStatus(), release: (error) => client.release(error),
          query: async (query, values) => {
            const result = await client.query(query, values);
            const text = typeof query === 'string' ? query : query.text;
            if (/^INSERT INTO "_jaren_migrations"/.test(text)) receiptSeen = true;
            if (receiptSeen && (point === 'commit' ? text === 'COMMIT' : /^INSERT INTO "_jaren_migrations"/.test(text))) {
              faults++;
              throw Object.assign(new Error(`${point} acknowledgement lost`), { code: point === 'commit' ? '08006' : 'XX000' });
            }
            return result;
          } };
      } };
      const faulty = await postgresDriver(source, { schema }).open();
      try {
        await assert.rejects(migrate({ connection: faulty }, [plan], { baseline: model, shadow: false }));
        assert.equal(faults, 1);
        if (point === 'commit') assert.equal(faulty.transactionState(), 'unknown');
      } finally { await faulty.close(); }
      const checked = await driver.open();
      try {
        const present = await (await checked.prepare(checked.dialect.introspect.tableExists())).get(['_jaren_migrations']);
        assert.equal(present !== undefined, point === 'commit');
        assert.equal((await (await checked.prepare('SELECT label FROM items')).get([])).label, point === 'commit' ? 'changed' : 'original');
        if (point === 'commit') {
          const repeated = await migrate({ connection: checked }, [plan], { baseline: model, shadow: false });
          assert.deepEqual(repeated.applied, []);
          assert.deepEqual(repeated.skipped, ['change']);
          assert.equal((await (await checked.prepare('SELECT count(*) AS n FROM _jaren_migrations')).get([])).n, 1);
        }
      } finally { await checked.close(); }
    }
  }));

  it('saves every native object, preserves programs/data/identity, and checks receipt and target on repeat', async () => {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    const schema = `jaren_migration_${process.pid}`;
    let connection;
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      connection = await postgresDriver(pool, { schema }).open();
      await connection.exec(`CREATE TABLE items(id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,label text NOT NULL);
        INSERT INTO items(label) VALUES('original'); ALTER TABLE items ENABLE ROW LEVEL SECURITY;
        CREATE POLICY same ON items USING (label=current_user);
        CREATE FUNCTION retain() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN RETURN NEW; END $body$;
        CREATE FUNCTION retained_function_with_a_long_public_signature(an_argument_name integer) RETURNS integer LANGUAGE sql AS $$ SELECT an_argument_name $$;
        CREATE FUNCTION retained_function_with_a_long_public_signature(an_argument_name text) RETURNS text LANGUAGE sql AS $$ SELECT an_argument_name $$;
        CREATE TRIGGER retained BEFORE INSERT ON items FOR EACH ROW EXECUTE FUNCTION retain()`);
      const source = (await readSchema(connection)).catalog;
      const overloaded = source.filter((object) => object.type === 'function' && object.name.startsWith('retained_function_'));
      assert.equal(overloaded.length, 2);
      assert.equal(new Set(overloaded.map(physicalObjectKey)).size, 2);
      assert.ok(overloaded.every((object) => object.name.length > 63));
      assert.ok(source.some((object) => object.type === 'dependency' && object.metadata.extension === 'plpgsql'
        && typeof object.metadata.extensionVersion === 'string'));
      const steps = [{ kind: 'ddl', sql: 'ALTER TABLE items ADD COLUMN extra integer DEFAULT 7' },
        { kind: 'ddl', sql: "CREATE FUNCTION message() RETURNS text LANGUAGE plpgsql AS $body$ BEGIN RETURN 'COMMIT; keep  two spaces'; END $body$" }];
      let target;
      await assert.rejects(connection.transaction(async (tx) => {
        for (const step of steps) await tx.exec(step.sql);
        target = { dialect: 'postgres', schema, catalog: (await readSchema(tx)).catalog };
        throw new Error('review fixture only');
      }), /review fixture only/);
      const plan = JSON.parse(JSON.stringify(await planPhysicalMigration(connection, model, model, {
        id: 'native-change', steps, dispositions: Object.fromEntries(source.map((o) => [physicalObjectKey(o), 'preserve'])),
        physicalTarget: target, assertions: [{ sql: 'SELECT id::text AS id,label FROM items ORDER BY id', expected: [{ id: '1', label: 'original' }] }],
      })));
      assert.equal(plan.physical.source.length, source.length);
      assert.deepEqual((await migrate({ connection }, [plan], { baseline: model, shadow: false })).applied, ['native-change']);
      assert.deepEqual(await (await connection.prepare('SELECT id::text AS id,label,extra FROM items')).all([]), [{ id: '1', label: 'original', extra: 7 }]);
      assert.equal((await (await connection.prepare('SELECT message() AS value')).get([])).value, 'COMMIT; keep  two spaces');
      const receipt = await (await connection.prepare('SELECT * FROM _jaren_migrations')).all([]);
      assert.deepEqual(await migrate({ connection }, [plan], { baseline: model, shadow: false }), { applied: [], skipped: ['native-change'], upToDate: true });
      assert.deepEqual(await (await connection.prepare('SELECT * FROM _jaren_migrations')).all([]), receipt);
      assert.equal((await migrationStatus({ connection }, [plan])).upToDate, true);
      assert.equal((await (await connection.prepare("INSERT INTO items(label) VALUES('next') RETURNING id::text AS id")).get([])).id, '2');
      const changed = structuredClone(plan); changed.steps[0].sql += ' ';
      await assert.rejects(migrate({ connection }, [changed], { baseline: model, shadow: false }), { code: 'JD0022' });
      await connection.exec('ALTER TABLE items DISABLE ROW LEVEL SECURITY');
      await assert.rejects(migrate({ connection }, [plan], { baseline: model, shadow: false }), { code: 'JD0023' });
      assert.match((await migrationStatus({ connection }, [plan])).drift, /^different/);
    } finally { await connection?.close(); await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool.end(); }
  });
});
