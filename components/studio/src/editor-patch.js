//@ts-check
/**
 * @file The `apply(patch, options)` the studio's document editors share:
 * an RFC 6902 patch applied to the document the editor reads, handed to
 * that editor's own `replace`, which owns the revision check, validation
 * and the dispatch.
 */

import { applyJSONPatch } from '@jarenjs/json/patch';

/**
 * Apply `patch` to the document `read()` returns and hand the result to
 * `replace(candidate, options)`. A patch that does not apply — or a read
 * or replace that throws — is answered as a refused receipt, never
 * thrown: the receipt is the contract an editor's callers branch on.
 * @template R
 * @param {() => { document: any }} read
 * @param {(candidate: any, options: any) => Promise<R>} replace
 * @param {Parameters<typeof applyJSONPatch>[1]} patch
 * @param {any} [options]
 * @returns {Promise<R | { ok: false, error: string, code: string | undefined }>}
 */
export function applyPatchThrough(read, replace, patch, options) {
  try {
    return replace(applyJSONPatch(read().document, patch), options);
  }
  catch (error) {
    const failure = /** @type {any} */ (error);
    return Promise.resolve({ ok: false, error: failure.message, code: failure.code });
  }
}
