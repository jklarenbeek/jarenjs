import type { Driver } from './index.js';

export interface NodeWorkerOptions {
  windowRows?: number;
  windowBytes?: number;
  maxPending?: number;
  maxStatements?: number;
  maxCursors?: number;
  allMaxRows?: number;
  allMaxBytes?: number;
  closeTimeoutMs?: number;
  startupTimeoutMs?: number;
}

/** One worker per connection; SQLite and its iterators live off the caller thread. */
export declare function nodeWorkerDriver(options?: NodeWorkerOptions): NodeWorkerDriver;

export interface WorkerMetrics {
  readonly frames: number;
  readonly rows: number;
  readonly maxFrameRows: number;
  readonly maxFrameBytes: number;
  readonly maxPending: number;
  readonly pending: number;
  readonly generation: number;
  readonly healthy: boolean;
}
export interface WorkerStatement {
  run(params?: readonly unknown[]): Promise<unknown>;
  get(params?: readonly unknown[]): Promise<Record<string, unknown> | undefined>;
  all(params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
  iterate(params?: readonly unknown[]): Promise<AsyncIterableIterator<Record<string, unknown>>>;
}
/** The ordinary Connection operations; transactions pass their owning scope. */
export interface WorkerConnectionScope {
  exec(sql: string): Promise<unknown>;
  prepare(sql: string, metadata?: { readOnly?: boolean; ephemeral?: boolean }): WorkerStatement | Promise<WorkerStatement>;
  transaction<T>(body: (scope: WorkerConnectionScope) => T | Promise<T>): Promise<T>;
}
export interface WorkerConnection extends WorkerConnectionScope {
  transaction<T>(body: (scope: WorkerConnectionScope) => T | Promise<T>, signal?: AbortSignal, mode?: 'deferred' | 'immediate'): Promise<T>;
  readonly synchronous: false;
  readonly capabilities: Readonly<Record<string, unknown>>;
  close(): Promise<void>;
}
export interface NodeWorkerConnection extends WorkerConnection {
  readonly generation: number;
  metrics(): WorkerMetrics;
  /** Fences this handle permanently; returns a newly opened connection. */
  restart(): Promise<NodeWorkerConnection>;
}
export interface NodeWorkerDriver extends Driver {
  open(path?: string, options?: import('./node.js').NodeOpenOptions): Promise<NodeWorkerConnection>;
}
