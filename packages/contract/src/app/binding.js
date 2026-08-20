//@ts-check
/**
 * @file `contractAppBinding(contract, options)`: the generated
 * `@jarenjs/app` documents of a contract (docs/CONTRACT-FORMAT.md §11) —
 * pure JSON, the `fsmToApp` shape, with no import in either direction.
 * For every operation the app uses it emits one task slot in a state
 * slice, a `start`, a `done` and a `reset` action in the async-task
 * convention of `@jarenjs/app`'s TASKS.md (a monotonic slot `id`, the
 * start patches the slot AND hands the new id to the effect, the
 * completion guards on that id so an out-of-order response is a
 * provable no-op), and a JSON Schema for the slice to compose into
 * `validateState`. The app document names ONE effect, `run: "contract"`;
 * the per-operation task mode is never NAMED in the document — it comes
 * from `policy.task` through `createContractEffect` — but the generator
 * derives the document's state-side guards from it exactly as it
 * derives the document's shape from `kind`, so that the slot and the
 * effect tell the same story in every mode (D10): an `exhaust`
 * operation's `start` is a no-op in state while its slot is `loading`
 * (the effect would ignore the duplicate start; state decides first, so
 * the one completion that arrives carries the current id and lands).
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
 * One task slot: the slice member of an operation. `kind` is the failed
 * outcome's kind while `status` is `"error"` (`"failure"` a declared or
 * taxonomy error, `"network"`, `"contract"`; `"cancelled"` never lands —
 * nothing is dispatched for it) and `null` otherwise, so a view tells
 * "you are offline" from "the server refused this" without parsing
 * `error.code`.
 * @typedef {{ id: number, status: 'idle' | 'loading' | 'done' | 'error', kind: 'failure' | 'network' | 'contract' | null, value: unknown, error: unknown, meta: unknown }} TaskSlot
 */

/**
 * One subscription slot: the slice member of a subscribe operation
 * (docs/CONTRACT-FORMAT.md §11.4). `input` is what `start` was
 * dispatched with — the subscription entry reads it from state, which
 * is what lets the generated `withQuery` resolve the stream's input
 * without a second channel; `value` is the maintained snapshot, `seq`
 * the last applied emission's seq.
 * @typedef {{ id: number, status: 'idle' | 'live' | 'error', kind: 'failure' | 'network' | 'contract' | null, input: unknown, value: unknown, error: unknown, meta: unknown, seq: number }} StreamSlot
 */

/**
 * The generated binding.
 * @typedef {Object} ContractAppBinding
 * @property {Record<string, TaskSlot | StreamSlot>} slice - operation id → its initial slot; mount it at `statePath`
 * @property {Record<string, any>} actions - per read/command operation
 *   `<namespace><op>/start`, `/done` and `/reset`; per subscribe operation
 *   `/start`, `/stop`, `/snapshot`, `/patch`, `/error` and `/reset`
 * @property {any[]} subs - one subscription entry per subscribe operation
 *   (`run: "contract-stream"`); spread into the app document's `subs`
 * @property {any} schema - the slice's JSON Schema, `$defs` of the contract carried, for `validateState`
 * @property {'contract'} effect - the effect name the task actions invoke
 * @property {'contract-stream'} subscription - the handler name the subs entries run
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
 * The generated documents of one subscribe operation
 * (docs/CONTRACT-FORMAT.md §11.4): a guarded `start` (no second
 * subscription while the slot is `live` — the same state-first rule as
 * an exhaust command's start), `stop`, the stream actions the
 * subscription handler dispatches (`snapshot`, `patch` — both guarded
 * on the slot id, `patch` additionally on a strictly greater `seq`, so
 * a stale instance's or an out-of-order event's dispatch is a provable
 * no-op — and `error`), `reset`, the `subs` entry whose `withQuery`
 * resolves the slot's `id` and `input` from state (restart keyed by the
 * resolved props by value), and the slot's schema. The `patch` action
 * receives the WHOLE patched document in `$payload.value` — an app
 * action's `patch` member is a literal op list whose members are query
 * expressions, so it cannot splice a runtime array of RFC 6902 ops; the
 * subscription handler applies the emission with `@jarenjs/json/patch`
 * (copy-on-write, structural sharing preserved) and the action replaces
 * the slot value with the result.
 * @param {Contract} contract
 * @param {any} op
 * @param {string} id
 * @param {string} namespace
 * @param {string} slot
 * @param {string} slotQuery
 * @param {string} idQuery
 * @param {any} nextId
 * @param {Record<string, any>} actions
 * @param {any[]} subs
 * @param {Record<string, any>} properties
 */
