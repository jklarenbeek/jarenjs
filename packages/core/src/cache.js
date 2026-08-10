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
 *
 * The VALUE axis is {@link createSemanticCache}: keyed by what a
 * plain-data value IS rather than by a fingerprint of it, for the caches
 * whose entries carry meaning (a compiled query, a query plan, a
 * registered function body) and where serving the wrong entry is wrong
 * data rather than a slow repaint.
 */

import { semanticKey } from './object.js';

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
 * @template V
 * @typedef {object} SemanticCache
 * @property {(value: any) => V | undefined} get - Lookup by structural
 *   identity. `undefined` means miss — including "this value cannot be
 *   keyed", which is a permanent miss, never someone else's entry.
 * @property {(value: any, entry: V) => boolean} set - Insert or refresh.
 *   Returns whether the entry was retained — `false` means the value
 *   could not be keyed, which a caller comparing sizes to detect an
 *   eviction must not mistake for one.
 * @property {(value: any, create: (identity: string | null) => V) => V}
 *   getOrCreate - Lookup or compute-and-insert in one step. `create`
 *   receives the identity, or `null` when the value was unkeyable and
 *   the result will NOT be retained.
 * @property {() => void} clear - Drop every entry.
 * @property {() => number} size - Current entry count.
 */

/**
 * A bounded cache keyed by a value's COLLISION-FREE structural identity
 * ({@link semanticKey}), for entries whose reuse decides a result.
 *
 * Two guarantees a fingerprint-keyed cache cannot give:
 *
 *  - **Distinct inputs never share an entry.** The key is the whole
 *    deterministic serialization, so a hash collision cannot make one
 *    document's compiled semantics answer for another's.
 *  - **An unkeyable input is a permanent miss, never a wrong hit.** A
 *    value carrying a cycle, a function or a class instance cannot be
 *    keyed injectively, so it is computed afresh every time and never
 *    retained. Correct and slow beats fast and wrong; callers that want
 *    to *reject* such input should validate before asking the cache.
 *
 * Compose with a discriminating tuple when an entry depends on more than
 * the document — `cache.getOrCreate([document, dialect, strict], …)`
 * keys the whole tuple, which a `${a}|${b}` string concatenation cannot
 * do injectively once `a` may itself contain the separator.
 * @template V
 * @param {number} limit - Maximum number of retained entries (> 0)
 * @returns {SemanticCache<V>}
 */
export function createSemanticCache(limit) {
  /** @type {BoundedCache<string, V>} */
  const cache = createBoundedCache(limit);

  /** @param {any} value @returns {string | null} */
  const identify = (value) => {
    try {
      return semanticKey(value);
    }
    catch {
      return null; // unkeyable: a permanent miss
    }
  };

  /** @type {SemanticCache<V>['get']} */
  function get(value) {
    const identity = identify(value);
    return identity === null ? undefined : cache.get(identity);
  }

  /** @type {SemanticCache<V>['set']} */
  function set(value, entry) {
    const identity = identify(value);
    if (identity === null) return false;
    cache.set(identity, entry);
    return true;
  }

  /** @type {SemanticCache<V>['getOrCreate']} */
  function getOrCreate(value, create) {
    const identity = identify(value);
    if (identity === null) return create(null);
    let entry = cache.get(identity);
    if (entry === undefined) {
      entry = create(identity);
      cache.set(identity, entry);
    }
    return entry;
  }

  return { get, set, getOrCreate, clear: () => cache.clear(), size: () => cache.size() };
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
