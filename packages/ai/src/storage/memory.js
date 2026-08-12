//@ts-check
/**
 * The in-memory storage adapter: the ledger's default, and the reason
 * `createLedger()` works with no arguments at all.
 *
 * A host that wants durability injects its own adapter over
 * `@jarenjs/db` (OPFS, survives the tab), `localStorage`, a file, or a
 * server. `@jarenjs/ai` gains no dependency either way — the whole
 * posture of this package is that it loads in a static page with two
 * dependencies, and a store is the largest thing it could have been made
 * to import.
 *
 * The adapter contract, in full:
 *
 *   get(key)      -> Promise<any | undefined>   a JSON value, or undefined
 *   set(key, val) -> Promise<void>              val is a JSON value
 *   delete(key)   -> Promise<void>              absent key is not an error
 *   keys(prefix)  -> Promise<string[]>          every key starting with prefix
 *
 * Four methods, all async, all JSON. Async even here, where nothing
 * needs to be: an adapter over IndexedDB or OPFS is unavoidably async,
 * and a synchronous default would let a caller write code that silently
 * breaks the moment real storage is wired in.
 */

/**
 * Create an in-memory adapter. Values are structurally cloned on the way
 * in and out, so a caller that mutates what it stored — or what it read —
 * cannot reach inside the ledger. Real storage serializes; a default
 * that shared references would make the durable path behave differently
 * from the test path, which is the kind of difference that surfaces in
 * production and nowhere else.
 *
 * @param {Map<string, string>} [backing] - an existing map to adopt
 * @returns {{ get: (key: string) => Promise<any>,
 *   set: (key: string, value: any) => Promise<void>,
 *   delete: (key: string) => Promise<void>,
 *   keys: (prefix?: string) => Promise<string[]> }}
 */
export function createMemoryStorage(backing = new Map()) {
  return {
    get: async (key) => {
      const raw = backing.get(key);
      return raw === undefined ? undefined : JSON.parse(raw);
    },
    set: async (key, value) => {
      backing.set(key, JSON.stringify(value));
    },
    delete: async (key) => {
      backing.delete(key);
    },
    keys: async (prefix = '') => [...backing.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort(),
  };
}
