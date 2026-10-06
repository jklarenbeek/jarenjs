//@ts-check
/** Migration execution and receipts use the JSON admitted before host work. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { migrationIdentity } from './migration-fixture.js';
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { JarenValidator } from '@jarenjs/validate';
import { migrate, migrationStatus, migrationChecksum, shapeHash, readSchema, openStore, createModelShape, planInvariants } from '@jarenjs/db';
import { postgresDriver } from '@jarenjs/db/postgres';
import { useStatementOnce } from '../../packages/db/src/driver.js';
import { tempDbPath } from './helpers.js';
import { ruleModel, RULE_TABLES } from './invariant-oracle.js';

const nativeDriver = process.versions.bun ? (await import('@jarenjs/db/bun')).bunDriver
  : (await import('@jarenjs/db/node')).nodeDriver;
const emptyModel = () => ({ $model: '0.1', collections: {} });
const collectionModel = () => ({ $model: '0.1', collections: { docs: { schema: { type: 'object' }, key: '/id' } } });
const link = (id, steps, model = emptyModel()) => ({
  $migration: '0.2', identity: migrationIdentity(model), id, from: shapeHash(model), to: shapeHash(model), steps,
});
const sqlStep = (name) => ({ kind: 'sql', sql: `CREATE TABLE ${name}(n INTEGER)` });
const hostStep = { kind: 'host', run: 'change', version: '1' };
const rows = (connection, sql) => useStatementOnce(connection, sql, (statement) => statement.all([]));
const receipt = async (connection) => (await rows(connection, 'SELECT * FROM _jaren_migrations'))[0];
const compileSchema = (schema) => new JarenValidator().compile(schema);
let schemaNumber = 0;

async function withDatabase(host, run) {
  const temp = tempDbPath();
  let pool, schema, connection;
  try {
    let driver = nativeDriver();
    if (host === 'postgres') {
      const { default: pg } = await import('pg');
      pool = new pg.Pool({ connectionString: process.env.JAREN_PG_URL, max: 3 });
      schema = `jaren_admission_${process.pid}_${schemaNumber++}`;
      await pool.query(`CREATE SCHEMA "${schema}"`);
      driver = postgresDriver(pool, { schema });
    }
    const path = host === 'postgres' ? ':memory:' : temp.dbPath;
    connection = await driver.open(path);
    return await run({ connection, driver, path, schema });
  }
  finally {
    await connection?.close();
    if (pool !== undefined) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
    temp.cleanup();
  }
}

/** Pause actual acquisition, preserving the real owned connection and cleanup. */
function pausedDriver(driver) {
  let resume;
  const waiting = new Promise((resolve) => { resume = resolve; });
  const counts = { opened: 0, closed: 0 };
  return { resume, counts, driver: { ...driver, async open(...args) {
    await waiting;
    const connection = await driver.open(...args);
    counts.opened++;
    return { ...connection, close() { counts.closed++; return connection.close(); } };
  } } };
}

async function targetOf(connection, schema) {
  const catalog = await readSchema(connection);
  return schema === undefined ? { objects: catalog.objects }
    : { dialect: 'postgres', schema, catalog: catalog.catalog };
}

