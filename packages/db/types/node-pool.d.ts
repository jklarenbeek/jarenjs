import type { Driver } from './index.js';
import type { NodeWorkerOptions, WorkerConnection } from './node-worker.js';

export interface NodeWorkerPoolOptions {
  readers?: number;
  queueCapacity?: number;
  graceMs?: number;
  worker?: NodeWorkerOptions;
}

/** One writer and bounded read-only WAL workers. Memory uses the writer alone. */
export declare function nodeWorkerPoolDriver(options?: NodeWorkerPoolOptions): NodeWorkerPoolDriver;

export interface PoolMetrics {
  readonly active: number;
  readonly idle: number;
  readonly queued: number;
  readonly waitMs: Readonly<{ p50: number; p95: number }>;
  readonly workers: readonly Readonly<{
    readOnly: boolean; healthy: boolean; active: boolean; generation: number; executions: number;
  }>[];
}
export interface NodeWorkerPoolConnection extends WorkerConnection {
  metrics(): PoolMetrics;
}
export interface NodeWorkerPoolDriver extends Driver {
  open(path?: string, options?: import('./node.js').NodeOpenOptions): Promise<NodeWorkerPoolConnection>;
}
