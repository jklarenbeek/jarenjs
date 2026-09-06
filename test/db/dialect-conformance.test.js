//@ts-check
/**
 * @file The conformance kit, run over every dialect this suite ships,
 * plus the capability-OFF half: a variant of the SQLite dialect with a
 * capability switched off, opened against a real engine, so the common
 * fallback or refusal each absent feature routes to is exercised
 * rather than skipped.
 *
 * The variants are legitimate dialects, not mocks: a dialect is a
 * frozen record of spellings and a capability table, and turning one
 * capability off is exactly the situation a second engine puts the
 * store in. Running them against `node:sqlite` means the store really
 * opens, really creates, really verifies and really writes — the parts
 * of the code a capability gate protects are the parts under test.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

import {
  openStore, sqliteDialect, createDialect, openConnection, baseCapabilities, PRAGMA_NAMES,
} from '@jarenjs/db';

import { fullDoubleDialect } from './helpers.js';
import { runDialectConformance } from './dialect-conformance.js';

const MODEL = {
  $model: '0.1',
  collections: {
    rows: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' }, n: { type: 'integer' }, s: { type: 'string' } },
      },
      key: '/id',
      indexes: [{ name: 'by_n', path: '$.n' }],
    },
  },
};

/**
 * The same dialect with capabilities overridden and the spellings an
 * absent capability owns removed with them — which is what makes the
 * variant a real dialect rather than a lie: a dialect that says it has
 * no configuration vocabulary must not still carry one.
 * @param {Record<string, boolean>} overrides
 * @returns {any}
 */
function variantDialect(overrides) {
  const capabilities = { ...sqliteDialect.capabilities, ...overrides };
  const spelling = { ...sqliteDialect, capabilities: Object.freeze(capabilities) };
  if (capabilities.pragmas !== true) {
    spelling.pragma = Object.freeze({ ...spelling.pragma, set: undefined });
    spelling.introspect = Object.freeze({ ...spelling.introspect, pragma: undefined });
  }
  if (capabilities.foreignKeysAlwaysOn === true) {
    spelling.pragma = Object.freeze({ ...spelling.pragma, foreignKeys: undefined });
    spelling.introspect = Object.freeze({ ...spelling.introspect, foreignKeysOn: undefined });
  }
  if (capabilities.declaredSqlText !== true) {
    spelling.introspect = Object.freeze({
      ...spelling.introspect, declaredSql: undefined, schemaDump: undefined,
    });
  }
  return Object.freeze(spelling);
}

/**
 * A driver over a fresh in-memory database that speaks the given
 * dialect and declares exactly the given capabilities.
 * @param {any} dialect
 * @param {{ pragmas?: readonly string[] }} [declared]
 * @returns {any}
 */
function variantDriver(dialect, declared = {}) {
  const db = new DatabaseSync(':memory:');
  /** @type {string[]} */
  const statements = [];
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
    registerFunction: (name, options, fn) => db.function(name, options, fn),
  };
  return {
    statements,
    driver: Object.freeze({
      name: `variant-${dialect.name}`,
      dialect,
      open: () => openConnection(raw, {
        dialect,
        synchronous: true,
        declared: {
          userFunctions: true,
          deterministicIndexableFunctions: true,
          pragmas: declared.pragmas ?? PRAGMA_NAMES,
        },
      }),
    }),
  };
}

runDialectConformance(sqliteDialect, { describe, it, assert });
runDialectConformance(fullDoubleDialect(createDialect), { describe, it, assert });

