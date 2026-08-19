//@ts-check
/**
 * @file `contractAppBinding` + `createContractEffect` in a headless
 * `createApp`: the generated slice/actions/schema; `validateState` from
 * the generated schema accepts every transition of the worked flow and
 * rejects a hand-corrupted status; the id guard rejects an out-of-order
 * older response; cancellation dispatches nothing; ONE `contract` effect
 * routes a `switch` read and an `exhaust` command to their modes; a
 * thrown host value lands as a `JC2058` outcome; `cancel`/`dispose`
 * fan out; the host errors `JC1005`/`JC1007`/`JC1008`.
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
  /** @type {{ url: string, init: any, resolve: () => void, signal: AbortSignal | undefined }[]} */
  const calls = [];
  const fetch = (/** @type {string} */ url, /** @type {any} */ init) => new Promise((resolve, reject) => {
    const call = {
      url, init, signal: init.signal,
      resolve: () => { handler(new Request('http://x' + url, init)).then(resolve, reject); },
    };
    if (init.signal) init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    calls.push(call);
  });
  return { calls, fetch };
}

/**
 * Mount the shop binding headless over a real server, with every
 * completion dispatch and every transition recorded.
 * @param {Record<string, any>} [handlers]
 * @param {any} [bindingOptions]
 * @param {any} [appOptions]
 */
