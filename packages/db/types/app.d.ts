/**
 * The app binding for live queries (LIVE-FORMAT §10): generated
 * documents plus the subscription handler factory — the db package
 * never imports `@jarenjs/app`.
 */
import type { Store } from './index.js';

export interface LiveAppBindingOptions {
  /** The registered subscription handler name (default 'db/live'). */
  run?: string;
  /** The patch-forwarding action name (default 'db/liveChanged'). */
  action?: string;
  /** JSON Pointer to the state slot holding `{ rows }`. */
  statePath: string;
  /** Collection name; omit for an entity-root document. */
  collection?: string;
  query: unknown;
  externals?: Record<string, unknown>;
  mode?: 'auto' | 'incremental' | 'rerun';
  /** An APP-FORMAT `when` query gating the subscription. */
  when?: unknown;
}

export interface LiveAppBinding {
  /** The APP-FORMAT §5.3 subscription entry (plain data). */
  subscription: unknown;
  /** `{ [action]: { patch: '$payload' } }` — merge into `actions`. */
  actions: Record<string, unknown>;
}

export declare function liveAppBinding(options: LiveAppBindingOptions): LiveAppBinding;
export declare function prefixLivePatch(
  patch: ReadonlyArray<{ op: string; path: string }>, statePath: string):
  Array<{ op: string; path: string }>;
export declare function createLiveSubscription(store: Store):
  (props: unknown, dispatch: (action: string, payload: unknown) => void) => () => void;
