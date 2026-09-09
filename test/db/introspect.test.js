//@ts-check
/**
 * @file Database → model. The claim is not "the model comes back"; it
 * is that what comes back is EXACT where the physical shape carries the
 * fact, REPORTED where it does not, and the same on both engines after
 * the physical names they each choose are accounted for.
 *
 * The SQLite half runs against a real database. The PostgreSQL half
 * runs against hand-authored catalog rows — the same rows the live
 * server answers, which the live suite proves separately — so the
 * two-engine agreement is checked here without an endpoint, and checked
 * again against the server where there is one.
 *
 * And the whole read is READ-ONLY: a statement trace is what says so,
 * not a comment.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

import {
  openStore, introspectModel, readSchema, INTROSPECT_CODES, sqliteDialect,
  openConnection, planMigration, normalizeModel, planCollection, PRAGMA_NAMES,
} from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDialect } from '@jarenjs/db/postgres';

/** A model with every shape the derivation has an answer for. */
const MODEL = {
  $model: '0.1',
  collections: {
    users: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          email: { type: 'string' },
          age: { type: 'integer' },
          score: { type: 'number' },
          extra: {},
          nested: { type: 'object', properties: { deep: { type: 'string' } } },
        },
      },
      key: '/id',
      indexes: [
        { name: 'by_email', path: '$.email', unique: true },
        { name: 'by_age', path: '$.age' },
        { name: 'by_deep', path: '$.nested.deep' },
      ],
    },
    events: {
      schema: { type: 'object', properties: { n: { type: 'integer' } } },
      key: null,
      identity: 'integer',
      indexes: [{ name: 'by_n', path: '$.n' }],
    },
  },
};

/** A store over a fresh in-memory SQLite database, and its connection. */
async function sqliteStore(model = MODEL) {
  const store = await openStore(model, { driver: nodeDriver() });
  return store;
}

/**
 * A connection over a database built by hand, so the derivation can be
 * shown what it does with a shape no model made.
 * @param {string[]} statements
 * @param {string[]} [trace] - every statement the connection runs
 */
