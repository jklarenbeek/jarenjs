//@ts-check
/**
 * @file `open(model, options)`: `openStore` with every option forwarded
 * verbatim, plus `validator` — a `JarenValidator` wired as the store's
 * `compileSchema`. The default validator reproduces the configuration
 * MIGRATING-FROM-ZOD's recipe uses (`collectErrors`, the string and
 * date-time formats registered), so `s.string().email()` asserts out
 * of the box; a host that already has a `compileSchema` passes it and
 * wins; `validator: null` opens the store unvalidated — the store's own
 * declared downgrade (`capabilities.validated === false`), chosen by
 * name, never by omission. The client is a frozen record of handles
 * keyed by the names the store declares — no Proxy anywhere: an unknown
 * name is `undefined`, and for a pen model a compile error. A handle is
 * built on its first read and is the same object on every later one, so
 * a host that keeps many stores open pays only for what it touches.
 */

import { openStore } from '@jarenjs/db';
import { JarenValidator } from '@jarenjs/validate';
import { stringFormats, dateTimeFormats } from '@jarenjs/formats';
import { isPlainOptions, setObjectMember } from '@jarenjs/core/object';

import { createEntityHandle, createCollectionHandle, createJoinHandle } from './handle.js';
import { registerLive } from './live.js';
import { onlyThisStore } from './source.js';

/**
 * A client transaction's options with the client's default unit of work:
 * `'own'` unless the caller NAMED one — an explicit `unitOfWork:
 * undefined` is no choice, so it keeps the default rather than silently
 * sharing the client's tracker (a spread let it override `'own'`). Any
 * other value is a choice and reaches the store as given: a `null` is the
 * store's to refuse (`JD0013`), exactly as `store.transaction` refuses it.
 * Options the store reads as plain — an object literal or a
 * null-prototype record (`isPlainOptions`, the store's own test) — get the
 * default; anything else passes through untouched, for the store to refuse
 * by its own closed set (`JD0013`).
 * @param {unknown} transactionOptions
 */
function ownByDefault(transactionOptions) {
  if (transactionOptions === undefined) return { unitOfWork: 'own' };
  if (!isPlainOptions(transactionOptions)) return transactionOptions;
  const { unitOfWork } = transactionOptions;
  return { ...transactionOptions, unitOfWork: unitOfWork === undefined ? 'own' : unitOfWork };
}

/** Where a handle record keeps the handles its members built. */
const HANDLES = Symbol('handles');
/** @type {Map<string, PropertyDescriptor>} */
const lazyMembers = new Map();
/**
 * The member of a handle record: a getter that builds the named handle on
 * its first read, through the record's own state. ONE getter per name for
 * the whole module, so every record over the same names — every client,
 * every transaction's — keeps one hidden class; a getter of its own per
 * record gave each record a hidden class of its own, which the old
 * generation kept, with its store behind it, until a full collection.
 * @param {string} name
 */
function lazyMember(name) {
  let member = lazyMembers.get(name);
  if (member === undefined) {
    member = Object.freeze({
      get() { return /** @type {any} */ (this)[HANDLES](name); }, enumerable: true, configurable: false });
    lazyMembers.set(name, member);
  }
  return member;
}

/**
 * The members of a record over `names`, in their order, built once per
 * client and given to each of its records.
 * @param {Iterable<string>} names
 * @returns {PropertyDescriptorMap}
 */
function lazyMembersOf(names) {
  /** @type {PropertyDescriptorMap} */
  const members = Object.create(null);
  for (const name of names) members[name] = lazyMember(name);
  return members;
}

/**
 * A frozen record whose members build their handle with `make` on the
 * first read and answer the same handle on every later one.
 * @param {PropertyDescriptorMap} members - from `lazyMembersOf`
 * @param {(name: string) => any} make
 */
function lazyRecord(members, make) {
  /** @type {Map<string, any>} */
  const built = new Map();
  const record = {};
  Object.defineProperty(record, HANDLES, {
    value: (/** @type {string} */ name) => {
      let handle = built.get(name);
      if (handle === undefined) {
        handle = make(name);
        built.set(name, handle);
      }
      return handle;
    },
  });
  Object.defineProperties(record, members);
  return Object.freeze(record);
}

