//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { migrate, migrationStatus, migrationHistory } from '../../packages/db/src/migrate.js';
import { EMPTY, hosts, document, legacy, fixture, all, run, rejected } from './migration-identity-helpers.js';

const initial = document('first', [
  { kind: 'sql', sql: 'CREATE TABLE witness(value TEXT)' },
  { kind: 'sql', sql: "INSERT INTO witness VALUES('first')" },
]);
const tail = document('tail', [{ kind: 'sql', sql: "INSERT INTO witness VALUES('tail')" }]);
const options = { baseline: EMPTY, shadow: false };

for (const host of hosts) describe(`${host}: exact migration authority`, () => {
  it('observes a fresh database without creating metadata or registering functions', async () => {
    await fixture(host, async (connection) => {
      const borrowed = { ...connection, registerFunction() { assert.fail('history reads do not register application functions'); } };
      const result = migrationHistory({ connection: borrowed });
      if (host === 'sqlite') assert.equal(result?.then, undefined);
      assert.deepEqual(await result, { version: 1, dialect: host, order: host === 'sqlite' ? 'rowid' : 'rid',
        history: { present: false, rows: [] }, identity: { present: false, rows: [] } });
      assert.deepEqual(await all(connection, connection.dialect.introspect.tables()), []);
    });
  });

  it('binds every actual stored field and remains unchanged on an exact repeat', async () => {
    await fixture(host, async (connection) => {
      const result = migrate({ connection }, [initial], options);
      if (host === 'sqlite') assert.equal(result?.then, undefined);
      assert.deepEqual((await result).applied, ['first']);
      const before = await migrationHistory({ connection });
      const receipt = JSON.parse(before.identity.rows.find((row) => row.key === 'receipt:0').value);
      assert.equal(receipt.document, canonicalizeJson(initial));
      assert.equal(receipt.row, canonicalizeJson(before.history.rows[0]));
      assert.equal(typeof before.history.rows[0].applied_at, 'string');
      assert.equal(before.history.rows[0].steps, '2');
      assert.equal(before.history.rows[0][before.order], '1');
      assert.deepEqual(await migrate({ connection }, [initial], options), { applied: [], skipped: ['first'], upToDate: true });
      assert.equal((await migrationStatus({ connection }, [initial])).upToDate, true);
      assert.deepEqual(await migrationHistory({ connection }), before);
    });
  });

  for (const surface of ['apply', 'status', 'dryRun']) it(`${surface} refuses newly pending legacy work before metadata exists`, async () => {
    await fixture(host, async (connection) => {
      const old = legacy('legacy', [{ kind: 'sql', sql: 'CREATE TABLE forbidden(v TEXT)' }]);
      await rejected(() => surface === 'status' ? migrationStatus({ connection }, [old])
        : migrate({ connection }, [old], { ...options, dryRun: surface === 'dryRun' }), 'JD0028');
      assert.deepEqual((await migrationHistory({ connection })).history, { present: false, rows: [] });
      assert.deepEqual(await all(connection, connection.dialect.introspect.tables()), []);
    });
  });

  for (const field of ['id', 'applied_at', 'from_hash', 'to_hash', 'checksum', 'steps', 'order'])
    it(`refuses a changed original ${field} before a pending link`, async () => {
      await fixture(host, async (connection) => {
        await migrate({ connection }, [initial], options);
        const name = field === 'order' ? connection.dialect.identityColumn?.name ?? 'rowid' : field;
        const value = ['applied_at', 'steps', 'order'].includes(field) ? 999 : `changed-${field}`;
        await run(connection, `UPDATE _jaren_migrations SET "${name}"=${connection.dialect.parameterRef(1, 'value')}`, [value]);
        const before = await migrationHistory({ connection });
        await rejected(() => migrationStatus({ connection }, [initial]), 'JD0022');
        await rejected(() => migrate({ connection }, [initial, tail], options), 'JD0022');
        assert.deepEqual(await migrationHistory({ connection }), before);
        assert.deepEqual((await all(connection, 'SELECT value FROM witness')).map((row) => row.value), ['first']);
      });
    });

  const corruptions = {
    missingHeader: "DELETE FROM _jaren_migration_identity WHERE key='header'",
    missingReceipt: "DELETE FROM _jaren_migration_identity WHERE key='receipt:0'",
    extraReceipt: "INSERT INTO _jaren_migration_identity(key,value) SELECT 'receipt:1',value FROM _jaren_migration_identity WHERE key='receipt:0'",
    extraKey: "INSERT INTO _jaren_migration_identity(key,value) VALUES('unknown','null')",
    malformed: "UPDATE _jaren_migration_identity SET value='{' WHERE key='header'",
    unsupported: "UPDATE _jaren_migration_identity SET value='{\"legacyCount\":0,\"legacyModel\":null,\"legacyTarget\":null,\"version\":2}' WHERE key='header'",
    empty: 'DELETE FROM _jaren_migration_identity',
    absent: 'DROP TABLE _jaren_migration_identity',
    column: 'ALTER TABLE _jaren_migration_identity ADD COLUMN unwanted TEXT',
  };
  for (const [name, sql] of Object.entries(corruptions)) it(`refuses ${name} identity metadata without repairing it`, async () => {
    await fixture(host, async (connection) => {
      await migrate({ connection }, [initial], options);
      await connection.exec(sql);
      const before = await migrationHistory({ connection });
      await rejected(() => migrate({ connection }, [initial, tail], options), 'JD0022');
      await rejected(() => migrationStatus({ connection }, [initial]), 'JD0022');
      assert.deepEqual(await migrationHistory({ connection }), before);
    });
  });

  for (const atomic of [false, true]) it(`${atomic ? 'atomic' : 'link'} rollback pairs normal and exact receipts`, async () => {
    await fixture(host, async (connection) => {
      const failed = document('failed', [{ kind: 'sql', sql: 'INSERT INTO missing_table VALUES(1)' }]);
      await rejected(() => migrate({ connection }, [initial, failed], { ...options, atomic }), 'JD0023');
      const observed = await migrationHistory({ connection });
      assert.deepEqual(observed.history.rows.map((row) => row.id), atomic ? [] : ['first']);
      assert.equal(observed.identity.rows.length, atomic ? 0 : 2);
      if (!atomic) assert.equal((await migrationStatus({ connection }, [initial])).upToDate, true);
    });
  });

  it('rolls back application work when its exact receipt insert fails', async () => {
    await fixture(host, async (connection) => {
      const failure = new Error('injected exact receipt failure');
      const wrap = (scope) => ({ ...scope,
        prepare(sql, metadata) {
          if (sql.startsWith('INSERT INTO "_jaren_migration_identity"')) throw failure;
          return scope.prepare(sql, metadata);
        },
        transaction: (fn, ...args) => scope.transaction((child) => fn(wrap(child)), ...args),
      });
      const wrapped = { ...wrap(connection), ...(connection.exclusively ? {
        exclusively: (fn, ...args) => connection.exclusively((scope) => fn(wrap(scope)), ...args),
      } : {}) };
      await assert.rejects(async () => migrate({ connection: wrapped }, [initial], options), (error) => error === failure);
      assert.deepEqual(await migrationHistory({ connection }), { version: 1, dialect: host, order: host === 'sqlite' ? 'rowid' : 'rid',
        history: { present: false, rows: [] }, identity: { present: false, rows: [] } });
    });
  });
});