for (const host of ['sqlite', 'postgres']) describe(`${host}: immutable migration admission`,
  { skip: host === 'postgres' && !process.env.JAREN_PG_URL && 'JAREN_PG_URL is not set' }, () => {
    it('a host cannot replace the receipt with SQL that never executed', async () => {
      await withDatabase(host, async ({ connection }) => {
        const doc = link('receipt', [sqlStep('executed'), hostStep]);
        const admitted = structuredClone(doc);
        const result = migrate({ connection }, [doc], { baseline: emptyModel(), shadow: false,
          hosts: { change: { version: '1', run() { doc.steps[0].sql = sqlStep('never_executed').sql; } } } });
        if (host === 'sqlite') assert.equal(result?.then, undefined, 'borrowed native execution stays synchronous');
        assert.deepEqual((await result).applied, ['receipt']);
        assert.deepEqual(await rows(connection, 'SELECT * FROM executed'), []);
        assert.equal((await receipt(connection)).checksum, migrationChecksum(admitted));
        await assert.rejects(async () => migrate({ connection }, [doc], { baseline: emptyModel(), shadow: false }), { code: 'JD0022' });
        assert.deepEqual(await migrate({ connection }, [admitted], { baseline: emptyModel(), shadow: false }),
          { applied: [], skipped: ['receipt'], upToDate: true });
      });
    });

    it('later links and their step lists are admitted before the first host runs', async () => {
      await withDatabase(host, async ({ connection }) => {
        const docs = [link('first', [hostStep]), link('second', [sqlStep('original_tail')])];
        const admitted = structuredClone(docs);
        const result = await migrate({ connection }, docs, { baseline: emptyModel(), shadow: false,
          hosts: { change: { version: '1', run() {
            docs[1].id = 'changed';
            docs[1].steps[0].sql = sqlStep('changed_tail').sql;
            docs.push(link('unadmitted', [sqlStep('unadmitted_tail')]));
          } } } });
        assert.deepEqual(result.applied, ['first', 'second']);
        assert.deepEqual(await rows(connection, 'SELECT * FROM original_tail'), []);
        assert.deepEqual((await rows(connection, 'SELECT id, checksum FROM _jaren_migrations ORDER BY id'))
          .map((row) => ({ ...row })), admitted.map((doc) => ({ id: doc.id, checksum: migrationChecksum(doc) })));
        assert.equal(docs[1].id, 'changed', 'the caller retains its own edits');
        assert.equal(docs.length, 3);
      });
    });

    it('a host cannot weaken the admitted target model before final validation', async () => {
      await withDatabase(host, async ({ connection, driver, path }) => {
        const baseline = { $model: '0.1', collections: { docs: {
          schema: { type: 'object', properties: { name: { type: 'string' } } }, key: '/id',
        } } };
        const model = structuredClone(baseline);
        model.collections.docs.schema.properties.name.maxLength = 3;
        const store = await openStore(baseline, { driver, path });
        await store.collection('docs').put({ id: 'a', name: 'too long' });
        await store.close();
        const doc = { ...link('narrow', [hostStep], baseline), identity: migrationIdentity(baseline, model), to: shapeHash(model) };
        await assert.rejects(async () => migrate({ connection }, [doc], { baseline, model,
          shadow: false, compileSchema, hosts: { change: { version: '1', run() {
            model.collections.docs.schema.properties.name.maxLength = 100;
          } } } }), { code: 'JD0021' });
        assert.equal(model.collections.docs.schema.properties.name.maxLength, 100);
        assert.deepEqual((await migrationStatus({ connection }, [])).applied, []);
        const reopened = await openStore(baseline, { driver, path });
        try { assert.deepEqual(await reopened.collection('docs').all(), [{ id: 'a', name: 'too long' }]); }
        finally { await reopened.close(); }
      });
    });

    it('a host cannot replace the reviewed physical target with the shape it just wrote', async () => {
      await withDatabase(host, async ({ connection, schema }) => {
        await connection.exec('CREATE TABLE item(n INTEGER)');
        const physicalTarget = await targetOf(connection, schema);
        const admitted = structuredClone(physicalTarget);
        const doc = link('physical', [{ kind: 'sql', sql: 'ALTER TABLE item ADD COLUMN unexpected INTEGER' }, hostStep]);
        const mutate = (scope) => {
          const catalog = readSchema(scope);
          const change = (value) => {
            if (schema === undefined) physicalTarget.objects = value.objects;
            else physicalTarget.catalog = value.catalog;
          };
          return catalog?.then ? catalog.then(change) : change(catalog);
        };
        // The host scope intentionally exposes no raw connection; use its
        // currently admitted transaction through a registration wrapper.
        let active = connection;
        const wrap = (scope) => ({ ...scope, transaction(fn, ...args) {
          return scope.transaction((child) => { active = child; return fn(wrap(child)); }, ...args);
        } });
        const wrapped = { ...wrap(connection), ...(connection.exclusively === undefined ? {} : {
          exclusively: (fn, ...args) => connection.exclusively((scope) => fn(wrap(scope)), ...args),
        }) };
        await assert.rejects(async () => migrate({ connection: wrapped }, [doc], {
          baseline: emptyModel(), physicalTarget, shadow: false,
          hosts: { change: { version: '1', run: () => mutate(active) } },
        }), { code: 'JD0023' });
        assert.deepEqual(await targetOf(connection, schema), admitted, 'refusal rolls back the changed physical shape');
        assert.notDeepEqual(physicalTarget, admitted, 'the caller mutation is neither frozen nor undone');
      });
    });

    it('an owned run admits the whole list before driver.open resolves and still closes once', async () => {
      await withDatabase(host, async ({ connection, driver, path }) => {
        const docs = [link('admitted', [sqlStep('admitted_table')])];
        const saved = structuredClone(docs);
        const paused = pausedDriver(driver);
        const result = migrate({ driver: paused.driver, path }, docs, { baseline: emptyModel(), shadow: false });
        assert.equal(typeof result.then, 'function');
        docs[0].steps[0].sql = sqlStep('changed_table').sql;
        docs.push(link('late', [sqlStep('late_table')]));
        paused.resume();
        assert.deepEqual((await result).applied, ['admitted']);
        assert.deepEqual(await rows(connection, 'SELECT * FROM admitted_table'), []);
        assert.equal((await receipt(connection)).checksum, migrationChecksum(saved[0]));
        assert.deepEqual(paused.counts, { opened: 1, closed: 1 });
      });
    });

    it('status compares the list admitted before owned connection acquisition', async () => {
      await withDatabase(host, async ({ connection, driver, path }) => {
        const docs = [link('saved', [])];
        await migrate({ connection }, docs, { baseline: emptyModel(), shadow: false });
        const paused = pausedDriver(driver);
        const result = migrationStatus({ driver: paused.driver, path }, docs);
        docs[0].steps.push(sqlStep('not_applied'));
        paused.resume();
        assert.deepEqual(await result, { applied: ['saved'], pending: [], drift: null, upToDate: true, baseline: 'saved' });
        assert.deepEqual(paused.counts, { opened: 1, closed: 1 });
        await assert.rejects(async () => migrationStatus({ connection }, docs), { code: 'JD0022' });
      });
    });

    if (host === 'sqlite') it('keeps nonalphabetic model declarations consistent with their existing invariant trigger names', async () => {
      await withDatabase(host, async ({ connection, driver, path }) => {
        assert.deepEqual(Object.keys(ruleModel.entities), ['Entry', 'Audit']);
        await connection.exec(RULE_TABLES[host]);
        const baseline = structuredClone(ruleModel);
        baseline.entities.Entry.invariants = [];
        const steps = planInvariants(ruleModel, { dialect: connection.dialect })
          .map((statement) => ({ kind: 'ddl', sql: statement.sql }));
        const doc = { ...link('rules', steps, baseline), identity: migrationIdentity(baseline, ruleModel), to: shapeHash(ruleModel) };
        assert.deepEqual((await migrate({ connection }, [doc], {
          baseline, model: ruleModel, shadow: false,
        })).applied, ['rules']);
        const store = await openStore(ruleModel, { driver, path, adopt: true });
        try {
          await assert.rejects(store.entity('Entry').create({ start: 3, end: 2, phase: 'draft' }), { code: 'JD2096' });
          const value = await store.entity('Entry').create({ start: 1, end: 2, phase: 'draft' });
          assert.equal(value.start, 1); assert.equal(value.end, 2);
        }
        finally { await store.close(); }
      });
    });
  });

