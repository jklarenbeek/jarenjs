//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { migrate, migrationStatus, migrationHistory, adoptMigrationHistory, migrationChecksum, createModelShape } from '../../packages/db/src/migrate.js';
import { chain } from '../../packages/db/src/driver.js';
import { hosts, document as exactDocument, legacy as legacyDocument, fixture as hostFixture, all, run, seedLegacy, rejected } from './migration-identity-helpers.js';

const MODEL = { $model: '0.1', collections: { items: { schema: { type: 'object' }, key: '/id' } } };
const document = (id, steps = []) => exactDocument(id, steps, MODEL);
const legacy = (id, steps = [], model = MODEL) => legacyDocument(id, steps, model);
const fixture = (host, execute) => hostFixture(host, async (connection, context) => {
  await createModelShape(connection, MODEL);
  return execute(connection, context);
});

const initial = legacy('first', [
  { kind: 'sql', sql: 'CREATE TABLE witness(value TEXT)' },
  { kind: 'sql', sql: "INSERT INTO witness VALUES('first')" },
]);
const tail = document('tail', [{ kind: 'sql', sql: "INSERT INTO witness VALUES('tail')" }]);

for (const host of hosts) describe(`${host}: explicit legacy attestation`, () => {
  it('adopts once, repeats the original observation without writes, then extends exact history', async () => {
    await fixture(host, async (connection) => {
      await seedLegacy(connection, [initial]);
      const observed = await migrationHistory({ connection });
      await rejected(() => migrationStatus({ connection }, [initial]), 'JD0028');
      await rejected(() => migrate({ connection }, [initial], { baseline: MODEL, shadow: false }), 'JD0028');
      const result = adoptMigrationHistory({ connection }, [initial], { observed, model: MODEL });
      if (host === 'sqlite') assert.equal(result?.then, undefined);
      assert.deepEqual(await result, { adopted: 1, unchanged: 0 });
      const after = await migrationHistory({ connection });
      assert.deepEqual(after.history, observed.history);
      assert.deepEqual(await adoptMigrationHistory({ connection }, [initial], { observed, model: MODEL }), { adopted: 0, unchanged: 1 });
      assert.deepEqual(await migrationHistory({ connection }), after);
      assert.equal((await migrationStatus({ connection }, [initial])).upToDate, true);
      assert.deepEqual((await migrate({ connection }, [initial, tail], { baseline: MODEL, shadow: false })).applied, ['tail']);
      const extended = await migrationHistory({ connection });
      assert.deepEqual(extended.history.rows[0], observed.history.rows[0]);
      assert.deepEqual(extended.identity.rows.find((row) => row.key === 'header'), after.identity.rows.find((row) => row.key === 'header'));
      await rejected(() => adoptMigrationHistory({ connection }, [initial], { observed, model: MODEL }), 'JD0022');
    });
  });

  it('binds the fixed legacy checksum collision to the actually attested document', async () => {
    await fixture(host, async (connection) => {
      const model = { $model: '0.1', collections: { items: { schema: { type: 'object' }, key: '/id' } } };
      const docs = ['p6oqx0', 'e6rrp7'].map((suffix) => legacy('same', [
        { kind: 'sql', sql: `CREATE TABLE IF NOT EXISTS collision_example_${suffix} (id INTEGER)` },
      ], model));
      assert.equal(migrationChecksum(docs[0]), 'fiebr3');
      assert.equal(migrationChecksum(docs[1]), 'fiebr3');
      await seedLegacy(connection, [docs[0]]);
      const observed = await migrationHistory({ connection });
      await adoptMigrationHistory({ connection }, [docs[0]], { observed, model });
      await rejected(() => migrationStatus({ connection }, [docs[1]]), 'JD0022');
      await rejected(() => migrate({ connection }, [docs[1]], { baseline: model, shadow: false }), 'JD0022');
      await rejected(() => adoptMigrationHistory({ connection }, [docs[1]], { observed, model }), 'JD0022');
      assert.deepEqual((await migrationHistory({ connection })).history, observed.history);
    });
  });

  for (const field of ['id', 'applied_at', 'from_hash', 'to_hash', 'checksum', 'steps'])
    it(`refuses a stale observed ${field} before side metadata is created`, async () => {
      await fixture(host, async (connection) => {
        await seedLegacy(connection, [initial]);
        const observed = await migrationHistory({ connection });
        await run(connection, `UPDATE _jaren_migrations SET "${field}"=${connection.dialect.parameterRef(1, 'v')}`,
          [field === 'steps' || field === 'applied_at' ? 99 : 'changed']);
        await rejected(() => adoptMigrationHistory({ connection }, [initial], { observed, model: MODEL }), 'JD0022');
        assert.equal((await migrationHistory({ connection })).identity.present, false);
      });
    });

  it('refuses partial applied lists and pending tails without trimming them', async () => {
    await fixture(host, async (connection) => {
      const second = legacy('second');
      await seedLegacy(connection, [initial, second]);
      const observed = await migrationHistory({ connection });
      for (const docs of [[initial], [second, initial], [initial, second, legacy('pending')], [initial, document('second')]]) {
        await rejected(() => adoptMigrationHistory({ connection }, docs, { observed, model: MODEL }), 'JD0022');
      }
      assert.equal((await migrationHistory({ connection })).identity.present, false);
    });
  });

  it('snapshots observed documents, model and physical target before registration callbacks', async () => {
    await fixture(host, async (connection) => {
      await seedLegacy(connection, [initial]);
      const observed = await migrationHistory({ connection });
      const inputs = structuredClone({ observed, model: MODEL, docs: [initial], physicalTarget: { objects: [], tables: [] } });
      let calls = 0;
      const options = { observed: inputs.observed, model: inputs.model, physicalTarget: inputs.physicalTarget,
        registerFunctions() {
          calls++;
          inputs.observed.history.rows[0].checksum = 'mutated';
          inputs.docs[0].steps[0].sql = 'DROP TABLE witness';
          inputs.model.$model = 'corrupt';
          inputs.physicalTarget.objects.push({ type: 'table' });
        } };
      if (host === 'postgres') delete options.physicalTarget;
      assert.deepEqual(await adoptMigrationHistory({ connection }, inputs.docs, options), { adopted: 1, unchanged: 0 });
      assert.equal(calls, 1);
      const after = await migrationHistory({ connection });
      assert.deepEqual(after.history, observed.history);
      const receipt = JSON.parse(after.identity.rows.find((row) => row.key === 'receipt:0').value);
      assert.equal(receipt.document, canonicalizeJson(initial));
      const header = JSON.parse(after.identity.rows.find((row) => row.key === 'header').value);
      assert.equal(header.legacyModel, canonicalizeJson(MODEL));
      if (host === 'sqlite') assert.equal(header.legacyTarget, canonicalizeJson({ objects: [], tables: [] }));
    });
  });

  it('rolls back all side rows when cancellation arrives during their write loop', async () => {
    await fixture(host, async (connection) => {
      const docs = [initial, legacy('second')];
      await seedLegacy(connection, docs);
      const observed = await migrationHistory({ connection });
      const controller = new AbortController();
      let inserts = 0;
      const wrap = (scope) => ({ ...scope,
        prepare(sql, metadata) {
          return chain(scope.prepare(sql, metadata), (statement) => sql.startsWith('INSERT INTO "_jaren_migration_identity"')
            ? { ...statement, run: (params) => chain(statement.run(params), (result) => {
              if (++inserts === 1) controller.abort();
              return result;
            }) } : statement);
        },
        transaction: (fn, ...args) => scope.transaction((child) => fn(wrap(child)), ...args),
      });
      const wrapped = { ...wrap(connection), ...(connection.exclusively ? {
        exclusively: (fn, ...args) => connection.exclusively((scope) => fn(wrap(scope)), ...args),
      } : {}) };
      await rejected(() => adoptMigrationHistory({ connection: wrapped }, docs, { observed, model: MODEL, signal: controller.signal }), 'JD2080');
      assert.equal(inserts, 1);
      assert.deepEqual(await migrationHistory({ connection }), observed);
    });
  });

  for (const field of ['legacyTarget', 'legacyModel']) it(`classifies unsupported stored ${field} as metadata disagreement`, async () => {
    await fixture(host, async (connection) => {
      await seedLegacy(connection, [initial]);
      const observed = await migrationHistory({ connection });
      await adoptMigrationHistory({ connection }, [initial], { observed, model: MODEL });
      const rows = await all(connection, "SELECT value FROM _jaren_migration_identity WHERE key='header'");
      const header = JSON.parse(rows[0].value);
      header[field] = '{}';
      await run(connection, `UPDATE _jaren_migration_identity SET value=${connection.dialect.parameterRef(1, 'v')} WHERE key='header'`, [canonicalizeJson(header)]);
      await rejected(() => migrationStatus({ connection }, [initial]), 'JD0022');
      await rejected(() => migrate({ connection }, [initial, tail], { baseline: MODEL, shadow: false }), 'JD0022');
    });
  });
});

