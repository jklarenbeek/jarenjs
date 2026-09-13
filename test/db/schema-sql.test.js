//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { comparableDeclaredSql, normalizeDeclaredSql, schemaShapeOf, readSchema } from '@jarenjs/db';

const managed = { columnOrder: /** @type {const} */ ('ignore') };

/** @param {(db: any) => any} run */
async function fixture(run) {
  const driver = process.versions.bun
    ? (await import('@jarenjs/db/bun')).bunDriver()
    : (await import('@jarenjs/db/node')).nodeDriver();
  const db = await driver.open(':memory:');
  try { return await run(db); }
  finally { await db.close(); }
}

describe('literal-aware declaration identity', () => {
  it('keeps default bytes that SQLite inserts differently', async () => {
    const results = [];
    for (const value of ['a  b', 'a b']) {
      results.push(await fixture(async (db) => {
        const sql = `CREATE TABLE "t"("v" TEXT DEFAULT '${value}')`;
        db.exec(sql);
        db.exec('INSERT INTO t DEFAULT VALUES');
        return { identity: comparableDeclaredSql(sql), shape: await schemaShapeOf(db),
          inserted: db.prepare('SELECT v FROM t').get([]).v,
          declared: (await readSchema(db)).tables[0].columns[0].default };
      }));
    }
    assert.deepEqual(results.map((r) => r.inserted), ['a  b', 'a b']);
    assert.deepEqual(results.map((r) => r.declared), ["'a  b'", "'a b'"]);
    assert.notEqual(results[0].identity, results[1].identity);
    assert.notDeepEqual(results[0].shape, results[1].shape);
  });

  it('preserves punctuation, clause-looking text, escapes and Unicode inside quotes', () => {
    for (const [left, right] of [
      ["'x ( y , z )'", "'x(y,z)'"],
      ["'IF NOT EXISTS x'", "'x'"],
      ["'a''  b'", "'a'' b'"],
      ["'é\u00a0λ'", "'é λ'"],
      ["'-- text\n/* body */'", "'-- text /* body */'"],
      ["X'0102'", "X'0103'"],
    ]) {
      const a = `CREATE TABLE t(v TEXT DEFAULT ${left})`;
      const b = `CREATE TABLE t(v TEXT DEFAULT ${right})`;
      assert.notEqual(normalizeDeclaredSql(a), normalizeDeclaredSql(b));
      assert.notEqual(comparableDeclaredSql(a, managed), comparableDeclaredSql(b, managed));
    }
    for (const [left, right] of [
      ['"a  b"', '"a b"'], ['"a""  b"', '"a"" b"'],
      ['`a``  b`', '`a`` b`'], ['[a,  b]', '[a, b]'],
    ]) assert.notEqual(comparableDeclaredSql(`CREATE TABLE t(${left} TEXT)`),
      comparableDeclaredSql(`CREATE TABLE t(${right} TEXT)`));
  });

  it('recognizes comments before whitespace and keeps a commented comma out of syntax', async () => {
    const results = [];
    for (const sql of ['CREATE TABLE "t"("a" TEXT -- x\n,"b" TEXT)',
      'CREATE TABLE "t"("a" TEXT -- x ,\n"b" TEXT)']) {
      results.push(await fixture(async (db) => {
        db.exec(sql);
        return { shape: await schemaShapeOf(db),
          columns: (await readSchema(db)).tables[0].columns.map((column) => column.name) };
      }));
    }
    assert.deepEqual(results.map((r) => r.columns), [['a', 'b'], ['a']]);
    assert.notDeepEqual(results[0].shape, results[1].shape);
  });

  it('ignores actual comments and formatting while preserving token boundaries', () => {
    assert.equal(normalizeDeclaredSql('CREATE /* header */ TABLE IF NOT EXISTS "t" ( "a" TEXT,\n"b" INTEGER ) STRICT'),
      comparableDeclaredSql('CREATE TABLE "t"("a" TEXT,"b" INTEGER)STRICT'));
    assert.equal(comparableDeclaredSql('CREATE TABLE "t"("a" TEXT -- member\n,"b" INTEGER)'),
      comparableDeclaredSql('CREATE TABLE "t"("a" TEXT,"b" INTEGER)'));
    assert.equal(comparableDeclaredSql('CREATE UNIQUE INDEX IF NOT EXISTS "i" ON "t"("a")'),
      comparableDeclaredSql('CREATE UNIQUE INDEX "i" ON "t"("a")'));
    assert.notEqual(comparableDeclaredSql('CREATE TABLE t(v TEXT DEFAULT (1 - -2))'),
      comparableDeclaredSql('CREATE TABLE t(v TEXT DEFAULT (1 --2\n))'));
  });

  it('keeps non-ASCII unquoted identifier characters that SQLite does not treat as whitespace', async () => {
    for (const space of ['\u00a0', '\u2003', '\u2028']) {
      await fixture(async (db) => {
        const sql = `CREATE TABLE t(a${space}b TEXT)`;
        db.exec(sql);
        assert.equal((await readSchema(db)).tables[0].columns[0].name, `a${space}b`);
        assert.notEqual(comparableDeclaredSql(sql), comparableDeclaredSql('CREATE TABLE t(a b TEXT)'));
      });
    }
  });

  it('keeps SQLite numeric underscore tokens whole', async () => {
    await fixture((db) => {
      assert.deepEqual({ ...db.prepare('SELECT 1_2 AS a,0xF_F AS b,1.2_5e1 AS c').get([]) },
        { a: 12, b: 255, c: 12.5 });
      for (const value of ['1_2', '0xF_F', '1.2_5e1']) {
        const sql = `CREATE TABLE t(v REAL DEFAULT (${value}))`;
        assert.ok(comparableDeclaredSql(sql).includes(value));
        assert.notEqual(comparableDeclaredSql(sql),
          comparableDeclaredSql(`CREATE TABLE t(v REAL DEFAULT (${value.replace('_', ' _')}))`));
      }
    });
  });

  it('refuses malformed and unsupported lexical input without a shared empty identity', () => {
    for (const sql of ['', ' /* unfinished', ' -- only a comment',
      "CREATE TABLE t(v TEXT DEFAULT 'unfinished)", 'CREATE TABLE "unfinished',
      'CREATE TABLE t([unfinished TEXT)', 'CREATE TABLE t(v TEXT',
      'CREATE TABLE t(v TEXT))', 'CREATE TABLE t(a\vb TEXT)',
      "CREATE TABLE t(v BLOB DEFAULT X'0')", 'CREATE TABLE t(v TEXT DEFAULT @parameter)',
      'CREATE TABLE t("a\0b" TEXT)', 'CREATE TABLE t(v REAL DEFAULT 1__2)',
      'CREATE TABLE t(v REAL DEFAULT 1e)', 'CREATE TABLE t(v REAL DEFAULT 1..2)']) {
      assert.throws(() => comparableDeclaredSql(sql), /SQL declaration cannot be compared/);
    }
    assert.throws(() => comparableDeclaredSql('CREATE TABLE t(a TEXT)',
      /** @type {any} */ ({ columnOrder: 'guess' })), /columnOrder/);
  });
});

