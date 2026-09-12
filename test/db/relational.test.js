//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { relational, sql, planRelational, defineTable, planTable, explainMapping, planEntity, sqliteDialect } from '@jarenjs/db';
import { defineModel, object, integer, string } from '@jarenjs/linq/model';

const c = sql.column, b = sql.binary, call = sql.call;
async function fixture(run) {
  const driver = process.versions.bun ? (await import('@jarenjs/db/bun')).bunDriver() : (await import('@jarenjs/db/node')).nodeDriver();
  const connection = await driver.open(':memory:');
  try { await run(connection, relational(connection)); }
  finally { connection.close(); }
}
const items = () => defineTable({ name: 'items', columns: [
  { name: 'id', type: 'INTEGER', identity: 'autoincrement', nullable: false },
  { name: 'name', type: 'TEXT', collation: 'NOCASE' },
  { name: 'state', type: 'TEXT', nullable: false, default: 'draft' },
  { name: 'revision', type: 'INTEGER', nullable: false, default: 1, check: b('>=', c('revision'), 1) },
  { name: 'raw', type: 'TEXT' }, { name: 'bytes', type: 'BLOB' },
], primaryKey: ['id'], indexes: [
  { name: 'current_name', unique: true, terms: [{ by: sql.collate(c('name'), 'NOCASE'), direction: 'asc' }], where: b('=', c('state'), 'draft') },
  { name: 'trimmed_name', terms: [{ by: call('trim', [c('name')]), direction: 'desc' }] },
], triggers: [{ name: 'immutable_items', timing: 'before', event: 'update',
  when: b('<>', c('state', 'OLD'), 'draft'), steps: [{ raise: { action: 'abort', message: 'immutable history' } }] }] });

it('column-first DDL preserves physical constraints, defaults, indexes and conditional triggers', async () => fixture((db, r) => {
  const plan = planTable(items());
  for (let i = 0; i < 2; i++) for (const text of plan.createSql) db.exec(text);
  assert.deepEqual(db.prepare('PRAGMA table_info(items)').all([]).map((x) => x.name), ['id', 'name', 'state', 'revision', 'raw', 'bytes']);
  const added = r.execute({ op: 'insert', table: 'items', values: { name: 'a' }, returning: '*' });
  assert.equal(added.rows[0].revision, 1);
  assert.equal(added.rows[0].id, 1);
  assert.throws(() => r.execute({ op: 'insert', table: 'items', values: { name: 'A' } }), /UNIQUE/);
  assert.throws(() => r.execute({ op: 'update', table: 'items', set: { revision: 0 }, where: 1 }), /CHECK/);
  r.execute({ op: 'update', table: 'items', set: { state: 'posted' }, where: b('=', c('id'), 1) });
  assert.throws(() => r.execute({ op: 'update', table: 'items', set: { state: 'posted' }, where: 1 }), /immutable history/);
  const model = defineModel({ entities: { Item: object({ id: integer().identity('auto'), name: string().nullable() })
    .physical({ table: 'simple', columns: { id: { name: 'id', codec: 'integer', null: 'reject' }, name: { name: 'name', codec: 'text', null: 'null' } } }) } });
  const mapping = explainMapping(model);
  for (const text of planEntity('Item', mapping.entities.Item, mapping, sqliteDialect).createSql) db.exec(text);
  assert.deepEqual(db.prepare('PRAGMA table_info(simple)').all([]).map((x) => x.type), ['INTEGER', 'TEXT']);
}));

