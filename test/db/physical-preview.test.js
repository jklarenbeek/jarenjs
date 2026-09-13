//@ts-check
/** A physical preview counts current relations without executing planned SQL. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, planPhysicalMigration, planTableMigration, readSchema, shapeHash } from '@jarenjs/db';

async function fixture(run) {
  const driver = process.versions.bun ? (await import('@jarenjs/db/bun')).bunDriver()
    : (await import('@jarenjs/db/node')).nodeDriver();
  const connection = await driver.open(':memory:');
  try { await run(connection); } finally { connection.close(); }
}
const modelFor = (table, kind = 'table') => ({ $model: '0.1', entities: { Item: {
  schema: { type: 'object', properties: {
    id: { type: 'integer', 'x-entity': { key: true } }, value: { type: 'string' },
  } }, physical: { table, kind, keys: ['id'], columns: {
    id: { name: 'id', codec: 'integer', null: 'reject' },
    value: { name: 'value', codec: 'text', null: 'reject' },
  } },
} } });
const table = { name: 'items', primaryKey: ['id'], columns: [
  { name: 'id', type: 'INTEGER' }, { name: 'value', type: 'TEXT' },
] };
const rowsOf = (connection) => connection.prepare('SELECT * FROM items ORDER BY id').all([]).map((row) => ({ ...row }));
const transform = (model) => ({ kind: 'jslt', collection: 'Item', model,
  stylesheet: [{ match: '$', body: { id: '$.id', value: { $upper: '$.value' } } }] });
const document = (id, model, steps) => ({ $migration: '0.1', id,
  from: shapeHash(model), to: shapeHash(model), steps });

it('a fresh guarded table followed by SQL and a transform previews twice with an unknown count, then applies', async () => fixture((connection) => {
  const model = modelFor('items');
  const plan = planTableMigration(connection, table, { id: 'create-items' });
  const steps = [{ kind: 'table', plan }, { kind: 'sql', sql: "INSERT INTO items VALUES(1,'example')" }, transform(model)];
  const migration = planPhysicalMigration(connection, model, model, { id: 'create-items', steps, dispositions: {} });
  const before = readSchema(connection);
  let previous;
  for (let run = 0; run < 2; run++) {
    const preview = migrate({ connection }, [migration], { baseline: model, model, shadow: false, dryRun: true });
    assert.equal(typeof preview?.then, 'undefined');
    assert.deepEqual(preview.counts, { Item: null });
    assert.equal(preview.shadowValidated, false);
    if (previous) assert.deepEqual(preview, previous);
    previous = preview;
    assert.deepEqual(readSchema(connection), before);
    assert.equal(connection.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='_jaren_migrations'").get([]).n, 0);
  }
  assert.deepEqual(migrate({ connection }, [migration], { baseline: model, model, shadow: false }).applied, ['create-items']);
  assert.deepEqual(rowsOf(connection), [{ id: 1, value: 'EXAMPLE' }]);
  assert.deepEqual(migrate({ connection }, [migration], { baseline: model, model, shadow: false }).applied, []);
  assert.deepEqual(rowsOf(connection), [{ id: 1, value: 'EXAMPLE' }]);
}));

it('an existing relation count describes current rows before pending SQL changes its membership', async () => fixture((connection) => {
  connection.exec("CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO items VALUES(1,'first'),(2,'second')");
  const model = modelFor('items');
  const migration = document('append-item', model,
    [{ kind: 'sql', sql: "INSERT INTO items VALUES(3,'third')" }, transform(model)]);
  const before = rowsOf(connection);
  for (let run = 0; run < 2; run++) {
    const preview = migrate({ connection }, [migration], { baseline: model, model, shadow: false, dryRun: true });
    assert.deepEqual(preview.counts, { Item: 2 });
    assert.deepEqual(rowsOf(connection), before);
    assert.equal(connection.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='_jaren_migrations'").get([]).n, 0);
  }
  assert.deepEqual(migrate({ connection }, [migration], { baseline: model, model, shadow: false }).applied, ['append-item']);
  assert.deepEqual(rowsOf(connection), [{ id: 1, value: 'FIRST' }, { id: 2, value: 'SECOND' }, { id: 3, value: 'THIRD' }]);
}));

it('relation discovery includes views while keeping a not-yet-created view count unknown', async () => fixture((connection) => {
  connection.exec("CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO items VALUES(1,'first');CREATE VIEW visible_items AS SELECT * FROM items");
  const before = readSchema(connection);
  for (const [name, expected] of [['visible_items', 1], ['future_items', null]]) {
    const model = modelFor(name, 'view');
    const migration = document(name, model, [{ kind: 'jslt', collection: 'Item', model, stylesheet: [] }]);
    for (let run = 0; run < 2; run++) {
      const preview = migrate({ connection }, [migration], { baseline: model, model, shadow: false, dryRun: true });
      assert.deepEqual(preview.counts, { Item: expected });
      assert.deepEqual(readSchema(connection), before);
    }
  }
}));