function handMade(statements, trace = undefined) {
  const db = new DatabaseSync(':memory:');
  for (const sql of statements) db.exec(sql);
  const record = (sql) => { if (trace !== undefined) trace.push(sql); };
  const raw = {
    exec: (sql) => { record(sql); return db.exec(sql); },
    prepare: (sql) => {
      record(sql);
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
  return openConnection(raw, {
    dialect: sqliteDialect, synchronous: true, declared: { pragmas: PRAGMA_NAMES },
  });
}

/** Every report row of one code, by the object it names. */
const of = (report, code) => report.filter((row) => row.code === code)
  .map((row) => row.object).sort();

describe('introspectModel — the derivation', () => {

  it('recovers scalar enum CHECKs without interpreting quoted SQL as syntax', async () => {
    const connection = handMade([
      `CREATE TABLE "Choice" ("id" TEXT PRIMARY KEY,
        "state" TEXT CHECK ("state" IN ('open', 'it''s (CHECK)', 'closed')),
        "level" INTEGER CHECK ("level" IN (-1, 0, 2)),
        "score" REAL CHECK ("score" IN (0.5, 1e2)),
        "other" TEXT CHECK (length("other") > 2))`,
    ]);
    try {
      const { model, report } = await introspectModel(connection);
      const props = model.entities.Choice.schema.properties;
      assert.deepStrictEqual(props.state.enum, ['open', "it's (CHECK)", 'closed']);
      assert.deepStrictEqual(props.level.enum, [-1, 0, 2]);
      assert.deepStrictEqual(props.score.enum, [0.5, 100]);
      assert.deepStrictEqual(of(report, 'unmapped-constraint'), ['Choice.check_4']);
    }
    finally { await connection.close(); }
  });

  it('never strengthens partial uniqueness or silently drops expression index terms', async () => {
    const connection = handMade([
      'CREATE TABLE "Choice" ("id" TEXT PRIMARY KEY, "state" TEXT, "level" INTEGER)',
      `CREATE UNIQUE INDEX "Choice_partial" ON "Choice" ("state") WHERE "level" > 0`,
      'CREATE INDEX "Choice_expr" ON "Choice" ("state", length("state"))',
    ]);
    try {
      const { model, report } = await introspectModel(connection);
      assert.deepStrictEqual(model.entities.Choice.schema.properties.state, { type: 'string' });
      assert.deepStrictEqual(of(report, 'unmapped-index'), ['Choice.Choice_expr', 'Choice.Choice_partial']);
    }
    finally { await connection.close(); }
  });

  it('does not derive enums from NULL lists, coercing affinity or larger predicates', async () => {
    const connection = handMade([
      `CREATE TABLE "Choice" ("id" TEXT PRIMARY KEY,
        "a" TEXT CHECK ("a" IN ('open', NULL)),
        "b" INTEGER CHECK ("b" IN ('1', '2')),
        "c" TEXT CHECK ("c" IN ('open') OR length("c") > 2))`,
    ]);
    try {
      const { model, report } = await introspectModel(connection);
      for (const name of ['a', 'b', 'c']) assert.strictEqual(model.entities.Choice.schema.properties[name].enum, undefined);
      assert.strictEqual(of(report, 'unmapped-constraint').length, 3);
    }
    finally { await connection.close(); }
  });

  it('does not interpret a collation-dependent CHECK as JSON enum equality', async () => {
    const connection = handMade([
      `CREATE TABLE "Choice" ("id" TEXT PRIMARY KEY,
        "state" TEXT COLLATE NOCASE CHECK ("state" IN ('open', 'closed')))`,
      `INSERT INTO "Choice" VALUES ('one', 'OPEN')`,
    ]);
    try {
      const { model, report } = await introspectModel(connection);
      assert.strictEqual(model.entities.Choice.schema.properties.state.enum, undefined);
      assert.deepStrictEqual(of(report, 'unmapped-constraint'), ['Choice.check_1']);
    }
    finally { await connection.close(); }
  });

  it('round-trips the enum CHECK emitted for a mapped entity property', async () => {
    const store = await sqliteStore({ $model: '0.1', entities: { Choice: { schema: {
      type: 'object', required: ['id'], properties: {
        id: { type: 'string', 'x-entity': { key: true } },
        state: { type: 'string', enum: ['open', "it's closed"], 'x-entity': { index: true } },
        fixed: { type: 'string', enum: ['only'], 'x-entity': { index: true } },
      },
    } } } });
    try {
      const { model, report } = await store.introspect();
      assert.deepStrictEqual(model.entities.Choice.schema.properties.state.enum, ['open', "it's closed"]);
      assert.deepStrictEqual(model.entities.Choice.schema.properties.fixed.enum, ['only']);
      assert.deepStrictEqual(of(report, 'unmapped-constraint'), []);
      const rebuilt = await sqliteStore(model);
      await rebuilt.close();
    }
    finally { await store.close(); }
  });

  it('a collection comes back with its key, its identity and every index path', async () => {
    const store = await sqliteStore();
    try {
      const { model } = await Promise.resolve(
        store.introspect({ keys: { users: '/id' } }));
      assert.strictEqual(model.$model, '0.1');
      assert.deepStrictEqual(Object.keys(model.collections).sort(), ['events', 'users']);
      assert.strictEqual(model.collections.users.key, '/id');
      assert.strictEqual(model.collections.users.identity, undefined);
      // a DATABASE-allocated key says so in its own column type
      assert.strictEqual(model.collections.events.key, null);
      assert.strictEqual(model.collections.events.identity, 'integer');
      // in CATALOG order, which is by name: a physical shape carries no
      // record of the order a model declared its indexes in, and a
      // derivation that invented one would be inventing
      assert.deepStrictEqual(model.collections.users.indexes, [
        { name: 'by_age', path: '$.age' },
        { name: 'by_deep', path: '$.nested.deep' },
        { name: 'by_email', path: '$.email', unique: true },
      ]);
      // the schema holds the members the SHAPE carries, typed from the
      // columns that carry them
      assert.deepStrictEqual(model.collections.users.schema, {
        type: 'object',
        properties: {
          id: { type: 'string' },
          email: { type: 'string' },
          age: { type: 'integer' },
          // the type lives at the DEPTH the path names it at, because
          // that is where the column's own type came from
          nested: { type: 'object', properties: { deep: { type: 'string' } } },
        },
      });
    }
    finally {
      await store.close();
    }
  });

  it('a derived model opens a store that verifies the shape it was read from', async () => {
    const store = await sqliteStore();
    const { model } = await Promise.resolve(
      store.introspect({ keys: { users: '/id' } }));
    await store.close();
    // the model is VALID: it normalizes, it plans, and its planned DDL
    // is the DDL the original made
    const collections = normalizeModel(model);
    assert.strictEqual(collections.size, 2);
    const planned = planCollection('users', collections.get('users'), sqliteDialect);
    const original = planCollection('users', normalizeModel(MODEL).get('users'), sqliteDialect);
    // the same SHAPE, which is what the drift check compares and what
    // the two models therefore have to agree on. The statement TEXT
    // differs only in the order the columns and indexes are written in,
    // because a physical shape carries no record of declaration order
    const byName = (shape) => ({
      columns: [...shape.columns].sort((a, b) => (a.name < b.name ? -1 : 1)),
      indexes: shape.indexes,
    });
    assert.deepStrictEqual(byName(planned.expected), byName(original.expected));
    assert.deepStrictEqual(planned.createSql.slice(1).sort(), original.createSql.slice(1).sort());
  });

  it('an introspected model enters the migration planner and finds nothing to do',
    async () => {
      const store = await sqliteStore();
      const { model } = await Promise.resolve(
        store.introspect({ keys: { users: '/id' } }));
      await store.close();
      // the derived model against the DECLARED one: the physical shapes
      // are the same, so the plan is empty. That is the convergence
      // claim, and it is what makes a derived model usable as a `from`
      const { migration, report } = planMigration(model, MODEL, { dialect: sqliteDialect });
      assert.deepStrictEqual(migration.steps.filter((step) => step.kind === 'ddl'), []);
      assert.deepStrictEqual(report.added, []);
      assert.deepStrictEqual(report.removed, []);
    });

  it('every loss has a code from the closed set, once, sorted', async () => {
    const store = await sqliteStore();
    try {
      const { report } = await Promise.resolve(store.introspect());
      for (const row of report) {
        assert.ok(Object.hasOwn(INTROSPECT_CODES, row.code), `unknown code ${row.code}`);
        assert.strictEqual(typeof row.object, 'string');
        assert.ok(row.detail.length > 20, row.code);
        assert.ok(Object.isFrozen(row));
      }
      const keys = report.map((row) => `${row.code} ${row.object}`);
      assert.deepStrictEqual([...keys].sort(), keys, 'the report is sorted');
      assert.strictEqual(new Set(keys).size, keys.length, 'each object is reported once');
      // the two the shape genuinely cannot carry
      assert.deepStrictEqual(of(report, 'document-members'), ['events', 'users']);
      assert.deepStrictEqual(of(report, 'key-source'), ['events.key', 'users.key']
        .filter((object) => object === 'users.key'),
      'only a text key cannot say what filled it');
    }
    finally {
      await store.close();
    }
  });

  it('strict mode refuses before returning a partial model', async () => {
    const store = await sqliteStore();
    try {
      await assert.rejects(
        async () => store.introspect({ strict: true }),
        (error) => {
          assert.strictEqual(error.code, 'JD0002');
          assert.match(error.message, /strict introspection refused/);
          assert.match(error.message, /document-members/);
          return true;
        });
    }
    finally {
      await store.close();
    }
  });

  it('the read issues no DDL and no DML, and opens no transaction', async () => {
    const trace = [];
    const connection = handMade([
      'CREATE TABLE "users" ("key" TEXT PRIMARY KEY, "doc" BLOB NOT NULL, '
      + '"gx_email" TEXT GENERATED ALWAYS AS (jsonb_extract("doc", \'$."email"\')) VIRTUAL) STRICT',
      'CREATE UNIQUE INDEX "users_by_email" ON "users" ("gx_email")',
    ], trace);
    trace.length = 0;
    await Promise.resolve(introspectModel(connection));
    assert.ok(trace.length > 0, 'it did read');
    for (const sql of trace) {
      assert.match(sql, /^(SELECT|PRAGMA)\b/,
        `a read-only introspection issued: ${sql}`);
      assert.ok(!/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|BEGIN|COMMIT|SAVEPOINT)\b/i.test(sql),
        `a read-only introspection issued: ${sql}`);
    }
    await connection.close();
  });

  it('a hostile table, column and member name survive the round trip', async () => {
    const model = {
      $model: '0.1',
      collections: {
        weird: {
          schema: { type: 'object', properties: { 'a.b': { type: 'string' },
            'has space': { type: 'integer' } } },
          key: null,
          identity: 'uuid',
          indexes: [
            { name: 'by_dotted', path: '$["a.b"]' },
            { name: 'by_spaced', path: '$["has space"]' },
          ],
        },
      },
    };
    const store = await openStore(model, { driver: nodeDriver() });
    try {
      const { model: derived } = await Promise.resolve(store.introspect());
      // `a.b` as ONE member and `a` → `b` as two are different paths,
      // and the derivation keeps them apart because the expression does
      assert.deepStrictEqual(derived.collections.weird.indexes.map((index) => index.path),
        ['$["a.b"]', '$["has space"]']);
    }
    finally {
      await store.close();
    }
  });

  describe('what the shape cannot carry is reported, not invented', () => {
    it('a view', async () => {
      const connection = handMade([
        'CREATE TABLE "users" ("key" TEXT PRIMARY KEY, "doc" BLOB NOT NULL) STRICT',
        'CREATE VIEW "recent" AS SELECT "key" FROM "users"',
      ]);
      const { model, report } = await Promise.resolve(introspectModel(connection));
      assert.deepStrictEqual(of(report, 'unmapped-view'), ['recent']);
      assert.deepStrictEqual(Object.keys(model.collections), ['users']);
      await connection.close();
    });

    it('a table that is neither a collection nor an entity', async () => {
      const connection = handMade([
        'CREATE TABLE "loose" ("a" TEXT, "b" INTEGER)',
      ]);
      const { model, report } = await Promise.resolve(introspectModel(connection));
      assert.deepStrictEqual(of(report, 'unmapped-table'), ['loose']);
      assert.strictEqual(model.collections, undefined);
      assert.strictEqual(model.entities, undefined);
      await connection.close();
    });

    it('a generated column over an expression this dialect did not write', async () => {
      const connection = handMade([
        'CREATE TABLE "users" ("key" TEXT PRIMARY KEY, "doc" BLOB NOT NULL, '
        + '"gx_len" INTEGER GENERATED ALWAYS AS (length("key")) VIRTUAL) STRICT',
      ]);
      const { model, report } = await Promise.resolve(introspectModel(connection));
      assert.deepStrictEqual(of(report, 'unmapped-column'), ['users.gx_len']);
      assert.deepStrictEqual(model.collections.users.indexes, []);
      await connection.close();
    });

    it('an index over a column no member path explains', async () => {
      const connection = handMade([
        'CREATE TABLE "users" ("key" TEXT PRIMARY KEY, "doc" BLOB NOT NULL, '
        + '"gx_len" INTEGER GENERATED ALWAYS AS (length("key")) VIRTUAL) STRICT',
        'CREATE INDEX "users_by_len" ON "users" ("gx_len")',
      ]);
      const { report } = await Promise.resolve(introspectModel(connection));
      assert.deepStrictEqual(of(report, 'unmapped-index'), ['users.users_by_len']);
      await connection.close();
    });

    it('a column type no schema type maps back from', async () => {
      const connection = handMade([
        'CREATE TABLE "users" ("key" TEXT PRIMARY KEY, "doc" BLOB NOT NULL, '
        + '"gx_x" ANY GENERATED ALWAYS AS (jsonb_extract("doc", \'$."x"\')) VIRTUAL) STRICT',
      ]);
      const { model, report } = await Promise.resolve(introspectModel(connection));
      assert.deepStrictEqual(of(report, 'unmapped-type'), ['users.gx_x']);
      assert.deepStrictEqual(model.collections.users.schema.properties.x, {},
        'the member is there and untyped, which is what the column says');
      await connection.close();
    });
  });

  describe('entities and relations', () => {
    const RELATIONAL = {
      $model: '0.1',
      entities: {
        Author: {
          schema: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string', 'x-entity': { key: true } },
              name: { type: 'string', 'x-entity': { index: true } },
              email: { type: 'string', 'x-entity': { unique: true } },
              books: { 'x-entity': { relation: {
                to: 'Book', many: true, via: 'authorId', onDelete: 'cascade' } } },
            },
          },
        },
        Book: {
          schema: {
            type: 'object',
            required: ['id', 'authorId'],
            properties: {
              id: { type: 'string', 'x-entity': { key: true } },
              title: { type: 'string' },
              authorId: { type: 'string' },
            },
          },
        },
      },
    };

    it('an entity comes back with its key, its indexed columns and its foreign key',
      async () => {
        const store = await openStore(RELATIONAL, { driver: nodeDriver() });
        try {
          const { model, report } = await Promise.resolve(store.introspect());
          assert.deepStrictEqual(Object.keys(model.entities).sort(), ['Author', 'Book']);
          const author = model.entities.Author.schema;
          assert.deepStrictEqual(author.required, ['id']);
          assert.deepStrictEqual(author.properties.id, {
            type: 'string', 'x-entity': { key: true } });
          assert.deepStrictEqual(author.properties.email, {
            type: 'string', 'x-entity': { unique: true } });
          assert.deepStrictEqual(author.properties.name, {
            type: 'string', 'x-entity': { index: true } });
          assert.deepStrictEqual(model.entities.Book.schema.properties.authorId, {
            'x-entity': { relation: { to: 'Author', via: 'authorId', onDelete: 'cascade' } } });
          // which SIDE declared the edge, and whether the other holds
          // many, is not in the shape
          assert.deepStrictEqual(of(report, 'ambiguous-relation'), ['Book.authorId']);
        }
        finally {
          await store.close();
        }
      });

    it('a join table becomes a many-to-many, declared on one side and reported', async () => {
      const model = {
        $model: '0.1',
        entities: {
          Person: {
            schema: { type: 'object', required: ['id'], properties: {
              id: { type: 'string', 'x-entity': { key: true } },
              tags: { 'x-entity': { relation: { to: 'Tag', many: true } } } } },
          },
          Tag: {
            schema: { type: 'object', required: ['name'], properties: {
              name: { type: 'string', 'x-entity': { key: true } } } },
          },
        },
      };
      const store = await openStore(model, { driver: nodeDriver() });
      try {
        const { model: derived, report } = await Promise.resolve(
          store.introspect());
        assert.deepStrictEqual(Object.keys(derived.entities).sort(), ['Person', 'Tag']);
        const relation = derived.entities.Person.schema.properties.tags['x-entity'].relation;
        assert.strictEqual(relation.to, 'Tag');
        assert.strictEqual(relation.many, true);
        assert.strictEqual(relation.through, 'Person_Tag');
        assert.ok(of(report, 'ambiguous-relation').includes('Person_Tag'));
      }
      finally {
        await store.close();
      }
    });
  });

  describe('the two engines answer the same question', () => {
    /**
     * A connection over hand-authored catalog rows: the shapes a
     * PostgreSQL server answers for the same model, which the live
     * suite checks against the server itself.
     * @param {Record<string, any[]>} answers
     */
    const pgConnection = (answers) => {
      const dialect = postgresDialect();
      const find = (sql) => {
        for (const [key, rows] of Object.entries(answers)) {
          if (sql.includes(key)) return rows;
        }
        return [];
      };
      return Object.freeze({
        dialect,
        capabilities: { declaredSqlText: false },
        prepare: (sql) => Object.freeze({
          all: () => find(sql),
          get: () => find(sql)[0],
          run: () => ({ changes: 0 }),
        }),
      });
    };

    it('recovers PostgreSQL array and singleton enum checks and reports partial indexes', async () => {
      const connection = pgConnection({
        'relkind IN': [{ name: 'Choice', type: 'table' }],
        'FROM pg_attribute a': [
          { name: 'doc', type: 'jsonb', hidden: 0 },
          { name: 'state', type: 'text', hidden: 0 },
          { name: 'score', type: 'numeric', hidden: 0 },
          { name: 'fixed', type: 'text', hidden: 0 },
        ],
        'CASE WHEN i.indisunique': [{ name: 'Choice_partial', uniq: 1, origin: 'c', partial: 1 }],
        'FROM pg_index i': [{ name: 'state' }],
        "c.contype = 'c'": [
          { name: 'state_check', expression: "(state = ANY (ARRAY['open'::text, 'it''s closed'::text]))" },
          { name: 'score_check', expression: '((score = ANY (ARRAY[(1)::numeric, (2.5)::numeric])))' },
          { name: 'fixed_check', expression: "(fixed = 'only'::text)" },
          { name: 'other_check', expression: '(score > (0)::numeric)' },
        ],
      });
      const { model, report } = await introspectModel(connection);
      const props = model.entities.Choice.schema.properties;
      assert.deepStrictEqual(props.state, { type: 'string', enum: ['open', "it's closed"] });
      assert.deepStrictEqual(props.score.enum, [1, 2.5]);
      assert.deepStrictEqual(props.fixed.enum, ['only']);
      assert.deepStrictEqual(of(report, 'unmapped-constraint'), ['Choice.other_check']);
      assert.deepStrictEqual(of(report, 'unmapped-index'), ['Choice.Choice_partial']);
    });

    it('equivalent fixtures derive the same logical model', async () => {
      const sqlite = await sqliteStore();
      const { model: fromSqlite } = await sqlite.introspect({ keys: { users: '/id' } });
      await sqlite.close();

      // the same two collections, as PostgreSQL's catalog reports them
      const path = (name) => `(doc #> '{${name}}'::text[])`;
      const connection = pgConnection({
        'relkind IN': [{ name: 'users', type: 'table' }, { name: 'events', type: 'table' }],
        'FROM pg_attribute a': [],
      });
      // one table at a time, because the answers are per table
      const usersRows = {
        'relkind IN': [{ name: 'users', type: 'table' }],
        "c.relname = 'users' AND n.nspname = ANY(current_schemas(false)) AND a.attnum": [
          { name: 'key', type: 'text', hidden: 0 },
          { name: 'doc', type: 'jsonb', hidden: 0 },
          { name: 'rid', type: 'bigint', hidden: 0 },
          { name: 'gx_email', type: 'text', hidden: 1 },
          { name: 'gx_age', type: 'numeric', hidden: 1 },
          { name: 'gx_nested_deep', type: 'text', hidden: 1 },
        ],
        'CASE WHEN i.indisunique': [
          { name: 'users_by_email', uniq: 1, origin: 'c' },
          { name: 'users_by_age', uniq: 0, origin: 'c' },
          { name: 'users_by_deep', uniq: 0, origin: 'c' },
          { name: 'users_pkey', uniq: 1, origin: 'pk' },
        ],
        "ci.relname = 'users_by_email'": [{ name: 'gx_email' }],
        "ci.relname = 'users_by_age'": [{ name: 'gx_age' }],
        "ci.relname = 'users_by_deep'": [{ name: 'gx_nested_deep' }],
        "ci.relname = 'users_pkey'": [{ name: 'key' }],
        'pg_get_expr': [
          { name: 'gx_email', expression: `CASE WHEN jsonb_typeof(${path('email')}) = `
            + `'string'::text THEN (doc #>> '{email}'::text[]) ELSE NULL::text END` },
          { name: 'gx_age', expression: `CASE WHEN jsonb_typeof(${path('age')}) = `
            + `'number'::text THEN (${path('age')})::numeric ELSE NULL::numeric END` },
          { name: 'gx_nested_deep',
            expression: `CASE WHEN jsonb_typeof(${path('nested,deep')}) = 'string'::text `
              + `THEN (doc #>> '{nested,deep}'::text[]) ELSE NULL::text END` },
        ],
        'pg_constraint': [],
      };
      const users = await Promise.resolve(
        introspectModel(pgConnection(usersRows), { keys: { users: '/id' } }));

      // the same key, the same index names, the same paths
      assert.strictEqual(users.model.collections.users.key,
        fromSqlite.collections.users.key);
      assert.deepStrictEqual(users.model.collections.users.indexes,
        fromSqlite.collections.users.indexes);
      // and the same members, with ONE declared difference: PostgreSQL
      // stores an integer member as `numeric`, which maps back to
      // `number` — the loss the mapping states
      assert.deepStrictEqual(Object.keys(users.model.collections.users.schema.properties).sort(),
        Object.keys(fromSqlite.collections.users.schema.properties).sort());
      assert.strictEqual(users.model.collections.users.schema.properties.age.type, 'number');
      assert.strictEqual(fromSqlite.collections.users.schema.properties.age.type, 'integer');
      void connection;
    });

    it('the neutral IR is the same shape whichever engine filled it', async () => {
      const store = await sqliteStore();
      const plans = [...normalizeModel(MODEL)].map(([name, collection]) =>
        planCollection(name, collection, sqliteDialect));
      await store.close();
      const connection = await Promise.resolve(
        handMade(plans.flatMap((plan) => plan.createSql)));
      try {
        const schema = await Promise.resolve(readSchema(connection));
        assert.deepStrictEqual(schema.views, []);
        assert.deepStrictEqual(schema.tables.map((table) => table.name).sort(),
          ['events', 'users']);
        const users = schema.tables.find((table) => table.name === 'users');
        for (const member of ['name', 'primaryKey', 'columns', 'generated',
          'indexes', 'foreignKeys']) {
          assert.ok(Object.hasOwn(users, member), member);
        }
        assert.deepStrictEqual(users.primaryKey, ['key']);
        assert.strictEqual(users.generated.length, 3);
        assert.deepStrictEqual(users.indexes.map((index) => index.name),
          ['users_by_age', 'users_by_deep', 'users_by_email'],
          'by name, so two engines list the same indexes in the same order');
      }
      finally {
        await connection.close();
      }
    });

    it('the engine\'s own tables are never a model\'s', async () => {
      const store = await openStore(MODEL, { driver: nodeDriver(), capture: { log: true } });
      try {
        const { model } = await Promise.resolve(store.introspect());
        assert.deepStrictEqual(Object.keys(model.collections).sort(), ['events', 'users']);
        assert.strictEqual(model.entities, undefined);
      }
      finally {
        await store.close();
      }
    });
  });
});
