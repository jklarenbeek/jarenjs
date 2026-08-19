//@ts-check
/**
 * @file `contractAppBinding(contract, options)`: the generated
 * `@jarenjs/app` documents of a contract (docs/CONTRACT-FORMAT.md §11) —
 * pure JSON, the `fsmToApp` shape, with no import in either direction.
 * For every operation the app uses it emits one task slot in a state
 * slice, a `start` action and a `done` action in the async-task
 * convention of `@jarenjs/app`'s TASKS.md (a monotonic slot `id`, the
 * start patches the slot AND hands the new id to the effect, the
 * completion guards on that id so an out-of-order response is a
 * provable no-op), and a JSON Schema for the slice to compose into
 * `validateState`. The app document names ONE effect, `run: "contract"`;
 * the per-operation task mode never appears in the document — it comes
 * from `policy.task` through `createContractEffect`.
 */

import { setObjectMember } from '@jarenjs/core/object';

import { ContractHostError } from '../errors.js';

/**
 * @typedef {import('../compile.js').Contract} Contract
 */

/**
 * @typedef {Object} ContractAppBindingOptions
 * @property {string} [namespace] - the action-name prefix; default `contract/`
 * @property {string} [statePath] - where the slice lives in app state, as a
 *   chain of identifier-safe segments; default `/contract`
 * @property {readonly string[]} [ops] - the operations the app uses; default every operation
 */

/**
 * One task slot: the slice member of an operation.
 * @typedef {{ id: number, status: 'idle' | 'loading' | 'done' | 'error', value: unknown, error: unknown, meta: unknown }} TaskSlot
 */

/**
 * The generated binding.
 * @typedef {Object} ContractAppBinding
 * @property {Record<string, TaskSlot>} slice - operation id → its initial slot; mount it at `statePath`
 * @property {Record<string, any>} actions - `<namespace><op>/start` and `<namespace><op>/done` per operation
 * @property {any} schema - the slice's JSON Schema, `$defs` of the contract carried, for `validateState`
 * @property {'contract'} effect - the effect name the actions invoke
 */

/** `statePath`: identifier-safe segments only, so it maps to a JSONPath without quoting. */
const STATE_PATH = /^(\/[A-Za-z_][A-Za-z0-9_]*)+$/;

/** The D6 error object as a schema: what a failed outcome puts in `error`. */
const ERROR_SCHEMA = Object.freeze({
  type: 'object',
  required: ['code', 'message', 'status', 'details', 'retryable'],
  properties: {
    code: { type: 'string' },
    message: { type: 'string' },
    status: { type: ['integer', 'null'] },
    details: {},
    retryable: { type: 'boolean' },
  },
});

/** The outcome `meta` as a schema. */
const META_SCHEMA = Object.freeze({
  type: 'object',
  required: ['op', 'attempt', 'trace', 'revision', 'etag', 'notModified'],
  properties: {
    op: { type: 'string' },
    attempt: {},
    trace: { type: ['string', 'null'] },
    revision: { type: ['string', 'null'] },
    etag: { type: ['string', 'null'] },
    notModified: { type: 'boolean' },
  },
});

/**
 * @param {string} reason
 * @returns {ContractHostError}
 */
function host(reason) {
  return new ContractHostError('JC1007', `contractAppBinding: ${reason}`);
}

/**
 * A JSON Patch `replace` op with a literal or query value.
 * @param {string} path
 * @param {unknown} value
 */
function replace(path, value) {
  return { op: 'replace', path, value };
}

/**
 * Generate the app documents of a contract: a state slice with one task
 * slot per operation, `start`/`done` actions per operation with the
 * TASKS.md id guard built in, and the slice's JSON Schema.
 *
 * The `start` action takes the operation's input as `$payload`: it
 * increments the slot `id`, sets `status: "loading"`, clears `error`,
 * and runs the `contract` effect with `{ op, input: $payload, id, done,
 * slot }` — the `id` written as the same increment expression the patch
 * uses (everything in an action evaluates against the PRE-transition
 * state). The `done` action guards on `$payload.id` against the slot
 * id, reads the outcome from `$payload.result` (or `$payload.error`,
 * where a host failure projected by the effect lands), and stores it:
 * `ok` → `status: "done"`, `value`, `meta`, `error: null`; otherwise
 * `status: "error"`, `error`, `meta`, and `value` UNTOUCHED — a failed
 * reload keeps the last good value.
 *
 * @param {Contract} contract
 * @param {ContractAppBindingOptions} [options]
 * @returns {ContractAppBinding}
 * @throws {ContractHostError} `JC1007` for an unknown/uncarriable operation in `ops` or a malformed option
 * @example
 * const { slice, actions, schema } = contractAppBinding(contract, { ops: ['catalog.load', 'product.save'] });
 * createApp({ state: { contract: slice }, view, actions: { ...actions, ...own } }, {
 *   effects: { contract: createContractEffect(client, { createTaskEffect }) },
 *   validateState: (state) => validate(state),   // validate compiled over { properties: { contract: schema } }
 * });
 * app.dispatch('contract/catalog.load/start', { since: '2026-01-01T00:00:00Z' });
 */
