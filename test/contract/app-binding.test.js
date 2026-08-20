//@ts-check
/**
 * @file `contractAppBinding` + `createContractEffect` in a headless
 * `createApp`: the generated slice/actions/schema; `validateState` from
 * the generated schema accepts every transition of the worked flow and
 * rejects a hand-corrupted status; the id guard rejects an out-of-order
 * older response; cancellation dispatches nothing; ONE `contract` effect
 * routes a `switch` read and an `exhaust` command to their modes — and
 * the generated documents agree with the effect in EVERY mode (03A):
 * an `exhaust` command double-dispatched runs once and its result
 * lands (the state-side start guard), `concat`/`parallel` are "latest
 * wins" with `status` honest, `reset` releases a slot the host
 * cancelled, the slot's `kind` names the failure class; a thrown host
 * value lands as a `JC2058` outcome; `cancel`/`dispose` fan out; the
 * host errors `JC1005`/`JC1007`/`JC1008`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { createApp, createTaskEffect } from '@jarenjs/app';
import { JarenValidator } from '@jarenjs/validate';
import { compileContract } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import { toFetchHandler } from '@jarenjs/contract/fetch';
import { createMemoryLedger } from '@jarenjs/contract/ledger';
import { openHttpClient } from '@jarenjs/contract/client';
import { contractAppBinding, createContractEffect } from '@jarenjs/contract/app';
import { load, shopHandlers } from './helpers.js';

const shop = compileContract(load('./fixtures/shop.contract.json'));
const PRODUCT = { id: 1, name: 'x', price: 1 };
const sync = (/** @type {() => void} */ flush) => flush();

/**
 * Drain microtasks, then wait (bounded) until `until` holds — the
 * server's request hash runs on crypto.subtle's threadpool, so a
 * completion may need more than one macrotask under load.
 * @param {() => boolean} [until]
 */
async function drain(until = () => true) {
  for (let i = 0; i < 16; i++) await Promise.resolve();
  for (let n = 0; n < 200 && !until(); n++) await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

/**
 * A deferred fetch: every request parks until the test answers it.
 * @param {(request: Request) => Promise<Response>} handler
 */
function deferredFetch(handler) {
  /** @type {{ url: string, init: any, resolve: () => void, fail: (err: unknown) => void, signal: AbortSignal | undefined }[]} */
  const calls = [];
  const fetch = (/** @type {string} */ url, /** @type {any} */ init) => new Promise((resolve, reject) => {
    const call = {
      url, init, signal: init.signal,
      resolve: () => { handler(new Request('http://x' + url, init)).then(resolve, reject); },
      fail: (/** @type {unknown} */ err) => reject(err),
    };
    if (init.signal) init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    calls.push(call);
  });
  return { calls, fetch };
}

/**
 * Mount a contract's binding headless over a real server, with every
 * completion dispatch and every transition recorded.
 * @param {import('@jarenjs/contract').Contract} contract
 * @param {Record<string, any>} handlers
 * @param {any} [bindingOptions]
 * @param {any} [appOptions]
 */
function mountContract(contract, handlers, bindingOptions = {}, appOptions = {}) {
  const server = serveHttp(contract, handlers, { ledger: createMemoryLedger(), onError: () => {} });
  const { calls, fetch } = deferredFetch(toFetchHandler(server));
  const client = openHttpClient(contract, { fetch });
  const { slice, actions, schema } = contractAppBinding(contract, bindingOptions);
  const validate = new JarenValidator().compile({ type: 'object', required: ['contract'], properties: { contract: schema, draft: {} } });
  /** @type {any[]} */
  const dispatches = [];
  /** @type {any[]} */
  const transitions = [];
  /** @type {any[]} */
  const errors = [];
  const effect = createContractEffect(client, { createTaskEffect });
  // the recording wrapper keeps the controls so app.destroy() can dispose
  const recording = Object.assign(
    (/** @type {any} */ props, /** @type {any} */ dispatch) => effect(props, (name, payload) => { dispatches.push([name, payload]); dispatch(name, payload); }),
    { cancel: effect.cancel, cancelAll: effect.cancelAll, dispose: effect.dispose });
  const app = createApp({
    state: { contract: slice, draft: null },
    view: [{ match: '$', body: ['main', {}] }],
    actions: {
      ...actions,
      corrupt: { patch: [{ op: 'replace', path: '/contract/catalog.load/status', value: 'nonsense' }] },
      draft: { patch: [{ op: 'replace', path: '/draft', value: '$payload' }] },
    },
  }, {
    schedule: sync,
    effects: { contract: recording },
    validateState: (s) => validate(s),
    onError: (err) => errors.push(err),
    ...appOptions,
  });
  app.subscribe((state) => transitions.push(state));
  const slot = (/** @type {string} */ op) => app.getState().contract[op];
  return { app, calls, dispatches, transitions, errors, effect, client, slice, actions, schema, validate, slot };
}

/**
 * Mount the shop binding (three operations) over the shop handlers.
 * @param {Record<string, any>} [handlers]
 * @param {any} [bindingOptions]
 * @param {any} [appOptions]
 */
function mount(handlers = {}, bindingOptions = {}, appOptions = {}) {
  return mountContract(shop, { ...shopHandlers(), ...handlers }, { ops: ['catalog.load', 'product.save', 'product.remove'], ...bindingOptions }, appOptions);
}

/** The four modes, one command each (canonical binding, `{ n }` in → `{ n }` out), for the "latest wins" pins. */
const MODES = compileContract({
  $contract: '0.1',
  operations: Object.fromEntries(['switch', 'exhaust', 'concat', 'parallel'].map((task) => [`run.${task}`, {
    kind: 'command',
    input: { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } },
    output: { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } },
    policy: { task },
  }])),
});
const IDLE = { id: 0, status: 'idle', kind: null, value: null, error: null, meta: null };

