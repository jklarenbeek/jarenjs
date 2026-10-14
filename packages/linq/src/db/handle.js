//@ts-check
/**
 * @file The handles the client fronts the store with. An entity handle
 * is the store's entity set — every member of it, the provider members
 * included, so `fromAsync(handle)` still binds through its root and two
 * handles of one client still share a scope — plus the chain start
 * (every `AsyncSequence` operator and terminal, delegated to
 * `fromAsync(set)`: nothing is duplicated, every read is the chain and
 * pushes down), `execute` and `explain` taking a chain as well as a
 * document, `include` (the graph builder that EMITS the store's
 * `load` spec), `link`/`unlink` (checked against the relation table
 * before the store records them) and `live`. A collection handle is the
 * collection with the same chain start and `live`, and `execute`,
 * `query` and `explain` taking a chain as well as a document.
 * `explain()` without a document explains the empty chain; with one it is
 * the store's explanation of that document.
 */

import { fromAsync, AsyncSequence } from '../async.js';
import { Graph } from './include.js';
import { requireMembership } from './membership.js';
import { registerLive } from './live.js';
import { isChain, resolveSource } from './chain.js';
import { createDbRangeProvider } from './range.js';

/** The chain surface, read once from the class: every public operator
 * and terminal, `explain` set aside for its overload. */
const CHAIN_MEMBERS = Object.getOwnPropertyNames(AsyncSequence.prototype)
  .filter((name) => name !== 'constructor' && name !== 'explain');
const CHAIN_SYMBOLS = Object.getOwnPropertySymbols(AsyncSequence.prototype);

/**
 * Give a handle the chain start over a provider: each member is
 * `fromAsync(provider)`'s, so the handle and the chain are one surface.
 * @param {any} provider - the store's handle (a collection or an entity set)
 * @param {Record<string | symbol, any>} members - the handle being built
 */
function chainStart(provider, members) {
  for (const name of CHAIN_MEMBERS) {
    members[name] = (...args) => fromAsync(provider)[name](...args);
  }
  for (const symbol of CHAIN_SYMBOLS) {
    members[symbol] = () => fromAsync(provider)[symbol]();
  }
}

/**
 * The handle's members that take a query document, which take a chain as
 * well: the chain's document runs with its `params()` bindings as the
 * externals, exactly as `live()` hands them over (`chain.js`), and a chain
 * built over another collection or entity is `JL0005`. A document is
 * handed to the store untouched. `explain()` with nothing is the empty
 * chain's explanation, the chain's own. A refusal of the chain is
 * answered as the store answers a refusal of a document on that member:
 * thrown where the store's member is value-or-promise (`execute` and
 * `query`, which a synchronous driver answers synchronously), a rejected
 * promise elsewhere.
 * @param {any} provider - the store's handle (a collection or an entity set)
 * @param {Record<string | symbol, any>} members - the handle being built
 * @param {import('./source.js').SourceScope} sources - the store
 *   view's record of the sources its handles front
 * @param {'entity' | 'collection'} kind
 * @param {string} name
 * @param {readonly string[]} thrown - the members that throw a refusal
 */
function acceptChains(provider, members, sources, kind, name, thrown) {
  for (const method of ['execute', 'query', 'explain']) {
    const read = provider[method];
    if (read === undefined) continue;
    const onlyOwn = sources.handleOf(kind, name, method);
    members[method] = (source, options) => {
      if (method === 'explain' && source === undefined) return fromAsync(provider).explain();
      if (!isChain(source)) return read(source, options);
      let resolved;
      try { resolved = resolveSource(source, options, onlyOwn); }
      catch (error) {
        if (thrown.includes(method)) throw error;
        return Promise.reject(error);
      }
      return read(resolved.document, resolved.options);
    };
  }
}

/**
 * The handle over one entity set.
 * @param {any} store - the opened store
 * @param {string} name - the entity
 * @param {import('./source.js').SourceScope} sources - the store
 *   view's record of the sources its handles front
 * @returns {any}
 */
export function createEntityHandle(store, name, sources) {
  const set = store.entity(name);
  /** @type {Record<string | symbol, any>} */
  const members = { ...set };
  chainStart(set, members);
  acceptChains(set, members, sources, 'entity', name, ['execute']);
  members.include = (pick, spec) => new Graph(set, name).include(pick, spec);
  // the graph with nothing included: the root clauses, the keyset and
  // the page over the rows alone
  members.graph = () => new Graph(set, name);
  members.range = (spec, options) => createDbRangeProvider(store, name, spec, options);
  members.link = (own, member, target) => {
    requireMembership(set.relations, name, member, 'link');
    set.link(own, member, target);
  };
  members.unlink = (own, member, target) => {
    requireMembership(set.relations, name, member, 'unlink');
    set.unlink(own, member, target);
  };
  members.live = (source = fromAsync(set), options = undefined) =>
    registerLive(store.live, source, options, sources.handleOf('entity', name, 'live'));
  const handle = Object.freeze(members);
  sources.bind('entity', name, handle);
  return handle;
}

/**
 * The handle over one collection.
 * @param {any} store - the opened store
 * @param {string} name - the collection
 * @param {import('./source.js').SourceScope} sources - the store
 *   view's record of the sources its handles front
 * @returns {any}
 */
export function createCollectionHandle(store, name, sources) {
  const collection = store.collection(name);
  /** @type {Record<string | symbol, any>} */
  const members = { ...collection };
  chainStart(collection, members);
  acceptChains(collection, members, sources, 'collection', name, ['execute', 'query']);
  // `all` is two things on a collection handle, told apart by the
  // argument: a predicate is the chain's quantifier (does every document
  // satisfy it?); nothing, or all()'s options, is the collection's every
  // document — always an array, one entry per document
  const quantifier = members.all;
  members.all = (/** @type {any} */ arg, /** @type {any[]} */ ...rest) =>
    (typeof arg === 'function' ? quantifier(arg, ...rest) : collection.all(arg));
  members.live = (source = fromAsync(collection), options = undefined) =>
    registerLive(collection.live, source, options, sources.handleOf('collection', name, 'live'));
  const handle = Object.freeze(members);
  sources.bind('collection', name, handle);
  return handle;
}
