//@ts-check
/**
 * @file Model-declared index expressions: the vocabulary, its refusals,
 * the column each dialect builds, the plan that uses it, and the round
 * trip back out through introspection.
 *
 * The claim under all of it: an index over a function is a SCHEMA
 * DEPENDENCY — a database whose column is computed by `lower(…)` cannot
 * be written from a connection that has no `lower` — so the model
 * declares the function, every store that opens the model is handed the
 * same declaration, and a store that cannot honour one refuses before a
 * single statement runs.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  openStore, sqliteDialect, planCollection, normalizeModel, planMigration,
  normalizeExpression, canonicalExpression, expressionMembers, expressionFunctions,
  shapeHash,
} from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDialect } from '@jarenjs/db/postgres';
import { expressionIndex } from '@jarenjs/linq/model';

import { statementCountingDriver, tempDbPath } from './helpers.js';

/** The host's declarations: one half for an engine that registers a
 * function, the other for one that calls its own immutable name. */
const FUNCTIONS = {
  lower: {
    arity: 1,
    deterministic: true,
    apply: (value) => (value === null || value === undefined ? null : String(value).toLowerCase()),
    sql: 'lower',
  },
  concat2: {
    arity: 2,
    deterministic: true,
    apply: (a, b) => `${a ?? ''}${b ?? ''}`,
    sql: 'concat',
  },
  rolled: { arity: 0, deterministic: false, apply: () => Math.random() },
  applyless: { arity: 1, deterministic: true, sql: 'lower' },
  sqlless: { arity: 1, deterministic: true, apply: (value) => String(value) },
};

const MODEL = {
  $model: '0.1',
  collections: {
    users: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' }, email: { type: 'string' },
          first: { type: 'string' }, last: { type: 'string' } },
      },
      key: '/id',
      indexes: [
        { name: 'by_lower_email',
          expression: { call: 'lower', args: [{ member: '$.email' }] },
          unique: true },
        { name: 'by_full',
          expression: { call: 'concat2', args: [{ member: '$.first' }, { member: '$.last' }] } },
      ],
    },
  },
};

/** A model with one expression index, over one member. */
const withExpression = (expression, options = {}) => ({
  $model: '0.1',
  collections: {
    users: {
      schema: { type: 'object', required: ['id'],
        properties: { id: { type: 'string' }, email: { type: 'string' } } },
      key: '/id',
      indexes: [{ name: 'by_x', expression, ...options }],
    },
  },
});