it('native relational reads preserve raw JSON, NULL, SQLite casts, aggregates and collation', async () => fixture((db, r) => {
  db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT,raw TEXT); CREATE TABLE lines(item INTEGER,amount REAL)');
  for (const values of [{ id: 1, name: null, raw: ' { "price" : "2.5", "qty": 2 } ' }, { id: 2, name: 'Ä', raw: '{}' }, { id: 3, name: 'a', raw: '{}' }]) r.execute({ op: 'insert', table: 'items', values });
  db.exec('INSERT INTO lines VALUES(1,0.1),(1,0.2),(2,1.5)');
  const query = { from: { table: 'items', as: 'i' }, columns: {
    id: c('id', 'i'), raw: c('raw', 'i'),
    price: sql.cast(call('json_extract', [c('raw', 'i'), '$.price']), 'REAL'),
    total: sql.scalar({ from: 'lines', columns: { n: call('coalesce', [call('sum', [c('amount')]), 0]) }, where: b('=', c('item'), c('id', 'i')) }),
    present: sql.exists({ from: 'lines', columns: { one: 1 }, where: b('=', c('item'), c('id', 'i')) }),
  }, orderBy: [{ by: sql.collate(c('name', 'i'), 'NOCASE'), nulls: 'first' }] };
  const expected = db.prepare("SELECT i.id,i.raw,CAST(json_extract(i.raw,'$.price') AS REAL) AS price,(SELECT COALESCE(SUM(amount),0) FROM lines WHERE item=i.id) AS total,EXISTS(SELECT 1 FROM lines WHERE item=i.id) AS present FROM items i ORDER BY i.name COLLATE NOCASE NULLS FIRST").all([]);
  assert.deepEqual(r.all(query), expected);
  assert.deepEqual([...r.iterate(query)], expected);
  const grouped = { from: { table: 'items', as: 'i' }, joins: [{ source: { table: 'lines', as: 'l' }, type: 'left', on: b('=', c('item', 'l'), c('id', 'i')) }],
    columns: { id: c('id', 'i'), n: call('count', [c('amount', 'l')], { distinct: true }), sum: call('sum', [c('amount', 'l')]) },
    groupBy: [c('id', 'i')], having: b('>=', call('count', []), 1), orderBy: [{ by: c('id', 'i') }] };
  assert.deepEqual(r.all(grouped), db.prepare('SELECT i.id,COUNT(DISTINCT l.amount) AS n,SUM(l.amount) AS sum FROM items i LEFT JOIN lines l ON l.item=i.id GROUP BY i.id HAVING COUNT(*)>=1 ORDER BY i.id').all([]));
  assert.equal(r.get({ from: 'lines', where: 0, columns: { n: call('sum', [c('amount')]) } }).n, null);
  assert.equal(r.get({ from: 'lines', columns: { n: call('sum', [sql.case([{ when: b('=', c('item'), 1), then: c('amount') }], 0)]) } }).n, 0.1 + 0.2);
  assert.deepEqual(r.all({ union: [{ from: 'items', columns: { id: c('id') }, where: b('<=', c('id'), 2) }, { from: 'items', columns: { id: c('id') }, where: b('>=', c('id'), 2) }], orderBy: [{ by: c('id') }] }).map((r) => r.id), [1, 2, 3]);
}));

