//@ts-check
/**
 * @file The dialect seam: golden SQL for the SQLite dialect (every
 * statement kind the store runs), the JSON-path text rules, and — the
 * proof the seam is real — a test-double dialect with different
 * quoting, parameter style and type names producing correspondingly
 * different SQL from the SAME model. No SQL text is spelled outside a
 * dialect, so different spelling primitives MUST surface in every
 * emitted statement.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createDialect, sqliteDialect, planCollection, normalizeModel } from '@jarenjs/db';

const MODEL = {
  $model: '0.1',
  collections: {
    users: {
      schema: {
        type: 'object',
        required: ['id', 'email'],
        properties: {
          id: { type: 'string' },
          email: { type: 'string' },
          age: { type: 'integer' },
        },
      },
      key: '/id',
      indexes: [
        { name: 'by_email', path: '$.email', unique: true },
        { name: 'by_age', path: '$.age' },
      ],
    },
  },
};

const SHAPE = { table: 'users', keyColumn: 'key', docColumn: 'doc' };

/** A deliberately foreign spelling: brackets, named refs, other types. */
const doubleDialect = createDialect({
  name: 'double',
  capabilities: { jsonb: false },
  tableSuffix: '',
  docColumnType: 'JSONDOC',
  quoteIdentifier: (s) => `[${s}]`,
  parameterRef: (i) => `@p${i}`,
  stringLiteral: (s) => `'${String(s).replace(/'/g, "''")}'`,
  booleanLiteral: (b) => (b ? 'TRUE' : 'FALSE'),
  typeFor: (schemaType, hint) => (hint === 'key' ? 'KEYTYPE' : 'VALTYPE'),
  limitClause: (limit, offset) => `FETCH ${limit} SKIP ${offset ?? 0}`,
  jsonPathText: (segments) => segments
    .map((s) => ('name' in s ? `/${s.name}` : `/#${s.index}`)).join(''),
  jsonExtract: (column, pathText) => `JX(${column}, '${pathText}')`,
  jsonSet: (expr, pathText, value) => `JS(${expr}, '${pathText}', ${value})`,
  jsonRemove: (expr, pathText) => `JR(${expr}, '${pathText}')`,
  jsonAppend: (expr, pathText, value) => `JA(${expr}, '${pathText}', ${value})`,
  jsonEncode: (param) => `JENC(${param})`,
  jsonText: (column) => `JTEXT(${column})`,
  jsonAgg: (expr) => `JAGG(${expr})`,
  excludedRef: (column) => `NEW.${column}`,
  tx: {
    begin: 'BEGIN', beginImmediate: 'GRAB', commit: 'COMMIT', rollback: 'ROLLBACK',
    savepoint: (n) => `MARK ${n}`,
    release: (n) => `UNMARK ${n}`,
    rollbackTo: (n) => `BACKTO ${n}`,
  },
  pragma: {
    busyTimeout: (ms) => `SET busy ${ms}`,
    journalMode: (mode) => `SET journal ${mode}`,
    foreignKeys: (on) => `SET fk ${on ? 1 : 0}`,
  },
  introspect: {
    version: () => 'GET version',
    compileOptions: () => 'GET options',
    tableExists: () => 'GET table @p1',
    columns: (t) => `GET columns ${t}`,
    indexes: (t) => `GET indexes ${t}`,
    indexColumns: (i) => `GET indexcolumns ${i}`,
  },
});

