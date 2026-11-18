//@ts-check
/**
 * @file The provider seam: a provider is any object exposing
 * `execute(queryDocument, options)` — contract-level coupling: the
 * chain imports no provider. `@jarenjs/db` implements this interface;
 * the package's one runtime edge — the client subpath `./db` — runs
 * the other way, toward the store, as declared optional peers, and the
 * store never imports this package. The in-memory runner implements
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
import { resolveRuntime } from '@jarenjs/core/runtime';
import { LinqBuildError } from './errors.js';

/** Stands in for an absent hook while walking the identity chain. */
const NO_HOOK = Object.freeze({});

const CACHES = createWeakCache();
const cacheFor = () => createBoundedCache(512);

/**
 * The cache identity of one compilation: the document's exact JSON text
 * beside the declared externals, the limits and the zone provider's part
 * ({@link zoneIdentity}). `null` when the value
 * cannot be keyed injectively — a function, an `undefined`, a symbol, a
 * bigint, a non-finite number, `-0`, or a class instance whose `toJSON`
 * would otherwise stand in for it — which is a permanent miss, never
 * someone else's entry.
 * @param {any} document
 * @param {readonly string[]} externals
 * @param {any} limits
 * @param {readonly (string | number)[] | null} zones
 * @returns {string | null}
 */
