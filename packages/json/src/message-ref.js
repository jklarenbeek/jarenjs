//@ts-check
/**
 * @file Message references and their rendering, apart from any one
 * catalog: a message id and its params, and the renderer that resolves the
 * references among the params before the template. The query engine's
 * catalog (`query/messages.js`) and the formula catalog both render through
 * it — the formula's without carrying the query engine's English, which a
 * formula author never needs.
 */

import { compileMessageCatalog } from '@jarenjs/core/message';
import { isJsonObject } from '@jarenjs/core/object';

/**
 * A message reference: a message id and its params, rendered by the
 * catalog that renders the message holding it.
 * @param {string} messageId
 * @param {Record<string, any>} [params]
 * @returns {{ messageId: string, params: Record<string, any> }}
 */
export function messageRef(messageId, params = {}) {
  return Object.freeze({ messageId, params: Object.freeze(params) });
}

/** @param {any} value @returns {value is { messageId: string, params: Record<string, any> }} */
const isMessageRef = (value) => isJsonObject(value) && typeof value.messageId === 'string'
  && Object.keys(value).length === 2 && isJsonObject(value.params);

/** Compiled catalogs, by the object they were compiled from (a compiled one passes as it is). */
const compiledPacks = new WeakMap();

/** @param {Record<string, any>} catalog @returns {Readonly<Record<string, (params: object) => string>>} */
function compiled(catalog) {
  let out = compiledPacks.get(catalog);
  if (out === undefined) compiledPacks.set(catalog, out = compileMessageCatalog(catalog));
  return out;
}

/**
 * Render a message id and its params through `catalog`: the message
 * references among the params first, then the template. An id the catalog
 * lacks renders through `fallback` — another catalog, or a function that
 * answers a rendering or `undefined` — and an id neither knows renders its
 * `reason` param, or the id itself.
 * @param {string} messageId
 * @param {Record<string, any>} params
 * @param {Record<string, any>} catalog - a plain catalog (a locale pack) or a compiled one
 * @param {Record<string, any> | ((messageId: string, params: Record<string, any>) => string | undefined)} [fallback]
 * @returns {string}
 */
export function renderMessageId(messageId, params, catalog, fallback = undefined) {
  const target = compiled(catalog);
  /** @type {Record<string, any>} */
  const resolved = {};
  for (const name of Object.keys(params ?? {})) {
    const value = params[name];
    resolved[name] = isMessageRef(value) ? renderMessageId(value.messageId, value.params, catalog, fallback) : value;
  }
  if (Object.hasOwn(target, messageId)) return target[messageId](resolved);
  const other = typeof fallback === 'function' ? fallback(messageId, resolved)
    : fallback !== undefined && Object.hasOwn(compiled(fallback), messageId) ? compiled(fallback)[messageId](resolved) : undefined;
  return other ?? String(resolved.reason ?? messageId);
}