/** Where a transaction's client keeps the store the callback received. */
const TRANSACTION = Symbol('transaction');
/**
 * A member of a transaction's client read through to the transaction's
 * store, which builds it on first use: one getter per member for the
 * whole module, as for the handle records.
 * @param {string} name
 * @returns {PropertyDescriptor}
 */
const readThrough = (name) => Object.freeze({
  get() { return /** @type {any} */ (this)[TRANSACTION][name]; }, enumerable: true, configurable: false });
const TRANSACTION_MEMBERS = Object.freeze({
  sql: readThrough('sql'), relational: readThrough('relational'), jobs: readThrough('jobs'), sync: readThrough('sync') });
const SAVEPOINTS_MEMBER = readThrough('savepoints');

/**
 * The validator the client compiles entity and collection schemas with
 * when none is given: every issue collected, formats asserting. A schema
 * it compiles answers `{ valid, errors }`, never a bare boolean.
 * @returns {JarenValidator<true>}
 */
export function defaultValidator() {
  return new JarenValidator({ collectErrors: true })
    .addFormats(stringFormats)
    .addFormats(dateTimeFormats);
}

/**
 * The collections a model declares, read once the store accepted it: a
 * model document declares `$model`; a prepared model (`prepareModel` from
 * `@jarenjs/db`) holds its document as `model`.
 * @param {any} model
 * @returns {Record<string, any> | undefined}
 */
function collectionsOf(model) {
  return (model.$model === undefined ? model.model : model).collections;
}

/**
 * Open a store and front it.
 * @param {any} model - a `$model` document (the model pen's, or JSON),
 *   or a model `prepareModel` from `@jarenjs/db` prepared once to open
 *   many stores from
 * @param {any} options - `openStore`'s options (`driver` required), plus
 *   `validator?` (a `JarenValidator`, wired as `compileSchema` unless an
 *   explicit `compileSchema` is given; `null` for an unvalidated store)
 * @returns {Promise<any>} the client
 */
