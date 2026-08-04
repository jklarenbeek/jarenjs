//@ts-check
/**
 * @file Shared db test doubles: a bun:sqlite-shaped Database over
 * node:sqlite (so the Bun adapter's whole open path runs under Node),
 * an all-asynchronous injected wasm handle (so every driver method is
 * exercised returning promises), and a temp-file helper for the
 * file-backed reopen scenarios.
 */

import { DatabaseSync } from 'node:sqlite';
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
      /** @param {any[]} params */
      get: (...params) => statement.get(...params),
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
 * A fresh temp database path plus its cleanup.
 * @returns {{ dbPath: string, cleanup: () => void }}
 */
export function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-db-'));
  return {
    dbPath: path.join(dir, 'store.db'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
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
    docColumnType: 'JSONDOC',
    quoteIdentifier: (s) => `[${s}]`,
    parameterRef: (i) => `@p${i}`,
    stringLiteral: (s) => `'${String(s).replace(/'/g, "''")}'`,
    booleanLiteral: (b) => (b ? 'TRUE' : 'FALSE'),
    typeFor: (schemaType, hint) => (hint === 'key' ? 'KEYTYPE' : 'VALTYPE'),
    limitClause: (limit, offset) => `FETCH ${limit ?? 'ALL'} SKIP ${offset ?? 0}`,
    jsonPathText: (segments) => segments
      .map((s) => ('name' in s ? `/${s.name}` : `/#${s.index}`)).join(''),
    jsonExtract: (column, pathText) => `JX(${column}, '${pathText}')`,
    jsonSet: (expr, pathText, value) => `JS(${expr}, '${pathText}', ${value})`,
    jsonRemove: (expr, pathText) => `JR(${expr}, '${pathText}')`,
    jsonAppend: (expr, pathText, value) => `JA(${expr}, '${pathText}', ${value})`,
    jsonEncode: (param) => `JENC(${param})`,
    jsonText: (column) => `JTEXT(${column})`,
    jsonAgg: (expr) => `JAGG(${expr})`,
    jsonTypeOf: (column, pathText) => `JTYPE(${column}, '${pathText}')`,
    valueTypeOf: (param) => `VTYPE(${param})`,
    strStartsWith: (value, a, b) => `SW(${value}, ${a}, ${b})`,
    strEndsWith: (value, a, b, c) => `EW(${value}, ${a}, ${b}, ${c})`,
    strContains: (value, p) => `CT(${value}, ${p})`,
    orderNulls: (nullsFirst) => (nullsFirst ? ' EMPTIES HIGH' : ' EMPTIES LOW'),
    rowIdentity: () => '[rid]',
    explainQuery: (sql) => `PLANFOR ${sql}`,
    excludedRef: (column) => `NEW.${column}`,
    tx: {
      begin: 'BEGIN', commit: 'COMMIT', rollback: 'ROLLBACK',
      savepoint: (n) => `MARK ${n}`,
      release: (n) => `UNMARK ${n}`,
      rollbackTo: (n) => `BACKTO ${n}`,
    },
    pragma: {
      busyTimeout: (ms) => `SET busy ${ms}`,
      journalMode: (mode) => `SET journal ${mode}`,
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
}