for (const host of hosts) it(`${host}: admission snapshots survive an owned acquisition pause`, async () => {
  await fixture(host, async (connection) => {
    await seedLegacy(connection, [initial]);
    const observed = await migrationHistory({ connection });
    const inputs = structuredClone({ observed, model: MODEL, docs: [initial] });
    let release, closes = 0, registrations = 0, validations = 0;
    const waiting = new Promise((resolve) => { release = resolve; });
    const driver = { open: () => waiting.then(() => ({ ...connection, close() { closes++; } })) };
    const pending = adoptMigrationHistory({ driver }, inputs.docs, {
      observed: inputs.observed, model: inputs.model,
      registerFunctions() { registrations++; },
      compileSchema() { validations++; return () => true; },
    });
    inputs.observed.history.rows[0].id = 'after-admission';
    inputs.docs[0].id = 'after-admission';
    inputs.model.collections.items.schema = { type: 'string' };
    release();
    assert.deepEqual(await pending, { adopted: 1, unchanged: 0 });
    assert.equal(closes, 1);
    assert.equal(registrations, 1);
    assert.equal(validations, 1);
    assert.deepEqual((await migrationHistory({ connection })).history, observed.history);
  });
});

for (const host of hosts) it(`${host}: preserves large numeric receipt text and signed order during adoption and append`, async () => {
  await fixture(host, async (connection) => {
    await seedLegacy(connection, [initial]);
    const order = connection.dialect.identityColumn?.name ?? 'rowid';
    const timestamp = host === 'postgres' ? '9007199254740993.2500' : '9007199254740993';
    await run(connection, `UPDATE _jaren_migrations SET "${order}"=-9007199254740993, applied_at=${connection.dialect.parameterRef(1, 'v')}`, [timestamp]);
    const observed = await migrationHistory({ connection });
    assert.equal(observed.history.rows[0][order], '-9007199254740993');
    assert.equal(observed.history.rows[0].applied_at, timestamp);
    await adoptMigrationHistory({ connection }, [initial], { observed, model: MODEL });
    await migrate({ connection }, [initial, tail], { baseline: MODEL, shadow: false });
    assert.deepEqual((await migrationHistory({ connection })).history.rows[0], observed.history.rows[0]);
  });
});

