//@ts-check
/** Opt-in business settlement shared by handlers on every invocation carrier. */
import { deepFreeze } from '@jarenjs/core/object';
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { ContractFailure, ContractHostError, ContractRuntimeError } from './errors.js';
import { runOperation, validateOperationInput } from './pipeline.js';

/**
 * Compile once around the existing neutral operation pipeline. Identity and
 * current authorization are application policy, never inferred from a receipt.
 * Handlers receive the repository's transaction as ctx.host; current-state reads
 * belong to a separate read operation. Transport TTL policy remains independent.
 * @param {import('./compile.js').CompiledOperation} operation
 * @param {{ repository: { execute: Function }, identity: (input: any, context: any) => any,
 * authorize: (input: any, context: any) => any, handler: (input: any, context: any) => any,
 * commitFailures?: string[], references?: (result: any, context: any) => any[],
 * refuse?: (reason: string, context: any) => any }} options
 */
export function createCommand(operation, options) {
  if (!operation || operation.kind !== 'command' || operation.http.opaque || operation.policy.idempotency !== 'none' || typeof options?.repository?.execute !== 'function'
    || ['identity', 'authorize', 'handler'].some((name) => typeof options[name] !== 'function'))
    throw new ContractHostError('JC1013', 'command settlement needs a JSON command, receipt repository, identity, authorization and handler');
  const failures = new Set(options.commitFailures ?? []);
  if ([...failures].some((code) => !Object.hasOwn(operation.errors, code))) throw new ContractHostError('JC1013', 'committed failure codes must be declared');
  const route = { op: operation, handler: options.handler, raw: false, validateInput: operation.input?.validate ?? null,
    validateOutput: operation.output.validate, details: operation.policy.errors.details, errors: operation.errors,
    retryOn: new Set(operation.policy.retry?.on ?? []) };
  const refused = (reason) => ({ state: 'refused', reason, historic: false });
  /** @param {any} input @param {any} [context] */
  async function execute(input, context = {}) {
    // Freeze before asynchronous authority checks so callers cannot change the
    // authorized request or the request whose hash the application computes.
    const value = deepFreeze(JSON.parse(canonicalizeJson(input ?? null)));
    if (await options.authorize(value, context) !== true) return refused('unauthorized');
    if (validateOperationInput(route, value) !== null) throw new ContractRuntimeError('JC2110', 'command input failed validation', { msgid: 'contract/command-failed' });
    const identity = options.identity(value, context);
    if (identity?.op !== operation.id) throw new ContractHostError('JC1013', 'identity operation must match the compiled command');
    try {
      return await options.repository.execute(identity, async (tx) => {
        if (context.signal?.aborted) throw refused('cancelled');
        const hostContext = Object.freeze({ ...context, host: tx, fail: ContractFailure });
        const result = await runOperation(route, value, hostContext);
        if (result.kind === 'contract') throw new ContractRuntimeError('JC2110', 'command validation or handler failed', { msgid: 'contract/command-failed', cause: result.cause });
        if (result.kind === 'failure' && !failures.has(result.code)) throw { state: 'uncommitted', historic: false, outcome: result };
        if (context.signal?.aborted) throw refused('cancelled');
        // Canonicalization rejects non-JSON values before any transaction commits.
        const outcome = JSON.parse(canonicalizeJson(result.kind === 'failure' ? { ...result, details: result.details ?? null } : result));
        return { outcome, references: options.references?.(outcome, hostContext) ?? [] };
      }, context.lease === undefined ? {} : { lease: context.lease });
    }
    catch (error) {
      if (error?.state === 'uncommitted' || error?.state === 'refused') return error;
      throw error;
    }
  }
  return Object.freeze({
    execute,
    /** A deliberate carrier wrapper around the one settlement implementation.
     * @param {any} input @param {any} context */
    async handler(input, context) {
      const settled = await execute(input, context);
      if (settled.state === 'refused') {
        if (options.refuse) return options.refuse(settled.reason, context);
        throw new ContractRuntimeError('JC2110', 'command refused', { msgid: 'contract/command-failed' });
      }
      const outcome = settled.receipt?.outcome ?? settled.outcome;
      return outcome.kind === 'failure' ? ContractFailure(outcome.code, outcome.params, outcome.details, { retryable: outcome.retryable }) : outcome.value;
    },
  });
}
