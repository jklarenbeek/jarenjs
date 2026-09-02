//@ts-check
/**
 * @file The transport-neutral core of every server-side binding: validate
 * the assembled input, call the handler through ONE uniform promise
 * boundary — a synchronous throw, a non-promise return and a rejection
 * settle exactly alike — classify the settlement (a declared operation
 * failure, with its details validated against the declaration's schema,
 * or a host fault), and validate the output. The HTTP binding wraps the
 * result in statuses, headers and bodies; the `local` and `port`
 * bindings wrap it in D6 outcomes and frames — the classification is
 * decided here once so the three can never disagree.
 *
 * Total for everything a handler can do: a hostile value whose `then`
 * accessor throws is a rejection at the boundary (`JC2008`-class), a
 * value whose other members throw survives it and dies in output
 * validation (`JC2010`-class); nothing here throws for a settlement and
 * nothing renders a message — the binding renders at its edge.
 */

import { isJsonValue } from '@jarenjs/core/object';

import { ContractRuntimeError, isContractFailure } from './errors.js';
import { HTTP_ERRORS, verdict, projectValidationDetails } from './http/wire.js';

/**
 * @typedef {import('./compile.js').CompiledOperation} CompiledOperation
 * @typedef {import('./compile.js').CompiledErrorDecl} CompiledErrorDecl
 */

/**
 * The neutral subset of a binding's prepared route — what the pipeline
 * reads per operation. The HTTP binding's `Route` carries these members
 * verbatim; the `local` and `port` bindings prepare exactly this.
 * @typedef {Object} PipelineRoute
 * @property {CompiledOperation} op
 * @property {((input: any, ctx: any) => unknown) | null} handler
 * @property {boolean} raw - opaque: the value is the binding's to check, never the output validator's
 * @property {((value: unknown) => any) | null} validateInput
 * @property {(value: unknown) => any} validateOutput
 * @property {'none' | 'paths' | 'full'} details
 * @property {Readonly<Record<string, CompiledErrorDecl>>} errors
 * @property {ReadonlySet<string>} retryOn
 */

/**
 * The classified settlement of one operation:
 *
 *  - `value` — the handler's output, validated;
 *  - `failure` — a declared operation error (`errors[code]`), its
 *    `details` validated, `retryable` from the failure or the retry
 *    policy, `status` the declaration's (a status-less binding ignores
 *    it);
 *  - `contract` — the host broke the contract: `JC2006` the input fails
 *    its validator (`details` by `policy.errors.details`), `JC2008` the
 *    handler threw a non-declared error, rejected or answered an
 *    undeclared code, `JC2010` the output or a declared error's details
 *    fail their schema. `cause` is for the binding's `onError` observer
 *    (`undefined` when there is nothing to report); it never crosses a
 *    wire.
 *
 * @typedef {{ kind: 'value', value: unknown }
 *   | { kind: 'failure', code: string, params: Readonly<Record<string, unknown>>, details: unknown, retryable: boolean, status: number }
 *   | { kind: 'contract', code: 'JC2006' | 'JC2008' | 'JC2010', details: unknown, cause: unknown }} OperationResult
 */

/**
 * The request-time codes of the `local` and `port` bindings —
 * code → `{ msgid, retryable }`, the same table-as-data shape as
 * `HTTP_ERRORS` and `CLIENT_ERRORS`. The normative table is
 * docs/CONTRACT-FORMAT.md §15–§16; a test holds them equal.
 */
export const PORT_LOCAL_ERRORS = Object.freeze({
  JC2070: Object.freeze({ msgid: 'contract/local-handler-failed', retryable: false }),
  JC2071: Object.freeze({ msgid: 'contract/unknown-operation', retryable: false }),
  JC2072: Object.freeze({ msgid: 'contract/port-timeout', retryable: true }),
  JC2073: Object.freeze({ msgid: 'contract/malformed-frame', retryable: false }),
  JC2074: Object.freeze({ msgid: 'contract/channel-closed', retryable: false }),
});

/**
 * @param {'JC2006' | 'JC2008' | 'JC2010'} code
 * @param {unknown} details
 * @param {unknown} cause
 * @returns {OperationResult}
 */
function contractResult(code, details, cause) {
  return { kind: 'contract', code, details, cause };
}

/**
 * A server trace id from a host generator. TOTAL: a generator that
 * throws or answers a non-string is replaced by the platform's UUID —
 * the one last-resort platform read in this package, reached only when
 * the injected generator (a `trace` option or the runtime record's
 * `uuid`) has itself failed, so a request still carries a trace; a run
 * whose generator fails was not the deterministic run the record
 * configures, and the fallback says nothing about it.
 * @param {() => string} trace
 * @returns {string}
 */
export function safeTrace(trace) {
  try {
    const t = trace();
    if (typeof t === 'string' && t.length > 0) return t;
  }
  catch {
    // fall through
  }
  return globalThis.crypto.randomUUID();
}

/**
 * Validate the assembled input against the operation's input validator.
 * `null` when valid (or the operation validates nothing); a `JC2006`
 * contract result otherwise, its `details` projected by
 * `policy.errors.details` and its `cause` the validator's own throw when
 * it had one.
 * @param {PipelineRoute} route
 * @param {unknown} input
 * @returns {OperationResult | null}
 */