describe('the index-expression vocabulary', () => {
  it('is three node kinds, and no fourth', () => {
    const at = '/x';
    const good = normalizeExpression(
      { call: 'concat2', args: [{ member: '$.a' }, { value: '-' }] }, at, FUNCTIONS);
    assert.deepStrictEqual(good,
      { call: 'concat2', args: [{ member: '$.a' }, { value: '-' }] });
    assert.ok(Object.isFrozen(good) && Object.isFrozen(good.args));
    for (const bad of [
      { member: '$.a', value: 1 },
      {},
      { sql: 'lower(x)' },
      { call: 'lower', args: [{ member: '$.a' }], extra: 1 },
      { member: '' },
      { value: null },
      { value: { a: 1 } },
      { value: [1] },
      { value: Number.NaN },
      { call: 'lower', args: 'not an array' },
      { call: '1bad', args: [] },
      'a string',
      null,
      [{ member: '$.a' }],
    ]) {
      assert.throws(() => normalizeExpression(bad, at, FUNCTIONS), (error) => {
        assert.strictEqual(error.code, 'JD0004');
        assert.ok(error.docPath.startsWith(at));
        return true;
      }, JSON.stringify(bad));
    }
  });

  it('resolves the function it names: unknown, wrong arity, non-deterministic', () => {
    const cases = [
      [{ call: 'nope', args: [{ member: '$.a' }] }, /which this store was not given/],
      [{ call: 'lower', args: [] }, /takes 1 argument\(s\) and the expression gives it 0/],
      [{ call: 'lower', args: [{ member: '$.a' }, { member: '$.b' }] }, /gives it 2/],
      [{ call: 'rolled', args: [] }, /not declared deterministic/],
    ];
    for (const [node, message] of cases) {
      assert.throws(() => normalizeExpression(node, '/x', FUNCTIONS), (error) => {
        assert.strictEqual(error.code, 'JD0004');
        assert.match(error.message, message);
        return true;
      }, JSON.stringify(node));
    }
    // and with no declarations at all, the refusal names the option
    assert.throws(() => normalizeExpression({ call: 'lower', args: [{ member: '$.a' }] },
      '/x', {}), /openStore\(\{ expressions \}\)/);
  });

  it('nests, but not without bound', () => {
    let node = { member: '$.a' };
    for (let i = 0; i < 8; i++) node = { call: 'lower', args: [node] };
    assert.ok(normalizeExpression(node, '/x', FUNCTIONS));
    assert.throws(() => normalizeExpression({ call: 'lower', args: [node] }, '/x', FUNCTIONS),
      (error) => error.code === 'JD0004');
  });

  it('the canonical form is the identity, and it preserves argument order', () => {
    const left = normalizeExpression(
      { call: 'concat2', args: [{ member: '$.a' }, { member: '$.b' }] }, '/x', FUNCTIONS);
    const right = normalizeExpression(
      { call: 'concat2', args: [{ member: '$.b' }, { member: '$.a' }] }, '/x', FUNCTIONS);
    assert.notStrictEqual(canonicalExpression(left), canonicalExpression(right),
      'two orders are two expressions and two columns');
    assert.strictEqual(canonicalExpression(left), 'concat2(m("$.a"),m("$.b"))');
    assert.deepStrictEqual(expressionMembers(left), ['$.a', '$.b']);
    assert.deepStrictEqual(expressionFunctions(
      normalizeExpression({ call: 'lower', args: [
        { call: 'concat2', args: [{ member: '$.a' }, { value: 'x' }] }] }, '/x', FUNCTIONS)),
    ['concat2', 'lower']);
  });

  it('is mutually exclusive with a path and with a derived index', () => {
    for (const [index, at] of [
      [{ name: 'by_x', path: '$.a', expression: { member: '$.a' } }, '/path'],
      [{ name: 'by_x', derive: 'geohash', precision: 6, expression: { member: '$.a' } }, '/derive'],
    ]) {
      const model = { $model: '0.1', collections: { users: {
        schema: { type: 'object', properties: { a: {} } }, key: null, identity: 'uuid',
        indexes: [index] } } };
      assert.throws(() => normalizeModel(model, FUNCTIONS), (error) => {
        assert.strictEqual(error.code, 'JD0004');
        assert.strictEqual(error.docPath, `/collections/users/indexes/0${at}`);
        return true;
      });
    }
  });

  it('changes the model\'s shape hash, deterministically', () => {
    const one = withExpression({ call: 'lower', args: [{ member: '$.email' }] });
    const other = withExpression({ call: 'lower', args: [{ member: '$.id' }] });
    const plain = withExpression(undefined);
    plain.collections.users.indexes = [{ name: 'by_x', path: '$.email' }];
    assert.strictEqual(shapeHash(one), shapeHash(structuredClone(one)), 'stable');
    assert.notStrictEqual(shapeHash(one), shapeHash(other));
    assert.notStrictEqual(shapeHash(one), shapeHash(plain));
  });
});

