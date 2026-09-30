//@ts-check
/**
 * @file `lintContract`: authoring checks a contract compiles through but a
 * request would meet in production (docs/CONTRACT-FORMAT.md §13.1). The
 * compiler is total — a document either compiles or throws — so a
 * warning needs a pure function of its own. Each finding carries a stable
 * rule id, the operation, the `docPath` to the member at fault and a
 * message naming the fix; `jaren-contract lint --fail-on <rule,…>` gates
 * on them in CI.
 *
 * The rules:
 * - `read-query-on-body-method` — a read bound to POST, PUT or PATCH whose
 *   members default to the query string: the client sends them there and a
 *   hand-written JSON body is ignored.
 * - `body-limit-unsatisfiable` — the smallest body the required members
 *   can encode to already exceeds `policy.limits.maxBodyBytes`, so every
 *   valid request is refused `JC2003`. The size is a LOWER bound.
 * - `retry-on-undeclared` — a `policy.retry.on` entry that is neither a
 *   code the operation declares nor a `JC` code a binding raises, so the
 *   retry it asks for can never happen.
 */

import { isJsonObject } from '@jarenjs/core/object';

import { compileContract } from './compile.js';
import { CONTRACT_CODES, ContractHostError } from './errors.js';
import { isCompiledContract } from './public.js';

/**
 * @typedef {import('./compile.js').Contract} Contract
 * @typedef {import('./compile.js').CompiledOperation} CompiledOperation
 */

/**
 * One finding.
 * @typedef {Object} LintFinding
 * @property {'read-query-on-body-method' | 'body-limit-unsatisfiable' | 'retry-on-undeclared'} rule
 * @property {string} op - the operation id
 * @property {string} docPath - the member at fault, a pointer into the document
 * @property {string} message - what happens, and the fix
 */

/** The rule ids, in the order a report lists them. */
export const LINT_RULES = Object.freeze(['read-query-on-body-method', 'body-limit-unsatisfiable', 'retry-on-undeclared']);

/** Methods that carry a request body. */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** @param {string} s */
const token = (s) => s.replaceAll('~', '~0').replaceAll('/', '~1');

/**
 * Check a compiled contract (or a document, compiled first).
 * @param {Contract | Record<string, unknown>} contract
 * @returns {LintFinding[]} in document order, the rules in `LINT_RULES` order per operation
 * @throws {ContractHostError} `JC1008` — neither a compiled contract nor a document object; a
 *   document that does not compile refuses with its own `JC00xx`
 * @example
 * lintContract(contract).map((f) => `${f.rule} ${f.op}: ${f.message}`);
 */
export function lintContract(contract) {
  if (!isCompiledContract(contract)) {
    if (!isJsonObject(contract)) {
      throw new ContractHostError('JC1008', 'lintContract: contract must be a compiled contract or a $contract document');
    }
    contract = compileContract(contract);
  }
  /** @type {LintFinding[]} */
  const findings = [];
  for (let i = 0; i < contract.ids.length; i++) {
    const op = contract.operations[contract.ids[i]];
    const declared = contract.doc.operations[op.id];
    const base = `/operations/${token(op.id)}`;
    readQueryOnBodyMethod(op, declared, base, findings);
    bodyLimitUnsatisfiable(op, contract, base, findings);
    retryOnUndeclared(op, base, findings);
  }
  return findings;
}

/**
 * @param {CompiledOperation} op
 * @param {any} declared
 * @param {string} base
 * @param {LintFinding[]} findings
 */
function readQueryOnBodyMethod(op, declared, base, findings) {
  if (op.kind !== 'read' || !BODY_METHODS.has(op.http.method)) return;
  // a declared whole-body member makes the body layout the author's
  // choice, and an opaque read has no JSON body to write members into
  if (op.http.body !== null || op.http.opaque) return;
  const declaredIn = isJsonObject(declared?.http?.in) ? declared.http.in : {};
  const defaulted = Object.keys(op.http.in).filter((m) =>
    op.http.in[m] === 'query' && !Object.hasOwn(declaredIn, m));
  if (defaulted.length === 0) return;
  findings.push({
    rule: 'read-query-on-body-method',
    op: op.id,
    docPath: `${base}/http/method`,
    message: `read '${op.id}' is bound to ${op.http.method}, and its members (${defaulted.map((m) => `'${m}'`).join(', ')}) `
      + 'default to the query string — the client sends them there, and a JSON body written by hand is ignored. '
      + 'Bind the read to GET, or declare the members\' location (http.in) or a whole-body member (http.body)',
  });
}

/**
 * @param {CompiledOperation} op
 * @param {Contract} contract
 * @param {string} base
 * @param {LintFinding[]} findings
 */