export function validateOperationInput(route, input) {
  if (route.validateInput === null) return null;
  const v = verdict(route.validateInput, input);
  if (v.valid) return null;
  return contractResult('JC2006', projectValidationDetails(route.details, v.errors), v.thrown);
}

/**
 * A declared operation failure: the code must be declared (`JC2008`-class
 * otherwise — the handler broke its own contract), the details must pass
 * the declaration's schema, or be a JSON value when it declares none
 * (`JC2010`-class otherwise), and `retryable` is the failure's own or
 * whether `policy.retry.on` names the code.
 * @param {PipelineRoute} route
 * @param {string} code
 * @param {Readonly<Record<string, unknown>>} params
 * @param {unknown} details
 * @param {boolean | null} retryable
 * @returns {OperationResult}
 */
function declaredResult(route, code, params, details, retryable) {
  const decl = typeof code === 'string' && Object.hasOwn(route.errors, code) ? route.errors[code] : undefined;
  if (decl === undefined) {
    return contractResult('JC2008', undefined, new ContractRuntimeError('JC2008',
      `the handler of operation '${route.op.id}' answered the undeclared error code ${JSON.stringify(code)}`,
      { msgid: HTTP_ERRORS.JC2008.msgid, params: { op: route.op.id }, status: 500 }));
  }
  if (decl.validate !== null) {
    const v = verdict(decl.validate, details);
    if (!v.valid) {
      return contractResult('JC2010', undefined, v.thrown !== undefined ? v.thrown : new ContractRuntimeError('JC2010',
        `the details of declared error '${code}' of operation '${route.op.id}' fail its schema`,
        { msgid: HTTP_ERRORS.JC2010.msgid, params: { op: route.op.id }, status: 500, cause: v.errors }));
    }
  }
  else if (details !== undefined && !isJsonValue(details)) {
    return contractResult('JC2010', undefined, new ContractRuntimeError('JC2010',
      `the details of declared error '${code}' of operation '${route.op.id}' are not a JSON value`,
      { msgid: HTTP_ERRORS.JC2010.msgid, params: { op: route.op.id }, status: 500 }));
  }
  return {
    kind: 'failure', code, params, details,
    retryable: retryable !== null ? retryable : route.retryOn.has(code),
    status: decl.status,
  };
}

/**
 * Classify the handler's resolved value: a `ContractFailure` is a
 * declared failure; anything else is the output, validated unless the
 * route is raw or validation is off.
 * @param {PipelineRoute} route
 * @param {unknown} value
 * @param {boolean} validateOutput
 * @returns {OperationResult}
 */
function settleValue(route, value, validateOutput) {
  if (isContractFailure(value)) return declaredResult(route, value.code, value.params, value.details, value.retryable);
  if (!route.raw && validateOutput) {
    const v = verdict(route.validateOutput, value);
    if (!v.valid) {
      return contractResult('JC2010', undefined, v.thrown !== undefined ? v.thrown : new ContractRuntimeError('JC2010',
        `the value of operation '${route.op.id}' fails its output schema`,
        { msgid: HTTP_ERRORS.JC2010.msgid, params: { op: route.op.id }, status: 500, cause: v.errors }));
    }
  }
  return { kind: 'value', value };
}

/**
 * Classify a rejection or throw: a `ContractRuntimeError` whose code the
 * operation declares is a declared failure; anything else — including a
 * hostile value whose prototype walk throws — is a `JC2008` contract
 * result carrying the rejection as `cause`, never onto a wire.
 * @param {PipelineRoute} route
 * @param {unknown} err
 * @returns {OperationResult}
 */
function settleThrown(route, err) {
  let declared = null;
  try {
    if (err instanceof ContractRuntimeError && typeof err.code === 'string' && Object.hasOwn(route.errors, err.code)) {
      declared = { code: err.code, params: err.params, retryable: typeof err.retryable === 'boolean' ? err.retryable : null };
    }
  }
  catch {
    declared = null;
  }
  if (declared !== null) return declaredResult(route, declared.code, declared.params, undefined, declared.retryable);
  return contractResult('JC2008', undefined, err);
}

/**
 * Call the handler through the uniform promise boundary and classify the
 * settlement. Never rejects; the returned promise always resolves an
 * {@link OperationResult}.
 * @param {PipelineRoute} route
 * @param {any} input - the validated input (`null` for an input-less operation)
 * @param {any} ctx - the frozen per-request context the handler receives
 * @param {boolean} validateOutput
 * @returns {Promise<OperationResult>}
 */
export function settleOperation(route, input, ctx, validateOutput) {
  const handler = /** @type {(input: any, ctx: any) => unknown} */ (route.handler);
  return new Promise((resolve) => { resolve(handler(input, ctx)); }).then(
    (value) => settleValue(route, value, validateOutput),
    (err) => settleThrown(route, err));
}

/**
 * The whole neutral pipeline of one operation: validate the input, then
 * call and classify — for a binding with nothing of its own between the
 * two steps (the HTTP binding interposes its idempotency claim and calls
 * the two halves itself).
 * @param {PipelineRoute} route
 * @param {any} input
 * @param {any} ctx
 * @param {{ validateOutput?: boolean }} [options]
 * @returns {Promise<OperationResult>}
 */
export function runOperation(route, input, ctx, options = {}) {
  const invalid = validateOperationInput(route, input);
  if (invalid !== null) return Promise.resolve(invalid);
  return settleOperation(route, input, ctx, options.validateOutput !== false);
}
