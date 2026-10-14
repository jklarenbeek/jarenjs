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
 * adds to them, and `chain.js` reads a chain the same way for `execute`,
 * `query` and `explain`.
 */

import { resolveSource } from './chain.js';

/**
 * Register a live query through the store's own registration.
 * @param {(document: any, options: any) => Promise<any>} register - the
 *   store's `live` (entity roots) or a collection's
 * @param {any} source - a chain or a document
 * @param {any} [options] - LIVE-FORMAT §7 options; `externals` merge over
 *   the chain's bindings
 * @param {(built: { source: any, rows: any }) => void} [onlyOwn] - a
 *   handle's refusal of a chain built over another source than its own
 * @returns {Promise<any>} the store's live query
 */
export function registerLive(register, source, options = undefined, onlyOwn = undefined) {
  try {
    const resolved = resolveSource(source, options, onlyOwn);
    return register(resolved.document, resolved.options);
  }
  catch (error) {
    // the store answers its refusals by a rejected promise, so a chain's
    // own refusal (`JL0004`, `JL0005`) is answered the same way
    return Promise.reject(error);
  }
}
