//@ts-check
/**
 * @file The advisory locks of a PostgreSQL store: one family of classes
 * (`0x4A524E__`), each lock's first key, and a second key naming the
 * session's current schema — the store's own once the driver has set its
 * search path. One store's locks of different classes never collide. The
 * writer and owner locks key the schema by its OID, which no two schemas
 * share, so two stores in two schemas never contend for them. The
 * migration, capture and jobs locks key it by `hashtext`, a 32-bit hash
 * two schema names can share: a store of an earlier release takes those
 * locks by that key, and two releases migrating one schema must meet on
 * one lock — so two colliding schemas wait for each other there, and
 * nothing worse. POSTGRESQL.md lists every class; a test holds the two
 * equal.
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

/** The schema by the hash of its name: the key of the classes a store of
 * an earlier release takes too. */
const SCHEMA_HASH_KEY = 'pg_catalog.hashtext(current_schema())';
/** The schema by its OID, shifted into `int4`, the type a two-key lock
 * takes: looked up by exact name, because a cast through `regnamespace`
 * parses the name as an identifier and folds its case. NULL — no lock
 * taken — for a session with no current schema, as the hash is. */
const SCHEMA_OID_KEY = '((SELECT n.oid FROM pg_catalog.pg_namespace n '
  + 'WHERE n.nspname = pg_catalog.current_schema())::int8 - 2147483648)::int4';
/** Each class's second key. @param {number} lockClass */
const schemaKeyOf = (lockClass) => (lockClass === POSTGRES_LOCK_CLASSES.writer
  || lockClass === POSTGRES_LOCK_CLASSES.owner ? SCHEMA_OID_KEY : SCHEMA_HASH_KEY);

/**
 * Take one class's lock for the rest of the transaction, waiting for it
 * under the session's `lock_timeout` (55P03 past it).
 * @param {number} lockClass
 * @returns {string}
 */
export const transactionLock = (lockClass) =>
  `SELECT pg_catalog.pg_advisory_xact_lock(${lockClass}, ${schemaKeyOf(lockClass)})`;

/** The owner lock: taken without waiting (`held` false when another
 * session holds it), and released explicitly — a session lock outlives
 * every transaction, and a pooled session outlives the store. */
export const OWNER_LOCK = Object.freeze({
  acquire: `SELECT pg_catalog.pg_try_advisory_lock(${POSTGRES_LOCK_CLASSES.owner}, ${SCHEMA_OID_KEY}) AS held, `
    + 'current_schema() AS schema',
  release: `SELECT pg_catalog.pg_advisory_unlock(${POSTGRES_LOCK_CLASSES.owner}, ${SCHEMA_OID_KEY}) AS released`,
});
