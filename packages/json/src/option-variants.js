//@ts-check
/**
 * @file Per-document compilation-variant caching, shared by the JSLT
 * and JTLT one-call entry points. A document compiles differently under
 * different options, so the cache key is the FULL option tuple — every
 * option that changes what compiles must be part of the derived key, or
 * a second call with different options silently reuses the first
 * compilation (the cache-poisoning bug the JTLT cache had before the
 * health pass). Identity-compared option values (hook functions,
 * function-extension registries) are interned to stable per-process ids
 * so the key is a flat string and lookup is O(1) instead of a linear
 * scan over an unbounded variants array.
 */

import { createBoundedCache, createWeakCache } from '@jarenjs/core/cache';

/** @type {WeakMap<object, number>} */
const IDENTITY_IDS = new WeakMap();
let nextIdentityId = 1;

/**
 * A stable per-process id for an identity-compared option value.
 * `null`/`undefined` share id 0 ("absent").
 * @param {any} value
 * @returns {number}
 */
export function identityOf(value) {
  if (value == null) return 0;
  let id = IDENTITY_IDS.get(value);
  if (id === undefined) {
    id = nextIdentityId++;
    IDENTITY_IDS.set(value, id);
  }
  return id;
}

/**
 * A two-axis compilation cache: documents by identity (weak, entries
 * die with the document), variants per document by derived option key
 * (bounded LRU — the old variants array grew without bound).
 * @param {number} [limitPerDocument] - variant bound per document
 * @returns {{ getOrCompile: (document: object, key: string, compile: () => any) => any }}
 */
export function createOptionVariantCache(limitPerDocument = 16) {
  const byDocument = createWeakCache();
  const newVariants = () => createBoundedCache(limitPerDocument);
  return {
    getOrCompile(document, key, compile) {
      const variants = /** @type {import('@jarenjs/core/cache').BoundedCache<string, any>} */ (
        byDocument.getOrCreate(document, newVariants));
      return variants.getOrCreate(key, compile);
    },
  };
}
