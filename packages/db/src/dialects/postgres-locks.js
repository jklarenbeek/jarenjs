//@ts-check
/**
 * @file The advisory locks of a PostgreSQL store: one family of classes
 * (`0x4A524E__`), each lock's first key, and one second key for all of
 * them — the session's current schema, which is the store's own once the
 * driver has set its search path. Two stores in two schemas therefore
 * never contend, and one store's locks of different classes never
 * collide. POSTGRESQL.md lists every class; a test holds the two equal.
 */

/** Every class the store takes, by what it guards. */
export const POSTGRES_LOCK_CLASSES = Object.freeze({
  /** A native migration run (held for its transaction). */
  migration: 1246907982,
  /** The capture journal's high-water allocation (held for its transaction). */
  capture: 1246907983,
  /** `mode: 'immediate'` — the store's writer lock (held for its transaction). */
  writer: 1246907984,
  /** `owner` — the store's single owner (held for the store's session). */
  owner: 1246907985,
  /** The job queue's catalog initialization (held for its transaction). */
  jobs: 1246907990,
});

/** The second key every class shares. */
const SCHEMA_KEY = 'pg_catalog.hashtext(current_schema())';

/**
 * Take one class's lock for the rest of the transaction, waiting for it
 * under the session's `lock_timeout` (55P03 past it).
 * @param {number} lockClass
 * @returns {string}
 */
export const transactionLock = (lockClass) =>
  `SELECT pg_catalog.pg_advisory_xact_lock(${lockClass}, ${SCHEMA_KEY})`;

/** The owner lock: taken without waiting (`held` false when another
 * session holds it), and released explicitly — a session lock outlives
 * every transaction, and a pooled session outlives the store. */
export const OWNER_LOCK = Object.freeze({
  acquire: `SELECT pg_catalog.pg_try_advisory_lock(${POSTGRES_LOCK_CLASSES.owner}, ${SCHEMA_KEY}) AS held, `
    + 'current_schema() AS schema',
  release: `SELECT pg_catalog.pg_advisory_unlock(${POSTGRES_LOCK_CLASSES.owner}, ${SCHEMA_KEY}) AS released`,
});
