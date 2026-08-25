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
import { chain } from '@jarenjs/db';
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
 *   deterministicIndexableFunctions?: boolean, sessions?: boolean }} declares
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
    /** @param {(scope: any) => any} fn */
    transaction: (fn) => target.transaction((scope) => fn(recording(scope))),
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
    // This hardens the RACE. It does not cure a handle that is genuinely
    // still open: `jobs-concurrency.test.js` still fails here on Windows
    // because `worker.stop()` keeps its claim loops running when they do
    // not drain inside the grace period, and those loops hold the
    // database — which is also why that file's process outlives its
    // assertions. That is a @jarenjs/db shutdown defect, not a cleanup
    // one, and it needs fixing there rather than papering over here.
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
export function fullDoubleDialect(createDialect) {
  return createDialect({
    name: 'double',
    capabilities: { jsonb: false },
    tableSuffix: '',
    epochFromRfc3339: (v) => `EPOCHMS(${v})`,
    docColumnType: 'JSONDOC',
    packedVectorType: 'VECBYTES',
    quoteIdentifier: (s) => `[${s}]`,
    parameterRef: (i) => `@p${i}`,
    stringLiteral: (s) => `'${String(s).replace(/'/g, "''")}'`,
    booleanLiteral: (b) => (b ? 'TRUE' : 'FALSE'),
    typeFor: (schemaType, hint) => (hint === 'key' ? 'KEYTYPE' : 'VALTYPE'),
    limitClause: (limit, offset) => `FETCH ${limit ?? 'ALL'} SKIP ${offset ?? 0}`,
    jsonPathText: (segments) => segments
      .map((s) => ('name' in s ? `/${s.name}` : `/#${s.index}`)).join(''),
    jsonExtract: (column, pathText) => `JX(${column}, '${pathText}')`,
    derivedExpression: (member, column) => (column.derive === 'geohash'
      ? `CELL(${member}, ${column.precision})`
      : `BOX_${column.component.toUpperCase()}(${member})`),
    jsonSet: (expr, pathText, value) => `JS(${expr}, '${pathText}', ${value})`,
    jsonRemove: (expr, pathText) => `JR(${expr}, '${pathText}')`,
    jsonAppend: (expr, pathText, value) => `JA(${expr}, '${pathText}', ${value})`,
    jsonEncode: (param) => `JENC(${param})`,
    jsonText: (column) => `JTEXT(${column})`,
    jsonAgg: (expr) => `JAGG(${expr})`,
    jsonTypeOf: (column, pathText) => `JTYPE(${column}, '${pathText}')`,
    valueTypeOf: (param) => `VTYPE(${param})`,
    strStartsWith: (value, lower, upper) => `SW(${value}, ${lower}, ${upper})`,
    strStartsWithExact: (value, a, b) => `SWX(${value}, ${a}, ${b})`,
    strEndsWith: (value, a, b, c) => `EW(${value}, ${a}, ${b}, ${c})`,
    strContains: (value, p) => `CT(${value}, ${p})`,
    orderNulls: (nullsFirst) => (nullsFirst ? ' EMPTIES HIGH' : ' EMPTIES LOW'),
    rowIdentity: () => '[rid]',
    identityIn: (identity, params) => `${identity} AMONG (${params.join(', ')})`,
    rtree: { module: 'BOXTREE', columns: ['rid', 'x0', 'x1', 'y0', 'y1'] },
    explainQuery: (sql) => `PLANFOR ${sql}`,
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
      foreignKeys: (on) => `SET fk ${on ? 'on' : 'off'}`,
      foreignKeyCheck: () => 'CHECK fk',
    },
    introspect: {
      version: () => 'GET version',
      compileOptions: () => 'GET options',
      tableExists: () => 'GET table @p1',
      columns: (t) => `GET columns ${t}`,
      indexes: (t) => `GET indexes ${t}`,
      indexColumns: (i) => `GET indexcolumns ${i}`,
      foreignKeysOn: () => 'GET fkon',
      foreignKeyList: (t) => `GET fklist ${t}`,
      dataVersion: () => 'GET data-version',
      schemaDump: () => 'GET schema-dump',
    },
  });
}
