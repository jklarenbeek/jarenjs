//@ts-check
/**
 * @file Shared db test doubles: a bun:sqlite-shaped Database over
 * node:sqlite (so the Bun adapter's whole open path runs under Node),
 * an all-asynchronous injected wasm handle (so every driver method is
 * exercised returning promises), an injected handle whose capability
 * DECLARATION the caller picks (so a declaration-selected branch runs
 * under Node), a driver that records the statements it executes, and a
 * temp-file helper for the file-backed reopen scenarios.
 */

import { DatabaseSync } from 'node:sqlite';
import { chain, rtreeDdl } from '@jarenjs/db';
import { adaptNodeDatabase } from '@jarenjs/db/node';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** A bun:sqlite-shaped Database over node:sqlite. */
export class BunShapedDatabase {
  /** @param {string} dbPath */
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
  }
  /** @param {string} sql */
  run(sql) {
    this.db.exec(sql);
  }
  /** @param {string} sql */
  prepare(sql) {
    const statement = this.db.prepare(sql);
    return {
      /** @param {any[]} params */
      run: (...params) => statement.run(...params),
      // real bun:sqlite answers NULL for a missing row (node:sqlite
      // answers undefined) — the double mimics bun so the adapter's
      // normalization is pinned by the packed run
      /** @param {any[]} params */
      get: (...params) => statement.get(...params) ?? null,
      /** @param {any[]} params */
      all: (...params) => statement.all(...params),
    };
  }
  close() {
    this.db.close();
  }
}

/**
 * An injected wasm handle whose EVERY method returns a promise —
 * exactly the shape a main-thread OPFS build has — backed by
 * node:sqlite underneath.
 * @returns {any}
 */
export function asyncWasmHandle() {
  return {
    synchronous: false,
    open: async (dbPath) => {
      const db = new DatabaseSync(dbPath);
      return {
        exec: async (sql) => db.exec(sql),
        prepare: async (sql) => {
          const statement = db.prepare(sql);
          return {
            run: async (params = []) => statement.run(...params),
            get: async (params = []) => statement.get(...params),
            all: async (params = []) => statement.all(...params),
          };
        },
        close: async () => db.close(),
      };
    },
  };
}

/**
 * An injected wasm handle over `node:sqlite` whose CAPABILITY
 * DECLARATION the caller chooses. It exists to run the branch a
 * driver's declaration selects — most of all the physical mapping of
 * derived index columns — under Node, without needing the runtime that
 * declares it: `bun:sqlite` exposes no `function`, so its columns are
 * stored rather than generated, and the same code path is what runs
 * here. The binding still EXPOSES `registerFunction`, so the branch
 * under test is the declaration and nothing else.
 * @param {{ userFunctions?: boolean,
 *   deterministicIndexableFunctions?: boolean, sessions?: boolean,
 *   pragmas?: readonly string[],
 *   maintenance?: Record<string, boolean> }} declares - `pragmas` narrows
 *   the configurable-pragma declaration (the whole closed set when
 *   absent); `maintenance` narrows the maintenance operations (all four
 *   when absent)
 * @returns {any}
 */
export function declaringWasmHandle(declares) {
  return {
    synchronous: true,
    declares,
    /** @param {string} dbPath */
    open: (dbPath) => {
      const db = new DatabaseSync(dbPath);
      return {
        /** @param {string} sql */
        exec: (sql) => db.exec(sql),
        /** @param {string} sql */
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
        registerFunction: (name, options, fn) => db.function(name, options, fn),
      };
    },
  };
}

/**
 * A driver wrapper that records every statement EXECUTED through it —
 * the two-run check needs to prove a second open runs no DDL, and
 * counting is the only way to say so by exit code.
 *
 * A transaction hands its callback a SCOPE whose `exec` reaches the raw
 * binding directly, so wrapping the connection alone would miss every
 * statement inside a transaction — which is where the shape work runs.
 * The scope is wrapped too, at every nesting depth.
 * @param {any} driver
 * @returns {{ driver: any, executed: string[] }}
 */
