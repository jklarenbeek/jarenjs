import type { LiveBounds } from './index.js';

export interface AsyncLiveOptions extends LiveBounds {
  /** Aggregate decoded input across all statements in one evaluation. */
  maxInputRows?: number;
  maxInputBytes?: number;
  /** At most one active callback and one latest event per observer. Default 8. */
  maxObservers?: number;
  /** Poll interval in milliseconds; local commits also wake the reader. Default 1000. */
  pollMs?: number;
  /** Durable records read per cycle. Default 32. */
  pageRows?: number;
  /** Revision validation attempts per cycle. Default 3. */
  maxAttempts?: number;
}

/** Pass this configuration as openStore's live option to enable resnapshot mode.
 * Requires durable capture and a driver with a lazy row iterator. */
export declare function asyncLive(options?: AsyncLiveOptions): LiveBounds;