describe('explicit column-order compatibility', () => {
  it('preserves physical order by default and relaxes safe named columns only on request', async () => {
    const statements = ['CREATE TABLE "t"("a" TEXT,"b" INTEGER)',
      'CREATE TABLE "t"("b" INTEGER,"a" TEXT)'];
    assert.notEqual(comparableDeclaredSql(statements[0]), comparableDeclaredSql(statements[1]));
    assert.equal(comparableDeclaredSql(statements[0], managed), comparableDeclaredSql(statements[1], managed));
    const results = [];
    for (const sql of statements) results.push(await fixture(async (db) => {
      db.exec(sql);
      return { strict: await schemaShapeOf(db), managed: await schemaShapeOf(db, managed) };
    }));
    assert.notDeepEqual(results[0].strict, results[1].strict);
    assert.deepEqual(results[0].managed, results[1].managed);
  });

  it('never sorts constraints whose conflict order changes surviving writes', async () => {
    const constraints = ['UNIQUE("a") ON CONFLICT FAIL', 'UNIQUE("b") ON CONFLICT IGNORE'];
    const results = [];
    for (const order of [constraints, [...constraints].reverse()]) results.push(await fixture(async (db) => {
      const sql = `CREATE TABLE "t"("a" INTEGER,"b" INTEGER,${order.join(',')})`;
      db.exec(sql);
      db.exec('INSERT INTO t VALUES(1,1)');
      let error = null;
      try { db.exec('INSERT INTO t VALUES(2,2),(1,1),(3,3)'); }
      catch (cause) { error = cause.message; }
      return { identity: comparableDeclaredSql(sql, managed), shape: await schemaShapeOf(db, managed),
        error, rows: db.prepare('SELECT a FROM t ORDER BY a').all([]).map((row) => row.a) };
    }));
    assert.deepEqual(results.map((r) => r.rows), [[1, 2, 3], [1, 2]]);
    assert.equal(results[0].error, null);
    assert.match(results[1].error, /UNIQUE constraint failed/);
    assert.notEqual(results[0].identity, results[1].identity);
    assert.notDeepEqual(results[0].shape, results[1].shape);
  });

  it('retains order for inline conflict/check clauses and unfamiliar table forms', () => {
    const a = '"a" INTEGER UNIQUE ON CONFLICT FAIL', b = '"b" INTEGER UNIQUE ON CONFLICT IGNORE';
    assert.notEqual(comparableDeclaredSql(`CREATE TABLE t(${a},${b})`, managed),
      comparableDeclaredSql(`CREATE TABLE t(${b},${a})`, managed));
    assert.notEqual(comparableDeclaredSql('CREATE TABLE t AS SELECT a,b FROM source', managed),
      comparableDeclaredSql('CREATE TABLE t AS SELECT b,a FROM source', managed));
    assert.notEqual(comparableDeclaredSql('CREATE TABLE t(a TEXT CHECK(a != \'\'),b TEXT)', managed),
      comparableDeclaredSql('CREATE TABLE t(b TEXT,a TEXT CHECK(a != \'\'))', managed));
  });

  it('preserves default evaluation order even when writes address columns by name', async () => {
    const defaults = ["a INTEGER DEFAULT(json_extract('bad','$'))", 'b INTEGER DEFAULT(abs(-9223372036854775808))'];
    const results = [];
    for (const order of [defaults, [...defaults].reverse()]) results.push(await fixture(async (db) => {
      const sql = `CREATE TABLE t(${order.join(',')})`;
      db.exec(sql);
      let error;
      try { db.exec('INSERT INTO t DEFAULT VALUES'); }
      catch (cause) { error = cause.message; }
      return { identity: comparableDeclaredSql(sql, managed), shape: await schemaShapeOf(db, managed), error };
    }));
    assert.match(results[0].error, /malformed JSON/);
    assert.match(results[1].error, /integer overflow/);
    assert.notEqual(results[0].identity, results[1].identity);
    assert.notDeepEqual(results[0].shape, results[1].shape);
    // The conservative policy preserves every DEFAULT clause; it does not
    // maintain a second expression classifier to infer which ones are pure.
    assert.notEqual(comparableDeclaredSql('CREATE TABLE t(a INTEGER DEFAULT 1,b INTEGER)', managed),
      comparableDeclaredSql('CREATE TABLE t(b INTEGER,a INTEGER DEFAULT 1)', managed));
  });
});

it('retains index terms, collations, predicates, and whole trigger programs in either policy', () => {
  for (const [a, b] of [
    ['CREATE INDEX i ON t(a,b)', 'CREATE INDEX i ON t(b,a)'],
    ['CREATE INDEX i ON t(a ASC)', 'CREATE INDEX i ON t(a DESC)'],
    ['CREATE INDEX i ON t(a COLLATE BINARY)', 'CREATE INDEX i ON t(a COLLATE NOCASE)'],
    ["CREATE INDEX i ON t(a) WHERE a='x  y'", "CREATE INDEX i ON t(a) WHERE a='x y'"],
    ["CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT RAISE(ABORT,'a  b'); END",
      "CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT RAISE(ABORT,'a b'); END"],
    ['CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; SELECT 2; END',
      'CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 2; SELECT 1; END'],
  ]) {
    assert.notEqual(comparableDeclaredSql(a), comparableDeclaredSql(b));
    assert.notEqual(comparableDeclaredSql(a, managed), comparableDeclaredSql(b, managed));
  }
});
