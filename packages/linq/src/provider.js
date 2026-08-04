//@ts-check
/**
 * @file The provider seam (D2): a provider is any object exposing
 * `execute(queryDocument, options)` — contract-level coupling, never an
 * import edge. `@jarenjs/db` will implement this interface without
 * either package importing the other. The in-memory runner implements
 * the SAME interface over an iterable, so it is both the reference
 * semantics every other provider must match and the proof the seam is
 * real.
 *
 * Compiled documents are shared through a bounded LRU keyed by
 * `contentKey(document)` (the memo-grade key — `canonicalizeJson` is
 * signature-grade and throws on non-JSON; do not conflate them), one
 * cache per `compileTypeTest` identity because the hook changes what
 * compiles.
 */

import { compileJsonQuery, JsonQueryCompileError } from '@jarenjs/json/query';
import { contentKey } from '@jarenjs/core/object';
import { createBoundedCache, createWeakCache } from '@jarenjs/core/cache';
import { LinqBuildError } from './errors.js';

/** The cache key sentinel for "no compileTypeTest supplied". */
const NO_HOOK = Object.freeze({});

const CACHES = createWeakCache();
const cacheFor = () => createBoundedCache(512);

/**
 * Compile a query document, shared across equal documents.
 * @param {any} document - the emitted (or hand-written) query document
 * @param {{ compileTypeTest?: any, externals: readonly string[] }} options
 * @returns {any} the compiled query
 * @throws {LinqBuildError} `JL0003` when a schema operator needs the
 *   missing `compileTypeTest` hook
 */
export function compileDocument(document, options) {
  const cache = /** @type {any} */ (CACHES.getOrCreate(options.compileTypeTest ?? NO_HOOK, cacheFor));
  const key = contentKey({ document, externals: options.externals });
  return cache.getOrCreate(key, () => {
    try {
      return compileJsonQuery(document, {
        compileTypeTest: options.compileTypeTest,
        externals: options.externals,
      });
    }
    catch (err) {
      if (err instanceof JsonQueryCompileError && err.code === 'JQ0008') {
        throw new LinqBuildError('JL0003',
          'ofType/cast compile schema operators, which need a type-test compiler — '
          + 'pass options.compileTypeTest to from()/fromDocument() '
          + '(e.g. createTypeTestCompiler() from @jarenjs/validate/query)',
          err.docPath, err);
      }
      throw err;
    }
  });
}

/**
 * Classify a `from()` source: an `execute` duck is a PROVIDER (the
 * document is handed over whole; nothing is enumerated locally);
 * any iterable is in-memory. Anything else is `JL0001` — at `from()`
 * time, not at enumeration time.
 * @param {any} source
 * @returns {'provider' | 'iterable'}
 */
export function classifySource(source) {
  if (source !== null && typeof source === 'object'
    && typeof (/** @type {any} */ (source).execute) === 'function') {
    return 'provider';
  }
  if (source != null && (typeof source === 'string'
    || typeof (/** @type {any} */ (source))[Symbol.iterator] === 'function')) {
    return 'iterable';
  }
  throw new LinqBuildError('JL0001',
    'from() needs an iterable or a provider exposing execute(document, options)');
}

/**
 * The in-memory execution of one document over an iterable source:
 * materialise (each execution re-reads the source — the deferred
 * re-enumeration contract), compile shared, run. The signature IS the
 * provider contract, deliberately.
 * @param {any} source - the iterable
 * @param {any} document
 * @param {{ compileTypeTest?: any, externalNames: readonly string[],
 *   externals: Record<string, any> }} options
 * @returns {any} the engine-shaped result (`undefined | item | items[]`)
 */
export function executeInMemory(source, document, options) {
  const compiled = compileDocument(document,
    { compileTypeTest: options.compileTypeTest, externals: options.externalNames });
  const data = Array.isArray(source) ? source : [...source];
  return compiled(data, options.externals);
}