function mount(handlers = {}, bindingOptions = {}, appOptions = {}) {
  const server = serveHttp(shop, { ...shopHandlers(), ...handlers }, { ledger: createMemoryLedger(), onError: () => {} });
  const { calls, fetch } = deferredFetch(toFetchHandler(server));
  const client = openHttpClient(shop, { fetch });
  const { slice, actions, schema } = contractAppBinding(shop, { ops: ['catalog.load', 'product.save', 'product.remove'], ...bindingOptions });
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

describe('contractAppBinding — the generated documents', () => {
  it('slice, actions, schema and effect name; the schema validates the slice; options are checked', () => {
    const { slice, actions, schema, effect } = contractAppBinding(shop);
    assert.strictEqual(effect, 'contract');
    assert.deepStrictEqual(Object.keys(slice), shop.ids);
    assert.deepStrictEqual(slice['catalog.load'], { id: 0, status: 'idle', value: null, error: null, meta: null });
    assert.deepStrictEqual(Object.keys(actions), shop.ids.flatMap((id) => [`contract/${id}/start`, `contract/${id}/done`]));
    // the start action is TASKS.md's shape: the increment expression twice, status loading, error cleared, one contract effect
    assert.deepStrictEqual(actions['contract/catalog.load/start'], {
      patch: [
        { op: 'replace', path: '/contract/catalog.load/id', value: { $add: ["$.contract['catalog.load'].id", 1] } },
        { op: 'replace', path: '/contract/catalog.load/status', value: 'loading' },
        { op: 'replace', path: '/contract/catalog.load/error', value: null },
      ],
      effects: [{ run: 'contract', with: { op: 'catalog.load', input: '$payload', id: { $add: ["$.contract['catalog.load'].id", 1] }, done: 'contract/catalog.load/done', slot: 'catalog.load' } }],
    });
    assert.deepStrictEqual(actions['contract/catalog.load/done'].$if[0], { $eq: ['$payload.id', "$.contract['catalog.load'].id"] }, 'the id guard is first');
    assert.strictEqual(JSON.stringify(actions).includes('"mode"'), false, 'the task mode never appears in the document');
    assert.doesNotThrow(() => JSON.parse(JSON.stringify({ slice, actions, schema })));
    // the schema: per op a slot; value = output schema or null; $defs carried with an $id
    const validate = new JarenValidator().compile(schema);
    assert.strictEqual(validate(slice), true);
    assert.strictEqual(schema.$id, 'urn:jaren:contract-app:shop');
    assert.deepStrictEqual(Object.keys(schema.$defs), ['Product', 'Catalog', 'Conflict']);
    assert.deepStrictEqual(schema.properties['catalog.load'].properties.value, { anyOf: [{ type: 'null' }, { $ref: '#/$defs/Catalog' }] });
    assert.strictEqual(schema.properties['image.bytes'].properties.value, true, 'output true → value true');
    assert.strictEqual(validate({ ...slice, 'catalog.load': { ...slice['catalog.load'], status: 'nonsense' } }), false);
    assert.strictEqual(validate({ ...slice, 'catalog.load': { ...slice['catalog.load'], status: 'done', value: { revision: 'x' } } }), false, 'value is checked against the output schema through $defs');
    assert.strictEqual(validate({ ...slice, 'catalog.load': { ...slice['catalog.load'], status: 'done', value: { revision: 1, products: [] } } }), true);
    // options: namespace, statePath, ops
    const custom = contractAppBinding(shop, { namespace: 'api:', statePath: '/ui/api', ops: ['product.save'] });
    assert.deepStrictEqual(Object.keys(custom.actions), ['api:product.save/start', 'api:product.save/done']);
    assert.strictEqual(custom.actions['api:product.save/start'].patch[0].path, '/ui/api/product.save/id');
    assert.strictEqual(custom.actions['api:product.save/start'].patch[0].value.$add[0], "$.ui.api['product.save'].id");
    assert.deepStrictEqual(Object.keys(custom.slice), ['product.save']);
    const noDefs = contractAppBinding(compileContract({ $contract: '0.1', operations: { a: { kind: 'read', output: true } } }));
    assert.strictEqual(noDefs.schema.$id, undefined, 'no $defs → no embedded resource');
    assert.throws(() => contractAppBinding(shop, { ops: ['nope'] }), (/** @type {any} */ e) => e.code === 'JC1007' && e instanceof TypeError);
    assert.throws(() => contractAppBinding(shop, { statePath: 'contract' }), (/** @type {any} */ e) => e.code === 'JC1007');
    assert.throws(() => contractAppBinding(shop, { statePath: '/a.b' }), (/** @type {any} */ e) => e.code === 'JC1007');
    assert.throws(() => contractAppBinding(shop, { namespace: /** @type {any} */ (1) }), (/** @type {any} */ e) => e.code === 'JC1007');
    assert.throws(() => contractAppBinding(/** @type {any} */ ({})), (/** @type {any} */ e) => e.code === 'JC1007');
    // a subscribe operation cannot exist in a compiled 0.1 contract; a hand-built one is refused as uncarriable
    const fake = { ids: ['s'], operations: { s: { kind: 'subscribe', output: { schema: true } } }, $defs: {}, id: null };
    assert.throws(() => contractAppBinding(/** @type {any} */ (fake)), (/** @type {any} */ e) => e.code === 'JC1007' && /subscribe/.test(e.message));
  });
});

describe('the contract effect in a headless app — the worked flow under validateState', () => {
  it('start → loading; the server answers → done with value and meta; a declared failure → error, value untouched; the schema accepts every transition', async () => {
    const { app, calls, slot, errors, dispatches } = mount({ 'product.save': (input, ctx) => (input.id === 9 ? ctx.fail('conflict', {}, { current: PRODUCT }) : { ...PRODUCT, id: input.id }) });
    app.dispatch('contract/catalog.load/start', { since: '2026-01-01T00:00:00Z' });
    assert.deepStrictEqual(slot('catalog.load'), { id: 1, status: 'loading', value: null, error: null, meta: null });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, '/api/catalog?since=2026-01-01T00%3A00%3A00Z');
    calls[0].resolve();
    await drain(() => slot('catalog.load').status !== 'loading');
    const done = slot('catalog.load');
    assert.deepStrictEqual([done.id, done.status, done.error], [1, 'done', null]);
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
    assert.deepStrictEqual([failed.status, failed.value], ['error', { ...PRODUCT, id: 3 }]);
    assert.deepStrictEqual(failed.error, { code: 'conflict', message: 'operation product.save failed with conflict', status: 409, details: { current: PRODUCT }, retryable: false });
    assert.strictEqual(failed.meta.attempt, 2);
    // a pre-send refusal lands the same way, no request made
    app.dispatch('contract/product.save/start', { id: 'x' });
    await drain(() => slot('product.save').status !== 'loading');
    assert.strictEqual(calls.length, 3, 'nothing was sent');
    assert.deepStrictEqual([slot('product.save').status, slot('product.save').error.code], ['error', 'JC2050']);
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

  it('one effect, two modes: a superseded switch read dispatches once with the newer result; an exhaust command double-dispatched runs the handler once', async () => {
    let saves = 0;
    const { app, calls, slot, dispatches } = mount({ 'product.save': (input) => { saves++; return { ...PRODUCT, id: input.id }; } });
    // the read: switch
    app.dispatch('contract/catalog.load/start');
    app.dispatch('contract/catalog.load/start');
    assert.strictEqual(calls.length, 2);
    calls[0].resolve();   // the aborted one; its fetch rejects with the abort reason first
    calls[1].resolve();
    await drain(() => slot('catalog.load').status !== 'loading');
    assert.deepStrictEqual(dispatches.filter(([n]) => n === 'contract/catalog.load/done').length, 1);
    assert.strictEqual(slot('catalog.load').meta.attempt, 2);
    // the command: exhaust — the second start increments the id but the effect ignores it
    app.dispatch('contract/product.save/start', { id: 1, revision: 1, product: PRODUCT });
    app.dispatch('contract/product.save/start', { id: 1, revision: 1, product: PRODUCT });
    assert.strictEqual(slot('product.save').id, 2);
    assert.strictEqual(calls.length, 3, 'exhaust: the duplicate start made no request');
    calls[2].resolve();
    await drain(() => saves === 1 && dispatches.some(([n]) => n === 'contract/product.save/done'));
    assert.strictEqual(saves, 1, 'the handler ran once');
    // the completion carries id 1 against a slot at 2: rejected by the guard — honest state: still loading until the next start
    assert.deepStrictEqual([slot('product.save').status, slot('product.save').value], ['loading', null]);
    assert.strictEqual(dispatches.filter(([n]) => n === 'contract/product.save/done').length, 1);
    // product.remove is a command too (exhaust by default) — its own slot, independent of product.save's
    app.dispatch('contract/product.remove/start', { id: 5 });
    assert.strictEqual(calls.length, 4);
    calls[3].resolve();
    await drain(() => slot('product.remove').status !== 'loading');
    assert.strictEqual(slot('product.remove').status, 'done');
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