export function recordingDriver(driver) {
  /** @type {string[]} */
  const executed = [];
  /** @param {any} target @returns {any} */
  const recording = (target) => Object.freeze({
    ...target,
    /** @param {string} sql */
    exec: (sql) => {
      executed.push(String(sql));
      return target.exec(sql);
    },
    /** @param {(scope: any) => any} fn @param {any[]} rest - the signal and the mode, forwarded */
    transaction: (fn, ...rest) => target.transaction((scope) => fn(recording(scope)), ...rest),
  });
  return {
    executed,
    driver: {
      name: driver.name,
      dialect: driver.dialect,
      /** @param {string} dbPath @param {any} options */
      open: (dbPath, options) => chain(driver.open(dbPath, options), recording),
    },
  };
}

/**
 * A fresh temp database path plus its cleanup.
 * @returns {{ dbPath: string, cleanup: () => void }}
 */
export function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-db-'));
  return {
    dbPath: path.join(dir, 'store.db'),
    // Windows keeps a deleted file's directory entry until the LAST
    // handle to it closes, so a bare `rmSync` races the kernel and throws
    // EPERM. `maxRetries` is node's own answer — it retries EPERM/EBUSY
    // with a backoff — and POSIX, which unlinks an open file immediately,
    // never reaches it.
    //
    // This hardens the RACE, and only the race: retries cannot cure a
    // handle that is genuinely still open. The one caller that used to
    // hold one — a worker claim loop `stop()` left running — is closed at
    // the source: `worker.stop()` now cancels or drains every claim,
    // renewal, checkpoint and settlement before it resolves, and
    // `jobs-concurrency.test.js` asserts every stop is
    // `{ drained: true, inFlight: 0 }` before its store closes. Do not
    // answer a future EPERM here by lengthening these retries.
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}

/**
 * The FULL test-double dialect for the query layer: every spelling
 * primitive foreign (brackets, `@pN` refs, alien JSON functions), so a
 * plan rendered through it and through SQLite differ correspondingly —
 * the D21 proof repeated at the query layer.
 * @param {any} createDialect - `createDialect` from @jarenjs/db
 * @returns {any}
 */
/** The foreign spelling's own R*Tree shape: a different module name and
 * a different column order, so a mapping that reached for SQLite's
 * would show up as the wrong SQL rather than as the same SQL. */
/** The foreign spelling's own identifier quoting: brackets, with the
 * closing one doubled — an identifier that could close its own quoting
 * is the hole every dialect has to be proved not to have. */
const quoteIdentifier = (name) => `[${String(name).replace(/]/g, ']]')}]`;

/** The foreign spelling's guard on its configuration vocabulary: a
 * closed word, never interpolated caller text. */
const pragmaWord = (word) => {
  if (!/^[a-z_0-9-]+$/i.test(String(word)))
    throw new TypeError(`not a configuration keyword: '${word}'`);
  return String(word);
};

const DOUBLE_RTREE = Object.freeze({
  module: 'BOXTREE',
  columns: Object.freeze(['rid', 'x0', 'x1', 'y0', 'y1']),
});

