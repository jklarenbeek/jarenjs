//@ts-check
/**
 * @file The contract revision: the lowercase hex SHA-256 over the RFC
 * 8785 canonical bytes of the public projection (docs/CONTRACT-FORMAT.md
 * §14) — the compatibility identity two independent processes agree on.
 * It hashes the PUBLIC projection, never the source document, so a
 * server-audience operation, a `policy.limits` value or an error-detail
 * level can change without moving the revision, while any member a
 * client can observe moves it. Memoized per compiled contract in a
 * private `WeakMap`, so `compileContract` stays synchronous and the
 * digest is computed at most once per process; `peekRevision` is the
 * synchronous read `describe()` uses (`null` until the promise settled).
 */

import { canonicalSha256 } from '@jarenjs/json/canonical';

import { ContractCompileError } from './errors.js';
import { publicProjection } from './public.js';

/**
 * @typedef {import('./compile.js').Contract} Contract
 */

/**
 * The memo: contract → `{ promise, value }`. `value` stays `null` until
 * the digest resolved; a rejected computation is NOT memoized, so a
 * transient host failure (`crypto.subtle` unavailable) can be retried,
 * while the deterministic refusal (`JC0061`) simply recurs.
 * @type {WeakMap<object, { promise: Promise<string>, value: string | null }>}
 */
const revisions = new WeakMap();

/**
 * Compute (once) the revision of a compiled contract: SHA-256 over the
 * canonical bytes of `publicProjection(contract)`, as 64 lowercase hex
 * characters. A projection that is not canonicalizable — a string member
 * carrying an unpaired surrogate, say — rejects with `JC0061`
 * (`ContractCompileError`, its `docPath` the offending value's pointer
 * INTO THE PROJECTION).
 * @param {Contract} contract
 * @returns {Promise<string>}
 * @example
 * const contract = compileContract(doc);
 * await contract.revision(); // 'e3b0c442…' — stable across compiles of equal documents
 */
export function contractRevision(contract) {
  const memo = revisions.get(contract);
  if (memo !== undefined) return memo.promise;
  /** @type {{ promise: Promise<string>, value: string | null }} */
  const record = { promise: /** @type {any} */ (null), value: null };
  record.promise = digest(contract, record);
  revisions.set(contract, record);
  return record.promise;
}

/**
 * @param {Contract} contract
 * @param {{ promise: Promise<string>, value: string | null }} record
 * @returns {Promise<string>}
 */
async function digest(contract, record) {
  let hex;
  try {
    hex = await canonicalSha256(publicProjection(contract));
  }
  catch (err) {
    revisions.delete(contract);
    if (err !== null && typeof err === 'object' && /** @type {any} */ (err).name === 'JsonCanonicalizeError') {
      throw new ContractCompileError('JC0061',
        `the public projection is not canonicalizable: ${/** @type {Error} */ (err).message}`,
        /** @type {any} */ (err).dataPath, /** @type {Error} */ (err));
    }
    throw err;
  }
  record.value = hex;
  return hex;
}

/**
 * The revision of a compiled contract if it has been computed, else
 * `null` — the synchronous read `describe()` renders, so a description
 * taken before anyone awaited `revision()` honestly says "not computed"
 * rather than blocking.
 * @param {Contract} contract
 * @returns {string | null}
 */
export function peekRevision(contract) {
  const memo = revisions.get(contract);
  return memo === undefined ? null : memo.value;
}
