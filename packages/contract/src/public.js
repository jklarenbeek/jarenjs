//@ts-check
/**
 * @file `publicProjection`: the browser-safe subset of a compiled contract
 * as a JSON document that is ITSELF a valid `$contract` 0.1 — what a
 * client needs and no more, what the revision hashes, and what every other
 * projection (OpenAPI, TypeScript, Markdown, tools) is built on.
 *
 * Retained: the operations whose `policy.audience` is not `server` (and,
 * when the caller narrows with `ops`, only those), each with its resolved
 * binding and policy minus the server-side knobs (`limits`,
 * `errors.details`), plus the `$defs` the retained schemas reach. Member
 * order is FIXED (docs/CONTRACT-FORMAT.md §12.1 — normative, because the
 * revision is the SHA-256 of the canonical bytes of this document): root
 * `$contract, id, version, compat, $defs, operations`; operation `kind,
 * input, output, errors, policy, http, doc`; policy `task, idempotency,
 * revision, cache, retry, audience`; http `method, path, in, body, status,
 * media`; error `status, schema`; operations in document order; `$defs` in
 * first-reference order. Defaults are materialized (the projection says
 * what the binding DOES, not what the author typed), so two documents
 * that behave alike project alike, and the projection of a projection is
 * the projection.
 */

import { isJsonObject, setObjectMember } from '@jarenjs/core/object';

import { ContractHostError } from './errors.js';
import { reachableDefs } from './bundle.js';

/**
 * @typedef {import('./compile.js').Contract} Contract
 * @typedef {import('./compile.js').CompiledOperation} CompiledOperation
 */

/**
 * @typedef {Object} PublicProjectionOptions
 * @property {readonly string[]} [ops] - the operations to keep, a subset
 *   of the contract's ids (default: all); `server` operations are never
 *   kept, listed or not
 */

/**
 * Whether `value` is a compiled contract — reads the members every
 * projection needs.
 * @param {unknown} value
 * @returns {value is Contract}
 */
export function isCompiledContract(value) {
  if (value === null || typeof value !== 'object') return false;
  const c = /** @type {any} */ (value);
  return isJsonObject(c.doc) && Array.isArray(c.ids) && c.operations !== null && typeof c.operations === 'object'
    && typeof c.match === 'function';
}

/**
 * The operations a projection retains, in document order: the public
 * ones, narrowed by `ops` when given. Throws `JC1008` for a malformed
 * `contract` or an `ops` entry that names no operation.
 * @param {Contract} contract
 * @param {readonly string[] | undefined} ops
 * @param {string} who - the projection's name, for the message
 * @returns {CompiledOperation[]}
 */
export function retainedOperations(contract, ops, who) {
  if (!isCompiledContract(contract)) {
    throw new ContractHostError('JC1008', `${who}: contract must be a compiled contract (compileContract(doc))`);
  }
  let wanted = null;
  if (ops !== undefined) {
    if (!Array.isArray(ops)) throw new ContractHostError('JC1008', `${who}: ops must be an array of operation ids`);
    wanted = new Set();
    for (let i = 0; i < ops.length; i++) {
      const id = ops[i];
      if (typeof id !== 'string' || !Object.hasOwn(contract.operations, id)) {
        throw new ContractHostError('JC1008', `${who}: ops[${i}] names no operation of the contract (${typeof id === 'string' ? id : typeof id})`);
      }
      wanted.add(id);
    }
  }
  const out = [];
  for (let i = 0; i < contract.ids.length; i++) {
    const op = contract.operations[contract.ids[i]];
    if (op.policy.audience === 'server') continue;
    if (wanted !== null && !wanted.has(op.id)) continue;
    out.push(op);
  }
  return out;
}

/**
 * The public policy of an operation: the client-facing members in the
 * fixed order, defaults materialized, the server-side knobs (`limits`,
 * `errors.details`) left out.
 * @param {CompiledOperation} op
 * @returns {Record<string, unknown>}
 */