export function fullDoubleDialect(createDialect) {
  return createDialect({
    name: 'double',
    // the foreign spelling has everything SQLite has except a binary
    // JSON type and an in-place ALTER — declared in full, because a
    // dialect that answers half the set is what the conformance kit
    // exists to catch
    capabilities: {
      jsonb: false,
      generatedColumns: true,
      indexableGeneratedColumns: true,
      untypedColumns: true,
      returning: true,
      upsert: true,
      savepoints: true,
      savepointStartsTransaction: true,
      immediateTransactions: true,
      groupByAlias: true,
      alterTableFull: false,
      virtualTables: true,
      triggers: true,
      pragmas: true,
      declaredSqlText: true,
      foreignKeysAlwaysOn: false,
      rowIdentity: true,
    },
    tableSuffix: '',
    generatedStorage: 'LAZY',
    epochFromRfc3339: (v) => `EPOCHMS(${v})`,
    docColumnType: 'JSONDOC',
    packedVectorType: 'VECBYTES',
    quoteIdentifier,
    parameterRef: (i) => `@p${i}`,
    stringLiteral: (s) => `'${String(s).replace(/'/g, "''")}'`,
    booleanLiteral: (b) => (b ? 'TRUE' : 'FALSE'),
    typeFor: (schemaType, hint) => (hint === 'key' ? 'KEYTYPE' : 'VALTYPE'),
    limitClause: (limit, offset) => `FETCH ${limit ?? 'ALL'} SKIP ${offset ?? 0}`,
    jsonPathText: (segments) => segments
      .map((s) => ('name' in s ? `/${s.name}` : `/#${s.index}`)).join(''),
    jsonExtract: (column, pathText) => `JX(${column}, '${pathText}')`,
    // exhaustive over the kind, exactly as the real spec is: a spelling
    // spec that answers SOMETHING for a kind it does not know is how a
    // new derive kind ships as silently wrong SQL, and a double that did
    // not mirror the refusal would hide that shape from every test that
    // uses it
    derivedExpression: (member, column) => {
      switch (column.derive) {
        case 'geohash':
          return `CELL(${member}, ${column.precision})`;
        case 'bbox':
          return `BOX_${column.component.toUpperCase()}(${member})`;
        case 'vector':
          throw new TypeError(
            'double dialect: a derive: \'vector\' column is stored on every driver'
            + ' and has no generated expression');
        default:
          throw new TypeError(
            `double dialect: no generated-column expression for derive kind '${column.derive}'`);
      }
    },
    jsonSet: (expr, pathText, value) => `JS(${expr}, '${pathText}', ${value})`,
    jsonRemove: (expr, pathText) => `JR(${expr}, '${pathText}')`,
    jsonAppend: (expr, pathText, value) => `JA(${expr}, '${pathText}', ${value})`,
    jsonEncode: (param) => `JENC(${param})`,
    jsonText: (column) => `JTEXT(${column})`,
    jsonAgg: (expr) => `JAGG(${expr})`,
    jsonTypeOf: (column, pathText) => `JTYPE(${column}, '${pathText}')`,
    numericTypeNames: ['integer', 'real'],
    jsonObject: (pairs) => `JOBJ(${pairs})`,
    schemaTypeOf: (declaredType) => (declaredType === 'KEYTYPE' ? 'string' : undefined),
    expressionOf: () => null,
    memberPathOf: (expression) => {
      const match = /JX\([^,]*,\s*'([^']*)'\)/.exec(String(expression));
      return match === null
        ? null
        : match[1].split('/').filter((part) => part.length > 0)
          .map((part) => (part.startsWith('#')
            ? { index: Number(part.slice(1)) } : { name: part }));
    },
    readGenerated: (rows) => rows.map((row) => ({
      name: String(row.name), expression: String(row.expression ?? ''),
    })),
    jsonEmbed: (column) => `JEMBED(${column})`,
    valueTypeOf: (param) => `VTYPE(${param})`,
    strStartsWith: (value, lower, upper) => `SW(${value}, ${lower}, ${upper})`,
    strStartsWithExact: (value, a, b) => `SWX(${value}, ${a}, ${b})`,
    strEndsWith: (value, a, b, c) => `EW(${value}, ${a}, ${b}, ${c})`,
    strContains: (value, p) => `CT(${value}, ${p})`,
    orderNulls: (nullsFirst) => (nullsFirst ? ' EMPTIES HIGH' : ' EMPTIES LOW'),
    timeBucket: (at, origin, everyA, everyB, everyC) =>
      `LADDER(${at}, ${origin}, ${everyA}, ${everyB}, ${everyC})`,
    groupAggregate: (fn, value) => (value === null
      ? 'TALLY(*)' : `ROLLUP_${fn.toUpperCase()}(${value})`),
    rowIdentity: () => '[rid]',
    identityIn: (identity, params) => `${identity} AMONG (${params.join(', ')})`,
    rtree: DOUBLE_RTREE,
    rtreeDdl: rtreeDdl({
      quoteIdentifier,
      rowIdentity: () => '[rid]',
      rtree: DOUBLE_RTREE,
    }),
    explainQuery: (sql) => `PLANFOR ${sql}`,
    explainLines: (rows) => rows.map((row) => String(row.detail)),
    isFullScan: (line, tables) => tables.some((table) => line === `READALL ${table}`),
    usesIndex: (line, index) => line.includes(`VIA ${index}`),
    excludedRef: (column) => `NEW.${column}`,
    tx: {
      begin: 'BEGIN', beginImmediate: 'GRAB', commit: 'COMMIT', rollback: 'ROLLBACK', deferForeignKeys: 'DEFER CHECKS',
      savepoint: (n) => `MARK ${quoteIdentifier(n)}`,
      release: (n) => `UNMARK ${quoteIdentifier(n)}`,
      rollbackTo: (n) => `BACKTO ${quoteIdentifier(n)}`,
    },
    pragma: {
      set: (name, value) => `SET ${pragmaWord(name)} ${pragmaWord(String(value))}`,
      foreignKeys: (on) => `SET fk ${on ? 'on' : 'off'}`,
      foreignKeyCheck: () => 'CHECK fk',
      walCheckpoint: (mode) => `FLUSH ${mode}`,
      integrityCheck: (limit) => `CHECK integrity ${limit ?? 'all'}`,
      optimize: () => 'TUNE',
    },
    introspect: {
      version: () => 'GET version',
      compileOptions: () => 'GET options',
      pragma: (name) => `GET pragma ${pragmaWord(name)}`,
      tableExists: () => 'GET table @p1',
      columns: (t) => `GET columns ${t}`,
      indexes: (t) => `GET indexes ${t}`,
      indexColumns: (i) => `GET indexcolumns ${i}`,
      foreignKeysOn: () => 'GET fkon',
      foreignKeyList: (t) => `GET fklist ${t}`,
      declaredSql: (t) => `GET declared ${t}`,
      tables: () => 'GET tables',
      generated: (t) => `GET generated ${t}`,
      dataVersion: () => 'GET data-version',
      schemaDump: () => 'GET schema-dump',
    },
  });
}

