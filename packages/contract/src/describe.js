//@ts-check
/**
 * @file `describe()`: a compiled contract as pure JSON — the resolved
 * binding and policy of every operation, with each defaulted value
 * marked in `inferred` so a projection can tell what the author
 * declared from what the compiler filled in. Stable member order, no
 * functions, no schemas (those stay on the compiled operations); this is
 * what a CLI prints and what a golden test compares. `revision` is read
 * synchronously from the memo (`peekRevision`), so it is `null` until
 * someone awaited `contract.revision()` — the well-known responder does
 * exactly that before it renders this document.
 */

import { peekRevision } from './revision.js';

/**
 * The description of one operation.
 * @typedef {Object} OperationDescription
 * @property {string} id
 * @property {'read' | 'command'} kind
 * @property {string} method
 * @property {string} path - the canonical `{name}` template
 * @property {number} status
 * @property {string} media
 * @property {boolean} opaque
 * @property {Readonly<Record<string, string>>} in - member → location
 * @property {string | null} body - the whole-body member, or null
 * @property {string} task
 * @property {string} idempotency
 * @property {string} cache
 * @property {{ http: boolean, status: boolean, media: boolean, in: readonly string[], task: boolean, idempotency: boolean, cache: boolean }} inferred
 *   which of the above the compiler defaulted: `http` when the whole
 *   binding is the canonical `POST /<id>`, `in` listing the members whose
 *   location was not declared
 */

/**
 * The description of a contract.
 * @typedef {Object} ContractDescription
 * @property {'0.1'} $contract
 * @property {string | null} id
 * @property {string | null} version
 * @property {readonly string[]} compat
 * @property {string | null} revision - the contract revision (64 lowercase
 *   hex; docs/CONTRACT-FORMAT.md §14) when `contract.revision()` has
 *   settled, `null` before — `describe()` stays synchronous and never
 *   computes it
 * @property {OperationDescription[]} operations - document order
 */

/**
 * Describe a compiled contract. Reads the compiled operations for the
 * resolved values and the frozen source document for what was declared.
 * @param {import('./compile.js').Contract} contract
 * @returns {ContractDescription}
 */
export function describeContract(contract) {
  const operations = [];
  for (let i = 0; i < contract.ids.length; i++) {
    const id = contract.ids[i];
    const op = contract.operations[id];
    const declared = contract.doc.operations[id];
    const http = declared.http;
    const policy = declared.policy;
    const declaredIn = http !== undefined && http.in !== undefined ? http.in : {};
    const inferredIn = [];
    const members = Object.keys(op.http.in);
    for (let j = 0; j < members.length; j++) {
      const m = members[j];
      const isVariable = op.http.variables.includes(m);
      const isBody = op.http.body === m;
      if (http === undefined || (!isVariable && !isBody && declaredIn[m] === undefined)) inferredIn.push(m);
    }
    operations.push({
      id,
      kind: op.kind,
      method: op.http.method,
      path: op.http.path,
      status: op.http.status,
      media: op.http.media,
      opaque: op.http.opaque,
      in: { ...op.http.in },
      body: op.http.body,
      task: op.policy.task,
      idempotency: op.policy.idempotency,
      cache: op.policy.cache,
      inferred: {
        http: http === undefined,
        status: http === undefined || http.status === undefined,
        media: http === undefined || http.media === undefined,
        in: inferredIn,
        task: policy === undefined || policy.task === undefined,
        idempotency: policy === undefined || policy.idempotency === undefined,
        cache: policy === undefined || policy.cache === undefined,
      },
    });
  }
  return {
    $contract: '0.1',
    id: contract.id,
    version: contract.version,
    compat: contract.compat.slice(),
    revision: peekRevision(contract),
    operations,
  };
}
