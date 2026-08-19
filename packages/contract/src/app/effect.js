//@ts-check
/**
 * @file `createContractEffect(client, options)`: ONE `@jarenjs/app`
 * effect handler (`run: "contract"`) that calls any operation of a
 * client and settles every descriptor with a D6 outcome
 * (docs/CONTRACT-FORMAT.md §11). It owns one task effect per distinct
 * `policy.task` mode the contract uses — built lazily through the
 * `createTaskEffect` factory the host hands in from `@jarenjs/app` —
 * and routes each descriptor `{ op, input, id, done, fail?, slot? }` to
 * the mode's inner effect, so the per-operation concurrency semantics
 * come from the contract's policy and never appear in the app document.
 * This package imports nothing from `@jarenjs/app`; the factory crosses
 * as a function, the documents as JSON.
 *
 * Settlement: the inner effect's `run` invokes the client with the
 * slot's signal and the descriptor's `id` as the attempt; an outcome of
 * `kind: "cancelled"` is turned into an `AbortError` so the task effect
 * dispatches nothing (a superseded task is dead by design); every other
 * outcome resolves and lands as `{ id, result: outcome }`; a host throw
 * is projected — never flattened to a string — into a `JC2058` outcome
 * that lands as `{ id, error: outcome }`.
 */

import { ContractHostError } from '../errors.js';
import { isOutcome, hostFailureOutcome } from '../client/outcome.js';

/**
 * @typedef {import('../compile.js').Contract} Contract
 * @typedef {import('../client/outcome.js').Outcome} Outcome
 */

/**
 * A client binding: what every `open*` returns. The effect reads
 * `invoke` and `contract` (for the task mode of each operation).
 * @typedef {{ invoke: (op: string, input: unknown, ctx: { signal: AbortSignal, attempt: unknown }) => Promise<Outcome> | Outcome, contract: Contract }} ClientLike
 */

/**
 * The `createTaskEffect` factory of `@jarenjs/app`, as the host hands it in.
 * @typedef {(run: (props: any, signal: AbortSignal) => any, options: { mode: string, projectError: (err: unknown, props: any) => any }) => TaskEffectLike} TaskEffectFactory
 */

/**
 * What a task effect exposes.
 * @typedef {((props: any, dispatch: (name: string, payload?: any) => void) => void) & { cancel: (slot?: string) => void, cancelAll: () => void, dispose: () => void }} TaskEffectLike
 */

/**
 * @typedef {Object} ContractEffectOptions
 * @property {TaskEffectFactory} createTaskEffect - `createTaskEffect` from `@jarenjs/app` (required)
 * @property {(err: unknown, props: any) => any} [projectError] - consulted
 *   first when the host throws; a result that is not an outcome falls
 *   back to the `JC2058` outcome
 * @property {Record<string, (params: object) => string> | null} [catalog] - compiled catalog for the `JC2058` message
 */

/**
 * The contract effect: an effect handler with the task-effect controls.
 * @typedef {((props: any, dispatch: (name: string, payload?: any) => void) => void) & {
 *   cancel: (slot?: string) => void, cancelAll: () => void, dispose: () => void }} ContractEffect
 */

/**
 * @param {string} code
 * @param {string} reason
 * @returns {ContractHostError}
 */
function host(code, reason) {
  return new ContractHostError(code, `createContractEffect: ${reason}`);
}

/**
 * An `AbortError`-named error: what `run` throws for a cancelled outcome
 * so the task effect dispatches nothing.
 * @returns {Error}
 */
function abortError() {
  const err = new Error('the operation was cancelled');
  err.name = 'AbortError';
  return err;
}

