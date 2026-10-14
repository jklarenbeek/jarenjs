//@ts-check
/**
 * @file A chain handed to a handle's document-taking member. A chain is
 * its document and the values its `params()` bound, so `live()`,
 * `execute()`, `query()` and `explain()` read one the same way: the
 * document is what the store runs, the bindings are the externals,
 * `options.externals` merges over them, a parameter an `in()` reads whole
 * as its list must be an array in the merged set (`JL0004`: a placeholder
 * the options override is not checked, and an override is), and a handle
 * takes only a chain built over its own collection or entity (`JL0005`).
 * A chain split by a host callback has no document; its own refusal
 * (`JL0005`) names why.
 */

import { isPlainOptions } from '@jarenjs/core/object';

import { RUN_BINDINGS } from '../document.js';
import { requireListBindings } from '../expression.js';

/** Whether a source is a chain: a document and an explanation to give.
 * @param {any} source */
export const isChain = (source) => source !== null && typeof source === 'object'
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
  const document = source.toDocument();
  // a chain-like this package did not build gives its own explanation
  return { document, ...(source[RUN_BINDINGS]?.() ?? { bindings: source.explain().bindings, lists: [] }) };
}

/**
 * The document and the options a store member is handed for a chain or a
 * document: the chain's bindings under `options.externals`, checked for
 * the lists its `in()` calls read whole.
 * @param {any} source - a chain or a query document
 * @param {any} [options] - the member's options; `externals` merge over
 *   the chain's bindings
 * @param {(chainSource: object) => void} [onlyOwn] - a handle's refusal of
 *   a chain built over another collection or entity than its own
 * @returns {{ document: any, options: any }}
 */
export function resolveSource(source, options = {}, onlyOwn = undefined) {
  const { document, bindings, lists, source: builtOver } = documentOf(source);
  if (builtOver != null) onlyOwn?.(builtOver);
  // options the store would refuse reach it as they were given: merging
  // would read `null` options as a TypeError, spread a string into
  // members and an array into `0`, `1`, ... and so accept them
  if (!isPlainOptions(options) || !(options.externals == null || isPlainOptions(options.externals))) {
    return { document, options };
  }
  const externals = { ...bindings, ...options.externals };
  requireListBindings(lists, new Map(Object.entries(externals)));
  return { document, options: { ...options, externals } };
}