it('baseline and model are private before registration callbacks and remain mutable for their caller', async () => {
  await withDatabase('sqlite', async ({ connection }) => {
    const baseline = collectionModel(), model = collectionModel();
    createModelShape(connection, baseline);
    const options = { baseline, model, shadow: false, registerFunctions() {
      baseline.collections.late = { schema: { type: 'object' }, key: '/id' };
      model.collections.late = { schema: { type: 'object' }, key: '/id' };
    } };
    const doc = link('original', [], baseline);
    assert.deepEqual(migrate({ connection }, [doc], options).applied, ['original']);
    assert.equal(Object.hasOwn(baseline.collections, 'late'), true);
    assert.equal(Object.hasOwn(model.collections, 'late'), true);
    assert.equal(options.baseline, baseline);
  });
});

it('a registration callback cannot replace the admitted model through the options object', async () => {
  await withDatabase('sqlite', async ({ connection }) => {
    const baseline = collectionModel();
    createModelShape(connection, baseline);
    const options = { baseline, model: collectionModel(), shadow: false, registerFunctions() {
      options.model = { $model: '0.1', collections: { late: { schema: { type: 'object' }, key: '/id' } } };
    } };
    assert.deepEqual(migrate({ connection }, [link('original', [], baseline)], options).applied, ['original']);
    assert.equal(Object.hasOwn(options.model.collections, 'late'), true);
  });
});