describe('contractAppBinding — the generated documents', () => {
  it('slice, actions, schema and effect name; the schema validates the slice; options are checked', () => {
    const { slice, actions, schema, effect } = contractAppBinding(shop);
    assert.strictEqual(effect, 'contract');
    assert.deepStrictEqual(Object.keys(slice), shop.ids);
    assert.deepStrictEqual(slice['catalog.load'], IDLE);
    assert.deepStrictEqual(Object.keys(actions), shop.ids.flatMap((id) => [`contract/${id}/start`, `contract/${id}/done`, `contract/${id}/reset`]), 'three actions per operation');
    // the start action of a switch read is TASKS.md's bare shape: the increment expression twice, status loading, kind and error cleared, one contract effect
    const bareStart = {
      patch: [
        { op: 'replace', path: '/contract/catalog.load/id', value: { $add: ["$.contract['catalog.load'].id", 1] } },
        { op: 'replace', path: '/contract/catalog.load/status', value: 'loading' },
        { op: 'replace', path: '/contract/catalog.load/kind', value: null },
        { op: 'replace', path: '/contract/catalog.load/error', value: null },
      ],
      effects: [{ run: 'contract', with: { op: 'catalog.load', input: '$payload', id: { $add: ["$.contract['catalog.load'].id", 1] }, done: 'contract/catalog.load/done', slot: 'catalog.load' } }],
    };
    assert.deepStrictEqual(actions['contract/catalog.load/start'], bareStart);
    // the start action of an exhaust command is the same shape behind the state-side guard: a no-op while the slot is loading
    assert.deepStrictEqual(actions['contract/product.save/start'], {
      $if: [{ $ne: ["$.contract['product.save'].status", 'loading'] }, {
        patch: [
          { op: 'replace', path: '/contract/product.save/id', value: { $add: ["$.contract['product.save'].id", 1] } },
          { op: 'replace', path: '/contract/product.save/status', value: 'loading' },
          { op: 'replace', path: '/contract/product.save/kind', value: null },
          { op: 'replace', path: '/contract/product.save/error', value: null },
        ],
        effects: [{ run: 'contract', with: { op: 'product.save', input: '$payload', id: { $add: ["$.contract['product.save'].id", 1] }, done: 'contract/product.save/done', slot: 'product.save' } }],
      }],
    });
    assert.strictEqual(actions['contract/product.remove/start'].$if !== undefined, true, 'a command defaults to exhaust → guarded');
    assert.deepStrictEqual(actions['contract/catalog.load/done'].$if[0], { $eq: ['$payload.id', "$.contract['catalog.load'].id"] }, 'the id guard is first');
    assert.deepStrictEqual(actions['contract/catalog.load/done'].$if[1].$return.$if[1].patch.map((/** @type {any} */ r) => [r.path, r.value]), [
      ['/contract/catalog.load/status', 'done'], ['/contract/catalog.load/kind', null], ['/contract/catalog.load/value', '$outcome.value'], ['/contract/catalog.load/meta', '$outcome.meta'], ['/contract/catalog.load/error', null]]);
    assert.deepStrictEqual(actions['contract/catalog.load/done'].$if[1].$return.$if[2].patch.map((/** @type {any} */ r) => [r.path, r.value]), [
      ['/contract/catalog.load/status', 'error'], ['/contract/catalog.load/kind', '$outcome.kind'], ['/contract/catalog.load/error', '$outcome.error'], ['/contract/catalog.load/meta', '$outcome.meta']]);
    assert.deepStrictEqual(actions['contract/catalog.load/reset'], { patch: [
      { op: 'replace', path: '/contract/catalog.load/status', value: 'idle' },
      { op: 'replace', path: '/contract/catalog.load/kind', value: null },
      { op: 'replace', path: '/contract/catalog.load/error', value: null },
    ] }, 'reset releases status/kind/error; id, value and meta stay');
    const text = JSON.stringify(actions);
    assert.strictEqual(text.includes('"mode"'), false, 'the task mode never appears in the document');
    for (const mode of ['exhaust', 'switch', 'concat', 'parallel']) assert.strictEqual(text.includes(`"${mode}"`), false, `the mode name "${mode}" is never written (D10)`);
    // the same over a contract with one operation per mode: only the exhaust start is guarded
    const modes = contractAppBinding(MODES);
    assert.deepStrictEqual(Object.entries(modes.actions).filter(([k]) => k.endsWith('/start')).map(([k, v]) => [k, v.$if !== undefined]),
      [['contract/run.switch/start', false], ['contract/run.exhaust/start', true], ['contract/run.concat/start', false], ['contract/run.parallel/start', false]]);
    for (const mode of ['exhaust', 'switch', 'concat', 'parallel']) assert.strictEqual(JSON.stringify(modes.actions).includes(`"${mode}"`), false);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify({ slice, actions, schema })));
    // the schema: per op a slot; value = output schema or null; $defs carried with an $id
    const validate = new JarenValidator().compile(schema);
    assert.strictEqual(validate(slice), true);
    assert.strictEqual(schema.$id, 'urn:jaren:contract-app:shop');
    assert.deepStrictEqual(Object.keys(schema.$defs), ['Product', 'Catalog', 'Conflict']);
    assert.deepStrictEqual(schema.properties['catalog.load'].required, ['id', 'status', 'kind', 'value', 'error', 'meta']);
    assert.deepStrictEqual(schema.properties['catalog.load'].properties.kind, { enum: [null, 'failure', 'network', 'contract'] });
    assert.deepStrictEqual(schema.properties['catalog.load'].properties.value, { anyOf: [{ type: 'null' }, { $ref: '#/$defs/Catalog' }] });
    assert.strictEqual(schema.properties['image.bytes'].properties.value, true, 'output true → value true');
    assert.strictEqual(validate({ ...slice, 'catalog.load': { ...slice['catalog.load'], status: 'nonsense' } }), false);
    assert.strictEqual(validate({ ...slice, 'catalog.load': { ...slice['catalog.load'], status: 'done', value: { revision: 'x' } } }), false, 'value is checked against the output schema through $defs');
    assert.strictEqual(validate({ ...slice, 'catalog.load': { ...slice['catalog.load'], status: 'done', value: { revision: 1, products: [] } } }), true);
    // kind: the enum is pinned (cancelled never lands); the cross-member invariant (kind null ⇔ status ≠ error) is NOT schema-checked —
    // a JSON Schema if/then would cost every transition and the generated actions are the only writer
    assert.strictEqual(validate({ ...slice, 'catalog.load': { ...slice['catalog.load'], kind: 'cancelled' } }), false);
    assert.strictEqual(validate({ ...slice, 'catalog.load': { ...slice['catalog.load'], kind: 'oops' } }), false);
    const { kind: _k, ...noKind } = slice['catalog.load'];
    assert.strictEqual(validate({ ...slice, 'catalog.load': noKind }), false, 'kind is required');
    for (const kind of ['failure', 'network', 'contract']) assert.strictEqual(validate({ ...slice, 'catalog.load': { ...slice['catalog.load'], status: 'error', kind, error: { code: 'x', message: 'm', status: null, details: null, retryable: false } } }), true);
    assert.strictEqual(validate({ ...slice, 'catalog.load': { ...slice['catalog.load'], status: 'done', kind: 'failure', value: { revision: 1, products: [] } } }), true, 'the enum, not the invariant');
    // options: namespace, statePath, ops
    const custom = contractAppBinding(shop, { namespace: 'api:', statePath: '/ui/api', ops: ['product.save'] });
    assert.deepStrictEqual(Object.keys(custom.actions), ['api:product.save/start', 'api:product.save/done', 'api:product.save/reset']);
    assert.strictEqual(custom.actions['api:product.save/start'].$if[1].patch[0].path, '/ui/api/product.save/id');
    assert.strictEqual(custom.actions['api:product.save/start'].$if[1].patch[0].value.$add[0], "$.ui.api['product.save'].id");
    assert.strictEqual(custom.actions['api:product.save/start'].$if[0].$ne[0], "$.ui.api['product.save'].status");
    assert.deepStrictEqual(Object.keys(custom.slice), ['product.save']);
    const noDefs = contractAppBinding(compileContract({ $contract: '0.1', operations: { a: { kind: 'read', output: true } } }));
    assert.strictEqual(noDefs.schema.$id, undefined, 'no $defs → no embedded resource');
    assert.throws(() => contractAppBinding(shop, { ops: ['nope'] }), (/** @type {any} */ e) => e.code === 'JC1007' && e instanceof TypeError);
    assert.throws(() => contractAppBinding(shop, { statePath: 'contract' }), (/** @type {any} */ e) => e.code === 'JC1007');
    assert.throws(() => contractAppBinding(shop, { statePath: '/a.b' }), (/** @type {any} */ e) => e.code === 'JC1007');
    assert.throws(() => contractAppBinding(shop, { namespace: /** @type {any} */ (1) }), (/** @type {any} */ e) => e.code === 'JC1007');
    assert.throws(() => contractAppBinding(/** @type {any} */ ({})), (/** @type {any} */ e) => e.code === 'JC1007');
    // a subscribe operation is carried too: its slot, actions and subs
    // entry are the app-subscription tests' subject; here only the shape
    const live = contractAppBinding(compileContract({ $contract: '0.1', operations: { feed: { kind: 'subscribe', output: true } } }));
    assert.deepStrictEqual(Object.keys(live.actions), ['contract/feed/start', 'contract/feed/stop', 'contract/feed/snapshot', 'contract/feed/patch', 'contract/feed/error', 'contract/feed/reset']);
    assert.strictEqual(live.subs.length, 1);
    assert.strictEqual(live.subscription, 'contract-stream');
  });
});

