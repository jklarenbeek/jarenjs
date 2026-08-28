//@ts-check
/**
 * @file `live(source, options)`: a chain's document and bound externals —
 * or a hand-written document — handed to the store's own registration
 * (`store.live` for an entity-root chain, `collection.live` for a
 * collection's), so the mode, the reason and the maintenance are the
 * store's (LIVE-FORMAT §7): an entity document re-runs on invalidation,
 * declared, and a store opened without capture refuses (`JD0050`)
 * exactly as it does for a document. The chain's `params()` bindings are
 * the externals, fixed at registration; `options.externals` adds to them.
 */

/** Whether a source is a chain: a document and an explanation to give. */
const isChain = (source) => source !== null && typeof source === 'object'
  && typeof source.toDocument === 'function' && typeof source.explain === 'function';

/**
 * The document a source stands for, with the values it bound.
 * @param {any} source - a chain (either surface) or a query document
 * @returns {{ document: any, bindings: Record<string, unknown> }}
 */
function documentOf(source) {
  if (!isChain(source)) return { document: source, bindings: {} };
  const explained = source.explain();
  // a chain split by a host callback has no document; its own refusal
  // (`JL0005`) names why
  if (explained.document === undefined) source.toDocument();
  return { document: explained.document, bindings: explained.bindings };
}

/**
 * Register a live query through the store's own registration.
 * @param {(document: any, options: any) => Promise<any>} register - the
 *   store's `live` (entity roots) or a collection's
 * @param {any} source - a chain or a document
 * @param {any} [options] - LIVE-FORMAT §7 options; `externals` merge over
 *   the chain's bindings
 * @returns {Promise<any>} the store's live query
 */
export function registerLive(register, source, options = {}) {
  const { document, bindings } = documentOf(source);
  return register(document, { ...options, externals: { ...bindings, ...(options.externals ?? {}) } });
}