export function contractAppBinding(contract, options = {}) {
  if (contract === null || typeof contract !== 'object' || !Array.isArray(contract.ids)
    || contract.operations === null || typeof contract.operations !== 'object') {
    throw host('the first argument must be a compiled contract (compileContract)');
  }
  if (options === null || typeof options !== 'object') throw host('options must be an object');
  const namespace = options.namespace === undefined ? 'contract/' : options.namespace;
  if (typeof namespace !== 'string') throw host('namespace must be a string');
  const statePath = options.statePath === undefined ? '/contract' : options.statePath;
  if (typeof statePath !== 'string' || !STATE_PATH.test(statePath)) {
    throw host('statePath must be a chain of identifier-safe segments, like /contract or /ui/api');
  }
  const ops = options.ops === undefined ? contract.ids : options.ops;
  if (!Array.isArray(ops)) throw host('ops must be an array of operation ids');
  const queryRoot = '$' + statePath.replaceAll('/', '.');

  /** @type {Record<string, TaskSlot>} */
  const slice = {};
  /** @type {Record<string, any>} */
  const actions = {};
  /** @type {Record<string, any>} */
  const properties = {};
  /** @type {string[]} */
  const required = [];

  for (let i = 0; i < ops.length; i++) {
    const id = ops[i];
    if (typeof id !== 'string' || !Object.hasOwn(contract.operations, id)) {
      throw host(`ops names '${String(id)}', which is not an operation of the contract`);
    }
    const op = contract.operations[id];
    if (/** @type {string} */ (op.kind) === 'subscribe') {
      throw host(`'${id}' is a subscribe operation; the app binding carries reads and commands until the stream binding lands`);
    }
    const slot = `${statePath}/${id}`;
    const slotQuery = `${queryRoot}['${id}']`;
    const idQuery = `${slotQuery}.id`;
    const nextId = { $add: [idQuery, 1] };
    const done = `${namespace}${id}/done`;

    setObjectMember(slice, id, { id: 0, status: 'idle', value: null, error: null, meta: null });

    setObjectMember(actions, `${namespace}${id}/start`, {
      patch: [
        replace(`${slot}/id`, nextId),
        replace(`${slot}/status`, 'loading'),
        replace(`${slot}/error`, null),
      ],
      effects: [
        { run: 'contract', with: { op: id, input: '$payload', id: nextId, done, slot: id } },
      ],
    });

    setObjectMember(actions, done, {
      $if: [
        { $eq: ['$payload.id', idQuery] },
        {
          $let: { outcome: { $coalesce: ['$payload.result', '$payload.error'] } },
          $return: {
            $if: [
              { $eq: ['$outcome.ok', true] },
              { patch: [
                replace(`${slot}/status`, 'done'),
                replace(`${slot}/value`, '$outcome.value'),
                replace(`${slot}/meta`, '$outcome.meta'),
                replace(`${slot}/error`, null),
              ] },
              { patch: [
                replace(`${slot}/status`, 'error'),
                replace(`${slot}/error`, '$outcome.error'),
                replace(`${slot}/meta`, '$outcome.meta'),
              ] },
            ],
          },
        },
      ],
    });

    const output = op.output.schema;
    const valueSchema = output === true ? true
      : output === false ? { type: 'null' }
        : { anyOf: [{ type: 'null' }, output] };
    setObjectMember(properties, id, {
      type: 'object',
      required: ['id', 'status', 'value', 'error', 'meta'],
      properties: {
        id: { type: 'integer', minimum: 0 },
        status: { enum: ['idle', 'loading', 'done', 'error'] },
        value: valueSchema,
        error: { anyOf: [{ type: 'null' }, ERROR_SCHEMA] },
        meta: { anyOf: [{ type: 'null' }, META_SCHEMA] },
      },
    });
    required.push(id);
  }

  /** @type {any} */
  const schema = { type: 'object', required, properties };
  // the operations' output schemas may `$ref` the contract's `$defs`; an
  // embedded resource with its own `$id` keeps `#/$defs/...` pointing
  // here wherever the consumer mounts the slice schema
  if (Object.keys(contract.$defs).length > 0) {
    schema.$id = `urn:jaren:contract-app:${contract.id === null ? 'contract' : contract.id}`;
    schema.$defs = contract.$defs;
  }

  return { slice, actions, schema, effect: 'contract' };
}
