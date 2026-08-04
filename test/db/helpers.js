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