describe('the contract effect in a headless app — the worked flow under validateState', () => {
  it('start → loading; the server answers → done with value and meta; a declared failure → error, value untouched; the schema accepts every transition', async () => {
    const { app, calls, slot, errors, dispatches } = mount({ 'product.save': (input, ctx) => (input.id === 9 ? ctx.fail('conflict', {}, { current: PRODUCT }) : { ...PRODUCT, id: input.id }) });
    app.dispatch('contract/catalog.load/start', { since: '2026-01-01T00:00:00Z' });
    assert.deepStrictEqual(slot('catalog.load'), { id: 1, status: 'loading', kind: null, value: null, error: null, meta: null });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, '/api/catalog?since=2026-01-01T00%3A00%3A00Z');
    calls[0].resolve();
    await drain(() => slot('catalog.load').status !== 'loading');
    const done = slot('catalog.load');
    assert.deepStrictEqual([done.id, done.status, done.kind, done.error], [1, 'done', null, null]);
    assert.deepStrictEqual(done.value, { revision: 1, products: [{ id: 1, name: 'a', price: 1 }] });
    assert.deepStrictEqual([done.meta.op, done.meta.attempt, typeof done.meta.trace], ['catalog.load', 1, 'string']);
    assert.deepStrictEqual(dispatches[0][0], 'contract/catalog.load/done');
    assert.deepStrictEqual(dispatches[0][1].id, 1);
    assert.strictEqual(dispatches[0][1].result.ok, true);
    // a command that succeeds
    app.dispatch('contract/product.save/start', { id: 3, revision: 1, product: PRODUCT });
    calls[1].resolve();
    await drain(() => slot('product.save').status !== 'loading');
    assert.deepStrictEqual([slot('product.save').status, slot('product.save').value], ['done', { ...PRODUCT, id: 3 }]);
    // a command that fails with a declared error keeps the last good value
    app.dispatch('contract/product.save/start', { id: 9, revision: 1, product: PRODUCT });
    assert.deepStrictEqual([slot('product.save').id, slot('product.save').status], [2, 'loading']);
    calls[2].resolve();
    await drain(() => slot('product.save').status !== 'loading');
    const failed = slot('product.save');
    assert.deepStrictEqual([failed.status, failed.kind, failed.value], ['error', 'failure', { ...PRODUCT, id: 3 }]);
    assert.deepStrictEqual(failed.error, { code: 'conflict', message: 'operation product.save failed with conflict', status: 409, details: { current: PRODUCT }, retryable: false });
    assert.strictEqual(failed.meta.attempt, 2);
    // a pre-send refusal lands the same way, no request made; kind says the contract was violated (no code parsing)
    app.dispatch('contract/product.save/start', { id: 'x' });
    await drain(() => slot('product.save').status !== 'loading');
    assert.strictEqual(calls.length, 3, 'nothing was sent');
    assert.deepStrictEqual([slot('product.save').status, slot('product.save').kind, slot('product.save').error.code], ['error', 'contract', 'JC2050']);
    // a transport rejection is kind network (product.remove: no declared retry, so nothing is re-sent)
    app.dispatch('contract/product.remove/start', { id: 4 });
    calls[3].fail(new TypeError('fetch failed'));   // the transport rejected (not a cancellation: no signal aborted)
    await drain(() => slot('product.remove').status !== 'loading');
    assert.deepStrictEqual([slot('product.remove').status, slot('product.remove').kind, slot('product.remove').error.code], ['error', 'network', 'JC2051']);
    // a start clears kind with error (kind is null whenever status is not error); the next success keeps it null
    app.dispatch('contract/product.save/start', { id: 5, revision: 1, product: PRODUCT });
    assert.deepStrictEqual([slot('product.save').status, slot('product.save').kind, slot('product.save').error], ['loading', null, null]);
    calls[4].resolve();
    await drain(() => slot('product.save').status !== 'loading');
    assert.deepStrictEqual([slot('product.save').status, slot('product.save').kind, slot('product.save').error, slot('product.save').value.id], ['done', null, null, 5]);
    assert.deepStrictEqual(errors, [], 'validateState accepted every transition');
  });

  it('validateState rejects a hand-corrupted status (JA2005) and the state stands', async () => {
    const { app, slot, errors } = mount();
    app.dispatch('corrupt');
    assert.strictEqual(slot('catalog.load').status, 'idle');
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].code, 'JA2005');
  });

  it('the id guard: an out-of-order older response does not overwrite state; cancellation dispatches nothing', async () => {
    const { app, calls, slot, dispatches, transitions } = mount();
    app.dispatch('contract/catalog.load/start');   // id 1
    app.dispatch('contract/catalog.load/start');   // id 2 — switch: request 1 is aborted
    assert.strictEqual(slot('catalog.load').id, 2);
    assert.strictEqual(calls[0].signal?.aborted, true, 'the slot\'s predecessor was aborted');
    calls[1].resolve();
    await drain(() => slot('catalog.load').status !== 'loading');
    assert.deepStrictEqual([slot('catalog.load').status, slot('catalog.load').meta.attempt], ['done', 2]);
    assert.strictEqual(dispatches.length, 1, 'the aborted request dispatched nothing (cancelled outcome → AbortError)');
    const seen = transitions.length;
    // an older completion that arrives anyway is dispatched and rejected by the guard
    app.dispatch('contract/catalog.load/done', { id: 1, result: { ok: true, value: { revision: 99, products: [] }, meta: { op: 'catalog.load', attempt: 1, trace: null, revision: null, etag: null, notModified: false } } });
    assert.strictEqual(slot('catalog.load').value.revision, 1, 'state keeps id 2\'s result');
    assert.strictEqual(transitions.length, seen, 'no transition fired for the stale completion');
    // a completion whose id matches but carries another attempt in meta still lands by the payload id, never by meta
    app.dispatch('contract/catalog.load/done', { id: 2, result: { ok: true, value: { revision: 7, products: [] }, meta: { op: 'catalog.load', attempt: 999, trace: 'spoofed', revision: null, etag: null, notModified: false } } });
    assert.strictEqual(slot('catalog.load').value.revision, 7);
  });

  it('one effect, two modes: a superseded switch read dispatches once with the newer result; an exhaust command double-dispatched runs the handler once AND its result lands', async () => {
    let saves = 0;
    const { app, calls, slot, dispatches, transitions } = mount({ 'product.save': (input) => { saves++; return { ...PRODUCT, id: input.id }; } });
    // the read: switch
    app.dispatch('contract/catalog.load/start');
    app.dispatch('contract/catalog.load/start');
    assert.strictEqual(calls.length, 2);
    calls[0].resolve();   // the aborted one; its fetch rejects with the abort reason first
    calls[1].resolve();
    await drain(() => slot('catalog.load').status !== 'loading');
    assert.deepStrictEqual(dispatches.filter(([n]) => n === 'contract/catalog.load/done').length, 1);
    assert.strictEqual(slot('catalog.load').meta.attempt, 2);
    // the command: exhaust — the second start is a no-op IN STATE (the $if guard): the id stays 1, no effect invocation, no transition
    const seen = transitions.length;
    app.dispatch('contract/product.save/start', { id: 1, revision: 1, product: PRODUCT });
    assert.strictEqual(transitions.length, seen + 1);
    app.dispatch('contract/product.save/start', { id: 1, revision: 1, product: PRODUCT });
    assert.strictEqual(transitions.length, seen + 1, 'the duplicate start fired no transition');
    assert.deepStrictEqual([slot('product.save').id, slot('product.save').status], [1, 'loading']);
    assert.strictEqual(calls.length, 3, 'exhaust: the duplicate start made no request');
    calls[2].resolve();
    await drain(() => slot('product.save').status !== 'loading');
    assert.strictEqual(saves, 1, 'the handler ran once');
    // the single completion carries id 1 against a slot at 1: it LANDS
    assert.deepStrictEqual([slot('product.save').id, slot('product.save').status, slot('product.save').kind, slot('product.save').value], [1, 'done', null, { ...PRODUCT, id: 1 }]);
    assert.strictEqual(dispatches.filter(([n]) => n === 'contract/product.save/done').length, 1, 'one dispatch');
    // the slot released, the next start runs (id 2)
    app.dispatch('contract/product.save/start', { id: 2, revision: 1, product: PRODUCT });
    assert.deepStrictEqual([slot('product.save').id, calls.length], [2, 4]);
    calls[3].resolve();
    await drain(() => slot('product.save').status !== 'loading');
    assert.strictEqual(saves, 2);
    // product.remove is a command too (exhaust by default) — its own slot, independent of product.save's
    app.dispatch('contract/product.remove/start', { id: 5 });
    assert.strictEqual(calls.length, 5);
    calls[4].resolve();
    await drain(() => slot('product.remove').status !== 'loading');
    assert.strictEqual(slot('product.remove').status, 'done');
  });

  it('every mode, one slot: switch newest wins; exhaust first wins and lands; concat and parallel are "latest wins" with status honest until the newest lands', async () => {
    /** @type {string[]} */
    const ran = [];
    const handlers = Object.fromEntries(MODES.ids.map((id) => [id, (/** @type {any} */ input) => { ran.push(`${id}:${input.n}`); return { n: input.n }; }]));
    const { app, calls, slot, dispatches, errors } = mountContract(MODES, handlers);
    const start = (/** @type {string} */ mode, /** @type {number} */ n) => app.dispatch(`contract/run.${mode}/start`, { n });
    const dones = (/** @type {string} */ mode) => dispatches.filter(([name]) => name === `contract/run.${mode}/done`).length;
    // concat: three starts queue in the effect; state counts every start (id 3, loading)
    start('concat', 1); start('concat', 2); start('concat', 3);
    assert.deepStrictEqual([slot('run.concat').id, slot('run.concat').status, calls.length], [3, 'loading', 1], 'one in flight, two queued');
    calls[0].resolve();
    await drain(() => calls.length === 2);
    assert.deepStrictEqual([slot('run.concat').status, slot('run.concat').value, dones('concat')], ['loading', null, 1], 'completion 1 is rejected by the guard (id 1 ≠ 3); status stays honest');
    calls[1].resolve();
    await drain(() => calls.length === 3);
    assert.deepStrictEqual([slot('run.concat').status, slot('run.concat').value, dones('concat')], ['loading', null, 2]);
    calls[2].resolve();
    await drain(() => slot('run.concat').status !== 'loading');
    assert.deepStrictEqual([slot('run.concat').id, slot('run.concat').status, slot('run.concat').value, slot('run.concat').meta.attempt, dones('concat')], [3, 'done', { n: 3 }, 3, 3], 'the third result lands at id 3');
    assert.deepStrictEqual(ran, ['run.concat:1', 'run.concat:2', 'run.concat:3'], 'all three ran, in order');
    // parallel: three requests at once; the newest id lands whenever it arrives; earlier ones are provable no-ops
    ran.length = 0;
    start('parallel', 1); start('parallel', 2); start('parallel', 3);
    assert.deepStrictEqual([slot('run.parallel').id, slot('run.parallel').status, calls.length], [3, 'loading', 6], 'three concurrent requests');
    calls[5].resolve();   // the newest answers first
    await drain(() => slot('run.parallel').status !== 'loading');
    assert.deepStrictEqual([slot('run.parallel').status, slot('run.parallel').value, slot('run.parallel').meta.attempt], ['done', { n: 3 }, 3]);
    calls[3].resolve(); calls[4].resolve();
    await drain(() => dones('parallel') === 3);
    assert.deepStrictEqual([slot('run.parallel').value, slot('run.parallel').meta.attempt], [{ n: 3 }, 3], 'the older results were dispatched and rejected by the guard');
    assert.deepStrictEqual(ran.sort(), ['run.parallel:1', 'run.parallel:2', 'run.parallel:3']);
    // switch: newest wins — the predecessor is aborted, its completion (if any) rejected
    ran.length = 0;
    start('switch', 1); start('switch', 2);
    assert.deepStrictEqual([slot('run.switch').id, calls.length, calls[6].signal?.aborted], [2, 8, true]);
    calls[7].resolve();
    await drain(() => slot('run.switch').status !== 'loading');
    assert.deepStrictEqual([slot('run.switch').status, slot('run.switch').value, dones('switch')], ['done', { n: 2 }, 1]);
    // exhaust: first wins — the second start is a state no-op, the first result lands
    ran.length = 0;
    start('exhaust', 1); start('exhaust', 2);
    assert.deepStrictEqual([slot('run.exhaust').id, calls.length], [1, 9]);
    calls[8].resolve();
    await drain(() => slot('run.exhaust').status !== 'loading');
    assert.deepStrictEqual([slot('run.exhaust').id, slot('run.exhaust').status, slot('run.exhaust').value, dones('exhaust')], [1, 'done', { n: 1 }, 1]);
    assert.deepStrictEqual(ran, ['run.exhaust:1']);
    assert.deepStrictEqual(errors, [], 'validateState accepted every transition');
  });

  it('reset releases a slot: after cancel(slot) on an exhaust command, start is a state no-op; reset → idle with id/value/meta kept; the next start runs; a late completion of the cancelled id is still rejected', async () => {
    const { app, calls, slot, effect, dispatches, transitions, errors } = mount({ 'product.save': (input) => ({ ...PRODUCT, id: input.id }) });
    // a first save lands (value and meta to keep)
    app.dispatch('contract/product.save/start', { id: 1, revision: 1, product: PRODUCT });
    calls[0].resolve();
    await drain(() => slot('product.save').status !== 'loading');
    const landed = slot('product.save');
    assert.deepStrictEqual([landed.id, landed.status, landed.value.id], [1, 'done', 1]);
    // a second attempt the host cancels: nothing dispatched, the slot stays loading, start is a state no-op
    app.dispatch('contract/product.save/start', { id: 2, revision: 1, product: PRODUCT });
    assert.deepStrictEqual([slot('product.save').id, slot('product.save').status], [2, 'loading']);
    effect.cancel('product.save');
    assert.strictEqual(calls[1].signal?.aborted, true);
    await drain();
    assert.strictEqual(dispatches.length, 1, 'the cancelled attempt dispatched nothing');
    assert.strictEqual(slot('product.save').status, 'loading');
    const seen = transitions.length;
    app.dispatch('contract/product.save/start', { id: 3, revision: 1, product: PRODUCT });
    assert.deepStrictEqual([slot('product.save').id, calls.length, transitions.length], [2, 2, seen], 'start while loading: no-op in state, no request, no transition');
    // reset: the one way out — status idle, kind/error null; id, value, meta untouched
    app.dispatch('contract/product.save/reset');
    assert.deepStrictEqual(slot('product.save'), { id: 2, status: 'idle', kind: null, value: landed.value, error: null, meta: landed.meta });
    // the next start runs
    app.dispatch('contract/product.save/start', { id: 3, revision: 1, product: PRODUCT });
    assert.deepStrictEqual([slot('product.save').id, slot('product.save').status, calls.length], [3, 'loading', 3]);
    // a late completion of the cancelled attempt (id 2) is rejected by the id guard — the id stayed monotonic through reset
    const before = transitions.length;
    app.dispatch('contract/product.save/done', { id: 2, result: { ok: true, value: { ...PRODUCT, id: 2 }, meta: { op: 'product.save', attempt: 2, trace: null, revision: null, etag: null, notModified: false } } });
    assert.deepStrictEqual([slot('product.save').status, slot('product.save').value.id, transitions.length], ['loading', 1, before]);
    calls[2].resolve();
    await drain(() => slot('product.save').status !== 'loading');
    assert.deepStrictEqual([slot('product.save').id, slot('product.save').status, slot('product.save').value.id], [3, 'done', 3]);
    // reset is also the ordinary "dismiss the error": error and kind go, value stays
    app.dispatch('contract/product.save/start', { id: 'x' });
    await drain(() => slot('product.save').status !== 'loading');
    assert.deepStrictEqual([slot('product.save').status, slot('product.save').kind], ['error', 'contract']);
    app.dispatch('contract/product.save/reset');
    assert.deepStrictEqual([slot('product.save').id, slot('product.save').status, slot('product.save').kind, slot('product.save').error, slot('product.save').value.id], [4, 'idle', null, null, 3]);
    assert.deepStrictEqual(errors, [], 'validateState accepted every transition');
  });

  it('cancel(slot) / cancelAll / dispose fan out to every mode; app.destroy() disposes', async () => {
    const { app, calls, effect, slot, dispatches } = mount();
    app.dispatch('contract/catalog.load/start');
    app.dispatch('contract/product.save/start', { id: 1, revision: 1, product: PRODUCT });
    assert.deepStrictEqual(calls.map((c) => c.signal?.aborted), [false, false]);
    effect.cancel('catalog.load');
    assert.deepStrictEqual(calls.map((c) => c.signal?.aborted), [true, false]);
    effect.cancelAll();
    assert.deepStrictEqual(calls.map((c) => c.signal?.aborted), [true, true]);
    await drain();
    assert.deepStrictEqual(dispatches, [], 'cancelled tasks dispatch nothing');
    assert.deepStrictEqual([slot('catalog.load').status, slot('product.save').status], ['loading', 'loading']);
    app.dispatch('contract/catalog.load/start');
    assert.strictEqual(calls.length, 3);
    app.destroy();
    assert.strictEqual(calls[2].signal?.aborted, true, 'destroy disposes the effect');
    // after dispose a start is ignored
    const { effect: e2, client } = mount();
    e2.dispose();
    e2({ op: 'catalog.load', input: null, id: 1, done: 'x' }, () => { throw new Error('must not dispatch'); });
    void client;
  });

  it('a thrown host value lands as a JC2058 outcome in state, never a string; a foreign client\'s non-outcome too; a host projectError is consulted first', async () => {
    const foreign = { contract: shop, invoke: async (/** @type {string} */ op) => { if (op === 'catalog.load') throw new Error('host bug'); return 'not an outcome'; } };
    const { actions, slice, schema } = contractAppBinding(shop, { ops: ['catalog.load', 'product.save'] });
    const validate = new JarenValidator().compile({ type: 'object', properties: { contract: schema } });
    /** @type {any[]} */
    const errors = [];
    const app = createApp({ state: { contract: slice }, view: [{ match: '$', body: ['main', {}] }], actions }, {
      schedule: sync, validateState: (s) => validate(s), onError: (e) => errors.push(e),
      effects: { contract: createContractEffect(foreign, { createTaskEffect }) },
    });
    app.dispatch('contract/catalog.load/start');
    await drain();
    const s = app.getState().contract['catalog.load'];
    assert.deepStrictEqual([s.status, s.error.code, s.error.message, s.meta.op, s.meta.attempt], ['error', 'JC2058', 'operation catalog.load failed in the host before an outcome was produced', 'catalog.load', 1]);
    assert.doesNotMatch(JSON.stringify(s), /host bug/, 'nothing of the thrown value crosses');
    app.dispatch('contract/product.save/start', { id: 1, revision: 1, product: PRODUCT });
    await drain();
    assert.deepStrictEqual([app.getState().contract['product.save'].status, app.getState().contract['product.save'].error.code], ['error', 'JC2058']);
    assert.deepStrictEqual(errors, [], 'the schema accepted the projected outcomes');
    // a host projectError that answers an outcome wins; one that answers garbage falls back
    const outcomes = [];
    const own = createContractEffect(foreign, { createTaskEffect, projectError: (err, props) => (props.op === 'catalog.load'
      ? { ok: false, kind: 'failure', error: { code: 'mine', message: 'm', status: null, details: null, retryable: false }, meta: { op: props.op, attempt: props.id, trace: null, revision: null, etag: null, notModified: false } }
      : 'garbage') });
    own({ op: 'catalog.load', input: null, id: 1, done: 'd' }, (name, payload) => outcomes.push(payload));
    await drain();
    assert.strictEqual(outcomes[0].error.error.code, 'mine');
    // a user projector that throws falls back as well
    const throwing = createContractEffect(foreign, { createTaskEffect, projectError: () => { throw new Error('x'); } });
    throwing({ op: 'catalog.load', input: null, id: 2, done: 'd' }, (name, payload) => outcomes.push(payload));
    await drain();
    assert.strictEqual(outcomes[1].error.error.code, 'JC2058');
  });

  it('host mistakes: an unknown op in the descriptor is JC1005 (JA2007 through the loop); bad arguments are JC1008', async () => {
    const { app, errors, client } = mount(undefined, undefined, {});
    app.dispatch('contract/catalog.load/start');
    const before = errors.length;
    // hand-written action naming an unknown op
    const effect = createContractEffect(client, { createTaskEffect });
    assert.throws(() => effect({ op: 'nope', id: 1, done: 'x' }, () => {}), (/** @type {any} */ e) => e.code === 'JC1005' && e instanceof TypeError);
    assert.throws(() => effect(null, () => {}), (/** @type {any} */ e) => e.code === 'JC1005');
    assert.strictEqual(errors.length, before);
    assert.throws(() => createContractEffect(client, /** @type {any} */ ({})), (/** @type {any} */ e) => e.code === 'JC1008' && /createTaskEffect/.test(e.message));
    assert.throws(() => createContractEffect(/** @type {any} */ ({}), { createTaskEffect }), (/** @type {any} */ e) => e.code === 'JC1008');
    assert.throws(() => createContractEffect(client, { createTaskEffect, projectError: /** @type {any} */ ('x') }), (/** @type {any} */ e) => e.code === 'JC1008');
    // malformed props reach the inner task effect's own TypeError (the TASKS.md contract)
    assert.throws(() => effect({ op: 'catalog.load' }, () => {}), TypeError);
  });
});
