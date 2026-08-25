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
 *   keys(prefix)  -> Promise<string[]>          every key starting with prefix, sorted
 *
 * Four methods, all async, all JSON. `keys()` answers in lexicographic
 * order, and the ledger depends on it: listings, the goal archive and a
 * snapshot's entries are read in key order, and its zero-padded
 * sequences exist so that order is chronological. Async even here,
 * where nothing needs to be: an adapter over IndexedDB or OPFS is
 * unavoidably async, and a synchronous default would let a caller write
 * code that silently breaks the moment real storage is wired in.
 */

/**
 * Create an in-memory adapter with JSON-value semantics: every value is
 * serialized on the way in and parsed on the way out, so what survives
 * is exactly what `JSON.stringify` preserves — a typed array comes back
 * as a plain object of its indices, `NaN` and `Infinity` as `null`, and
 * `undefined` members vanish. That is the contract, not a shortcut: real
 * storage serializes, and a default that kept more (a structured clone
 * would keep a `Float32Array`) would let the test path behave
 * differently from the durable one, which is the kind of difference
 * that surfaces in production and nowhere else. The round-trip also
 * copies: a caller that mutates what it stored — or what it read —
 * cannot reach inside the ledger.
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