export async function open(model, options) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('open needs { driver } from @jarenjs/db/node, /bun or /wasm');
  }
  const { validator, ...storeOptions } = options;
  if (validator !== undefined && validator !== null
    && (typeof validator !== 'object' || typeof validator.compile !== 'function')) {
    throw new TypeError('open: validator must be a JarenValidator (an object with compile(schema)), '
      + 'or null for an unvalidated store');
  }
  if (storeOptions.compileSchema === undefined && validator !== null) {
    const jaren = validator ?? defaultValidator();
    storeOptions.compileSchema = (schema) => jaren.compile(schema);
  }
  const compile = storeOptions.compileSchema;
  // A schema the compiler refuses is refused at open, though no handle
  // is built there: each entity's store handle is taken now (the store
  // compiles the entity's write schema with it), and each declared
  // collection schema is compiled now and handed to the store when the
  // collection is first used, rather than compiled a second time.
  /** @type {Map<unknown, unknown>} */
  const compiled = new Map();
  if (typeof compile === 'function') {
    storeOptions.compileSchema = (/** @type {unknown} */ schema) =>
      (compiled.has(schema) ? compiled.get(schema) : compile(schema));
  }
  const store = await openStore(model, storeOptions);
  if (typeof compile === 'function') {
    try {
      for (const name of store.roots ?? []) store.entity(name);
      for (const { schema } of Object.values(collectionsOf(model) ?? {})) {
        if (compiled.has(schema)) continue;
        const validate = compile(schema);
        // the store's own result contract, read where the store would
        if (validate !== null && typeof validate !== 'function')
          throw new TypeError('openStore: compileSchema must return a validation function');
        compiled.set(schema, validate);
      }
    }
    catch (error) {
      // the refusal is the answer: a close that fails too must not replace it
      try { await store.close(); }
      catch { /* the store's own failure to close is not this open's answer */ }
      throw error;
    }
  }

  // the names every record of this client has, in the store's order
  const entityMembers = lazyMembersOf(store.roots ?? []);
  const collectionMembers = lazyMembersOf(Object.keys(collectionsOf(model) ?? {}));

  /**
   * The typed handles over ONE store view — the root store, or the one
   * a transaction callback received. Building them from the same two
   * constructors is what keeps a transaction's `entities.X` the same
   * surface, with the same inference, as the client's own. Each handle
   * is built on its first read.
   * @param {any} over
   */
  const handlesOf = (over) => {
    // one join handle per join table: both inverse members of an edge
    // name the same root
    /** @type {Map<string, any>} */
    const joins = new Map();
    /** The join handle of each many-to-many member of `name`. @param {string} name */
    const membershipsOf = (name) => {
      /** @type {Record<string, any>} */
      const record = {};
      for (const [member, relation] of Object.entries(over.relations?.[name] ?? {})) {
        if (relation.kind !== 'manyToMany') continue;
        let join = joins.get(relation.joinTable);
        if (join === undefined) {
          join = createJoinHandle(over, relation.joinTable, name);
          joins.set(relation.joinTable, join);
        }
        setObjectMember(record, member, join);
      }
      return Object.freeze(record);
    };
    return {
      entities: lazyRecord(entityMembers, (name) => createEntityHandle(over, name, membershipsOf(name))),
      collections: lazyRecord(collectionMembers, (name) => createCollectionHandle(over, name)),
    };
  };

  /**
   * The client a transaction callback receives: the same shape as the
   * root client, over the store that is INSIDE the transaction. Its
   * handles run as the transaction's owner rather than waiting for a
   * commit they are part of, and its `transaction` nests.
   *
   * Built per transaction, because the handles bind to the store view —
   * and the whole point of a transaction's own unit of work is that two
   * handlers do not share one.
   * @param {any} tx - the store the callback received
   */
  const transactionClient = (tx) => {
    /** @type {Record<string | symbol, any>} */
    const inner = {
      store: tx,
      capabilities: tx.capabilities,
      // the attempt of a retried transaction this callback runs in (1-based)
      attempt: tx.attempt,
      // the isolation level the transaction runs at
      isolation: tx.isolation,
    };
    // `sql`, the store's relational engine as this transaction's owner,
    // `jobs` and `sync` are the transaction's own, read through on first
    // use as the transaction's store builds them
    Object.defineProperty(inner, TRANSACTION, { value: tx });
    Object.defineProperties(inner, TRANSACTION_MEMBERS);
    const { entities, collections } = handlesOf(tx);
    inner.entities = entities;
    inner.collections = collections;
    // the options reach the store, which reads a nested transaction's
    // closed set (refusing what a savepoint cannot honour) — dropping
    // them here would make a refused `unitOfWork` silently shared
    inner.transaction = (/** @type {any} */ fn, /** @type {any} */ transactionOptions) =>
      tx.transaction((/** @type {any} */ nested) => fn(transactionClient(nested)), transactionOptions);
    // the named-savepoint group (MODEL-FORMAT §5.2), read through as it
    // is: partial rollback belongs to the transaction that owns the
    // connection, so the root client deliberately has no twin
    Object.defineProperty(inner, 'savepoints', SAVEPOINTS_MEMBER);
    if (tx.saveChanges !== undefined) {
      inner.saveChanges = () => tx.saveChanges();
      const onlyThis = onlyThisStore(tx);
      inner.live = (source, liveOptions) => registerLive(tx.live, source, liveOptions, onlyThis);
    }
    return Object.freeze(inner);
  };

  /** @type {Record<string, any>} */
  const client = {
    store,
    capabilities: store.capabilities,
    ...handlesOf(store),
    // A transaction gets its own unit of work by default: two handlers
    // on one client then hold two records for the same entity key and
    // neither can see the other's pending state. `unitOfWork: 'shared'`
    // opts back into the store's, for a caller who staged changes
    // outside the transaction and means to save them inside it.
    transaction: (fn, transactionOptions) => store.transaction(
      (tx) => fn(transactionClient(tx)), ownByDefault(transactionOptions)),
    close: (closeOptions) => store.close(closeOptions),
  };
  // the unit of work and entity live queries exist exactly when the
  // model declares entities — as on the store
  if (store.saveChanges !== undefined) {
    client.saveChanges = () => store.saveChanges();
    const onlyThis = onlyThisStore(store);
    client.live = (source, liveOptions) => registerLive(store.live, source, liveOptions, onlyThis);
  }
  return Object.freeze(client);
}