describe('SQLite dialect goldens', () => {
  const plan = planCollection('users',
    normalizeModel(MODEL).get('users'), sqliteDialect);

  it('createTable: STRICT, JSONB doc, typed generated columns', () => {
    assert.deepStrictEqual(plan.createSql, [
      'CREATE TABLE "users" ('
      + '"key" TEXT PRIMARY KEY, '
      + '"doc" BLOB NOT NULL, '
      + '"gx_email" TEXT GENERATED ALWAYS AS (jsonb_extract("doc", \'$."email"\')) VIRTUAL, '
      + '"gx_age" INTEGER GENERATED ALWAYS AS (jsonb_extract("doc", \'$."age"\')) VIRTUAL'
      + ') STRICT',
      'CREATE UNIQUE INDEX "users_by_email" ON "users" ("gx_email")',
      'CREATE INDEX "users_by_age" ON "users" ("gx_age")',
    ]);
  });

  it('the write and read statements', () => {
    assert.strictEqual(sqliteDialect.dml.insert(SHAPE),
      'INSERT INTO "users" ("key", "doc") VALUES (?, jsonb(?))');
    assert.strictEqual(sqliteDialect.dml.insertAllocated(SHAPE),
      'INSERT INTO "users" ("doc") VALUES (jsonb(?)) RETURNING "key" AS "key"');
    assert.strictEqual(sqliteDialect.dml.upsert(SHAPE),
      'INSERT INTO "users" ("key", "doc") VALUES (?, jsonb(?)) '
      + 'ON CONFLICT ("key") DO UPDATE SET "doc" = excluded."doc"');
    assert.strictEqual(sqliteDialect.dml.get(SHAPE),
      'SELECT json("doc") AS "doc" FROM "users" WHERE "key" = ?');
    assert.strictEqual(sqliteDialect.dml.del(SHAPE),
      'DELETE FROM "users" WHERE "key" = ?');
    assert.strictEqual(
      sqliteDialect.dml.updateDoc(SHAPE, 'jsonb_set("doc", \'$."age"\', jsonb(?))', 2),
      'UPDATE "users" SET "doc" = jsonb_set("doc", \'$."age"\', jsonb(?)) WHERE "key" = ?');
  });

  it('json path text: quoted members, bracketed indexes, null on the unrepresentable', () => {
    assert.strictEqual(sqliteDialect.jsonPathText([{ name: 'a b.c' }, { index: 0 }]),
      '$."a b.c"[0]');
    assert.strictEqual(sqliteDialect.jsonPathText([{ name: 'has"quote' }]), null);
    assert.strictEqual(sqliteDialect.jsonPathText([{ name: 'ctl' }]), null);
  });

  it('the expression primitives', () => {
    assert.strictEqual(sqliteDialect.quoteIdentifier('we"ird'), '"we""ird"');
    assert.strictEqual(sqliteDialect.stringLiteral("o'clock"), "'o''clock'");
    assert.strictEqual(sqliteDialect.booleanLiteral(true), '1');
    assert.strictEqual(sqliteDialect.booleanLiteral(false), '0');
    assert.strictEqual(sqliteDialect.parameterRef(3, 'x'), '?');
    assert.strictEqual(sqliteDialect.limitClause(10), 'LIMIT 10');
    assert.strictEqual(sqliteDialect.limitClause(10, 20), 'LIMIT 10 OFFSET 20');
    assert.strictEqual(sqliteDialect.jsonExtract('"doc"', '$."a"'),
      'jsonb_extract("doc", \'$."a"\')');
    assert.strictEqual(sqliteDialect.jsonAgg('"gx_age"'), 'json_group_array("gx_age")');
    assert.strictEqual(sqliteDialect.typeFor('number', 'generated'), 'REAL');
    assert.strictEqual(sqliteDialect.typeFor('boolean', 'generated'), 'INTEGER');
    assert.strictEqual(sqliteDialect.typeFor(undefined, 'generated'), 'ANY');
    assert.strictEqual(sqliteDialect.typeFor(undefined, 'key'), 'TEXT');
  });

  it('transaction, pragma and introspection phrases', () => {
    assert.strictEqual(sqliteDialect.tx.savepoint('sp_1'), 'SAVEPOINT "sp_1"');
    assert.strictEqual(sqliteDialect.tx.release('sp_1'), 'RELEASE SAVEPOINT "sp_1"');
    assert.strictEqual(sqliteDialect.tx.rollbackTo('sp_1'), 'ROLLBACK TO SAVEPOINT "sp_1"');
    assert.strictEqual(sqliteDialect.tx.begin, 'BEGIN');
    assert.strictEqual(sqliteDialect.tx.commit, 'COMMIT');
    assert.strictEqual(sqliteDialect.tx.rollback, 'ROLLBACK');
    assert.strictEqual(sqliteDialect.pragma.busyTimeout(5000), 'PRAGMA busy_timeout = 5000');
    assert.strictEqual(sqliteDialect.pragma.journalMode('wal'), 'PRAGMA journal_mode = wal');
    assert.throws(() => sqliteDialect.pragma.journalMode('wal; DROP TABLE x'), TypeError);
    assert.match(sqliteDialect.introspect.version(), /sqlite_version/);
    assert.match(sqliteDialect.introspect.compileOptions(), /pragma_compile_options/);
    assert.match(sqliteDialect.introspect.tableExists(), /sqlite_schema/);
    assert.match(sqliteDialect.introspect.columns('users'), /pragma_table_xinfo\('users'\)/);
    assert.match(sqliteDialect.introspect.indexes('users'), /pragma_index_list\('users'\)/);
    assert.match(sqliteDialect.introspect.indexColumns('users_by_age'),
      /pragma_index_info\('users_by_age'\)/);
  });

  it('jsonSet/jsonRemove/jsonAppend/jsonEncode/jsonText spell the JSONB family', () => {
    assert.strictEqual(sqliteDialect.jsonSet('"doc"', '$."a"', 'jsonb(?)'),
      'jsonb_set("doc", \'$."a"\', jsonb(?))');
    assert.strictEqual(sqliteDialect.jsonRemove('"doc"', '$."a"'),
      'jsonb_remove("doc", \'$."a"\')');
    assert.strictEqual(sqliteDialect.jsonAppend('"doc"', '$."tags"', 'jsonb(?)'),
      'jsonb_insert("doc", \'$."tags"[#]\', jsonb(?))');
    assert.strictEqual(sqliteDialect.jsonEncode('?'), 'jsonb(?)');
    assert.strictEqual(sqliteDialect.jsonText('"doc"'), 'json("doc")');
  });
});