if (hosts.includes('postgres')) {
  it('postgres: finite arbitrary-precision timestamps retain decimal scale without Number conversion', async () => {
    await fixture('postgres', async (connection) => {
      await seedLegacy(connection, [initial]);
      await connection.exec("UPDATE _jaren_migrations SET applied_at = '1e1000'::numeric");
      const observed = await migrationHistory({ connection });
      assert.equal(observed.history.rows[0].applied_at, `1${'0'.repeat(1000)}`);
      assert.deepEqual(await adoptMigrationHistory({ connection }, [initial], { observed, model: MODEL }), { adopted: 1, unchanged: 0 });
      assert.deepEqual((await migrationHistory({ connection })).history, observed.history);
    });
  });

  for (const sql of ["UPDATE _jaren_migrations SET applied_at='NaN'::numeric",
    'UPDATE _jaren_migrations SET applied_at=NULL', 'UPDATE _jaren_migrations SET steps=2.0'])
    it(`postgres: observes but cannot attest invalid native payload: ${sql}`, async () => {
      await fixture('postgres', async (connection) => {
        await seedLegacy(connection, [initial]);
        await connection.exec(sql);
        const observed = await migrationHistory({ connection });
        await rejected(() => adoptMigrationHistory({ connection }, [initial], { observed, model: MODEL }), 'JD0022');
        assert.deepEqual(await migrationHistory({ connection }), observed);
      });
    });

  it('postgres: duplicate original rid values refuse without renumbering history', async () => {
    await fixture('postgres', async (connection) => {
      const docs = [initial, legacy('second')];
      await seedLegacy(connection, docs);
      await connection.exec('UPDATE _jaren_migrations SET rid=1');
      const observed = await migrationHistory({ connection });
      assert.deepEqual(observed.history.rows.map((row) => row.rid), ['1', '1']);
      await rejected(() => adoptMigrationHistory({ connection }, docs, { observed, model: MODEL }), 'JD0022');
      assert.deepEqual(await migrationHistory({ connection }), observed);
    });
  });

  for (const table of ['_jaren_migrations', '_jaren_migration_identity'])
    it(`postgres: ${table} rewrite rules cannot become migration authority`, async () => {
      await fixture('postgres', async (connection) => {
        await seedLegacy(connection, [initial]);
        const observed = await migrationHistory({ connection });
        await adoptMigrationHistory({ connection }, [initial], { observed, model: MODEL });
        await connection.exec(`CREATE RULE discard_receipt AS ON INSERT TO ${table} DO INSTEAD NOTHING`);
        const before = await migrationHistory({ connection });
        await rejected(() => migrate({ connection }, [initial, tail], { baseline: MODEL, shadow: false }), 'JD0022');
        await rejected(() => adoptMigrationHistory({ connection }, [initial], { observed, model: MODEL }), 'JD0022');
        assert.deepEqual(await migrationHistory({ connection }), before);
        assert.deepEqual((await all(connection, 'SELECT value FROM witness')).map((row) => row.value), ['first']);
      });
    });
}
