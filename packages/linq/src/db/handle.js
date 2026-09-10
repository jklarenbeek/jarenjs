//@ts-check
/**
 * @file The handles the client fronts the store with. An entity handle
 * is the store's entity set — every member of it, the provider members
 * included, so `fromAsync(handle)` still binds through its root and two
 * handles of one client still share a scope — plus the chain start
 * (every `AsyncSequence` operator and terminal, delegated to
 * `fromAsync(set)`: nothing is duplicated, every read is the chain and
 * pushes down), `include` (the graph builder that EMITS the store's
 * `load` spec), `link`/`unlink` (checked against the relation table
 * before the store records them) and `live`. A collection handle is the
 * collection with the same chain start and `live`. `explain()` without
 * a document explains the empty chain; with one it is the store's
 * explanation of that document.
 */

import { fromAsync, AsyncSequence } from '../async.js';
import { Graph } from './include.js';
import { requireMembership } from './membership.js';
import { registerLive } from './live.js';
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
  const explainDocument = provider.explain;
  members.explain = (document, options) => (document === undefined
    ? fromAsync(provider).explain()
    : explainDocument(document, options));
}

/**
 * The handle over one entity set.
 * @param {any} store - the opened store
 * @param {string} name - the entity
 * @returns {any}
 */
export function createEntityHandle(store, name) {
  const set = store.entity(name);
  /** @type {Record<string | symbol, any>} */
  const members = { ...set };
  chainStart(set, members);
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
    registerLive(store.live, source, options);
  return Object.freeze(members);
}

/**
 * The handle over one collection.
 * @param {any} store - the opened store
 * @param {string} name - the collection
 * @returns {any}
 */
export function createCollectionHandle(store, name) {
  const collection = store.collection(name);
  /** @type {Record<string | symbol, any>} */
  const members = { ...collection };
  chainStart(collection, members);
  members.live = (source = fromAsync(collection), options = undefined) =>
    registerLive(collection.live, source, options);
  return Object.freeze(members);
}