function compilationKey(document, externals, limits, zones) {
  try {
    return JSON.stringify([document, externals, limits ?? null, zones], function (key, value) {
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

/** The number each zone provider that declares no identity keys under. */
const ZONE_IDS = new WeakMap();
let zoneCount = 0;

/**
 * The part of a compilation's key a zone provider adds, as the formula
 * compiler of `@jarenjs/json/formula` keys it: `['zones', name, revision]`
 * for the identity a provider declares (`{ name, revision }`, as
 * `createIntlZoneProvider` and a compiled VTIMEZONE record it), so two
 * providers that answer differently never share a compiled document, or
 * `['zones', n]` for its object when it declares none. `null` without a
 * provider, and `undefined` for a value that is no provider at all: the
 * compile refuses that one, and it is never cached.
 * @param {any} provider
 * @returns {readonly (string | number)[] | null | undefined}
 */
function zoneIdentity(provider) {
  if (provider === undefined || provider === null) return null;
  if (typeof provider !== 'object') return undefined;
  const declared = provider.identity;
  if (declared === undefined) {
    let n = ZONE_IDS.get(provider);
    if (n === undefined) {
      n = ++zoneCount;
      ZONE_IDS.set(provider, n);
    }
    return ['zones', n];
  }
  if (declared === null || typeof declared !== 'object' || typeof declared.name !== 'string' || declared.name === ''
    || typeof declared.revision !== 'string' || declared.revision === '')
    throw new TypeError('options.zoneProvider.identity must be { name, revision } with non-empty strings');
  return ['zones', declared.name, declared.revision];
}

/** The zone provider each client handle lends the chains built over it. */
const HANDLE_ZONES = new WeakMap();

/**
 * Lend a client handle's zone provider to every chain built over it with
 * `from(handle)` or `fromAsync(handle)` and no zone provider of its own,
 * so what such a chain runs in memory reads a named zone as the store does.
 * @template {object} T
 * @param {T} handle
 * @param {any} zoneProvider
 * @returns {T}
 */
export function lendZoneProvider(handle, zoneProvider) {
  HANDLE_ZONES.set(handle, zoneProvider);
  return handle;
}

/**
 * A source's options with its runtime record read: the record's zone
 * provider stands in for an absent `zoneProvider`, by `openStore`'s
 * precedence (an explicit option wins over the record's member), and the
 * record itself is not kept, because a compile reads nothing else of it;
 * with neither, a client handle's own ({@link lendZoneProvider}).
 * A record the runtime refuses is its `TypeError`, as `openStore`'s is.
 * @param {Record<string, any>} options - a source's options, already read
 * @param {unknown} source - what the chain is built over
 * @returns {Record<string, any>}
 */
export function readRuntime(options, source) {
  let read = options;
  if (options.runtime !== undefined) {
    const { runtime, ...rest } = options;
    const { zoneProvider } = resolveRuntime(runtime);
    if (rest.zoneProvider === undefined && zoneProvider !== null) rest.zoneProvider = zoneProvider;
    read = rest;
  }
  if (read.zoneProvider === undefined && source !== null && typeof source === 'object' && HANDLE_ZONES.has(source))
    read = { ...read, zoneProvider: HANDLE_ZONES.get(source) };
  return read;
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
  'compileTypeTest', 'functions', 'collations', 'pathFunctions', 'limits', 'zoneProvider',
]);

/** Every member `from()`/`fromAsync()`/`fromDocument()` options carry:
 * the forwarded compile options, the cache-partition key and the runtime
 * record, read for its zone provider ({@link readRuntime}). A closed
 * set — a misspelt `limits` is refused, never a silently unbounded run. */
export const SOURCE_OPTION_KEYS = Object.freeze([...COMPILE_OPTION_KEYS, 'registry', 'runtime']);

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
 *   pathFunctions?: any, limits?: any, zoneProvider?: any, registry?: object,
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
  // the externals, the limits and the zone provider are part of the
  // identity: the same document compiles differently against a different
  // set of declared names, differently again under a step or result
  // bound, and a named zone reads the wall clock its provider answers
  const zones = zoneIdentity(options.zoneProvider);
  const key = zones === undefined ? null : compilationKey(document, options.externals, options.limits, zones);
  return key === null ? compile() : cache.getOrCreate(key, compile);
}

/**
 * Whether a source is a provider: an `execute` duck. The one dispatch
 * both surfaces share — on `fromAsync` it is asked BEFORE the iterable
 * shapes, so a provider that also happens to be iterable is still a
 * provider.
 * @param {any} source
 * @returns {boolean}
 */
export function isProviderSource(source) {
  return source !== null && typeof source === 'object'
    && typeof (/** @type {any} */ (source).execute) === 'function';
}

/**
 * The root expression a provider's items are bound through (QUERY-PEN
 * §8): its `root` (`'$.Post[*]'` for an entity set), or `'$[*]'` when it
 * names none — the whole input, a collection. A provider that serves
 * SEVERAL roots and none of its own (a store with entities: `roots`) has
 * nothing a chain could iterate — `$[*]` over the entity map would
 * answer the rows of every entity, mixed, or count the SETS — so it is
 * refused here, at `from()` time, naming the roots to chain over.
 * @param {any} provider
 * @returns {string}
 */
export function providerRoot(provider) {
  const root = provider.root;
  if (root === undefined || root === null) {
    const roots = provider.roots;
    if (Array.isArray(roots) && roots.length > 0) {
      throw new LinqBuildError('JL0007',
        `this provider serves entity roots ${roots.join(', ')} and has no root of its own — `
        + 'chain over one of them: from(store.entity(name)) (QUERY-PEN.md §8)');
    }
    return '$[*]';
  }
  if (typeof root !== 'string' || root === '') {
    throw new LinqBuildError('JL0005',
      `a provider's root is a path expression string ('$.Post[*]'), got ${typeof root}`);
  }
  return root;
}

/**
 * The relation context a provider offers (QUERY-PEN §8): its own
 * relation table — `relations`, keyed by member (MODEL-FORMAT §10.1) —
 * and a resolver for the tables of the other roots of its scope
 * (`scope.relations`, keyed by root name: one store's entity sets), so
 * a hop can continue into another root. `null` when the provider
 * carries no table: a relation name is then an ordinary member.
 * @param {any} provider
 * @returns {{ table: any, resolve: (name: string) => any } | null}
 */
export function providerRelations(provider) {
  const table = provider.relations;
  if (table === null || typeof table !== 'object') return null;
  const scope = provider.scope;
  const scoped = scope !== null && typeof scope === 'object' ? scope.relations : undefined;
  return {
    table,
    resolve: (name) => (scoped !== null && typeof scoped === 'object'
      && Object.hasOwn(scoped, name) ? scoped[name] : undefined),
  };
}

/**
 * Whether two sources may share one document: the same object, or two
 * providers carrying one `scope` — one store's entity sets, which are
 * two roots of ONE multi-entity input (QUERY-PEN §8).
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
export function sharesScope(a, b) {
  if (a === b) return true;
  if (!isProviderSource(a) || !isProviderSource(b)) return false;
  const scope = a.scope;
  return scope !== undefined && scope !== null && scope === b.scope;
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
  if (isProviderSource(source)) return 'provider';
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
