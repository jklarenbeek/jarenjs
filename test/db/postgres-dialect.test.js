//@ts-check
/**
 * @file The PostgreSQL dialect: the order-01 conformance kit, unchanged,
 * plus the boundaries that are this engine's own — an identifier past
 * the length it truncates at, a member path its array grammar cannot
 * carry, the storage word its generated columns take, the collation
 * that makes a prefix range mean the same thing it means on SQLite, and
 * the catalog statements the shape check and introspection read.
 *
 * Every case here is PURE TEXT. Nothing in this file opens a
 * connection: the dialect imports no client, and proving that is half
 * the point of the seam.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { sqliteDialect, planCollection, normalizeModel } from '@jarenjs/db';
import { postgresDialect, IDENTIFIER_BYTES } from '@jarenjs/db/postgres';

import { runDialectConformance, HOSTILE_NAMES } from './dialect-conformance.js';

const pg = postgresDialect();
const q = pg.quoteIdentifier;

runDialectConformance(pg, { describe, it, assert });

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
          score: { type: 'number' },
          active: { type: 'boolean' },
          extra: {},
        },
      },
      key: '/id',
      indexes: [
        { name: 'by_email', path: '$.email', unique: true },
        { name: 'by_age', path: '$.age' },
        { name: 'by_extra', path: '$.extra' },
      ],
    },
  },
};

describe('the PostgreSQL mapping', () => {
  const users = normalizeModel(MODEL).get('users');
  const plan = planCollection('users', users, pg);

  it('a collection is a jsonb document, a declared row identity and STORED columns', () => {
    const [create] = plan.createSql;
    assert.ok(create.startsWith('CREATE TABLE "users" ('));
    assert.ok(create.includes('"key" text COLLATE "C" PRIMARY KEY'));
    assert.ok(create.includes('"doc" jsonb NOT NULL'));
    // PostgreSQL has no per-row identity that survives an UPDATE, and a
    // collection is a sequence, so the dialect declares one
    assert.ok(create.includes('"rid" bigserial'));
    assert.strictEqual(pg.rowIdentity(), '"rid"');
    // STORED, because a VIRTUAL generated column cannot be indexed here
    assert.strictEqual((create.match(/\) STORED/g) ?? []).length, 3);
    assert.ok(!create.includes('VIRTUAL'));
    assert.ok(!create.includes('STRICT'));
  });

  it('a typed column reads its member through a guard that cannot raise', () => {
    const [create] = plan.createSql;
    // a generated column's expression must be IMMUTABLE, and a cast
    // that can raise is not: the type test lives INSIDE the CASE, and a
    // document whose member is another JSON type stores NULL
    assert.ok(create.includes('"gx_age" numeric GENERATED ALWAYS AS '
      + '((CASE WHEN jsonb_typeof(("doc" #> \'{"age"}\')) = \'number\' '
      + 'THEN (("doc" #> \'{"age"}\'))::numeric END)) STORED'), create);
    assert.ok(create.includes('"gx_email" text COLLATE "C" GENERATED ALWAYS AS '), create);
    assert.ok(create.includes('THEN "doc" #>> \'{"email"}\' END) COLLATE "C")) STORED'), create);
    // a path the schema does not type has no honest scalar type
    assert.ok(create.includes(
      '"gx_extra" jsonb GENERATED ALWAYS AS (("doc" #> \'{"extra"}\')) STORED'), create);
  });

  it('a text column and a text comparison are byte-ordered, whatever the server locale', () => {
    // SQLite's default BINARY collation is byte order; without an
    // explicit C the same half-open prefix range would hold different
    // rows on a database initialised in another locale
    assert.strictEqual(pg.typeFor('string', 'generated'), 'text COLLATE "C"');
    assert.ok(pg.jsonExtract(q('doc'), pg.jsonPathText([{ name: 'a' }]), 'text')
      .endsWith('COLLATE "C")'));
    assert.strictEqual(pg.strStartsWith(q('gx_email'), '$1', '$2'),
      '("gx_email" >= $1 AND "gx_email" < $2)');
  });

  it('integer and number are one column type, and a boolean is 1 or 0', () => {
    assert.strictEqual(pg.typeFor('integer', 'generated'), 'numeric');
    assert.strictEqual(pg.typeFor('number', 'generated'), 'numeric');
    // a boolean MEMBER is 1 or 0 in the shared mapping — a type test
    // and a projected pair's own type name both compare against those
    // integers, and a `boolean` column would make each an
    // operator-resolution error rather than a row
    assert.strictEqual(pg.typeFor('boolean', 'generated'), 'smallint');
    assert.ok(pg.jsonExtract(q('doc'), '{"active"}', 'boolean').includes('THEN 1 ELSE 0'));
    // a `bigint` column would be the better index and would REJECT a
    // document the model accepts — 3.5 in a member the schema types
    // `integer` — inside a generated column's cast
    assert.strictEqual(pg.comparableColumnType('numeric'), 'NUMERIC');
  });

  it('a declared type reduces to what the catalog reports', () => {
    const rows = [
      ['text COLLATE "C"', 'TEXT'],
      ['bigserial', 'BIGINT'],
      ['numeric', 'NUMERIC'],
      ['jsonb', 'JSONB'],
      ['smallint', 'SMALLINT'],
      ['bytea', 'BYTEA'],
      ['int8', 'BIGINT'],
      ['bool', 'BOOLEAN'],
      ['float8', 'DOUBLE PRECISION'],
    ];
    for (const [declared, comparable] of rows)
      assert.strictEqual(pg.comparableColumnType(declared), comparable, declared);
  });

  it('an identifier longer than PostgreSQL keeps is refused, not truncated', () => {
    const long = `gx_${'a'.repeat(IDENTIFIER_BYTES)}`;
    assert.throws(() => q(long), (error) => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /longer than 63 bytes/);
      assert.match(error.message, /truncates silently/);
      return true;
    });
    // by BYTES, not characters: twenty astral characters are eighty
    assert.throws(() => q(String.fromCodePoint(0x1f600).repeat(20)), TypeError);
    assert.strictEqual(q('a'.repeat(IDENTIFIER_BYTES)), `"${'a'.repeat(IDENTIFIER_BYTES)}"`);
  });

  it('a member path is a text[] literal, and refuses what it cannot address', () => {
    assert.strictEqual(pg.jsonPathText([{ name: 'a' }, { index: 0 }, { name: 'b c' }]),
      '{"a","0","b c"}');
    // an element carrying a comma, a brace or a quote is ONE element
    assert.strictEqual(pg.jsonPathText([{ name: 'a,b' }]), '{"a,b"}');
    assert.strictEqual(pg.jsonPathText([{ name: '}' }]), '{"}"}');
    assert.strictEqual(pg.jsonPathText([{ name: 'q"uote' }]), '{"q\\"uote"}');
    assert.strictEqual(pg.jsonPathText([{ name: 'back\\slash' }]), '{"back\\\\slash"}');
    // `#>` counts from the front only; a path that meant different
    // members to the read and the write would be worse than none
    assert.strictEqual(pg.jsonPathText([{ index: -1 }]), null);
    assert.strictEqual(pg.jsonPathText([{ name: `ctl${String.fromCharCode(0)}` }]), null);
  });

  it('an append addresses the position after the last element', () => {
    const path = /** @type {string} */ (pg.jsonPathText([{ name: 'tags' }]));
    assert.strictEqual(pg.jsonAppend(q('doc'), path, '($1)::jsonb'),
      'jsonb_insert("doc", \'{"tags",-1}\', ($1)::jsonb, true)');
    assert.strictEqual(pg.jsonRemove(q('doc'), path), '("doc" #- \'{"tags"}\')');
    assert.strictEqual(pg.jsonSet(q('doc'), path, '($1)::jsonb'),
      'jsonb_set("doc", \'{"tags"}\', ($1)::jsonb, true)');
  });

  it('the type discriminator answers the vocabulary the whole store shares', () => {
    const type = pg.jsonTypeOf(q('doc'), /** @type {string} */ (pg.jsonPathText([{ name: 'a' }])));
    // the row decoder reads these names in JavaScript, so a JSON string
    // is `text` and a JSON boolean is `true` or `false` here too
    assert.ok(type.includes("'text'"));
    assert.ok(type.includes("'true'") && type.includes("'false'"));
    assert.ok(type.includes('jsonb_typeof'));
    // one JSON number type, so one name — which is what the emitter's
    // numeric guard reads
    assert.deepStrictEqual([...pg.numericTypeNames], ['number']);
    assert.deepStrictEqual([...sqliteDialect.numericTypeNames], ['integer', 'real']);
  });

  it('an external operand is bound as JSON and compared in JSON space', () => {
    // a PostgreSQL parameter's type is resolved once, for the whole
    // statement; one placeholder cannot be a text member's operand in
    // one branch and a numeric member's in another, and the guard that
    // keeps a row out of the wrong branch does not stop the COERCION
    assert.strictEqual(pg.externalEncoding, 'json');
    assert.strictEqual(pg.externalRef('$1', 'text'), '(((($1)::jsonb) #>> \'{}\') COLLATE "C")');
    assert.strictEqual(pg.externalRef('$1', 'number'), '(($1)::jsonb)');
    assert.strictEqual(pg.externalCompare('"gx_age"', 'number'), 'to_jsonb("gx_age")');
    assert.strictEqual(pg.externalCompare('"gx_email"', 'text'), '"gx_email"');
    assert.strictEqual(sqliteDialect.externalEncoding, 'value',
      'a dynamically typed engine binds the value itself');
  });

  it('unsupported features are named false and carry no half of themselves', () => {
    assert.strictEqual(pg.capabilities.pragmas, false);
    assert.deepStrictEqual(pg.pragma, {}, 'no half of a configuration vocabulary');
    assert.strictEqual(pg.introspect.pragma, undefined);
    assert.strictEqual(pg.capabilities.declaredSqlText, false);
    assert.strictEqual(pg.introspect.declaredSql, undefined);
    assert.strictEqual(pg.capabilities.virtualTables, false);
    assert.strictEqual(pg.ddl.createVirtualTable, undefined);
    assert.strictEqual(pg.ddl.createSyncTriggers, undefined);
    assert.deepStrictEqual(pg.rtree, {});
    assert.strictEqual(pg.capabilities.foreignKeysAlwaysOn, true);
    assert.strictEqual(pg.introspect.foreignKeysOn, undefined);
    assert.strictEqual(pg.capabilities.immediateTransactions, false);
    assert.strictEqual(pg.tx.beginImmediate, pg.tx.begin);
    // a derived column is STORED here and the store writes its value, so
    // asking this dialect to spell the expression is a planner defect
    assert.throws(
      () => pg.derivedColumn(q('doc'), '{"at"}', { derive: 'geohash', precision: 6 }),
      TypeError);
  });

  it('the catalog statements answer the neutral rows the shape check reads', () => {
    assert.ok(pg.introspect.tableExists().includes('$1'), 'the table probe binds its name');
    for (const name of HOSTILE_NAMES) {
      for (const build of [pg.introspect.columns, pg.introspect.indexes,
        pg.introspect.indexColumns, pg.introspect.foreignKeyList]) {
        const sql = build(name);
        // the name is a VALUE inside a quoted literal, never syntax
        assert.ok(!/;\s*\w/.test(sql), sql);
        assert.ok(sql.includes(pg.stringLiteral(name)), sql);
      }
    }
    assert.match(pg.introspect.columns('users'), /attgenerated <> '' THEN 1 ELSE 0 END AS hidden/);
    assert.match(pg.introspect.indexes('users'), /indisprimary THEN 'pk' ELSE 'c' END AS origin/);
    assert.match(pg.introspect.indexColumns('users_by_age'), /ORDER BY k\.ord$/);
    assert.match(pg.introspect.foreignKeyList('orders'), /AS on_delete/);
    assert.match(pg.introspect.foreignKeyList('orders'), /AS seq/);
  });

  it('a search path narrows every catalog statement to one schema', () => {
    const scoped = postgresDialect({ searchPath: 'jaren_run_1' });
    for (const sql of [scoped.introspect.tableExists(), scoped.introspect.columns('users'),
      scoped.introspect.indexes('users'), scoped.introspect.indexColumns('i'),
      scoped.introspect.foreignKeyList('users')]) {
      assert.ok(sql.includes("n.nspname = 'jaren_run_1'"), sql);
      assert.ok(!sql.includes('current_schemas'), sql);
    }
    assert.ok(pg.introspect.columns('users').includes('ANY(current_schemas(false))'));
  });

  it('the plan narrative is read by the dialect that produced it', () => {
    assert.strictEqual(pg.explainQuery('SELECT 1'), 'EXPLAIN SELECT 1');
    const scan = 'Seq Scan on users  (cost=0.00..1.05 rows=5 width=64)';
    assert.deepStrictEqual(pg.explainLines([{ 'QUERY PLAN': scan }]), [scan]);
    assert.strictEqual(pg.isFullScan(scan, ['users']), true);
    assert.strictEqual(pg.isFullScan(scan, ['orders']), false);
    const seek = 'Index Scan using users_by_age on users  (cost=0.15..8.17 rows=1 width=64)';
    assert.strictEqual(pg.isFullScan(seek, ['users']), false);
    assert.strictEqual(pg.usesIndex(seek, 'users_by_age'), true);
    assert.strictEqual(pg.usesIndex(seek, 'users_by_email'), false);
    assert.strictEqual(pg.usesIndex('Bitmap Index Scan on users_by_email', 'users_by_email'), true);
  });

  it('the same model produces correspondingly different SQL from the SQLite one', () => {
    const sqlite = planCollection('users', users, sqliteDialect);
    assert.strictEqual(sqlite.createSql.length, plan.createSql.length);
    // the TABLE differs in every part that is a spelling — the document
    // type, the storage word, the column types, the extraction. The
    // INDEXES do not, and should not: `CREATE INDEX <name> ON <table>
    // (<columns>)` is the same statement in both engines, over the same
    // declared names, which is exactly what portability means
    assert.notStrictEqual(plan.createSql[0], sqlite.createSql[0]);
    assert.deepStrictEqual(plan.createSql.slice(1), sqlite.createSql.slice(1));
    // and the same declared indexes, by name and covered columns
    assert.deepStrictEqual(plan.expected.indexes, sqlite.expected.indexes);
    assert.deepStrictEqual(
      plan.expected.columns.map((column) => column.name).sort(),
      [...sqlite.expected.columns.map((column) => column.name), 'rid'].sort());
  });
});