/**
 * A driver that counts what a cursor does to a statement: every
 * `iterate()` opened, every `next()` pulled through it, every `return()`
 * that released it — and every `all()` that materialised. The counters
 * are the caller's, so a suite resets them after seeding.
 * @param {{ iterate: number, next: number, return: number, all: number }} counters
 * @returns {{ open: () => any }}
 */
export function statementCountingDriver(counters) {
  const db = new DatabaseSync(':memory:');
  return {
    /** @param {{ queueTimeout?: number }} [options] - the store's open options; `queueTimeout` is honoured */
    open: (options) => adaptNodeDatabase({
      exec: (sql) => db.exec(sql),
      prepare: (sql) => {
        const statement = db.prepare(sql);
        return {
          run: (...p) => statement.run(...p),
          get: (...p) => statement.get(...p),
          all: (...p) => {
            counters.all++;
            return statement.all(...p);
          },
          iterate: (...p) => {
            counters.iterate++;
            const iterator = statement.iterate(...p);
            return {
              next: () => {
                counters.next++;
                return iterator.next();
              },
              return: (value) => {
                counters.return++;
                return iterator.return(value);
              },
              [Symbol.iterator]() { return this; },
            };
          },
        };
      },
      function: (name, options, fn) => db.function(name, options, fn),
      aggregate: (name, spec) => db.aggregate(name, spec),
      createSession: (sessionOptions) => (sessionOptions === undefined ? db.createSession() : db.createSession(sessionOptions)),
      close: () => db.close(),
    }, { queueTimeout: options?.queueTimeout }),
  };
}