describe('the column each dialect builds', () => {
  const collections = normalizeModel(MODEL, FUNCTIONS);

  it('SQLite computes it through a registered deterministic function', () => {
    const plan = planCollection('users', collections.get('users'), sqliteDialect,
      { expressions: FUNCTIONS, registered: true });
    const [create] = plan.createSql;
    assert.match(create,
      /"gx_lower_email_x" TEXT GENERATED ALWAYS AS \(jaren_x_lower\(jsonb_extract\("doc", '\$\."email"'\)\)\) VIRTUAL/);
    assert.match(create, /"gx_concat2_first_last_x" TEXT GENERATED ALWAYS AS \(jaren_x_concat2\(/);
    assert.deepStrictEqual(plan.createSql.slice(1), [
      'CREATE UNIQUE INDEX "users_by_lower_email" ON "users" ("gx_lower_email_x")',
      'CREATE INDEX "users_by_full" ON "users" ("gx_concat2_first_last_x")',
    ]);
    // the functions the store must register before it can so much as
    // SELECT from the table it created
    assert.deepStrictEqual(plan.expressions.map((entry) => entry.functions),
      [['lower'], ['concat2']]);
  });

  it('PostgreSQL calls the immutable function the host promised the server has', () => {
    const plan = planCollection('users', collections.get('users'), postgresDialect(),
      { expressions: FUNCTIONS, registered: false });
    const [create] = plan.createSql;
    assert.match(create,
      /"gx_lower_email_x" text COLLATE "C" GENERATED ALWAYS AS \(lower\(\("doc" #>> '\{"email"\}'\)\)\) STORED/);
    // the model's name and the SQL name are different, and the mapping
    // is the host's: `concat2` is `concat` on the server
    assert.match(create, /GENERATED ALWAYS AS \(concat\(\("doc" #>> /);
    assert.ok(!create.includes('jaren_x_'), 'nothing is registered here');
  });

  it('each dialect reads its OWN expression back out of the SQL it wrote', () => {
    const byName = { jaren_x_lower: 'lower', jaren_x_concat2: 'concat2', concat: 'concat2',
      lower: 'lower' };
    const declared = { call: 'concat2',
      args: [{ call: 'lower', args: [{ member: '$.a' }] }, { value: '-' }] };
    for (const [dialect, registered] of
      /** @type {[any, boolean][]} */ ([[sqliteDialect, true], [postgresDialect(), false]])) {
      const model = withExpression(declared);
      const plan = planCollection('users', normalizeModel(model, FUNCTIONS).get('users'),
        dialect, { expressions: FUNCTIONS, registered });
      const [column] = plan.generated;
      const sql = /^.*GENERATED ALWAYS AS \((.*)\) (?:VIRTUAL|STORED)/
        .exec(plan.createSql[0].slice(plan.createSql[0].indexOf(column.name)))[1];
      assert.deepStrictEqual(dialect.expressionOf(sql, byName), declared, dialect.name);
      // and SQL this dialect did not write answers null, which is what
      // the introspector reports rather than guesses
      assert.strictEqual(dialect.expressionOf('length("key")', byName), null, dialect.name);
      assert.strictEqual(dialect.expressionOf('nope(1)', byName), null, dialect.name);
    }
  });

  it('one column serves every index that declares the same expression', () => {
    const shared = {
      $model: '0.1',
      collections: { users: { schema: { type: 'object', properties: { a: {} } },
        key: null, identity: 'uuid',
        indexes: [
          { name: 'one', expression: { call: 'lower', args: [{ member: '$.a' }] } },
          { name: 'two', expression: { call: 'lower', args: [{ member: '$.a' }] }, unique: true },
        ] } },
    };
    const plan = planCollection('users', normalizeModel(shared, FUNCTIONS).get('users'),
      sqliteDialect, { expressions: FUNCTIONS, registered: true });
    assert.strictEqual(plan.generated.length, 1, 'one expression, one column');
    assert.strictEqual(plan.createSql.length, 3);
    assert.ok(plan.createSql[1].includes(plan.generated[0].name));
    assert.ok(plan.createSql[2].includes(plan.generated[0].name));
  });

  it('a declaration missing the half its engine needs is JD0004, before any DDL', () => {
    const model = withExpression({ call: 'applyless', args: [{ member: '$.email' }] });
    const collection = normalizeModel(model, FUNCTIONS).get('users');
    // this engine REGISTERS, and there is nothing to register
    assert.throws(() => planCollection('users', collection, sqliteDialect,
      { expressions: FUNCTIONS, registered: true }), (error) => {
      assert.strictEqual(error.code, 'JD0004');
      assert.match(error.message, /has no 'apply'/);
      return true;
    });
    // and the mirror: this engine calls its own, and was given no name
    const other = normalizeModel(
      withExpression({ call: 'sqlless', args: [{ member: '$.email' }] }), FUNCTIONS).get('users');
    assert.throws(() => planCollection('users', other, postgresDialect(),
      { expressions: FUNCTIONS, registered: false }), (error) => {
      assert.strictEqual(error.code, 'JD0004');
      assert.match(error.message, /has no 'sql' name/);
      assert.match(error.message, /never SQL text/);
      return true;
    });
  });

  it('a string argument is a bound LITERAL, never text spliced into SQL', () => {
    const model = withExpression({ call: 'concat2',
      args: [{ member: '$.email' }, { value: "o'clock; DROP TABLE users" }] });
    const plan = planCollection('users', normalizeModel(model, FUNCTIONS).get('users'),
      sqliteDialect, { expressions: FUNCTIONS, registered: true });
    // quoted by the dialect, so the statement it lands in is one
    // statement — the census's rule, applied to a caller's string
    assert.ok(plan.createSql[0].includes("'o''clock; DROP TABLE users'"));
    assert.strictEqual(plan.createSql.length, 2, 'one table, one index — nothing else parsed');
  });

  it('the function name is namespaced, so a model never shadows the engine\'s own', () => {
    const plan = planCollection('users', collections.get('users'), sqliteDialect,
      { expressions: FUNCTIONS, registered: true });
    assert.ok(plan.createSql[0].includes('jaren_x_lower('));
    assert.ok(!/[^_]lower\(/.test(plan.createSql[0]));
  });
});

describe('a store over a declared expression index', () => {
  it('computes the column, seeks through the index, and reads the document whole',
    async () => {
      const counters = { iterate: 0, next: 0, return: 0, all: 0 };
      const store = await openStore(MODEL,
        { driver: statementCountingDriver(counters), expressions: FUNCTIONS });
      try {
        const users = store.collection('users');
        await users.insert({ id: 'a', email: 'ANN@Example.COM', first: 'Ann', last: 'Lee' });
        await users.insert({ id: 'b', email: 'bob@example.com', first: 'Bob', last: 'Ray' });
        // the document is untouched by the index over it
        assert.deepStrictEqual(await users.get('a'),
          { id: 'a', email: 'ANN@Example.COM', first: 'Ann', last: 'Lee' });
        // the column IS the lowered value: a unique index over it
        // refuses a second document whose email differs only in case
        await assert.rejects(() => users.insert({ id: 'c', email: 'ann@EXAMPLE.com' }),
          (error) => {
            assert.strictEqual(error.code, 'JD2005');
            assert.strictEqual(error.class, 'constraint');
            return true;
          });
      }
      finally {
        await store.close();
      }
    });

  it('the engine SEEKS through the created index for a predicate over the column',
    async () => {
      // the query language has no way to spell `lower(email)`, so the
      // claim is checked where it lives: the database's own plan for a
      // predicate over the column the expression built. The dialect that
      // wrote the index is the one that reads the narrative.
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(':memory:');
      db.function('jaren_x_lower', { deterministic: true },
        (value) => (value === null ? null : String(value).toLowerCase()));
      db.function('jaren_x_concat2', { deterministic: true },
        (a, b) => `${a ?? ''}${b ?? ''}`);
      const plan = planCollection('users', normalizeModel(MODEL, FUNCTIONS).get('users'),
        sqliteDialect, { expressions: FUNCTIONS, registered: true });
      for (const sql of plan.createSql) db.exec(sql);
      db.prepare('INSERT INTO "users" ("key", "doc") VALUES (?, jsonb(?))')
        .run('a', JSON.stringify({ id: 'a', email: 'ANN@Example.COM' }));
      const column = plan.generated.find((entry) => entry.name.startsWith('gx_lower'));
      const rows = db.prepare(sqliteDialect.explainQuery(
        `SELECT "key" FROM "users" WHERE ${sqliteDialect.quoteIdentifier(column.name)} = ?`))
        .all('ann@example.com');
      const lines = sqliteDialect.explainLines(rows);
      assert.ok(lines.some((line) => sqliteDialect.usesIndex(line, 'users_by_lower_email')),
        `the plan did not seek: ${lines.join('; ')}`);
      assert.ok(!lines.some((line) => sqliteDialect.isFullScan(line, ['users'])));
      // and the column really carries the lowered value
      assert.deepStrictEqual(
        db.prepare(`SELECT ${sqliteDialect.quoteIdentifier(column.name)} AS v FROM "users"`)
          .all().map((row) => row.v), ['ann@example.com']);
      db.close();
    });

  it('a store given no declarations refuses the model by name, before any statement',
    async () => {
      await assert.rejects(() => openStore(MODEL, { driver: nodeDriver() }), (error) => {
        assert.strictEqual(error.code, 'JD0004');
        assert.match(error.message, /the declared functions are none/);
        assert.strictEqual(error.docPath,
          '/collections/users/indexes/0/expression/call');
        return true;
      });
    });

  it('a driver that can neither register nor be given a SQL name refuses at open',
    async () => {
      const model = withExpression({ call: 'sqlless', args: [{ member: '$.email' }] });
      // the wasm-shaped case: a connection that declares no
      // deterministic indexable functions computes nothing itself
      const { statements, driver } = nonRegisteringDriver();
      await assert.rejects(() => openStore(model, { driver, expressions: FUNCTIONS }),
        (error) => {
          assert.strictEqual(error.code, 'JD0004');
          assert.match(error.message, /has no 'sql' name/);
          return true;
        });
      assert.deepStrictEqual(statements.filter((sql) => /^CREATE/.test(sql)), [],
        'the refusal precedes every statement');
    });

  it('the index survives a reopen: the shape verifies against the declared text', async () => {
    // a FILE, so the second open meets the table the first created —
    // and the drift check compares the declared expression text, which
    // is where a function that had changed under it would show up
    const { dbPath, cleanup } = tempDbPath();
    try {
      const first = await openStore(MODEL,
        { driver: nodeDriver(), path: dbPath, expressions: FUNCTIONS });
      await first.collection('users').insert({ id: 'a', email: 'A@B.C' });
      await first.close();
      const second = await openStore(MODEL,
        { driver: nodeDriver(), path: dbPath, expressions: FUNCTIONS });
      assert.deepStrictEqual(await second.collection('users').get('a'),
        { id: 'a', email: 'A@B.C' });
      await second.close();
      // and a model whose expression CHANGED is drift, not a silent
      // reuse of a column that computes something else
      const changed = structuredClone(MODEL);
      changed.collections.users.indexes[0].expression = {
        call: 'concat2', args: [{ member: '$.email' }, { value: '!' }] };
      await assert.rejects(() => openStore(changed,
        { driver: nodeDriver(), path: dbPath, expressions: FUNCTIONS }),
      (error) => error.code === 'JD0002');
    }
    finally {
      cleanup();
    }
  });
});

describe('the round trip', () => {
  it('introspect → plan finds no DDL to do, and a second read answers the same', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), expressions: FUNCTIONS });
    try {
      const first = await store.introspect({ keys: { users: '/id' }, expressions: FUNCTIONS });
      // the expression came back, whole
      assert.deepStrictEqual(first.model.collections.users.indexes, [
        { name: 'by_full',
          expression: { call: 'concat2', args: [{ member: '$.first' }, { member: '$.last' }] } },
        { name: 'by_lower_email',
          expression: { call: 'lower', args: [{ member: '$.email' }] }, unique: true },
      ]);
      // and it plans no structural change against the model it was read from
      const { migration } = planMigration(first.model, MODEL,
        { dialect: sqliteDialect, expressions: FUNCTIONS });
      assert.deepStrictEqual(migration.steps.filter((step) => step.kind === 'ddl'), []);
      // reading twice answers the same, which is what makes it a read
      const second = await store.introspect({ keys: { users: '/id' }, expressions: FUNCTIONS });
      assert.deepStrictEqual(second.model, first.model);
      assert.deepStrictEqual(second.report, first.report);
    }
    finally {
      await store.close();
    }
  });

  it('without the declarations the column is reported, not guessed', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), expressions: FUNCTIONS });
    try {
      const { model, report } = await store.introspect({ keys: { users: '/id' } });
      assert.deepStrictEqual(model.collections.users.indexes, [],
        'an index over a function nobody named is not an index this read can declare');
      const unmapped = report.filter((row) => row.code === 'unmapped-column');
      assert.strictEqual(unmapped.length, 2);
      for (const row of unmapped) assert.match(row.detail, /declared index expression/);
    }
    finally {
      await store.close();
    }
  });
});

describe('the model pen writes the same document', () => {
  it('expressionIndex() answers what the format declares', () => {
    assert.deepStrictEqual(
      expressionIndex({ call: 'lower', args: [(d) => d.email] }, { unique: true }),
      { name: 'by_lower_email',
        expression: { call: 'lower', args: [{ member: '$.email' }] }, unique: true });
    // and the store accepts it unchanged
    const model = { $model: '0.1', collections: { users: {
      schema: { type: 'object', properties: { email: { type: 'string' } } },
      key: null, identity: 'uuid',
      indexes: [expressionIndex({ call: 'lower', args: [(d) => d.email] })] } } };
    const collection = normalizeModel(model, FUNCTIONS).get('users');
    assert.strictEqual(collection.indexes[0].canonical, 'lower(m("$.email"))');
  });

  it('refuses what the vocabulary does not name, as a build error', () => {
    for (const bad of ['lower(email)', { sql: 'lower(x)' }, { call: '1bad' }, null]) {
      assert.throws(() => expressionIndex(bad), (error) => {
        assert.strictEqual(error.code, 'JL0101');
        return true;
      }, JSON.stringify(bad));
    }
    assert.throws(() => expressionIndex({ call: 'lower', args: [(d) => d.a] },
      { derive: 'geohash' }), /does not take 'derive'/);
  });
});

/**
 * A driver whose connection declares no deterministic indexable
 * functions — the shape a wasm build or another engine has.
 */
function nonRegisteringDriver() {
  /** @type {string[]} */
  const statements = [];
  const driver = {
    name: 'non-registering',
    dialect: sqliteDialect,
    open: async () => {
      const { DatabaseSync } = await import('node:sqlite');
      const { openConnection, PRAGMA_NAMES } = await import('@jarenjs/db');
      const db = new DatabaseSync(':memory:');
      const raw = {
        exec: (sql) => { statements.push(sql); return db.exec(sql); },
        prepare: (sql) => {
          statements.push(sql);
          const statement = db.prepare(sql);
          return {
            run: (params = []) => statement.run(...params),
            get: (params = []) => statement.get(...params),
            all: (params = []) => statement.all(...params),
            iterate: (params = []) => statement.iterate(...params),
          };
        },
        close: () => db.close(),
      };
      return openConnection(raw, { dialect: sqliteDialect, synchronous: true,
        declared: { pragmas: PRAGMA_NAMES } });
    },
  };
  return { statements, driver };
}
