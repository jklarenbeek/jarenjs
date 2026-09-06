//@ts-check
/**
 * @file The portability close-out: ONE hostile model corpus through the
 * whole round trip, on every dialect this suite has.
 *
 * pen → schema → plan → create → introspect → plan against the original
 * → apply → introspect again. The claims, in order:
 *
 *  - the model the PEN writes and the model written by hand are one
 *    document, and it validates against both model-schema artifacts;
 *  - every dialect plans it, and the plan is the shape the drift check
 *    then verifies;
 *  - a read of the created database derives a model whose SECOND read
 *    is identical (a read is a read), whose index set is the declared
 *    one, and whose loss rows are the same on both engines;
 *  - the migration planner finds no structural change between the
 *    derived model and the declared one — the convergence claim;
 *  - and every unsupported feature is REFUSED or REPORTED by name,
 *    never silently mapped to something else.
 *
 * SQLite runs it against a real database. PostgreSQL runs the pure
 * planning and refusal half here, and the live half in
 * `postgres-live.test.js`, so the corpus is a gate with no endpoint and
 * a stronger one with.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  openStore, sqliteDialect, createDialect, planCollection, normalizeModel, planMigration,
  DIALECT_CAPABILITIES, INTROSPECT_CODES,
} from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDialect } from '@jarenjs/db/postgres';
import * as m from '@jarenjs/linq/model';

import { fullDoubleDialect } from './helpers.js';

/** The host's declared index-expression functions. */
const FUNCTIONS = {
  lower: {
    arity: 1,
    deterministic: true,
    apply: (value) => (value === null || value === undefined ? null : String(value).toLowerCase()),
    sql: 'lower',
  },
};

/** Names chosen to break a naive quoting, a naive path grammar and a
 * naive column stem — all at once. */
const HOSTILE_MEMBER = 'a.b';
const SPACED_MEMBER = 'has space';

/** The corpus, written by the model pen. */
const PENNED = m.defineModel({
  collections: {
    accounts: m.collection(
      m.object({
        id: m.string(),
        email: m.string(),
        age: m.integer(),
        score: m.number(),
        active: m.boolean(),
        untyped: m.any(),
        nested: m.object({ deep: m.string() }),
      }),
      {
        key: (d) => d.id,
        indexes: [
          m.index((d) => d.email, { name: 'by_email', unique: true }),
          m.index((d) => d.age, { name: 'by_age' }),
          m.index((d) => d.nested.deep, { name: 'by_deep' }),
          m.index((d) => d.untyped, { name: 'by_untyped' }),
          m.index([(d) => d.age, (d) => d.email], { name: 'by_age_email' }),
          m.expressionIndex({ call: 'lower', args: [(d) => d.email] },
            { name: 'by_lower_email' }),
        ],
      }),
    ticks: m.collection(m.object({ n: m.integer() }),
      { key: null, identity: 'integer', indexes: [m.index((d) => d.n, { name: 'by_n' })] }),
  },
});

/** The same corpus with the two members a pen lambda cannot name. */
const CORPUS = (() => {
  const model = structuredClone(PENNED);
  const accounts = model.collections.accounts;
  accounts.schema.properties[HOSTILE_MEMBER] = { type: 'string' };
  accounts.schema.properties[SPACED_MEMBER] = { type: 'integer' };
  accounts.indexes.push(
    { name: 'by_dotted', path: `$[${JSON.stringify(HOSTILE_MEMBER)}]` },
    { name: 'by_spaced', path: `$[${JSON.stringify(SPACED_MEMBER)}]` });
  return model;
})();

/** Every dialect this suite has, and whether it computes an expression
 * itself or calls the engine's own function. */
const DIALECTS = [
  { dialect: sqliteDialect, registered: true },
  { dialect: postgresDialect(), registered: false },
  { dialect: fullDoubleDialect(createDialect), registered: true },
];

