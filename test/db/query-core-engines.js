//@ts-check
/**
 * @file One store model on both engines: SQLite in memory, and PostgreSQL
 * in a schema of its own when `JAREN_PG_URL` names an endpoint (a pool of
 * two connections, the schema dropped afterwards).
 */
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const url = process.env.JAREN_PG_URL;
let schemas = 0;

/**
 * Run `fn` over a fresh store of `model` on each available engine.
 * @param {any} model
 * @param {(store: any, host: 'sqlite' | 'postgres') => Promise<void>} fn
 * @param {{ sessions?: number }} [options] - the sessions the PostgreSQL
 *   store holds (`openStore`'s own option, over a pool of three); SQLite
 *   runs on its one connection either way
 */
export async function onBothEngines(model, fn, options = {}) {
  const sqlite = await openStore(model, { driver: nodeDriver() });
  try {
    await fn(sqlite, 'sqlite');
  }
  finally {
    await sqlite.close();
  }
  if (!url) return;
  const { default: pg } = await import('pg');
  const { postgresDriver } = await import('@jarenjs/db/postgres');
  const sessions = options.sessions ?? 1;
  const pool = new pg.Pool({ connectionString: url, max: sessions > 1 ? 3 : 2 });
  const schema = `query_core_${process.pid}_${++schemas}`;
  await pool.query(`CREATE SCHEMA "${schema}"`);
  let store;
  try {
    store = await openStore(model, sessions > 1
      ? { driver: postgresDriver(pool, { schema, maxConnections: 3 }), sessions }
      : { driver: postgresDriver(pool, { schema }) });
    await fn(store, 'postgres');
  }
  finally {
    try {
      await store?.close();
    }
    finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  }
}

/**
 * Run `fn` over a store of physical entities whose tables `ddlFor` creates
 * first: SQLite in memory, and PostgreSQL in a schema of its own when
 * `JAREN_PG_URL` names an endpoint (the schema dropped afterwards).
 * @param {(schema: string | null) => any} modelFor - the model, given the
 *   PostgreSQL schema its physical tables live in (`null` on SQLite)
 * @param {(prefix: string) => string} ddlFor - the tables' `CREATE TABLE`
 *   statements, each name after the given qualifier
 * @param {(store: any, host: 'sqlite' | 'postgres') => Promise<void>} fn
 */
export async function onBothEnginesPhysical(modelFor, ddlFor, fn) {
  const db = await nodeDriver().open(':memory:');
  db.exec(ddlFor(''));
  const sqlite = await openStore(modelFor(null), { driver: { ...nodeDriver(), open: async () => db }, adopt: true });
  try {
    await fn(sqlite, 'sqlite');
  }
  finally {
    await sqlite.close();
  }
  if (!url) return;
  const { default: pg } = await import('pg');
  const { postgresDriver } = await import('@jarenjs/db/postgres');
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const schema = `query_core_${process.pid}_${++schemas}`;
  await pool.query(`CREATE SCHEMA "${schema}"`);
  let store;
  try {
    await pool.query(ddlFor(`"${schema}".`));
    store = await openStore(modelFor(schema), { driver: postgresDriver(pool, { schema }), adopt: true });
    await fn(store, 'postgres');
  }
  finally {
    try {
      await store?.close();
    }
    finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  }
}