for (const host of hosts) for (const values of [['2', '10'], ['-9007199254740993', '-9007199254740992']])
  it(`${host}: lossless order ${values.join(', ')} uses numeric history order`, async () => {
    await fixture(host, async (connection) => {
      const { seedLegacy } = await import('./migration-identity-helpers.js');
      const docs = [legacy('first'), legacy('second')];
      await seedLegacy(connection, docs);
      const order = connection.dialect.identityColumn?.name ?? 'rowid';
      await connection.exec(`UPDATE _jaren_migrations SET "${order}" = -"${order}"`);
      for (let at = 0; at < values.length; at++) {
        await run(connection, `UPDATE _jaren_migrations SET "${order}"=${connection.dialect.parameterRef(1, 'order')} WHERE id=${connection.dialect.parameterRef(2, 'id')}`,
          [values[at], docs[at].id]);
      }
      const observed = await migrationHistory({ connection });
      assert.deepEqual(observed.history.rows.map((row) => row.id), ['first', 'second']);
      assert.deepEqual(observed.history.rows.map((row) => row[order]), values);
    });
  });

it('status inspects a pending exact draft while execution retains the draft refusal', async () => {
  await fixture('sqlite', async (connection) => {
    const draft = document('draft', [{ kind: 'jslt', collection: 'items', stylesheet: [], draft: true }]);
    assert.deepEqual(migrationStatus({ connection }, [draft]).pending, ['draft']);
    await rejected(() => migrate({ connection }, [draft], options), 'JD0021');
    const old = legacy('legacy-draft', draft.steps);
    await rejected(() => migrate({ connection }, [old], options), 'JD0028');
    assert.equal(migrationHistory({ connection }).history.present, false);
  });
});

for (const host of hosts) it(`${host}: colliding model fingerprints cannot replace exact baseline, links or target`, async () => {
  await fixture(host, async (connection) => {
    const model = (value) => ({ $model: '0.1', collections: { items: {
      key: '/id', schema: { type: 'object', properties: { id: { type: 'string' }, n: { const: value } } },
    } } });
    const a = model('159koso'), b = model('gnt19f');
    const initial = document('same', [], a);
    assert.equal(initial.from, '15ta7pe');
    assert.equal(document('other', [], b).from, initial.from);
    assert.notEqual(initial.identity.from, document('other', [], b).identity.from);
    await rejected(() => migrate({ connection }, [initial], { baseline: b, shadow: false }), 'JD0020');
    assert.equal((await migrationHistory({ connection })).history.present, false);
    await migrate({ connection }, [initial], { baseline: a, shadow: false });
    const before = await migrationHistory({ connection });
    await rejected(() => migrate({ connection }, [initial, document('tail', [], b)], { baseline: a, shadow: false }), 'JD0020');
    await rejected(() => migrationStatus({ connection }, [initial], { model: b }), 'JD0020');
    assert.deepEqual(await migrationHistory({ connection }), before);
  });
});
