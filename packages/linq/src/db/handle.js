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
 * the store's explanation of that document. A join handle is a many-to-many
 * join table's read-only query root, reached through the relation member
 * that names it (`memberships`), with the same chain start and document
 * members and `live`.
 */

import { STORE_SOURCE } from '@jarenjs/db';

import { fromAsync, AsyncSequence } from '../async.js';
import { Graph } from './include.js';
import { requireMembership } from './membership.js';
import { registerLive } from './live.js';
import { isChain, resolveSource } from './chain.js';
import { onlyOwnSource } from './source.js';
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
 * built over another collection or entity, the same-named one of another
 * store, or rows in memory, is `JL0005` (`source.js`). A document is
 * handed to the store untouched, and an `include()` graph as its load
 * specification, which the store refuses as one. `explain()` with nothing is the empty
 * chain's explanation, the chain's own. A refusal of the chain is
 * answered as the store answers a refusal of a document on that member:
 * thrown where the store's member is value-or-promise (`execute` and
 * `query`, which a synchronous driver answers synchronously), a rejected
 * promise elsewhere.
 * @param {any} provider - the store's handle (a collection or an entity set)
 * @param {Record<string | symbol, any>} members - the handle being built
 * @param {readonly string[]} thrown - the members that throw a refusal
 */
function acceptChains(provider, members, thrown) {
  for (const method of ['execute', 'query', 'explain']) {
    const read = provider[method];
    if (read === undefined) continue;
    const onlyOwn = onlyOwnSource(provider, method);
    members[method] = (source, options) => {
      if (method === 'explain' && source === undefined) return fromAsync(provider).explain();
      if (!isChain(source) && !(source instanceof Graph)) return read(source, options);
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
 * A handle's `live`: a chain over the handle's own source (the whole source
 * when none is given) or a document, registered through the store's live
 * registration as it stands at the call; a chain over another source is
 * `JL0005` (`source.js`).
 * @param {any} provider - the store's handle the chain is built over
 * @param {() => any} registration - the store member that registers it
 */
const liveOver = (provider, registration) => (source = fromAsync(provider), options = undefined) =>
  registerLive(registration(), source, options, onlyOwnSource(provider, 'live'));

/**
 * The read-only handle over one many-to-many join table, the query root
 * `$.<JoinTable>[*]` (MODEL-FORMAT §10.7): the chain start over its rows,
 * `execute` and `explain` taking a chain as well as a document, the item
 * `cursor` over a document, and `live`. A join row is its two key columns
 * (`<Entity>_key`), so the handle has no point read, no unit of work and
 * no relation table — a membership is still written through
 * `link`/`unlink`. Its provider is
 * the store's entity document surface under the join table's own root and
 * source, and it carries the entity sets' `scope`, so a chain over it and
 * a chain over an entity join in one document.
 * @param {any} store - the opened store (or a transaction's view of it)
 * @param {string} name - the join table
 * @param {string} entity - an entity the join table relates: its set lends
 *   the document members, which take any document over the store's roots
 * @returns {any}
 */
export function createJoinHandle(store, name, entity) {
  const set = store.entity(entity);
  const provider = Object.freeze({
    execute: set.execute,
    cursor: set.cursor,
    explain: set.explain,
    root: `$.${name}[*]`,
    [STORE_SOURCE]: Object.freeze({ kind: 'join table', name, store: set[STORE_SOURCE].store }),
    scope: set.scope,
  });
  /** @type {Record<string | symbol, any>} */
  const members = { ...provider };
  chainStart(provider, members);
  acceptChains(provider, members, ['execute']);
  members.live = liveOver(provider, () => store.live);
  return Object.freeze(members);
}

/**
 * The handle over one entity set.
 * @param {any} store - the opened store
 * @param {string} name - the entity
 * @param {Readonly<Record<string, any>>} memberships - the join handle of
 *   each many-to-many member, by member name
 * @returns {any}
 */
export function createEntityHandle(store, name, memberships) {
  const set = store.entity(name);
  /** @type {Record<string | symbol, any>} */
  const members = { ...set };
  chainStart(set, members);
  acceptChains(set, members, ['execute']);
  members.memberships = memberships;
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
  members.live = liveOver(set, () => store.live);
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
  acceptChains(collection, members, ['execute', 'query']);
  // `all` is two things on a collection handle, told apart by the
  // argument: a predicate is the chain's quantifier (does every document
  // satisfy it?); nothing, or all()'s options, is the collection's every
  // document — always an array, one entry per document
  const quantifier = members.all;
  members.all = (/** @type {any} */ arg, /** @type {any[]} */ ...rest) =>
    (typeof arg === 'function' ? quantifier(arg, ...rest) : collection.all(arg));
  members.live = liveOver(collection, () => collection.live);
  return Object.freeze(members);
}
