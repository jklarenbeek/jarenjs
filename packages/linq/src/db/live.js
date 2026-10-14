//@ts-check
/**
 * @file `live(source, options)`: a chain's document and bound externals —
 * or a hand-written document — handed to the store's own registration
 * (`store.live` for an entity-root chain, `collection.live` for a
 * collection's), so the mode, the reason and the maintenance are the
 * store's (LIVE-FORMAT §7): a chain is maintained or re-run exactly as
 * its document would be, an `include()` chain — a load specification,
 * not a query document — is `JD0033`, and a store opened without capture
 * refuses (`JD0050`) as it does for a document. The chain's `params()`
 * bindings are the externals, fixed at registration; `options.externals`
 * adds to them.
 * The merged set is what the store runs, so it is the set a parameter an
 * `in()` reads whole as its list must be an array in (`JL0004`): a
 * placeholder the options override is not checked, and an override is.
 * A chain carries the source it was built over, and a handle registers
 * only a chain over its own (`JL0005`): the document names rows of that
 * source and nothing else, so another source's chain would be a query
 * over the wrong rows.
 */

import { isPlainOptions } from '@jarenjs/core/object';

import { RUN_BINDINGS } from '../document.js';
import { requireListBindings } from '../expression.js';

/** Whether a source is a chain: a document and an explanation to give. */
const isChain = (source) => source !== null && typeof source === 'object'
  && typeof source.toDocument === 'function' && typeof source.explain === 'function';

/**
 * The document a source stands for, the values it bound and the
 * parameters its `in()` calls read whole as lists — unchecked, because
 * what the store runs is decided only once the options are merged in.
 * @param {any} source - a chain (either surface) or a query document
 * @returns {{ document: any, bindings: Record<string, unknown>, lists: readonly string[],
 *   source?: object | null }} `source` is the provider the chain was
 *   built over (`null`: rows in memory), absent when the source
 *   is a document or a chain-like this package did not build
 */
function documentOf(source) {
  if (!isChain(source)) return { document: source, bindings: {}, lists: [] };
  // a chain split by a host callback has no document; its own refusal
  // (`JL0005`) names why
  const document = source.toDocument();
  // a chain-like this package did not build gives its own explanation
  return { document, ...(source[RUN_BINDINGS]?.() ?? { bindings: source.explain().bindings, lists: [] }) };
}

/**
 * Register a live query through the store's own registration.
 * @param {(document: any, options: any) => Promise<any>} register - the
 *   store's `live` (entity roots) or a collection's
 * @param {any} source - a chain or a document
 * @param {any} [options] - LIVE-FORMAT §7 options; `externals` merge over
 *   the chain's bindings
 * @param {(chainSource: object) => void} [onlyOwn] - a handle's refusal of
 *   a chain built over another collection or entity than its own
 * @returns {Promise<any>} the store's live query
 */
export function registerLive(register, source, options = {}, onlyOwn = undefined) {
  try {
    const { document, bindings, lists, source: builtOver } = documentOf(source);
    if (builtOver != null) onlyOwn?.(builtOver);
    // options the store would refuse reach it as they were given: merging
    // would read `null` options as a TypeError, spread a string into
    // members and an array into `0`, `1`, ... and so accept them
    if (!isPlainOptions(options) || !(options.externals == null || isPlainOptions(options.externals))) {
      return register(document, options);
    }
    const externals = { ...bindings, ...options.externals };
    requireListBindings(lists, new Map(Object.entries(externals)));
    return register(document, { ...options, externals });
  }
  catch (error) {
    // the store answers its refusals by a rejected promise, so a chain's
    // own refusal (`JL0004`, `JL0005`) is answered the same way
    return Promise.reject(error);
  }
}
