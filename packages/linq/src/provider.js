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
 * Compiled documents are shared through a bounded LRU keyed by the
 * document's COLLISION-FREE, ORDER-SENSITIVE identity — its exact JSON
 * text — one cache per REGISTRY identity, because the hooks change what
 * compiles, so two different registries must not share compiled
 * programs. A fingerprint would not do: a 32-bit content hash collides
 * after tens of thousands of documents, and a collision here runs one
 * query's compiled program for another query's document — silently
 * wrong rows. Nor would an order-insensitive identity: a constructor's
 * member order is part of a document's meaning (`{ id, name }` and
 * `{ name, id }` project different objects), and a cache that keyed them
 * as one answered the second projection in the first one's order.
 */

import { compileJsonQuery, JsonQueryCompileError } from '@jarenjs/json/query';
import { createBoundedCache, createWeakCache } from '@jarenjs/core/cache';
import { LinqBuildError } from './errors.js';

/** Stands in for an absent hook while walking the identity chain. */
const NO_HOOK = Object.freeze({});

const CACHES = createWeakCache();
const cacheFor = () => createBoundedCache(512);

/**
 * The cache identity of one compilation: the document's exact JSON text
 * beside the declared externals and the limits. `null` when the value
 * cannot be keyed injectively — a function, an `undefined`, a symbol, a
 * bigint, a non-finite number, `-0`, or a class instance whose `toJSON`
 * would otherwise stand in for it — which is a permanent miss, never
 * someone else's entry.
 * @param {any} document
 * @param {readonly string[]} externals
 * @param {any} limits
 * @returns {string | null}
 */
function compilationKey(document, externals, limits) {
  try {
    return JSON.stringify([document, externals, limits ?? null], function (key, value) {
      const raw = this[key];
      const type = typeof raw;
      if (type === 'function' || type === 'undefined' || type === 'symbol' || type === 'bigint'
        || (type === 'number' && (!Number.isFinite(raw) || Object.is(raw, -0)))) {
        throw new TypeError('unkeyable');
      }
      if (raw !== null && type === 'object' && !Array.isArray(raw)) {
        const proto = Object.getPrototypeOf(raw);
        if (proto !== Object.prototype && proto !== null) throw new TypeError('unkeyable');
      }
      return value;
    });
  }
  catch {
    return null;
  }
}

/** The root of the hook-identity chain. */
const REGISTRY_IDS = createWeakCache();
/** The token minted for each distinct COMBINATION of hook identities. */
const REGISTRY_TOKEN = Symbol('linq.registryToken');

/**
 * The compile options a sequence forwards to the engine, beyond the
 * document itself. `orderBy(..., {collation})` and `$call` emit perfectly
 * good documents, and without the matching registry the in-memory
 * compiler could only answer `JQ0010` — so a Dutch sort was expressible
 * and not executable. These are the registries that close that gap; the
 * engine's own option names, deliberately, so there is one vocabulary.
 */
export const COMPILE_OPTION_KEYS = Object.freeze([
  'compileTypeTest', 'functions', 'collations', 'pathFunctions', 'limits',
]);

/**
 * Pick the forwarded compile options out of a sequence's options bag.
 * @param {Record<string, any>} options
 * @returns {Record<string, any>}
 */
export function compileOptionsOf(options) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const key of COMPILE_OPTION_KEYS) {
    if (options[key] !== undefined) out[key] = options[key];
  }
  return out;
}

/**
 * A stable token for one COMBINATION of hook identities, so compiled
 * programs are shared exactly among callers whose hooks agree.
 *
 * Partitioning on one hook is not enough: a document naming a `nl`
 * collation compiles to different code with and without that registry,
 * and a shared partition would serve the compiled-with version to a
 * caller who passed no collations at all — which is a wrong answer, not
 * a missing error. The chain walks every hook slot in a fixed order
 * through WeakMaps, so a token lives exactly as long as the registries
 * that produced it. `limits` is plain data and rides in the cache key
 * instead of here, so a fresh `{ steps: 1000 }` literal per call does
 * not mint a fresh partition every time.
 * @param {Record<string, any>} options
 * @returns {object} the partition key
 */
function registryIdentity(options) {
  if (options.registry !== undefined) return options.registry;
  let node = /** @type {any} */ (REGISTRY_IDS);
  for (const key of ['compileTypeTest', 'functions', 'collations', 'pathFunctions']) {
    const hook = options[key];
    const slot = hook === undefined || hook === null ? NO_HOOK : hook;
    node = node.getOrCreate(slot, () => {
      const next = createWeakCache();
      /** @type {any} */ (next)[REGISTRY_TOKEN] = Object.freeze({});
      return next;
    });
  }
  return /** @type {any} */ (node)[REGISTRY_TOKEN];
}

/**
 * Compile a query document, shared across equal documents.
 * @param {any} document - the emitted (or hand-written) query document
 * @param {{ compileTypeTest?: any, functions?: any, collations?: any,
 *   pathFunctions?: any, limits?: any, registry?: object,
 *   externals: readonly string[] }} options - `registry` is the cache
 *   partition key: one object identity per distinct set of hooks, since
 *   the hooks decide what a document compiles to
 * @returns {any} the compiled query
 * @throws {LinqBuildError} `JL0003` when a schema operator needs the
 *   missing `compileTypeTest` hook
 */
export function compileDocument(document, options) {
  const cache = /** @type {any} */ (CACHES.getOrCreate(registryIdentity(options), cacheFor));
  const compile = () => {
    try {
      return compileJsonQuery(document, {
        ...compileOptionsOf(options),
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
  };
  // the externals and the limits are part of the identity: the same
  // document compiles differently against a different set of declared
  // names, and differently again under a step or result bound
  const key = compilationKey(document, options.externals, options.limits);
  return key === null ? compile() : cache.getOrCreate(key, compile);
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
    { ...options, externals: options.externalNames });
  const data = Array.isArray(source) ? source : [...source];
  return compiled(data, options.externals);
}