it('exact assignments, conditional authority, partial conflicts and byte copying use one transaction', async () => fixture((db, r) => {
  for (const text of planTable(items()).createSql) db.exec(text);
  db.exec('CREATE TABLE audit(n INTEGER); CREATE TRIGGER only_name AFTER UPDATE OF name ON items BEGIN INSERT INTO audit VALUES(1); END');
  const bytes = new Uint8Array([9, 0, 255, 7]).subarray(1, 3);
  r.execute({ op: 'insert', table: 'items', values: { name: 'a', bytes, raw: ' { "x": 1 } ' } });
  assert.equal(r.execute({ op: 'update', table: 'items', set: { raw: c('raw') }, where: 1 }).affected, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM audit').get([]).n, 0);
  assert.equal(r.execute({ op: 'update', table: 'items', set: { name: 'a' }, reporting: 'changed', where: 1 }).affected, 0);
  assert.equal(r.execute({ op: 'update', table: 'items', set: { name: 'a' }, reporting: 'matched', where: 1 }).affected, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM audit').get([]).n, 1);
  const update = { op: 'update', table: 'items', set: { revision: b('+', c('revision'), 1) }, where: b('AND', b('=', c('revision'), 1), b('=', c('state'), 'draft')) };
  assert.equal(r.execute(update).affected, 1); assert.equal(r.execute(update).affected, 0);
  const conflict = { target: [sql.collate(c('name'), 'NOCASE')], where: b('=', c('state'), 'draft'), action: 'update', set: { bytes: c('bytes', 'excluded') } };
  assert.equal(r.execute({ op: 'insert', table: 'items', values: { name: 'A', bytes: new Uint8Array([0, 1, 0]) }, conflict }).affected, 1);
  assert.deepEqual([...r.get({ from: 'items' }).bytes], [0, 1, 0]);
  assert.equal(r.execute({ op: 'insert', table: 'items', values: { name: 'a' }, conflict: { target: conflict.target, where: conflict.where, action: 'nothing' } }).affected, 0);
  db.exec('CREATE TABLE copies(id INTEGER PRIMARY KEY,bytes BLOB,raw TEXT)');
  assert.equal(r.execute({ op: 'insert', table: 'copies', columns: ['id', 'bytes', 'raw'], source: { from: 'items', columns: { id: c('id'), bytes: c('bytes'), raw: c('raw') } }, conflict: { action: 'nothing' } }).affected, 1);
  assert.deepEqual([...r.get({ from: 'copies' }).bytes], [0, 1, 0]);
  assert.throws(() => db.transaction(() => { r.execute({ op: 'delete', table: 'copies', where: 1 }); throw new Error('rollback'); }), /rollback/);
  assert.equal(r.get({ from: 'copies' }).raw, ' { "x": 1 } ');
  assert.throws(() => planRelational({ from: 'items', where: sql.param('missing') }), { code: 'JD0038' });
  assert.throws(() => planRelational({ op: 'delete', table: 'items' }), { code: 'JD0038' });
}));

it('unknown-schema scans inspect SQLite storage classes and release their first row', async () => fixture((db, r) => {
  db.exec('CREATE TABLE "user supplied"("payload" ANY) STRICT');
  for (const value of [123, 'secret', null, new Uint8Array([0, 1]), 'other']) r.execute({ op: 'insert', table: 'user supplied', values: { payload: value } });
  const query = { from: 'user supplied', columns: { rid: c('rowid'), value: c('payload') }, where: b('=', call('typeof', [c('payload')]), 'text'), orderBy: [{ by: c('rowid') }] };
  const expected = db.prepare('SELECT rowid AS rid,payload AS value FROM "user supplied" WHERE typeof(payload)=\'text\' ORDER BY rowid').all([]);
  assert.deepEqual(r.all(query), expected);
  const cursor = r.iterate(query);
  assert.equal(cursor.streaming, 'row');
  assert.equal(cursor.next().value.value, 'secret');
  cursor.return(); assert.equal(cursor.next().done, true);
  // The released read no longer holds a statement over the schema.
  db.exec('DROP TABLE "user supplied"');
}));

it('schema defaults and invalid structural programs are checked without SQL string wrappers', async () => fixture((db, r) => {
  const table = { name: 'timestamps', columns: [{ name: 'at', type: 'TEXT', default: call('strftime', ['%Y-%m-%dT%H:%M:%fZ', 'now']) }] };
  for (const statement of planTable(table).createSql) db.exec(statement);
  r.execute({ op: 'insert', table: 'timestamps', values: {} });
  assert.match(r.get({ from: 'timestamps' }).at, /^\d{4}-\d{2}-\d{2}T/);
  for (const value of [{ ...table, indexes: {} }, { ...table, constraints: [{ kind: 'unique', columns: ['at'], onDelete: 'cascade' }] },
    { ...table, indexes: [{ name: 'bad', terms: [{ by: c('at'), nulls: 'first' }] }] }]) assert.throws(() => planTable(value), { code: 'JD0005' });
  assert.throws(() => planRelational({ op: 'insert', table: 'timestamps', values: {}, extra: 'ignored' }), { code: 'JD0038' });
}));

it('value, negation, membership and windows execute with explicit SQLite semantics', async () => fixture((db, r) => {
  db.exec('CREATE TABLE items(id INTEGER); INSERT INTO items VALUES(1),(2),(3),(4)');
  const query = { from: 'items', columns: { id: c('id'), literal: sql.value('quoted\'text') },
    where: sql.not(sql.in(c('id'), [2, 4])), orderBy: [{ by: c('id'), direction: 'desc' }], limit: 1, offset: 1 };
  assert.deepEqual(r.all(query), db.prepare("SELECT id,? AS literal FROM items WHERE NOT(id IN (2,4)) ORDER BY id DESC LIMIT 1 OFFSET 1").all(["quoted'text"]));
}));

it('catalog-driven native reads include framework tables without adopting their shape', async () => fixture((db, r) => {
  db.exec("CREATE TABLE _jaren_jobs(payload);INSERT INTO _jaren_jobs VALUES('framework text')");
  const tables = r.all({ from: 'sqlite_schema', columns: { name: c('name') }, where: b('=', c('type'), 'table') });
  assert.ok(tables.some((table) => table.name === '_jaren_jobs'));
  assert.equal(r.get({ from: '_jaren_jobs', columns: { text: c('payload') }, where: b('=', call('typeof', [c('payload')]), 'text') }).text, 'framework text');
}));