/**
 * Make the `contract` effect of an app over a client. Register it as
 * `effects: { contract: createContractEffect(client, { createTaskEffect }) }`;
 * the generated actions of `contractAppBinding` invoke it.
 *
 * @param {ClientLike} client - an open client (`openHttpClient`, …)
 * @param {ContractEffectOptions} options
 * @returns {ContractEffect}
 * @throws {ContractHostError} `JC1008` for a malformed client or option
 * @example
 * // createApp and createTaskEffect are the host's, imported from @jarenjs/app;
 * // openHttpClient from '@jarenjs/contract/client', createContractEffect from '@jarenjs/contract/app'
 * const client = openHttpClient(contract, { baseUrl });
 * const effect = createContractEffect(client, { createTaskEffect });
 * createApp(doc, { effects: { contract: effect } });
 */
export function createContractEffect(client, options) {
  if (client === null || typeof client !== 'object' || typeof client.invoke !== 'function'
    || client.contract === null || typeof client.contract !== 'object' || client.contract.operations === null
    || typeof client.contract.operations !== 'object') {
    throw host('JC1008', 'the first argument must be an open client ({ invoke, contract })');
  }
  if (options === null || typeof options !== 'object' || typeof options.createTaskEffect !== 'function') {
    throw host('JC1008', 'options.createTaskEffect is required — pass createTaskEffect from @jarenjs/app (this package does not import it)');
  }
  const factory = options.createTaskEffect;
  const userProject = options.projectError === undefined ? null : options.projectError;
  if (userProject !== null && typeof userProject !== 'function') throw host('JC1008', 'options.projectError must be a function');
  const catalog = options.catalog === undefined ? null : options.catalog;
  const operations = client.contract.operations;

  /**
   * The inner `run`: invoke with the slot's signal and the descriptor's
   * id as the attempt; a cancelled outcome becomes an abort; a value that
   * is not an outcome (a foreign client) becomes a `JC2058` outcome.
   * @param {any} props
   * @param {AbortSignal} signal
   * @returns {Promise<Outcome>}
   */
  function run(props, signal) {
    return Promise.resolve(client.invoke(props.op, props.input, { signal, attempt: props.id })).then((outcome) => {
      if (!isOutcome(outcome)) return hostFailureOutcome(props.op, props.id, catalog);
      if (!outcome.ok && outcome.kind === 'cancelled') throw abortError();
      return outcome;
    });
  }

  /**
   * The settlement projector: a thrown host value becomes an outcome —
   * the host's own projector first, the `JC2058` outcome otherwise — so
   * the completion action always reads an outcome.
   * @param {unknown} err
   * @param {any} props
   * @returns {Outcome}
   */
  function projectError(err, props) {
    if (userProject !== null) {
      try {
        const projected = userProject(err, props);
        if (isOutcome(projected)) return projected;
      }
      catch {
        // fall through to the default projection
      }
    }
    return hostFailureOutcome(typeof props?.op === 'string' ? props.op : '', props?.id, catalog);
  }

  /** @type {Map<string, TaskEffectLike>} */
  const modes = new Map();

  /**
   * @param {string} mode
   * @returns {TaskEffectLike}
   */
  function inner(mode) {
    let effect = modes.get(mode);
    if (effect === undefined) {
      effect = factory(run, { mode, projectError });
      modes.set(mode, effect);
    }
    return effect;
  }

  /** @type {any} */
  const contractEffect = function contractEffect(/** @type {any} */ props, /** @type {(name: string, payload?: any) => void} */ dispatch) {
    const op = props === null || typeof props !== 'object' ? undefined : props.op;
    if (typeof op !== 'string' || !Object.hasOwn(operations, op)) {
      throw new ContractHostError('JC1005', `createContractEffect: the effect props must name an operation of the contract in 'op', got ${JSON.stringify(op)}`);
    }
    inner(operations[op].policy.task)(props, dispatch);
  };

  /** @param {string} [slot] */
  contractEffect.cancel = function cancel(slot) {
    for (const effect of modes.values()) effect.cancel(slot);
  };

  contractEffect.cancelAll = function cancelAll() {
    for (const effect of modes.values()) effect.cancelAll();
  };

  contractEffect.dispose = function dispose() {
    for (const effect of modes.values()) effect.dispose();
  };

  return contractEffect;
}