describe('capability-off dialects reach the common fallback, not a skip', () => {
  it('no configuration vocabulary: nothing is applied, the record is all null, '
    + 'and an explicit request is refused by name', async () => {
    const dialect = variantDialect({ pragmas: false });
    const { driver, statements } = variantDriver(dialect, { pragmas: [] });
    const store = await openStore(MODEL, { driver });
    try {
      assert.deepStrictEqual(Object.values(store.capabilities.pragmas)
        .filter((value) => value !== null), [],
      'a connection with no vocabulary reports every pragma as unread');
      // the foreign-key switch is a different capability and still runs;
      // what must not appear is a CONFIGURATION statement or its read-back
      const configuration = statements.filter((sql) =>
        /^PRAGMA /.test(sql) && !/foreign_keys/.test(sql));
      assert.deepStrictEqual(configuration, [],
        'no configuration statement may be issued where there is no vocabulary');
      // the store still works: the absent capability cost configuration,
      // not correctness
      await store.collection('rows').insert({ id: 'a', n: 1 });
      assert.deepStrictEqual(await store.collection('rows').get('a'), { id: 'a', n: 1 });
    }
    finally {
      await store.close();
    }
    const second = variantDriver(variantDialect({ pragmas: false }), { pragmas: [] });
    await assert.rejects(
      () => openStore(MODEL, { driver: second.driver, busyTimeout: 1234 }),
      (error) => {
        assert.strictEqual(error.code, 'JD0007');
        assert.match(error.message, /cannot apply pragma 'busyTimeout'/);
        return true;
      });
  });

  it('referential integrity always on: the switch is neither set nor read', async () => {
    const dialect = variantDialect({ foreignKeysAlwaysOn: true });
    const { driver, statements } = variantDriver(dialect);
    const store = await openStore(MODEL, { driver });
    try {
      assert.ok(!statements.some((sql) => /foreign_keys/.test(sql)),
        'an engine that always enforces has no switch to set or verify');
      await store.collection('rows').insert({ id: 'a', n: 1 });
    }
    finally {
      await store.close();
    }
  });

  it('no declared CREATE text: the structural drift check still refuses a changed table', async () => {
    const dialect = variantDialect({ declaredSqlText: false });
    const first = variantDriver(dialect);
    const store = await openStore(MODEL, { driver: first.driver });
    await store.collection('rows').insert({ id: 'a', n: 1 });
    assert.ok(!first.statements.some((sql) => /\bsql\b.*FROM sqlite_schema/.test(sql)),
      'a dialect with no declared text must not read a CREATE statement back');
    await store.close();

    // the same database, reopened against a model whose column set
    // differs: the structural half of the check is what catches it
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE "rows" ("key" TEXT PRIMARY KEY, "doc" BLOB NOT NULL) STRICT');
    const raw = {
      exec: (sql) => db.exec(sql),
      prepare: (sql) => {
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
    const driver = Object.freeze({
      name: 'variant', dialect,
      open: () => openConnection(raw, { dialect, synchronous: true,
        declared: { pragmas: PRAGMA_NAMES } }),
    });
    await assert.rejects(() => openStore(MODEL, { driver }), (error) => {
      assert.strictEqual(error.code, 'JD0002');
      assert.match(error.message, /missing: 'gx_n'/);
      return true;
    });
  });

  it('no change capture and no job queue: both refuse by name at open', async () => {
    // a probe that answers what an engine with neither subsystem would.
    // A failed open CLOSES the connection it acquired, so each attempt
    // gets its own handle — otherwise the second failure would be the
    // closed store's, not the refusal under test.
    const noSubsystems = () => {
      const db = new DatabaseSync(':memory:');
      const raw = {
        exec: (sql) => db.exec(sql),
        prepare: (sql) => {
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
      const probe = (_raw, _dialect, declared) => Object.freeze({
        ...baseCapabilities(),
        version: '3.45.0',
        jsonb: true,
        generatedColumns: true,
        returning: true,
        upsert: true,
        savepoints: true,
        lazyIteration: true,
        configurablePragmas: Object.freeze([...(declared.pragmas ?? [])]),
        jobs: false,
        changeCapture: false,
      });
      return Object.freeze({
        name: 'no-subsystems',
        dialect: sqliteDialect,
        open: () => openConnection(raw, {
          dialect: sqliteDialect, synchronous: true, probe,
          declared: { pragmas: PRAGMA_NAMES },
        }),
      });
    };

    await assert.rejects(
      () => openStore(MODEL, { driver: noSubsystems(), capture: true }),
      (error) => {
        assert.strictEqual(error.code, 'JD0051');
        assert.match(error.message, /change capture is unavailable on this driver/);
        return true;
      });
    await assert.rejects(
      () => openStore(MODEL, { driver: noSubsystems(), jobs: true }),
      (error) => {
        assert.strictEqual(error.code, 'JD0003');
        assert.match(error.message, /durable job queue is unavailable/);
        return true;
      });
    // and the store itself still opens, reads and writes without them
    const store = await openStore(MODEL, { driver: noSubsystems() });
    try {
      await store.collection('rows').insert({ id: 'a', n: 1 });
      assert.deepStrictEqual(await store.collection('rows').get('a'), { id: 'a', n: 1 });
    }
    finally {
      await store.close();
    }
  });
});
