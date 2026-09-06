/** Hand-authored declarations for @jarenjs/db/postgres (strategy 1). */
import type { Dialect, Driver } from '@jarenjs/db';

/** The byte length PostgreSQL truncates an identifier at; the dialect
 * refuses a longer one rather than letting two names silently become
 * one. */
export declare const IDENTIFIER_BYTES: number;
/** The minimum server this store accepts, as `server_version_num`
 * spells it. */
export declare const POSTGRES_FLOOR: number;

/**
 * The PostgreSQL 16+ dialect. Pure text: it imports no client, so this
 * subpath resolves and type-checks with nothing installed.
 */
export declare function postgresDialect(options?: {
  /** The one schema every catalog statement looks in. Unset, the
   * connection's own search path -- what a disposable per-run schema
   * needs. */
  searchPath?: string;
}): Dialect;

/** One acquired client, adapted to the raw binding contract. */
export declare function adaptPostgresClient(client: {
  query: Function;
  release?: Function;
}, options?: { onClose?: () => unknown }): unknown;

/** The probe: the server's version floor, and every capability this
 * engine does and does not have. */
export declare function postgresProbe(raw: unknown): unknown;

/**
 * The driver over an injected connection source. A `pg.Pool` satisfies
 * `{ connect() }` as it stands; a single client becomes one with
 * `{ connect: () => client }`. One client is acquired at open, held for
 * the store's life, and released exactly once at close.
 */
export declare function postgresDriver(source: {
  connect: Function;
}, options?: {
  /** The schema the store lives in: set on the connection AND given to
   * the dialect, so the DDL and the catalog reads agree. */
  schema?: string;
  queueTimeout?: number;
}): Driver;
