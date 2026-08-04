//@ts-check
/**
 * @file The suite's one bounded-cache primitive. Before this file the
 * FIFO-512 delete-oldest map was written five times (the query engine's
 * string cache, the JSONPath query cache, forms' three pointer caches)
 * with a sixth divergent flush-all variant in forms' regex cache and a
 * true LRU in the view projection memo. One implementation, one policy:
 *
 *  - **LRU with recency refresh**: a `get` hit re-inserts the entry, so
 *    the evicted entry is the least recently USED, not the oldest
 *    inserted. (FIFO versus LRU was never result-observable at any call
 *    site — both bound memory; LRU keeps hot entries hotter.)
 *  - **Evict at `size >= limit` before inserting a new key**, so the
 *    cache never holds more than `limit` entries. (The old sites
 *    disagreed between `>=`-before and `>`-after; the capacity is the
 *    same, the invariant here is simply "never above `limit`".)
 *  - `undefined` is the miss sentinel: a cache MUST NOT store
 *    `undefined` as a value (store `null` for "computed, negative" —
 *    the regex cache does exactly that).
 *
 * The identity axis is {@link createWeakCache}: reference-keyed,
 * unbounded by design because a WeakMap is bounded by its keys'
 * lifetimes — an entry dies with its key. Compose the two for
 * "per-registry bounded caches" (a WeakMap of bounded caches).
 */

/**
 * @template K, V
 * @typedef {object} BoundedCache
 * @property {(key: K) => V | undefined} get - Lookup; a hit refreshes
 *   recency. `undefined` means miss.
 * @property {(key: K, value: V) => void} set - Insert or refresh; evicts
 *   the least recently used entry when the cache is full.
 * @property {(key: K, create: (key: K) => V) => V} getOrCreate - Lookup
 *   or compute-and-insert in one step.
 * @property {() => void} clear - Drop every entry.
 * @property {() => number} size - Current entry count.
 */

/**
 * A bounded, string-or-value-keyed LRU cache.
 * @template K, V
 * @param {number} limit - Maximum number of retained entries (> 0)
 * @returns {BoundedCache<K, V>}
 */
export function createBoundedCache(limit) {
  /** @type {Map<K, V>} */
  const map = new Map();

  /** @type {BoundedCache<K, V>['get']} */
  function get(key) {
    const value = map.get(key);
    if (value !== undefined) {
      // Refresh recency: Map iteration order is insertion order, so
      // delete + set moves the entry to the back of the eviction queue.
      map.delete(key);
      map.set(key, value);
    }
    return value;
  }

  /** @type {BoundedCache<K, V>['set']} */
  function set(key, value) {
    if (map.has(key)) map.delete(key);
    else if (map.size >= limit) map.delete(map.keys().next().value);
    map.set(key, value);
  }

  /** @type {BoundedCache<K, V>['getOrCreate']} */
  function getOrCreate(key, create) {
    let value = get(key);
    if (value === undefined) {
      value = create(key);
      set(key, value);
    }
    return value;
  }

  return { get, set, getOrCreate, clear: () => map.clear(), size: () => map.size };
}

/**
 * @template {object} K
 * @template V
 * @typedef {object} WeakCache
 * @property {(key: K) => V | undefined} get
 * @property {(key: K, value: V) => void} set
 * @property {(key: K, create: (key: K) => V) => V} getOrCreate
 */

/**
 * The identity axis: a reference-keyed cache whose entries live exactly
 * as long as their keys. No bound, deliberately — the bound is the
 * caller's ownership of the key objects.
 * @template {object} K
 * @template V
 * @returns {WeakCache<K, V>}
 */
export function createWeakCache() {
  /** @type {WeakMap<K, V>} */
  const map = new WeakMap();

  /** @type {WeakCache<K, V>['getOrCreate']} */
  function getOrCreate(key, create) {
    let value = map.get(key);
    if (value === undefined) {
      value = create(key);
      map.set(key, value);
    }
    return value;
  }

  return { get: (key) => map.get(key), set: (key, value) => map.set(key, value), getOrCreate };
}
