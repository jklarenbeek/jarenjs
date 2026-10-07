//@ts-check
/**
 * @file One model, one body, both engines: a fresh store over an in-memory
 * SQLite database and over a schema of its own on the PostgreSQL server
 * `JAREN_PG_URL` names (two connections at most, the schema dropped
 * afterwards). Without the variable the PostgreSQL half is skipped.
 */
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

export const PG_URL = process.env.JAREN_PG_URL;

/** The engines a suite runs on, each with its skip reason. */
export const ENGINES = /** @type {const} */ (['sqlite', 'postgres']);

/** @param {string} engine @returns {string | false} */
export const skipFor = (engine) => engine === 'postgres' && !PG_URL && 'JAREN_PG_URL is not set';

let schemas = 0;

/**
 * A PostgreSQL pool and a fresh schema, handed to `fn` and dropped after.
 * @template T
 * @param {(pg: { pool: any, schema: string, driver: (options?: any) => any }) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withPostgres(fn) {
  const { default: pg } = await import('pg');
  const { postgresDriver } = await import('@jarenjs/db/postgres');
  const pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
  const schema = `jaren_store_core_${process.pid}_${++schemas}`;
  await pool.query(`CREATE SCHEMA "${schema}"`);
  try {
    return await fn({ pool, schema, driver: (options = {}) => postgresDriver(pool, { schema, ...options }) });
  }
  finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool.end();
  }
}

/**
 * Open `model` on `engine`, run `fn` over the store, and close it.
 * @template T
 * @param {string} engine
 * @param {any} model
 * @param {(store: any, pg: { pool: any, schema: string } | null) => Promise<T>} fn
 * @param {Record<string, any>} [options] - further `openStore` options
 * @returns {Promise<T>}
 */
export async function withStore(engine, model, fn, options = {}) {
  if (engine === 'sqlite') {
    const store = await openStore(model, { driver: nodeDriver(), ...options });
    try { return await fn(store, null); }
    finally { await store.close(); }
  }
  return withPostgres(async ({ pool, schema, driver }) => {
    const store = await openStore(model, { driver: driver(), ...options });
    try { return await fn(store, { pool, schema }); }
    finally { await store.close(); }
  });
}

/** A save report's row counts. @param {any} report */
export const counted = (report) => ({ inserted: report.inserted, updated: report.updated, deleted: report.deleted });
