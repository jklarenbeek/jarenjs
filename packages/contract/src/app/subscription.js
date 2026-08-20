//@ts-check
/**
 * @file `createContractSubscription(client)`: the ONE `contract-stream`
 * subscription handler the generated subs entries of
 * `contractAppBinding` run (docs/CONTRACT-FORMAT.md §11.4). A handler is
 * `(props, dispatch) => cleanup` — the `@jarenjs/app` subscription
 * shape — so no task-effect factory is needed and this package still
 * imports nothing from `@jarenjs/app`: the entry documents cross as
 * JSON and the handler crosses as a function over a client.
 *
 * The handler subscribes through `client.subscribe`, maintains the
 * document HOST-SIDE by applying each `{ patch, seq }` emission with
 * `@jarenjs/json/patch` (copy-on-write — structural sharing is
 * preserved end to end, which is what keeps the O(k) renderer's fast
 * paths alive), and dispatches the named actions with `{ id, … }`
 * payloads — the generated actions guard on the id (and, for `patch`,
 * on a strictly greater `seq`), so a stale instance's dispatch is a
 * provable no-op in state. An `onError` outcome lands in the error
 * action as-is; a server `end` lands there too, as a `network`-kind
 * outcome with the channel-closed code — the stream is gone and the
 * slot must say so, so a view can offer a reconnect (a new `start`).
 */

import { compileJSONPatch } from '@jarenjs/json/patch';

import { ContractHostError } from '../errors.js';
import { renderMessage } from '../http/wire.js';
import { CLIENT_ERRORS, makeMeta, failedOutcome, outcomeError, clientError } from '../client/outcome.js';
import { PORT_LOCAL_ERRORS } from '../pipeline.js';

/**
 * @typedef {import('../compile.js').Contract} Contract
 * @typedef {import('../client/outcome.js').Outcome} Outcome
 * @typedef {import('../http/wire.js').Catalog} Catalog
 */

/**
 * A client binding that carries streams: what `openHttpClient` and
 * `openPortClient` return. The handler reads `subscribe` only.
 * @typedef {{ subscribe: (op: string, input: unknown, options: object) => { stop: () => void }, contract: Contract }} StreamClientLike
 */

/**
 * @typedef {Object} ContractSubscriptionOptions
 * @property {Catalog | null} [catalog] - compiled catalog for the end/apply messages
 */

/**
 * The props of one generated subs entry: the operation, the slot id and
 * input resolved from state, and the action names to dispatch.
 * @typedef {{ op: string, id: number, input: unknown, snapshot: string, patch: string, error: string }} StreamProps
 */

/**
 * Make the `contract-stream` subscription handler of an app over a
 * client. Register it as `subs: { 'contract-stream':
 * createContractSubscription(client) }`; the generated entries of
 * `contractAppBinding` run it.
 *
 * @param {StreamClientLike} client - an open client whose `capabilities.stream` is true
 * @param {ContractSubscriptionOptions} [options]
 * @returns {(props: StreamProps, dispatch: (name: string, payload?: any) => void) => (() => void)}
 * @throws {ContractHostError} `JC1008` for a malformed client or option
 * @example
 * createApp({ ...doc, subs: [...binding.subs] }, {
 *   effects: { contract: createContractEffect(client, { createTaskEffect }) },
 *   subs: { 'contract-stream': createContractSubscription(client) },
 * });
 */
export function createContractSubscription(client, options = {}) {
  if (client === null || typeof client !== 'object' || typeof client.subscribe !== 'function'
    || client.contract === null || typeof client.contract !== 'object') {
    throw new ContractHostError('JC1008', 'createContractSubscription: the first argument must be an open client with subscribe ({ subscribe, contract })');
  }
  if (options === null || typeof options !== 'object') {
    throw new ContractHostError('JC1008', 'createContractSubscription: options must be an object');
  }
  const catalog = options.catalog === undefined ? null : options.catalog;

  return function contractStream(props, dispatch) {
    const p = /** @type {any} */ (props);
    if (p === null || typeof p !== 'object' || typeof p.op !== 'string'
      || typeof p.snapshot !== 'string' || typeof p.patch !== 'string' || typeof p.error !== 'string') {
      throw new ContractHostError('JC1008', 'contract-stream: props must carry op and the snapshot/patch/error action names (a contractAppBinding subs entry)');
    }
    const { op, id } = p;
    /** @type {unknown} */
    let doc = null;
    const sub = client.subscribe(op, p.input === undefined ? null : p.input, {
      onSnapshot: (/** @type {unknown} */ value, /** @type {{ seq: number }} */ info) => {
        doc = value;
        dispatch(p.snapshot, { id, value, seq: info.seq });
      },
      onPatch: (/** @type {{ patch: any[], seq: number }} */ emission) => {
        try {
          doc = compileJSONPatch(/** @type {any} */ (emission.patch))(doc);
        }
        catch {
          // the emission does not apply to the document the stream built —
          // one end broke the patch contract; the error dispatch flips the
          // slot off 'live' and the app's own reconciliation runs the
          // cleanup, so the client's stop() still runs exactly once
          dispatch(p.error, {
            id,
            outcome: failedOutcome('contract',
              clientError(catalog, 'JC2053', { op }, null, [{ path: '', keyword: 'patch' }]), makeMeta(op, null, null)),
          });
          return;
        }
        dispatch(p.patch, { id, value: doc, seq: emission.seq });
      },
      onError: (/** @type {Outcome} */ outcome) => dispatch(p.error, { id, outcome }),
      onEnd: () => {
        // the server ended the stream: the slot must say the channel is
        // gone, so a view can offer a reconnect (a fresh start)
        dispatch(p.error, {
          id,
          outcome: failedOutcome('network',
            outcomeError('JC2074', renderMessage(catalog, PORT_LOCAL_ERRORS.JC2074.msgid, { op }), null, null, false),
            makeMeta(op, null, null)),
        });
      },
    });
    return () => sub.stop();
  };
}

// re-exported so a host settling its own outcomes beside the handler
// needs no second import path
export { CLIENT_ERRORS };