function appendSubscription(contract, op, id, namespace, slot, slotQuery, idQuery, nextId, actions, subs, properties) {
  const idGuard = { $eq: ['$payload.id', idQuery] };

  setObjectMember(actions, `${namespace}${id}/start`, {
    $if: [
      { $ne: [`${slotQuery}.status`, 'live'] },
      {
        patch: [
          replace(`${slot}/id`, nextId),
          replace(`${slot}/status`, 'live'),
          replace(`${slot}/kind`, null),
          replace(`${slot}/error`, null),
          replace(`${slot}/input`, '$payload'),
        ],
      },
    ],
  });

  setObjectMember(actions, `${namespace}${id}/stop`, {
    patch: [replace(`${slot}/status`, 'idle')],
  });

  setObjectMember(actions, `${namespace}${id}/snapshot`, {
    $if: [
      idGuard,
      {
        patch: [
          replace(`${slot}/value`, '$payload.value'),
          replace(`${slot}/seq`, '$payload.seq'),
        ],
      },
    ],
  });

  setObjectMember(actions, `${namespace}${id}/patch`, {
    $if: [
      { $and: [idGuard, { $gt: ['$payload.seq', `${slotQuery}.seq`] }] },
      {
        patch: [
          replace(`${slot}/value`, '$payload.value'),
          replace(`${slot}/seq`, '$payload.seq'),
        ],
      },
    ],
  });

  setObjectMember(actions, `${namespace}${id}/error`, {
    $if: [
      idGuard,
      {
        patch: [
          replace(`${slot}/status`, 'error'),
          replace(`${slot}/kind`, '$payload.outcome.kind'),
          replace(`${slot}/error`, '$payload.outcome.error'),
          replace(`${slot}/meta`, '$payload.outcome.meta'),
        ],
      },
    ],
  });

  setObjectMember(actions, `${namespace}${id}/reset`, {
    patch: [
      replace(`${slot}/status`, 'idle'),
      replace(`${slot}/kind`, null),
      replace(`${slot}/error`, null),
    ],
  });

  subs.push({
    run: 'contract-stream',
    when: { $eq: [`${slotQuery}.status`, 'live'] },
    withQuery: {
      op: id,
      id: idQuery,
      input: `${slotQuery}.input`,
      snapshot: `${namespace}${id}/snapshot`,
      patch: `${namespace}${id}/patch`,
      error: `${namespace}${id}/error`,
    },
  });

  const output = op.output.schema;
  const valueSchema = output === true ? true
    : output === false ? { type: 'null' }
      : { anyOf: [{ type: 'null' }, output] };
  const inputSchema = op.input === null
    ? { type: 'null' }
    : { anyOf: [{ type: 'null' }, op.input.schema] };
  setObjectMember(properties, id, {
    type: 'object',
    required: ['id', 'status', 'kind', 'input', 'value', 'error', 'meta', 'seq'],
    properties: {
      id: { type: 'integer', minimum: 0 },
      status: { enum: ['idle', 'live', 'error'] },
      kind: { enum: [null, 'failure', 'network', 'contract'] },
      input: inputSchema,
      value: valueSchema,
      error: { anyOf: [{ type: 'null' }, ERROR_SCHEMA] },
      meta: { anyOf: [{ type: 'null' }, META_SCHEMA] },
      seq: { type: 'integer', minimum: 0 },
    },
  });
}

