import type { Store } from './index.js';
import type { LexicalDefinition } from '@jarenjs/core/search';

export interface SearchStorage {
  load(id: string): Promise<string | null>;
  save(id: string, payload: string): Promise<{ changes: number }>;
}
export declare function createDbSearchStorage(store: Store, collection: string, options?: { maxBytes?: number }): SearchStorage;
export interface DbSearch {
  readonly sourceRevision: string;
  refresh(): Promise<any>;
  search(text: string, request?: Record<string, unknown>): Promise<any>;
  row(id: string, revision: string): any;
  subscribe(observer: (event: any) => void): () => void;
  explain(): { mode: string; nativeFTS: boolean; reason: string; maxRows: number; maxBytes: number; capture: string; externalChanges: string };
  stats(): any;
  dispose(): Promise<void>;
}
export declare function createDbSearch(store: Store, entity: string, definition: LexicalDefinition,
  options: { source: string; maxRows?: number; maxBytes?: number; storage?: SearchStorage; snapshotKey?: string }): Promise<DbSearch>;
