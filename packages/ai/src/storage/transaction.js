//@ts-check
import { createMemoryStorage } from './memory.js';

/**
 * Atomically transform the JSON record map under a namespace. The synchronous
 * callback receives a detached current map and returns {next, result}; omitting
 * next is a read-only decision. Failure publishes nothing. Keys cannot escape
 * the namespace. Adapters serialize the callback with every other write.
 * @typedef {string | { prefixes?: string[], keys?: string[] }} StorageScope
 * @typedef {(prefix: StorageScope, transform: (current: Record<string, any>) =>
 *   { next?: Record<string, any>, result?: any }) => Promise<any>} StorageMutation
 */

const staged = new WeakSet();
/** Whether a private view is already enclosed by an atomic publication. */
export const isAtomicView = (view) => staged.has(view);

const signature = (map) => JSON.stringify(Object.keys(map).sort().map((key) => [key, map[key]]));

/**
 * Stage async ledger work off-store, then publish through one synchronous CAS.
 * Readers never observe the staged adapter. Competing commits retry against a
 * fresh record map; external I/O belongs outside the transform callback.
 * Four-method adapters retain their explicit single-writer behavior.
 * @template T
 * @param {any} storage
 * @param {StorageScope} prefix
 * @param {(view: any) => Promise<T>} task
 * @returns {Promise<T>}
 */
export async function atomicTask(storage, prefix, task) {
  if (typeof storage.mutate !== 'function') return task(storage);
  for (let attempt = 0; attempt < 128; attempt++) {
    const before = await storage.mutate(prefix, (current) => ({ result: current }));
    const expected = signature(before);
    const backing = new Map(Object.entries(before).map(([key, value]) => [key, JSON.stringify(value)]));
    const view = createMemoryStorage(backing);
    // Staging already owns its isolated map; nested transactions need no CAS.
    const { mutate: _mutate, ...plain } = view;
    staged.add(plain);
    const result = await task(plain);
    const next = Object.fromEntries([...backing].map(([key, raw]) => [key, JSON.parse(raw)]));
    const changed = signature(next) !== expected;
    const committed = await storage.mutate(prefix, (current) => signature(current) !== expected
      ? { result: false } : { ...(changed ? { next } : {}), result: true });
    if (committed) return result;
  }
  throw Object.assign(new Error('ledger transaction conflict; retry the operation'), { code: 'LEDGER_CONFLICT' });
}
