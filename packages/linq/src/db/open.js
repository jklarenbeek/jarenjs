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
 * name, never by omission. The client is a frozen record of handles built ONCE at open
 * from the names the store declares — no Proxy anywhere: an unknown
 * name is `undefined`, and for a pen model a compile error.
 */

import { openStore } from '@jarenjs/db';
import { JarenValidator } from '@jarenjs/validate';
import { stringFormats, dateTimeFormats } from '@jarenjs/formats';
import { setObjectMember } from '@jarenjs/core/object';

import { createEntityHandle, createCollectionHandle } from './handle.js';
import { registerLive } from './live.js';

/**
 * The validator the client compiles entity and collection schemas with
 * when none is given: every issue collected, formats asserting.
 * @returns {JarenValidator}
 */
export function defaultValidator() {
  return new JarenValidator({ collectErrors: true })
    .addFormats(stringFormats)
    .addFormats(dateTimeFormats);
}

/**
 * Open a store and front it.
 * @param {any} model - a `$model` document: the model pen's, or JSON
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
  const store = await openStore(model, storeOptions);

  /**
   * The typed handles over ONE store view — the root store, or the one
   * a transaction callback received. Building them from the same two
   * constructors is what keeps a transaction's `entities.X` the same
   * surface, with the same inference, as the client's own.
   * @param {any} over
   */
  const handlesOf = (over) => {
    const entities = {};
    for (const name of over.roots ?? []) {
      setObjectMember(entities, name, createEntityHandle(over, name));
    }
    const collections = {};
    for (const name of Object.keys(model.collections ?? {})) {
      setObjectMember(collections, name, createCollectionHandle(over, name));
    }
    return { entities: Object.freeze(entities), collections: Object.freeze(collections) };
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
    /** @type {Record<string, any>} */
    const inner = {
      store: tx,
      capabilities: tx.capabilities,
      sql: tx.sql,
      jobs: tx.jobs,
      sync: tx.sync,
      ...handlesOf(tx),
      transaction: (fn) => tx.transaction((nested) => fn(transactionClient(nested))),
      // the named-savepoint group (MODEL-FORMAT §5.2), forwarded as it
      // is: partial rollback belongs to the transaction that owns the
      // connection, so the root client deliberately has no twin
      savepoints: tx.savepoints,
    };
    if (tx.saveChanges !== undefined) {
      inner.saveChanges = () => tx.saveChanges();
      inner.live = (source, liveOptions) => registerLive(tx.live, source, liveOptions);
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
      (tx) => fn(transactionClient(tx)),
      { unitOfWork: 'own', ...transactionOptions }),
    close: (closeOptions) => store.close(closeOptions),
  };
  // the unit of work and entity live queries exist exactly when the
  // model declares entities — as on the store
  if (store.saveChanges !== undefined) {
    client.saveChanges = () => store.saveChanges();
    client.live = (source, liveOptions) => registerLive(store.live, source, liveOptions);
  }
  return Object.freeze(client);
}
