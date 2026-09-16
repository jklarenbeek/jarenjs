/** Hand-authored declarations for @jarenjs/db/postgres (strategy 1). */
import type { Dialect, Driver } from '@jarenjs/db';

/** The byte length PostgreSQL truncates an identifier at; the dialect
 * refuses a longer one rather than letting two names silently become
 * one. */
export declare const IDENTIFIER_BYTES: number;
/** The minimum server this store accepts, as `server_version_num`
 * spells it. */
export declare const POSTGRES_FLOOR: number;

/** Finite per-driver, per-session and per-fetch resource budgets. */
export interface PostgresLimits {
  windowRows: number;
  /** Maximum retained normalized frame bytes; a received oversized frame refuses. */
  windowBytes: number;
  maxPending: number;
  maxStatements: number;
  maxCursors: number;
  allMaxRows: number;
  allMaxBytes: number;
  maxConnections: number;
  queueCapacity: number;
  acquisitionTimeoutMs: number;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  closeTimeoutMs: number;
  cursorLifetimeMs: number;
}
export declare const POSTGRES_DEFAULTS: Readonly<PostgresLimits>;
export interface PostgresClient {
  query: Function;
  release?: (error?: Error) => unknown;
  /** Native ReadyForQuery status, when the host supplies it. */
  getTransactionStatus?: () => 'I' | 'T' | 'E' | null;
}
export interface PostgresOptions extends Partial<PostgresLimits> {
  schema?: string;
  /** Empty transactional wake-up hints; captured writes require capture.log. */
  notifyChannel?: string;
  queueTimeout?: number;
  /** Stores require session affinity; transaction poolers refuse JD0003. */
  poolMode?: 'session';
  prepared?: 'named' | 'unnamed';
  /** Buffered compatibility receives the client result before checking bounds. */
  cursorMode?: 'native' | 'buffered';
  destroy?: (client: PostgresClient, error: Error) => unknown;
  /** Cancel only the supplied query generation on this still-owned session.
   * Resolve after cancellation delivery settles. No next query or reusable lease
   * starts while it is pending. Forced close may discard the socket, retaining
   * its admission credit; cursor return also waits for the response. */
  cancel?: (client: PostgresClient, queryGeneration: number) => unknown;
}
export interface PostgresAdmissionMetrics {
  readonly active: number;
  readonly idle: number;
  readonly queued: number;
  readonly waitMs: Readonly<{ p50: number; p95: number }>;
}
export interface PostgresDriver extends Driver {
  open(path?: string, options?: { queueTimeout?: number; signal?: AbortSignal }): Promise<PostgresConnection>;
  metrics(): PostgresAdmissionMetrics;
}
export interface PostgresStatement {
  get(params?: readonly unknown[]): Promise<Record<string, unknown> | undefined>;
  all(params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
  run(params?: readonly unknown[]): Promise<{ changes: number; lastInsertRowid?: unknown }>;
  iterate(params?: readonly unknown[]): AsyncIterableIterator<Record<string, unknown>>;
}
/** Scope-bound operations stay on the transaction's acquired physical client. */
export interface PostgresScope {
  readonly synchronous: false;
  readonly dialect: Dialect;
  readonly capabilities: Readonly<Record<string, unknown>>;
  prepare(sql: string, metadata?: { readOnly?: boolean; ephemeral?: boolean }): PostgresStatement | Promise<PostgresStatement>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(fn: (scope: PostgresScope) => T | Promise<T>): Promise<T>;
}
export interface PostgresConnection extends PostgresScope {
  readonly mustQueue: boolean;
  transaction<T>(fn: (scope: PostgresScope) => T | Promise<T>, signal?: AbortSignal, mode?: 'deferred' | 'immediate'): Promise<T>;
  exclusively<T>(fn: (scope: PostgresScope) => T | Promise<T>, what?: string, signal?: AbortSignal): T | Promise<T>;
  metrics(): Readonly<Record<string, unknown>>;
  close(): Promise<void>;
}

/**
 * The PostgreSQL 16+ dialect. Pure text: it imports no client, so this
 * subpath resolves and type-checks with nothing installed.
 */
export declare function postgresDialect(options?: {
  /** The one schema every catalog statement looks in. Unset, the
   * connection's own search path -- what a disposable per-run schema
   * needs. */
  searchPath?: string;
  notifyChannel?: string;
}): Dialect;

export interface PostgresNotificationOptions extends Partial<PostgresLimits> {
  channel: string;
  /** Total reconnect attempts over this owner's lifetime; default 5. */
  maxReconnects?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}
export interface PostgresNotifications extends AsyncIterableIterator<null> {
  /** Resolves after initial LISTEN commits, before the initial wake token. */
  readonly ready: Promise<void>;
  close(): Promise<void>;
  metrics(): Readonly<Record<string, number | boolean | unknown>>;
}
/** A separate session source with EventEmitter-shaped on/off and release.
 * At most one pending next() and one coalesced null token. Every successful
 * connection emits an initial token: drain durable pages after LISTEN, also
 * on reconnect. Poll pages independently when prompt delivery is required;
 * notifications are lossy hints and never authorization or durable records. */
export declare function postgresNotifications(source: { connect: Function },
  options: PostgresNotificationOptions): PostgresNotifications;

/** One acquired client, adapted to the raw binding contract. */
export declare function adaptPostgresClient(client: PostgresClient, options?: PostgresOptions & {
  onClose?: () => unknown;
  /** Low-level adapters default to buffered and do not configure server settings. */
  nativeCursor?: boolean;
  serverTimeouts?: boolean;
}): unknown;

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
}, options?: PostgresOptions): PostgresDriver;