function publicPolicy(op) {
  const p = op.policy;
  /** @type {Record<string, unknown>} */
  const policy = { task: p.task, idempotency: p.idempotency };
  if (p.revision !== null) policy.revision = p.revision;
  policy.cache = p.cache;
  if (p.retry !== null) policy.retry = { max: p.retry.max, on: p.retry.on.slice() };
  policy.audience = p.audience;
  return policy;
}

/**
 * The public binding of an operation: method, canonical path, every
 * member's location, the whole-body member when declared, status, media.
 * @param {CompiledOperation} op
 * @returns {Record<string, unknown>}
 */
function publicHttp(op) {
  const h = op.http;
  /** @type {Record<string, unknown>} */
  const http = { method: h.method, path: h.path };
  /** @type {Record<string, string>} */
  const locations = {};
  const members = Object.keys(h.in);
  for (let i = 0; i < members.length; i++) setObjectMember(locations, members[i], h.in[members[i]]);
  http.in = locations;
  if (h.body !== null) http.body = h.body;
  http.status = h.status;
  http.media = h.media;
  return http;
}

/**
 * Project one operation.
 * @param {CompiledOperation} op
 * @returns {Record<string, unknown>}
 */
function publicOperation(op) {
  /** @type {Record<string, unknown>} */
  const out = { kind: op.kind };
  if (op.input !== null) out.input = op.input.schema;
  out.output = op.output.schema;
  const codes = Object.keys(op.errors);
  if (codes.length > 0) {
    /** @type {Record<string, unknown>} */
    const errors = {};
    for (let i = 0; i < codes.length; i++) {
      const decl = op.errors[codes[i]];
      /** @type {Record<string, unknown>} */
      const e = { status: decl.status };
      if (decl.schema !== null) e.schema = decl.schema;
      setObjectMember(errors, codes[i], e);
    }
    out.errors = errors;
  }
  out.policy = publicPolicy(op);
  out.http = publicHttp(op);
  if (op.doc !== null) out.doc = op.doc;
  return out;
}

/**
 * The public projection of a compiled contract: a `$contract` 0.1
 * document (it compiles) holding the public operations with their
 * resolved bindings and policies and the `$defs` they reach, in the fixed
 * member order the revision hashes. Schema subtrees are the contract's own
 * (frozen); the composition is fresh.
 * @param {Contract} contract
 * @param {PublicProjectionOptions} [options]
 * @returns {Record<string, unknown>}
 * @throws {ContractHostError} `JC1008` — not a compiled contract, or `ops` names no operation
 * @example
 * const pub = publicProjection(contract);
 * compileContract(pub).ids; // the public operations, in document order
 */
export function publicProjection(contract, options = {}) {
  const ops = retainedOperations(contract, options.ops, 'publicProjection');
  /** @type {Record<string, unknown>} */
  const out = { $contract: '0.1' };
  if (contract.id !== null) out.id = contract.id;
  if (contract.version !== null) out.version = contract.version;
  if (contract.compat.length > 0) out.compat = contract.compat.slice();
  /** @type {unknown[]} */
  const roots = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.input !== null) roots.push(op.input.schema);
    roots.push(op.output.schema);
    const codes = Object.keys(op.errors);
    for (let j = 0; j < codes.length; j++) {
      if (op.errors[codes[j]].schema !== null) roots.push(op.errors[codes[j]].schema);
    }
  }
  const names = reachableDefs(roots, contract.doc);
  if (names.length > 0) {
    /** @type {Record<string, unknown>} */
    const defs = {};
    for (let i = 0; i < names.length; i++) setObjectMember(defs, names[i], contract.doc.$defs[names[i]]);
    out.$defs = defs;
  }
  /** @type {Record<string, unknown>} */
  const operations = {};
  for (let i = 0; i < ops.length; i++) setObjectMember(operations, ops[i].id, publicOperation(ops[i]));
  out.operations = operations;
  return out;
}
