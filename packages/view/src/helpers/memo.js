//@ts-check
/**
 * @file The memo pair a visual component's `view()` projection is built
 * on: an LRU-memoized `compile(source)` and a reference-stable
 * `view(sourceOrDoc)` that accepts either a source string or an
 * already-parsed document. Reference stability is the point — an
 * unchanged input returns the identical vnode, so the patcher sees it
 * in O(1) (the O(change) contract).
 */

import { createBoundedCache } from '@jarenjs/core/cache';

/**
 * @typedef {object} ProjectionMemo
 * @property {(source: string) => any} compile memoized compile
 * @property {(sourceOrDoc: any) => any} view memoized vnode projection:
 *   a string compiles through the source memo; `null`/`undefined`
 *   project to `null`; any other value is treated as a parsed document
 *   and memoized by reference.
 */

/**
 * Create the memoized compile + view projection for a source-compiling
 * component. The source memo is a string-keyed LRU (Map re-insertion
 * order as recency); the document memo is a WeakMap keyed on the parsed
 * document's identity, so documents held in app state stay cached for
 * exactly as long as the state holds them.
 *
 * @param {object} spec
 * @param {(source: string) => any} spec.compile compile a source string
 * @param {(compiled: any) => any} spec.toVnode project a compiled result
 * @param {(doc: object) => any} spec.docToVnode project a parsed document
 * @param {number} [spec.memoLimit] LRU size of the source memo (default 32)
 * @returns {ProjectionMemo}
 */
export function createProjectionMemo({ compile, toVnode, docToVnode, memoLimit = 32 }) {
  /** Source-string memo (the shared bounded LRU, `@jarenjs/core/cache`). */
  const bySource = createBoundedCache(memoLimit);
  /** Parsed-document memo (reference-keyed). */
  /** @type {WeakMap<object, any>} */
  const byDoc = new WeakMap();

  /** @type {(source: string) => any} */
  const memoCompile = (source) => bySource.getOrCreate(source, compile);

  /** @type {(sourceOrDoc: any) => any} */
  const view = (sourceOrDoc) => {
    if (typeof sourceOrDoc === 'string') {
      return toVnode(memoCompile(sourceOrDoc));
    }
    if (sourceOrDoc === null || sourceOrDoc === undefined) return null;
    let vnode = byDoc.get(sourceOrDoc);
    if (vnode === undefined) {
      vnode = docToVnode(sourceOrDoc);
      byDoc.set(sourceOrDoc, vnode);
    }
    return vnode;
  };

  return { compile: memoCompile, view };
}
