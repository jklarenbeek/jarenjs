import type { NodeOpenOptions } from './node.js';
import type { CancellationCapabilities, Driver } from './index.js';
import type { NodeWorkerConnection, NodeWorkerOptions, WorkerMetrics } from './node-worker.js';

export interface NodeProcessOptions extends NodeWorkerOptions { maxOwners?: number; timeoutMs?: number; maxRequestBytes?: number }
export interface ProcessSettlement {
  readonly path: string | null;
  readonly generation: number;
  readonly pid: number | null;
  readonly status: 'starting' | 'healthy' | 'quarantined' | 'exited';
  readonly transaction: 'none' | 'active' | 'committed' | 'rolled-back' | 'unknown';
  readonly safeToReplace: boolean;
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
}
export interface NodeProcessConnection extends NodeWorkerConnection {
  readonly capabilities: Readonly<Record<string, unknown>> & {
    readonly process: true; readonly ownerTermination: true;
    readonly cancellation: CancellationCapabilities & {readonly midStatement: false};
  };
  supervise<T>(body: (connection: NodeProcessConnection) => T | Promise<T>, options?: {signal?: AbortSignal; timeoutMs?: number}): Promise<T>;
  cancel(reason?: string): Error;
  settlement(): ProcessSettlement;
  /** Resolves only after the OS reports owner exit, never from a caller deadline. */
  settled(): Promise<ProcessSettlement>;
  metrics(): WorkerMetrics & {readonly owner: ProcessSettlement; readonly supervised: number};
  restart(): Promise<NodeProcessConnection>;
}
export interface NodeProcessDriver extends Driver {
  open(path?: string, options?: NodeOpenOptions): Promise<NodeProcessConnection>;
  metrics(): Readonly<{capacity: number; owners: number; quarantined: number; healthy: number}>;
}
export declare function nodeProcessDriver(options?: NodeProcessOptions): NodeProcessDriver;