/**
 * Generate the app documents of a contract: a state slice with one task
 * slot per operation, `start`/`done`/`reset` actions per operation with
 * the TASKS.md id guard built in, and the slice's JSON Schema.
 *
 * The `start` action takes the operation's input as `$payload`: it
 * increments the slot `id`, sets `status: "loading"`, clears `kind` and
 * `error`, and runs the `contract` effect with `{ op, input: $payload, id, done,
 * slot }` — the `id` written as the same increment expression the patch
 * uses (everything in an action evaluates against the PRE-transition
 * state). For an operation whose `policy.task` is `exhaust` the whole
 * start is wrapped in `$if: [{ $ne: [<slot>.status, "loading"] }, …]`
 * — a `$if` without else is the empty sequence (APP-FORMAT §3.2): no
 * patch, no effect, no render — so a duplicate start leaves the slot id
 * where it is and the single completion lands. The `done` action guards
 * on `$payload.id` against the slot id, reads the outcome from
 * `$payload.result` (or `$payload.error`, where a host failure projected
 * by the effect lands), and stores it: `ok` → `status: "done"`, `kind:
 * null`, `value`, `meta`, `error: null`; otherwise `status: "error"`,
 * `kind` (the outcome's), `error`, `meta`, and `value` UNTOUCHED — a
 * failed reload keeps the last good value. The `reset` action releases
 * the slot: `status: "idle"`, `kind: null`, `error: null`; `id`, `value`
 * and `meta` stay (the id must stay monotonic so a late completion of a
 * cancelled attempt is still rejected; the last good value survives a
 * reset as it survives an error).
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

  /** @type {Record<string, TaskSlot | StreamSlot>} */
  const slice = {};
  /** @type {Record<string, any>} */
  const actions = {};
  /** @type {any[]} */
  const subs = [];
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
    const slot = `${statePath}/${id}`;
    const slotQuery = `${queryRoot}['${id}']`;
    const idQuery = `${slotQuery}.id`;
    const nextId = { $add: [idQuery, 1] };
    const done = `${namespace}${id}/done`;

    if (op.kind === 'subscribe') {
      appendSubscription(contract, op, id, namespace, slot, slotQuery, idQuery, nextId, actions, subs, properties);
      setObjectMember(slice, id, { id: 0, status: 'idle', kind: null, input: null, value: null, error: null, meta: null, seq: 0 });
      required.push(id);
      continue;
    }

    setObjectMember(slice, id, { id: 0, status: 'idle', kind: null, value: null, error: null, meta: null });

    const start = {
      patch: [
        replace(`${slot}/id`, nextId),
        replace(`${slot}/status`, 'loading'),
        replace(`${slot}/kind`, null),
        replace(`${slot}/error`, null),
      ],
      effects: [
        { run: 'contract', with: { op: id, input: '$payload', id: nextId, done, slot: id } },
      ],
    };
    // the state-side guard derived from policy.task (the mode itself is
    // never written): an exhaust operation's duplicate start is a no-op
    // in state exactly as it is in the effect, so the one completion
    // that arrives carries the current id
    setObjectMember(actions, `${namespace}${id}/start`, op.policy.task === 'exhaust'
      ? { $if: [{ $ne: [`${slotQuery}.status`, 'loading'] }, start] }
      : start);

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
                replace(`${slot}/kind`, null),
                replace(`${slot}/value`, '$outcome.value'),
                replace(`${slot}/meta`, '$outcome.meta'),
                replace(`${slot}/error`, null),
              ] },
              { patch: [
                replace(`${slot}/status`, 'error'),
                replace(`${slot}/kind`, '$outcome.kind'),
                replace(`${slot}/error`, '$outcome.error'),
                replace(`${slot}/meta`, '$outcome.meta'),
              ] },
            ],
          },
        },
      ],
    });

    setObjectMember(actions, `${namespace}${id}/reset`, {
      patch: [
        replace(`${slot}/status`, 'idle'),
        replace(`${slot}/kind`, null),
        replace(`${slot}/error`, null),
      ],
    });

    const output = op.output.schema;
    const valueSchema = output === true ? true
      : output === false ? { type: 'null' }
        : { anyOf: [{ type: 'null' }, output] };
    setObjectMember(properties, id, {
      type: 'object',
      required: ['id', 'status', 'kind', 'value', 'error', 'meta'],
      properties: {
        id: { type: 'integer', minimum: 0 },
        status: { enum: ['idle', 'loading', 'done', 'error'] },
        // the enum, not the cross-member invariant (kind is null exactly
        // when status is not "error"): a JSON Schema if/then would cost
        // every transition, and the generated actions are the only writer
        kind: { enum: [null, 'failure', 'network', 'contract'] },
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

  return { slice, actions, subs, schema, effect: 'contract', subscription: 'contract-stream' };
}
