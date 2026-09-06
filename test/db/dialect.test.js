//@ts-check
/**
 * @file The dialect seam: golden SQL for the SQLite dialect (every
 * statement kind the store runs) and the JSON-path text rules, plus a
 * first look at the seam being real — the SAME model through a foreign
 * spelling spec, producing correspondingly different DDL and writes.
 *
 * That look is deliberately small here. The whole-surface version — every
 * DDL and DML builder, every plan mode, and a scan proving no SQLite
 * spelling reaches the foreign corpus — is `dialect-mirror.test.js`,
 * over the same spec.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createDialect, sqliteDialect, planCollection, normalizeModel } from '@jarenjs/db';

import { fullDoubleDialect } from './helpers.js';

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

/**
 * The one foreign spelling spec this suite has: brackets, named
 * parameter refs, other type names. It lives in `helpers.js` because
 * `dialect-mirror.test.js` drives the WHOLE statement surface through
 * it — two doubles would be two answers to "what does a second spelling
 * look like", and the weaker one is always the one a proof reaches for.
 */
const doubleDialect = fullDoubleDialect(createDialect);

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
    // the by-identities fetch of a k-nearest plan's candidates: a
    // membership test over the row identity, in identity order
    assert.strictEqual(sqliteDialect.dml.selectByIdentities(SHAPE, 3),
      'SELECT json("doc") AS "doc" FROM "users" WHERE "rowid" IN (?, ?, ?) ORDER BY "rowid"');
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

  // A prefix predicate is the one string operator with a sargable
  // spelling: `substr(col, 1, n) = p` is a function OF the column and
  // can only be scanned, while the half-open range over the same
  // prefix is an index seek. `strStartsWithExact` keeps the scannable
  // form for the one pattern that has no expressible upper bound.
  it('the prefix predicate is a half-open range, not a substr call', () => {
    assert.strictEqual(sqliteDialect.strStartsWith('"gx_name"', '?', '?'),
      '("gx_name" >= ? AND "gx_name" < ?)');
    assert.strictEqual(sqliteDialect.strStartsWithExact('"gx_name"', '?', '?'),
      'substr("gx_name", 1, length(?)) = ?');
    assert.strictEqual(sqliteDialect.strEndsWith('"gx_name"', '?', '?', '?'),
      '(length(?) = 0 OR substr("gx_name", -length(?)) = ?)',
      'unchanged: no sargable form exists');
    assert.strictEqual(sqliteDialect.strContains('"gx_name"', '?'),
      'instr("gx_name", ?) > 0', 'unchanged: no sargable form exists');
  });

  // The plan is PROSE on SQLite, one `detail` column per row, and only
  // the dialect that asked for it can read it: the profile's scan
  // refusal and a "does this predicate reach its index" check are both
  // questions about that narrative.
  it('the plan narrative: a full scan, and a seek through a named index', () => {
    assert.strictEqual(sqliteDialect.explainQuery('SELECT 1'), 'EXPLAIN QUERY PLAN SELECT 1');
    const rows = [{ detail: 'SCAN users' },
      { detail: 'SEARCH users USING INDEX users_by_age (gx_age=?)' },
      { detail: 'SCAN t0' },
      { detail: 'SEARCH t1 USING COVERING INDEX orders_by_at (gx_at>?)' }];
    const lines = sqliteDialect.explainLines(rows);
    assert.deepStrictEqual(lines, rows.map((row) => row.detail));
    assert.strictEqual(sqliteDialect.isFullScan(lines[0], ['users']), true);
    assert.strictEqual(sqliteDialect.isFullScan(lines[0], ['orders']), false);
    assert.strictEqual(sqliteDialect.isFullScan(lines[1], ['users']), false,
      'a search through an index is not a full read');
    // a join statement's narrative names the ALIAS the emitter gave the
    // table, which is why an alias shape counts as a scan of its own
    assert.strictEqual(sqliteDialect.isFullScan(lines[2], ['users']), true);
    assert.strictEqual(sqliteDialect.isFullScan(lines[3], ['orders']), false);
    assert.strictEqual(sqliteDialect.usesIndex(lines[1], 'users_by_age'), true);
    assert.strictEqual(sqliteDialect.usesIndex(lines[1], 'users_by_email'), false);
    assert.strictEqual(sqliteDialect.usesIndex(lines[3], 'orders_by_at'), true,
      'a covering index is the index');
    assert.strictEqual(sqliteDialect.usesIndex(lines[0], 'users_by_age'), false);
  });

  it('transaction, pragma and introspection phrases', () => {
    assert.strictEqual(sqliteDialect.tx.savepoint('sp_1'), 'SAVEPOINT "sp_1"');
    assert.strictEqual(sqliteDialect.tx.release('sp_1'), 'RELEASE SAVEPOINT "sp_1"');
    assert.strictEqual(sqliteDialect.tx.rollbackTo('sp_1'), 'ROLLBACK TO SAVEPOINT "sp_1"');
    assert.strictEqual(sqliteDialect.tx.begin, 'BEGIN');
    assert.strictEqual(sqliteDialect.tx.commit, 'COMMIT');
    assert.strictEqual(sqliteDialect.tx.rollback, 'ROLLBACK');
    assert.strictEqual(sqliteDialect.pragma.set('busy_timeout', 5000), 'PRAGMA busy_timeout = 5000');
    assert.strictEqual(sqliteDialect.pragma.set('journal_mode', 'wal'), 'PRAGMA journal_mode = wal');
    assert.strictEqual(sqliteDialect.pragma.set('cache_size', -8000.7), 'PRAGMA cache_size = -8000');
    assert.strictEqual(sqliteDialect.introspect.pragma('synchronous'), 'PRAGMA synchronous');
    // neither a name nor a value outside the guarded word/integer forms
    // reaches the statement text
    assert.throws(() => sqliteDialect.pragma.set('journal_mode', 'wal; DROP TABLE x'), TypeError);
    assert.throws(() => sqliteDialect.pragma.set('journal_mode; DROP TABLE x', 'wal'), TypeError);
    assert.throws(() => sqliteDialect.pragma.set('cache_size', Number.NaN), TypeError);
    assert.throws(() => sqliteDialect.introspect.pragma('x; DROP TABLE y'), TypeError);
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
      + "[gx_email] VALTYPE GENERATED ALWAYS AS (JX([doc], '/email')) LAZY, "
      + "[gx_age] VALTYPE GENERATED ALWAYS AS (JX([doc], '/age')) LAZY"
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
    assert.strictEqual(doubleDialect.tx.savepoint('s'), 'MARK [s]');
  });
});
