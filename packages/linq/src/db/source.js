//@ts-check
/**
 * @file Which collection or entity of the model a chain was built over.
 * A chain's document names rows of the source it was built from and
 * nothing else, so a handle that registers a chain's document registers
 * it over ITS rows: a chain over `users` handed to `orders.live()` would
 * be a query over the wrong collection. The client therefore records, for
 * the providers it fronts (the store's own set or collection, the handle
 * around it, and the synchronous twin the store offers), the kind and the
 * name they stand for, and a handle's `live()`, `execute()`, `query()` and
 * `explain()` compare the name a chain reports against its own.
 *
 * The comparison is by name within the model, never by object: a chain
 * over the same-named source of another client of the model, or from a
 * transaction's view, ran the right rows and still does. A chain with no
 * store source (over rows in memory) is a document builder, and a source
 * the client has not recorded (a view the host opened on the raw store,
 * another transaction's, a hand-written provider) is not another source it
 * can name; both are taken as they always were.
 *
 * The client's own handles are recorded when they are built, so a chain
 * from any client of the model is known; a transaction's are built per
 * transaction and recorded on the first lookup that finds a source
 * unknown, and the synchronous twins on the first lookup after that.
 */

import { LinqBuildError } from '../errors.js';

/**
 * @typedef {ReturnType<typeof createSourceScope>} SourceScope
 * @typedef {{ kind: 'entity' | 'collection', name: string }} SourceKey
 *   the kind of source and its name
 */

/** @type {WeakMap<object, SourceKey>} */
const KEYS = new WeakMap();

/** The steps that record a client's root view, by its root store: any
 * scope that meets a source unknown to it asks the root's too.
 * @type {WeakMap<object, (() => void)[]>} */
const ROOT_STEPS = new WeakMap();

/**
 * The recording of one store view's handles (the root store, or the one a
 * transaction callback received).
 * @param {any} view - the store view the handles are built over
 * @param {object} owner - the client's root store: every view of one
 *   client shares it
 * @returns {{
 *   bind: (kind: 'entity' | 'collection', name: string, handle: object) => void,
 *   record: () => void,
 *   handleOf: (kind: 'entity' | 'collection', name: string, method: string) => (source: object) => void }}
 */
export function createSourceScope(view, owner) {
  /** @type {{ kind: 'entity' | 'collection', name: string, handle: object }[]} */
  const named = [];
  let providersBound = false;
  let twinsBound = false;

  /** The handles and the store's own providers behind them. */
  const bindProviders = () => {
    if (providersBound) return;
    providersBound = true;
    for (const { kind, name, handle } of named) {
      const key = { kind, name };
      KEYS.set(handle, key);
      KEYS.set(view[kind](name), key);
    }
  };
  /** The synchronous twins, which only a synchronous connection has; they
   * are the last to be bound because a client that never meets a
   * synchronous chain never needs them. */
  const bindTwins = () => {
    if (twinsBound) return;
    twinsBound = true;
    const sync = view.sync;
    if (sync === undefined || sync === null) return;
    for (const { kind, name } of named) {
      if (typeof sync[kind] === 'function') KEYS.set(sync[kind](name), { kind, name });
    }
  };
  const steps = [bindProviders, bindTwins];
  if (view === owner) ROOT_STEPS.set(owner, steps);

  /** The key a source was recorded under: this scope's providers, then
   * its twins, then the root view's.
   * @param {object} source @returns {SourceKey | undefined} */
  const keyOf = (source) => {
    let key = KEYS.get(source);
    if (key !== undefined) return key;
    const root = view === owner ? [] : ROOT_STEPS.get(owner) ?? [];
    for (const step of [...steps, ...root]) {
      step();
      key = KEYS.get(source);
      if (key !== undefined) return key;
    }
    return undefined;
  };

  return {
    bind(kind, name, handle) {
      named.push({ kind, name, handle });
    },
    record: bindProviders,
    handleOf(kind, name, method) {
      return (source) => {
        const key = keyOf(source);
        // names are unique across kinds (two objects of one database cannot
        // share a table name), so the name settles which source it is
        if (key !== undefined && key.name !== name) {
          throw new LinqBuildError('JL0005',
            `${method}() on ${kind} '${name}' was handed a chain built over ${key.kind} '${key.name}' — `
            + 'a chain runs against the source it was built over; build it from this handle, '
            + 'or hand it to the handle it was built from');
        }
      };
    },
  };
}
