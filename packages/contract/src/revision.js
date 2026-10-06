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
import { isPlainOptions } from '@jarenjs/core/object';

import { ContractCompileError, ContractHostError } from './errors.js';
import { hostProjection, publicProjection } from './public.js';

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

/** The host revisions' memo, apart from the public one: a separate identity. */
const hostRevisions = new WeakMap();

/**
 * Compute (once) the revision of a compiled contract: SHA-256 over the
 * canonical bytes of `publicProjection(contract)`, as 64 lowercase hex
 * characters. A projection that is not canonicalizable — a string member
 * carrying an unpaired surrogate, say — rejects with `JC0061`
 * (`ContractCompileError`, its `docPath` the offending value's pointer
 * INTO THE PROJECTION).
 *
 * `{ audience: 'all' }` asks for the HOST revision instead: the same
 * digest over `hostProjection(contract)`, every operation included, with
 * a memo of its own. It moves when a server-audience operation changes
 * and the public one does not; it is an internal gate's identity, never
 * served on the well-known path or in `meta.revision`.
 * @param {Contract} contract
 * @param {{ audience?: 'public' | 'all' }} [options] - a closed set (`JC1008`)
 * @returns {Promise<string>}
 * @example
 * const contract = compileContract(doc);
 * await contract.revision(); // 'e3b0c442…' — stable across compiles of equal documents
 * await contract.revision({ audience: 'all' }); // the host revision
 */
export function contractRevision(contract, options = undefined) {
  let all;
  try { all = revisionAudience(options) === 'all'; }
  catch (error) { return Promise.reject(error); }
  const memos = all ? hostRevisions : revisions;
  const memo = memos.get(contract);
  if (memo !== undefined) return memo.promise;
  /** @type {{ promise: Promise<string>, value: string | null }} */
  const record = { promise: /** @type {any} */ (null), value: null };
  record.promise = digest(contract, record, memos, all ? hostProjection : publicProjection, all ? 'host' : 'public');
  memos.set(contract, record);
  return record.promise;
}

/**
 * Which revision a caller asks for: the public one by default, or the
 * host revision under `{ audience: 'all' }` — a closed set (`JC1008`).
 * @param {unknown} options
 * @returns {'public' | 'all'}
 */
function revisionAudience(options) {
  if (options === undefined) return 'public';
  if (!isPlainOptions(options) || Object.keys(options).some((key) => key !== 'audience')) {
    throw new ContractHostError('JC1008', "revision: options is { audience?: 'public' | 'all' }");
  }
  const audience = /** @type {any} */ (options).audience;
  if (audience === undefined || audience === 'public') return 'public';
  if (audience === 'all') return 'all';
  throw new ContractHostError('JC1008', "revision: options.audience is 'public' or 'all'");
}

/**
 * @param {Contract} contract
 * @param {{ promise: Promise<string>, value: string | null }} record
 * @param {WeakMap<object, { promise: Promise<string>, value: string | null }>} memos
 * @param {(contract: Contract) => Record<string, unknown>} project
 * @param {'public' | 'host'} which - the projection's name, for the refusal
 * @returns {Promise<string>}
 */
async function digest(contract, record, memos, project, which) {
  let hex;
  try {
    hex = await canonicalSha256(project(contract));
  }
  catch (err) {
    memos.delete(contract);
    if (err !== null && typeof err === 'object' && /** @type {any} */ (err).name === 'JsonCanonicalizeError') {
      throw new ContractCompileError('JC0061',
        `the ${which} projection is not canonicalizable: ${/** @type {Error} */ (err).message}`,
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