it('the runtime clock cannot edit an already admitted step', async () => {
  await withDatabase('sqlite', async ({ connection }) => {
    const doc = link('clock', [sqlStep('before_clock')]);
    const admitted = structuredClone(doc);
    const outcome = migrate({ connection }, [doc], { baseline: emptyModel(), shadow: false,
      deadline: 100, runtime: { now() { doc.steps[0].sql = sqlStep('after_clock').sql; return 0; } } });
    assert.deepEqual(outcome.applied, ['clock']);
    assert.deepEqual(await rows(connection, 'SELECT * FROM before_clock'), []);
    assert.equal((await receipt(connection)).checksum, migrationChecksum(admitted));
  });
});

it('shadow and primary execute the same snapshot despite a shadow host editing caller SQL', async () => {
  await withDatabase('sqlite', async ({ connection, driver }) => {
    const baseline = collectionModel();
    createModelShape(connection, baseline);
    const doc = link('shadow', [sqlStep('both_ran'), hostStep], baseline);
    const admitted = structuredClone(doc), contexts = [];
    const result = await migrate({ connection }, [doc], { baseline, shadowDriver: driver,
      hosts: { change: { version: '1', run(_scope, ctx) {
        contexts.push(ctx.shadow);
        if (ctx.shadow) doc.steps[0].sql = sqlStep('only_primary').sql;
      } } } });
    assert.deepEqual(result.applied, ['shadow']);
    assert.deepEqual(contexts, [true, false]);
    assert.deepEqual(await rows(connection, 'SELECT * FROM both_ran'), []);
    assert.equal((await receipt(connection)).checksum, migrationChecksum(admitted));
  });
});

it('status snapshots its target model before a delayed open', async () => {
  await withDatabase('sqlite', async ({ connection, driver, path }) => {
    const model = collectionModel(), paused = pausedDriver(driver);
    createModelShape(connection, model);
    const result = migrationStatus({ driver: paused.driver, path }, [], { model });
    model.collections.late = { schema: { type: 'object' }, key: '/id' };
    paused.resume();
    assert.deepEqual(await result, { applied: [], pending: [], drift: null, upToDate: true, baseline: null });
    assert.deepEqual(paused.counts, { opened: 2, closed: 2 }, 'both owned primary and reference close');
  });
});

it('canonical admission preserves own __proto__ JSON and does not rewrite or freeze caller inputs', async () => {
  await withDatabase('sqlite', async ({ connection }) => {
    const doc = { ...link('json', []), metadata: JSON.parse('{"__proto__":{"safe":true},"z":1,"a":2}') };
    const baseline = emptyModel(), docs = [doc];
    const before = JSON.stringify({ docs, baseline }), keys = Object.keys(doc.metadata);
    const outcome = migrate({ connection }, docs, { baseline, shadow: false });
    assert.deepEqual(outcome.applied, ['json']);
    assert.equal((await receipt(connection)).checksum, migrationChecksum(doc));
    assert.equal(JSON.stringify({ docs, baseline }), before);
    assert.deepEqual(Object.keys(doc.metadata), keys);
    assert.equal(Object.hasOwn(doc.metadata, '__proto__'), true);
    assert.equal(Object.isFrozen(doc), false); assert.equal(Object.isFrozen(baseline), false);
    assert.equal(canonicalizeJson(doc.metadata), '{"__proto__":{"safe":true},"a":2,"z":1}');
  });
});

for (const borrowed of [true, false]) it(`${borrowed ? 'borrowed' : 'owned'} admission refuses non-JSON before opening or invoking hooks`, async () => {
  await withDatabase('sqlite', async ({ connection, driver, path }) => {
    for (const invalid of [undefined, () => {}, 1n, NaN, new Date(0)]) {
      const doc = { ...link('bad-json', [hostStep]), metadata: invalid };
      let opened = 0, called = 0;
      const target = borrowed ? { connection } : { path, driver: { ...driver, open(...args) {
        opened++; return driver.open(...args);
      } } };
      const run = () => migrate(target, [doc], { baseline: emptyModel(), shadow: false,
        registerFunctions() { called++; }, hosts: { change: { version: '1', run() { called++; } } } });
      if (borrowed) assert.throws(run, { name: 'JsonCanonicalizeError' });
      else await assert.rejects(run(), { name: 'JsonCanonicalizeError' });
      assert.equal(opened, 0); assert.equal(called, 0);
    }
  });
});