describe('the test-double dialect proves the seam (D21)', () => {
  const users = normalizeModel(MODEL).get('users');
  const sqlitePlan = planCollection('users', users, sqliteDialect);
  const doublePlan = planCollection('users', users, doubleDialect);

  it('the same model produces correspondingly different DDL', () => {
    assert.deepStrictEqual(doublePlan.createSql, [
      'CREATE TABLE [users] ('
      + '[key] KEYTYPE PRIMARY KEY, '
      + '[doc] JSONDOC NOT NULL, '
      + "[gx_email] VALTYPE GENERATED ALWAYS AS (JX([doc], '/email')) VIRTUAL, "
      + "[gx_age] VALTYPE GENERATED ALWAYS AS (JX([doc], '/age')) VIRTUAL"
      + ')',
      'CREATE UNIQUE INDEX [users_by_email] ON [users] ([gx_email])',
      'CREATE INDEX [users_by_age] ON [users] ([gx_age])',
    ]);
    for (let i = 0; i < sqlitePlan.createSql.length; i++)
      assert.notStrictEqual(doublePlan.createSql[i], sqlitePlan.createSql[i]);
  });

  it('and correspondingly different write statements', () => {
    assert.strictEqual(doubleDialect.dml.insert(SHAPE),
      'INSERT INTO [users] ([key], [doc]) VALUES (@p1, JENC(@p2))');
    assert.strictEqual(doubleDialect.dml.upsert(SHAPE),
      'INSERT INTO [users] ([key], [doc]) VALUES (@p1, JENC(@p2)) '
      + 'ON CONFLICT ([key]) DO UPDATE SET [doc] = NEW.[doc]');
    assert.strictEqual(doubleDialect.dml.get(SHAPE),
      'SELECT JTEXT([doc]) AS [doc] FROM [users] WHERE [key] = @p1');
    assert.strictEqual(doubleDialect.dml.insertAllocated(SHAPE),
      'INSERT INTO [users] ([doc]) VALUES (JENC(@p1)) RETURNING [key] AS [key]');
    assert.strictEqual(doubleDialect.dml.del(SHAPE),
      'DELETE FROM [users] WHERE [key] = @p1');
    assert.strictEqual(doubleDialect.limitClause(5, 10), 'FETCH 5 SKIP 10');
    assert.strictEqual(doubleDialect.booleanLiteral(true), 'TRUE');
    assert.strictEqual(doubleDialect.tx.savepoint('s'), 'MARK s');
  });
});