function bodyLimitUnsatisfiable(op, contract, base, findings) {
  if (op.input === null || op.http.opaque) return;
  const members = Object.keys(op.http.in).filter((m) => op.http.in[m] === 'body');
  if (members.length === 0 && op.http.body === null) return;
  const effective = op.input.effective;
  const required = new Set(Array.isArray(effective.required) ? effective.required : []);
  const properties = isJsonObject(effective.properties) ? effective.properties : {};
  const scope = { doc: contract.doc, seen: new Set() };
  let least;
  // an optional body member left out sends no body at all
  if (op.http.body !== null) least = required.has(op.http.body) ? minimumBytes(properties[op.http.body], scope, 0) : 0;
  else {
    const kept = members.filter((m) => required.has(m));
    least = 2 + Math.max(0, kept.length - 1);
    for (const m of kept) least += utf8Bytes(JSON.stringify(m)) + 1 + minimumBytes(properties[m], scope, 0);
  }
  const limit = op.policy.limits.maxBodyBytes;
  if (least <= limit) return;
  findings.push({
    rule: 'body-limit-unsatisfiable',
    op: op.id,
    docPath: `${base}/policy/limits/maxBodyBytes`,
    message: `the required body of '${op.id}' encodes to at least ${least} bytes, over policy.limits.maxBodyBytes ${limit} — every `
      + 'valid request is refused JC2003. The size is a lower bound: maxLength counts code points and JSON escaping only adds. '
      + 'Raise the limit, or relax the bounds',
  });
}

/**
 * The fewest bytes a value valid under `schema` can encode to — a lower
 * bound that never overstates: an unknown shape counts one byte.
 * @param {unknown} schema
 * @param {{ doc: any, seen: Set<unknown> }} scope
 * @param {number} depth
 * @returns {number}
 */
function minimumBytes(schema, scope, depth) {
  if (depth > 32 || !isJsonObject(schema)) return 1;
  if (typeof schema.$ref === 'string') {
    if (!schema.$ref.startsWith('#/$defs/') || scope.seen.has(schema.$ref)) return 1;
    const target = scope.doc.$defs?.[decodeURIComponent(schema.$ref.slice('#/$defs/'.length))];
    scope.seen.add(schema.$ref);
    const n = minimumBytes(target, scope, depth + 1);
    scope.seen.delete(schema.$ref);
    return n;
  }
  if (Object.hasOwn(schema, 'const')) return utf8Bytes(JSON.stringify(schema.const) ?? 'null');
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return Math.min(...schema.enum.map((v) => utf8Bytes(JSON.stringify(v) ?? 'null')));
  }
  const types = typeof schema.type === 'string' ? [schema.type] : Array.isArray(schema.type) ? schema.type : null;
  if (types === null || types.length === 0) return 1;
  return Math.min(...types.map((t) => minimumOfType(t, schema, scope, depth)));
}

/**
 * @param {unknown} type
 * @param {Record<string, any>} schema
 * @param {{ doc: any, seen: Set<unknown> }} scope
 * @param {number} depth
 * @returns {number}
 */
function minimumOfType(type, schema, scope, depth) {
  switch (type) {
    case 'string': return 2 + (Number.isInteger(schema.minLength) && schema.minLength > 0 ? schema.minLength : 0);
    case 'null': case 'boolean': return 4;
    case 'number': case 'integer': return 1;
    case 'array': {
      const n = Number.isInteger(schema.minItems) && schema.minItems > 0 ? schema.minItems : 0;
      return n === 0 ? 2 : 2 + (n - 1) + n * minimumBytes(schema.items, scope, depth + 1);
    }
    case 'object': {
      const required = Array.isArray(schema.required)
        ? [...new Set(schema.required.filter((/** @type {unknown} */ r) => typeof r === 'string'))] : [];
      const properties = isJsonObject(schema.properties) ? schema.properties : {};
      let n = 2 + Math.max(0, required.length - 1);
      for (const m of required) n += utf8Bytes(JSON.stringify(m)) + 1 + minimumBytes(properties[m], scope, depth + 1);
      return n;
    }
    default: return 1;
  }
}

/** @param {string} text */
function utf8Bytes(text) {
  return new TextEncoder().encode(text).length;
}

/**
 * @param {CompiledOperation} op
 * @param {string} base
 * @param {LintFinding[]} findings
 */
function retryOnUndeclared(op, base, findings) {
  if (op.policy.retry === null) return;
  const on = op.policy.retry.on;
  for (let i = 0; i < on.length; i++) {
    const code = on[i];
    if (Object.hasOwn(op.errors, code) || retriedCode(code)) continue;
    findings.push({
      rule: 'retry-on-undeclared',
      op: op.id,
      docPath: `${base}/policy/retry/on/${i}`,
      message: `policy.retry.on names '${code}', which '${op.id}' does not declare and the client never retries — the retry it `
        + 'asks for can never happen. Name a declared error code, or a JC20xx wire code (JC2009 is an in-progress claim); '
        + 'a network loss (JC2051) is retried under any declared retry',
    });
  }
}

/**
 * Whether the client retries an outcome with this JC code: the HTTP wire
 * taxonomy (`JC2001`–`JC2049`), which arrives as a `failure` outcome, and
 * the network loss `JC2051`, retried under any declared `policy.retry`.
 * A compile or host code, or a client-side contract code (`JC2053`), never
 * arrives as a retryable outcome.
 * @param {string} code
 */
function retriedCode(code) {
  return Object.hasOwn(CONTRACT_CODES, code) && (/^JC20[0-4]\d$/.test(code) || code === 'JC2051');
}