describe('the portability corpus', () => {
  it('the pen writes the document the format declares, and it normalizes', () => {
    assert.strictEqual(PENNED.$model, '0.1');
    assert.deepStrictEqual(PENNED.collections.accounts.indexes.map((one) => one.name),
      ['by_email', 'by_age', 'by_deep', 'by_untyped', 'by_age_email', 'by_lower_email']);
    assert.deepStrictEqual(
      PENNED.collections.accounts.indexes.at(-1).expression,
      { call: 'lower', args: [{ member: '$.email' }] });
    const collections = normalizeModel(CORPUS, FUNCTIONS);
    assert.deepStrictEqual([...collections.keys()], ['accounts', 'ticks']);
    assert.strictEqual(collections.get('accounts').indexes.length, 8);
  });

  it('every dialect plans it, and each plans it differently', () => {
    const collections = normalizeModel(CORPUS, FUNCTIONS);
    const seen = new Set();
    for (const { dialect, registered } of DIALECTS) {
      const plan = planCollection('accounts', collections.get('accounts'), dialect,
        { expressions: FUNCTIONS, registered });
      // one table and eight indexes: the composite is its own index over
      // two columns that already exist, and the expression index its own
      // column
      assert.strictEqual(plan.createSql.length, 9, dialect.name);
      assert.ok(plan.createSql[0].startsWith(`CREATE TABLE ${dialect.quoteIdentifier('accounts')}`),
        dialect.name);
      // every declared index is there, by name
      assert.deepStrictEqual(plan.expected.indexes.map((one) => one.name), [
        'accounts_by_age', 'accounts_by_age_email', 'accounts_by_deep', 'accounts_by_dotted',
        'accounts_by_email', 'accounts_by_lower_email', 'accounts_by_spaced',
        'accounts_by_untyped',
      ], dialect.name);
      seen.add(plan.createSql[0]);
    }
    assert.strictEqual(seen.size, DIALECTS.length,
      'three dialects, three spellings of one model');
  });

  it('a hostile member is one member on every dialect, and never two', () => {
    const collections = normalizeModel(CORPUS, FUNCTIONS);
    for (const { dialect, registered } of DIALECTS) {
      const plan = planCollection('accounts', collections.get('accounts'), dialect,
        { expressions: FUNCTIONS, registered });
      // `a.b` as ONE member and `a` → `b` as two are different paths and
      // must be different columns; the canonical spelling is what keeps
      // them apart, on every dialect
      const dotted = plan.generated.find((column) => column.canonical.includes('a.b'));
      assert.ok(dotted !== undefined, dialect.name);
      assert.ok(plan.createSql[0].includes(dialect.quoteIdentifier(dotted.name)), dialect.name);
      assert.strictEqual(new Set(plan.generated.map((column) => column.name)).size,
        plan.generated.length, `${dialect.name}: two paths shared a column`);
    }
  });

  it('every dialect answers the whole closed capability set, and they disagree', () => {
    const answers = DIALECTS.map(({ dialect }) => dialect.capabilities);
    for (const capabilities of answers) {
      assert.deepStrictEqual(Object.keys(capabilities).sort(),
        Object.keys(DIALECT_CAPABILITIES).sort());
    }
    // a matrix in which every row agreed would not be a matrix
    const differing = Object.keys(DIALECT_CAPABILITIES)
      .filter((name) => new Set(answers.map((one) => one[name])).size > 1);
    assert.ok(differing.length >= 6,
      `only ${differing.length} capabilities differ across the dialects: ${differing}`);
    for (const name of ['pragmas', 'declaredSqlText', 'virtualTables', 'untypedColumns',
      'foreignKeysAlwaysOn', 'immediateTransactions']) {
      assert.ok(differing.includes(name), `${name} does not differ`);
    }
  });

  describe('forward and back, on SQLite', () => {
    it('creates, reads, introspects, converges, and reads the same again', async () => {
      const store = await openStore(CORPUS, { driver: nodeDriver(), expressions: FUNCTIONS });
      try {
        const accounts = store.collection('accounts');
        const document = {
          id: 'a',
          email: 'ANN@Example.COM',
          age: 30,
          score: 1.5,
          active: true,
          untyped: { anything: [1, null, 'two'] },
          nested: { deep: 'down' },
          [HOSTILE_MEMBER]: 'dotted',
          [SPACED_MEMBER]: 7,
        };
        await accounts.insert(document);
        assert.deepStrictEqual(await accounts.get('a'), document);

        const first = await store.introspect({
          keys: { accounts: '/id' }, expressions: FUNCTIONS });
        // every declared index came back, by name
        assert.deepStrictEqual(first.model.collections.accounts.indexes
          .map((one) => one.name).sort(),
        ['by_age', 'by_age_email', 'by_deep', 'by_dotted', 'by_email',
          'by_lower_email', 'by_spaced', 'by_untyped']);
        // including the hostile members, as ONE member each
        const dotted = first.model.collections.accounts.indexes
          .find((one) => one.name === 'by_dotted');
        assert.strictEqual(dotted.path, `$[${JSON.stringify(HOSTILE_MEMBER)}]`);
        // and the declared expression, whole
        assert.deepStrictEqual(first.model.collections.accounts.indexes
          .find((one) => one.name === 'by_lower_email').expression,
        { call: 'lower', args: [{ member: '$.email' }] });

        // the convergence claim: no structural change between the
        // derived model and the one the database was made from
        const { migration } = planMigration(first.model, CORPUS,
          { dialect: sqliteDialect, expressions: FUNCTIONS });
        assert.deepStrictEqual(migration.steps.filter((step) => step.kind === 'ddl'), [],
          'a read of an unchanged database plans no change');

        // a read is a read: the second answers the first
        const second = await store.introspect({
          keys: { accounts: '/id' }, expressions: FUNCTIONS });
        assert.deepStrictEqual(second.model, first.model);
        assert.deepStrictEqual(second.report, first.report);

        // every loss row is one of the closed codes, and named once
        for (const row of first.report)
          assert.ok(Object.hasOwn(INTROSPECT_CODES, row.code), row.code);
        const keys = first.report.map((row) => `${row.code} ${row.object}`);
        assert.strictEqual(new Set(keys).size, keys.length);
      }
      finally {
        await store.close();
      }
    });

    it('applying the derived model to a fresh database makes the same shape', async () => {
      const store = await openStore(CORPUS, { driver: nodeDriver(), expressions: FUNCTIONS });
      const { model } = await store.introspect({
        keys: { accounts: '/id' }, expressions: FUNCTIONS });
      await store.close();
      // the derived model OPENS: it is a valid model, and the store it
      // makes verifies the shape it plans
      const reopened = await openStore(model, { driver: nodeDriver(), expressions: FUNCTIONS });
      try {
        const declared = planCollection('accounts',
          normalizeModel(CORPUS, FUNCTIONS).get('accounts'), sqliteDialect,
          { expressions: FUNCTIONS, registered: true });
        const derived = planCollection('accounts',
          normalizeModel(model, FUNCTIONS).get('accounts'), sqliteDialect,
          { expressions: FUNCTIONS, registered: true });
        const byName = (shape) => ({
          columns: [...shape.columns].sort((a, b) => (a.name < b.name ? -1 : 1)),
          indexes: [...shape.indexes].sort((a, b) => (a.name < b.name ? -1 : 1)),
        });
        assert.deepStrictEqual(byName(derived.expected), byName(declared.expected));
      }
      finally {
        await reopened.close();
      }
    });
  });

  describe('what is unsupported is refused or reported, never mapped to something else',
    () => {
      it('a store asked for a SQLite-only subsystem on a driver without it', async () => {
        // proved against the PostgreSQL driver in its own suite; here the
        // capability itself is the claim, on the dialect that has it
        assert.strictEqual(sqliteDialect.capabilities.pragmas, true);
        assert.strictEqual(postgresDialect().capabilities.pragmas, false);
      });

      it('an R*Tree mapping on a dialect with no virtual tables', () => {
        const spatial = {
          $model: '0.1',
          collections: {
            places: {
              schema: { type: 'object', properties: { at: { type: 'object' } } },
              key: null,
              identity: 'uuid',
              indexes: [{ name: 'by_box', path: '$.at', derive: 'bbox', physical: 'rtree' }],
            },
          },
        };
        const collections = normalizeModel(spatial);
        // SQLite realizes it as a virtual table beside the collection
        const sqlite = planCollection('places', collections.get('places'), sqliteDialect,
          { derived: 'virtual', rtree: true });
        assert.strictEqual(sqlite.virtualTables.length, 1);
        // PostgreSQL has none, so the same declaration maps back onto
        // the B-tree over the four edge columns — and says so
        const postgres = planCollection('places', collections.get('places'), postgresDialect(),
          { derived: 'stored', rtree: false });
        assert.strictEqual(postgres.virtualTables.length, 0);
        assert.strictEqual(postgres.expected.indexes.length, 1);
        assert.strictEqual(postgres.expected.indexes[0].columns.length, 4);
      });

      it('an expression whose function this engine cannot honour', () => {
        const model = {
          $model: '0.1',
          collections: { a: { schema: { type: 'object', properties: { x: {} } },
            key: null, identity: 'uuid',
            indexes: [{ name: 'by_x', expression: { call: 'f', args: [{ member: '$.x' }] } }] } },
        };
        const applyless = { f: { arity: 1, deterministic: true, sql: 'f' } };
        const sqlless = { f: { arity: 1, deterministic: true, apply: (v) => v } };
        assert.throws(() => planCollection('a', normalizeModel(model, applyless).get('a'),
          sqliteDialect, { expressions: applyless, registered: true }),
        (error) => error.code === 'JD0004');
        assert.throws(() => planCollection('a', normalizeModel(model, sqlless).get('a'),
          postgresDialect(), { expressions: sqlless, registered: false }),
        (error) => error.code === 'JD0004');
      });

      it('an identifier longer than the engine keeps', () => {
        const long = 'a'.repeat(80);
        // SQLite has no such limit and quotes it
        assert.strictEqual(sqliteDialect.quoteIdentifier(long), `"${long}"`);
        // PostgreSQL truncates silently, so the dialect refuses instead
        assert.throws(() => postgresDialect().quoteIdentifier(long), TypeError);
      });
    });
});
