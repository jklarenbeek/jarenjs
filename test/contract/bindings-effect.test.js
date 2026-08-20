//@ts-check
/**
 * @file The 03 app binding over the new clients: ONE test body,
 * parameterized by binding, drives `contractAppBinding` +
 * `createContractEffect` headless over a `local` client and over a
 * `port` client (a real `servePort` behind a `MessageChannel`) with the
 * same generated documents and the same assertions as the HTTP run in
 * `app-binding.test.js` — the worked flow under `validateState`, the id
 * guard, the exhaust result-lands case, `reset`, the slot `kind`, and
 * cancellation dispatching nothing. What differs by construction is
 * asserted as such: a declared failure carries `status: null` on these
 * bindings (D6 — the member present, never omitted) where HTTP carries
 * 409, and `meta.trace` is still a server-generated string on both.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';

import { createApp, createTaskEffect } from '@jarenjs/app';
import { JarenValidator } from '@jarenjs/validate';
import { compileContract } from '@jarenjs/contract';
import { openLocalClient } from '@jarenjs/contract/local';
import { servePort, openPortClient } from '@jarenjs/contract/port';
import { contractAppBinding, createContractEffect } from '@jarenjs/contract/app';
import { load } from './helpers.js';

const shop = compileContract(load('./fixtures/shop.contract.json'));
const PRODUCT = { id: 1, name: 'x', price: 1 };
const sync = (/** @type {() => void} */ flush) => flush();

/** The four modes, one command each — the 03A "latest wins" pins. */
const MODES = compileContract({
  $contract: '0.1',
  operations: Object.fromEntries(['switch', 'exhaust', 'concat', 'parallel'].map((task) => [`run.${task}`, {
    kind: 'command',
    input: { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } },
    output: { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } },
    policy: { task },
  }])),
});

/** @type {{ close: () => void }[]} */
const opened = [];
after(() => { for (const closable of opened) closable.close(); });

/**
 * Deferred handlers: every invocation parks until the test answers it —
 * the binding-neutral twin of the http run's deferred fetch.
 * @param {Record<string, (input: any, ctx: any) => any>} impl
 */
function deferredHandlers(impl) {
  /** @type {{ op: string, input: any, signal: AbortSignal, resolve: () => void, fail: (err: unknown) => void }[]} */
  const calls = [];
  /** @type {Record<string, (input: any, ctx: any) => any>} */
  const handlers = {};
  for (const [id, fn] of Object.entries(impl)) {
    handlers[id] = (input, ctx) => new Promise((resolve, reject) => {
      calls.push({
        op: id, input, signal: ctx.signal,
        resolve: () => { resolve(fn(input, ctx)); },
        fail: (/** @type {unknown} */ err) => reject(err),
      });
    });
  }
  return { calls, handlers };
}

/** @param {import('@jarenjs/contract').Contract} contract @param {Record<string, any>} impl */
function localClient(contract, impl) {
  const { calls, handlers } = deferredHandlers(impl);
  const client = openLocalClient(contract, handlers);
  opened.push(client);
  return { client, calls };
}

/** @param {import('@jarenjs/contract').Contract} contract @param {Record<string, any>} impl */
function portClient(contract, impl) {
  const { calls, handlers } = deferredHandlers(impl);
  const { port1, port2 } = new MessageChannel();
  const server = servePort(contract, handlers, { channel: port1 });
  const client = openPortClient(contract, { channel: port2, timeoutMs: 0 });
  opened.push({ close: () => { server.close(); client.close(); port1.close(); port2.close(); } });
  return { client, calls };
}

/**
 * Drain microtasks, then wait (bounded) until `until` holds — the port
 * round-trip crosses several message hops.
 * @param {() => boolean} [until]
 */
async function drain(until = () => true) {
  for (let i = 0; i < 16; i++) await Promise.resolve();
  for (let n = 0; n < 200 && !until(); n++) await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

/**
 * Wait until the deferred-handler table has seen `n` calls (a port
 * request crosses the channel before the handler parks).
 * @param {{ length: number }} calls
 * @param {number} n
 */
function seen(calls, n) {
  return drain(() => calls.length >= n);
}

/**
 * Mount a contract's binding headless over a client, with every
 * completion dispatch and every transition recorded — the shape of the
 * http run's mount, minus the wire.
 * @param {import('@jarenjs/contract').Contract} contract
 * @param {{ client: any, calls: any[] }} opened
 * @param {any} [bindingOptions]
 */
function mount(contract, opened, bindingOptions = {}) {
  const { client, calls } = opened;
  const { slice, actions, schema } = contractAppBinding(contract, bindingOptions);
  const validate = new JarenValidator().compile({ type: 'object', required: ['contract'], properties: { contract: schema, draft: {} } });
  /** @type {any[]} */
  const dispatches = [];
  /** @type {any[]} */
  const transitions = [];
  /** @type {any[]} */
  const errors = [];
  const effect = createContractEffect(client, { createTaskEffect });
  const recording = Object.assign(
    (/** @type {any} */ props, /** @type {any} */ dispatch) => effect(props, (name, payload) => { dispatches.push([name, payload]); dispatch(name, payload); }),
    { cancel: effect.cancel, cancelAll: effect.cancelAll, dispose: effect.dispose });
  const app = createApp({
    state: { contract: slice, draft: null },
    view: [{ match: '$', body: ['main', {}] }],
    actions,
  }, {
    schedule: sync,
    effects: { contract: recording },
    validateState: (s) => validate(s),
    onError: (err) => errors.push(err),
  });
  app.subscribe((state) => transitions.push(state));
  const slot = (/** @type {string} */ op) => app.getState().contract[op];
  return { app, calls, dispatches, transitions, errors, effect, slot };
}

/**
 * The one body, over one binding.
 * @param {'local' | 'port'} name
 * @param {(contract: import('@jarenjs/contract').Contract, impl: Record<string, any>) => { client: any, calls: any[] }} openClient
 */
function suite(name, openClient) {
  const shopImpl = () => ({
    'catalog.load': () => ({ revision: 1, products: [{ id: 1, name: 'a', price: 1 }] }),
    'product.save': (/** @type {any} */ input, /** @type {any} */ ctx) => (input.id === 9 ? ctx.fail('conflict', {}, { current: PRODUCT }) : { ...PRODUCT, id: input.id }),
    'product.search': () => [],
    'product.remove': () => true,
  });
  const OPS = { ops: ['catalog.load', 'product.save', 'product.remove'] };

  describe(`the contract effect over a ${name} client — 03/03A's assertions`, () => {
    it('start → loading; done with value and meta (trace a string); a declared failure → error with status null, value untouched; a pre-send refusal is JC2050; the schema accepts every transition', async () => {
      const m = mount(shop, openClient(shop, shopImpl()), OPS);
      m.app.dispatch('contract/catalog.load/start', { since: '2026-01-01T00:00:00Z' });
      assert.deepStrictEqual(m.slot('catalog.load'), { id: 1, status: 'loading', kind: null, value: null, error: null, meta: null });
      await seen(m.calls, 1);
      assert.deepStrictEqual([m.calls[0].op, m.calls[0].input], ['catalog.load', { since: '2026-01-01T00:00:00Z' }]);
      m.calls[0].resolve();
      await drain(() => m.slot('catalog.load').status !== 'loading');
      const done = m.slot('catalog.load');
      assert.deepStrictEqual([done.id, done.status, done.kind, done.error], [1, 'done', null, null]);
      assert.deepStrictEqual(done.value, { revision: 1, products: [{ id: 1, name: 'a', price: 1 }] });
      assert.deepStrictEqual([done.meta.op, done.meta.attempt, typeof done.meta.trace], ['catalog.load', 1, 'string']);
      assert.deepStrictEqual(m.dispatches[0][0], 'contract/catalog.load/done');
      assert.strictEqual(m.dispatches[0][1].result.ok, true);
      // a command that succeeds
      m.app.dispatch('contract/product.save/start', { id: 3, revision: 1, product: PRODUCT });
      await seen(m.calls, 2);
      m.calls[1].resolve();
      await drain(() => m.slot('product.save').status !== 'loading');
      assert.deepStrictEqual([m.slot('product.save').status, m.slot('product.save').value], ['done', { ...PRODUCT, id: 3 }]);
      // a command that fails with a declared error keeps the last good value — and status is null on this binding
      m.app.dispatch('contract/product.save/start', { id: 9, revision: 1, product: PRODUCT });
      assert.deepStrictEqual([m.slot('product.save').id, m.slot('product.save').status], [2, 'loading']);
      await seen(m.calls, 3);
      m.calls[2].resolve();
      await drain(() => m.slot('product.save').status !== 'loading');
      const failed = m.slot('product.save');
      assert.deepStrictEqual([failed.status, failed.kind, failed.value], ['error', 'failure', { ...PRODUCT, id: 3 }]);
      assert.deepStrictEqual(failed.error, { code: 'conflict', message: 'operation product.save failed with conflict', status: null, details: { current: PRODUCT }, retryable: false });
      assert.strictEqual(failed.meta.attempt, 2);
      // a pre-send refusal lands the same way, nothing invoked
      m.app.dispatch('contract/product.save/start', { id: 'x' });
      await drain(() => m.slot('product.save').status !== 'loading');
      assert.strictEqual(m.calls.length, 3, 'nothing ran');
      assert.deepStrictEqual([m.slot('product.save').status, m.slot('product.save').kind, m.slot('product.save').error.code], ['error', 'contract', 'JC2050']);
      // a start clears kind with error; the next success keeps it null
      m.app.dispatch('contract/product.save/start', { id: 5, revision: 1, product: PRODUCT });
      assert.deepStrictEqual([m.slot('product.save').status, m.slot('product.save').kind, m.slot('product.save').error], ['loading', null, null]);
      await seen(m.calls, 4);
      m.calls[3].resolve();
      await drain(() => m.slot('product.save').status !== 'loading');
      assert.deepStrictEqual([m.slot('product.save').status, m.slot('product.save').kind, m.slot('product.save').value.id], ['done', null, 5]);
      assert.deepStrictEqual(m.errors, [], 'validateState accepted every transition');
    });

    it('the id guard: a superseded switch read dispatches once with the newer result; an out-of-order older completion is rejected', async () => {
      const m = mount(shop, openClient(shop, shopImpl()), OPS);
      m.app.dispatch('contract/catalog.load/start');   // id 1
      m.app.dispatch('contract/catalog.load/start');   // id 2 — switch: attempt 1 is aborted
      assert.strictEqual(m.slot('catalog.load').id, 2);
      await seen(m.calls, 2);
      assert.strictEqual(m.calls[0].signal.aborted, true, 'the predecessor was told to stop');
      m.calls[0].resolve();
      m.calls[1].resolve();
      await drain(() => m.slot('catalog.load').status !== 'loading');
      assert.deepStrictEqual([m.slot('catalog.load').status, m.slot('catalog.load').meta.attempt], ['done', 2]);
      assert.strictEqual(m.dispatches.filter(([n]) => n === 'contract/catalog.load/done').length, 1, 'the cancelled attempt dispatched nothing');
      const seenTransitions = m.transitions.length;
      m.app.dispatch('contract/catalog.load/done', { id: 1, result: { ok: true, value: { revision: 99, products: [] }, meta: { op: 'catalog.load', attempt: 1, trace: null, revision: null, etag: null, notModified: false } } });
      assert.strictEqual(m.slot('catalog.load').value.revision, 1, 'state keeps id 2\'s result');
      assert.strictEqual(m.transitions.length, seenTransitions, 'no transition fired for the stale completion');
    });

    it('exhaust: a double-dispatched command runs the handler once AND its result lands; the slot releases for the next start', async () => {
      let saves = 0;
      const m = mount(shop, openClient(shop, {
        ...shopImpl(),
        'product.save': (/** @type {any} */ input) => { saves++; return { ...PRODUCT, id: input.id }; },
      }), OPS);
      const before = m.transitions.length;
      m.app.dispatch('contract/product.save/start', { id: 1, revision: 1, product: PRODUCT });
      assert.strictEqual(m.transitions.length, before + 1);
      m.app.dispatch('contract/product.save/start', { id: 1, revision: 1, product: PRODUCT });
      assert.strictEqual(m.transitions.length, before + 1, 'the duplicate start fired no transition');
      assert.deepStrictEqual([m.slot('product.save').id, m.slot('product.save').status], [1, 'loading']);
      await seen(m.calls, 1);
      assert.strictEqual(m.calls.length, 1, 'exhaust: the duplicate start invoked nothing');
      m.calls[0].resolve();
      await drain(() => m.slot('product.save').status !== 'loading');
      assert.strictEqual(saves, 1, 'the handler ran once');
      assert.deepStrictEqual([m.slot('product.save').id, m.slot('product.save').status, m.slot('product.save').kind, m.slot('product.save').value],
        [1, 'done', null, { ...PRODUCT, id: 1 }], 'the single completion LANDS');
      assert.strictEqual(m.dispatches.filter(([n]) => n === 'contract/product.save/done').length, 1);
      m.app.dispatch('contract/product.save/start', { id: 2, revision: 1, product: PRODUCT });
      await seen(m.calls, 2);
      assert.deepStrictEqual([m.slot('product.save').id, m.calls.length], [2, 2], 'the slot released');
      m.calls[1].resolve();
      await drain(() => m.slot('product.save').status !== 'loading');
      assert.strictEqual(saves, 2);
    });

    it('every mode, one slot: switch newest wins; exhaust first wins and lands; concat and parallel are "latest wins" with status honest', async () => {
      /** @type {string[]} */
      const ran = [];
      const impl = Object.fromEntries(MODES.ids.map((id) => [id, (/** @type {any} */ input) => { ran.push(`${id}:${input.n}`); return { n: input.n }; }]));
      const m = mount(MODES, openClient(MODES, impl));
      const start = (/** @type {string} */ mode, /** @type {number} */ n) => m.app.dispatch(`contract/run.${mode}/start`, { n });
      const dones = (/** @type {string} */ mode) => m.dispatches.filter(([n]) => n === `contract/run.${mode}/done`).length;
      // concat: three starts queue in the effect; state counts every start
      start('concat', 1); start('concat', 2); start('concat', 3);
      await seen(m.calls, 1);
      assert.deepStrictEqual([m.slot('run.concat').id, m.slot('run.concat').status, m.calls.length], [3, 'loading', 1], 'one in flight, two queued');
      m.calls[0].resolve();
      await seen(m.calls, 2);
      assert.deepStrictEqual([m.slot('run.concat').status, m.slot('run.concat').value, dones('concat')], ['loading', null, 1], 'completion 1 is rejected by the guard (id 1 ≠ 3)');
      m.calls[1].resolve();
      await seen(m.calls, 3);
      m.calls[2].resolve();
      await drain(() => m.slot('run.concat').status !== 'loading');
      assert.deepStrictEqual([m.slot('run.concat').id, m.slot('run.concat').status, m.slot('run.concat').value, m.slot('run.concat').meta.attempt, dones('concat')],
        [3, 'done', { n: 3 }, 3, 3], 'the third result lands at id 3');
      assert.deepStrictEqual(ran, ['run.concat:1', 'run.concat:2', 'run.concat:3'], 'all three ran, in order');
      // parallel: three at once; the newest id lands whenever it arrives
      ran.length = 0;
      start('parallel', 1); start('parallel', 2); start('parallel', 3);
      await seen(m.calls, 6);
      assert.deepStrictEqual([m.slot('run.parallel').id, m.slot('run.parallel').status], [3, 'loading']);
      m.calls[5].resolve();   // the newest answers first
      await drain(() => m.slot('run.parallel').status !== 'loading');
      assert.deepStrictEqual([m.slot('run.parallel').status, m.slot('run.parallel').value, m.slot('run.parallel').meta.attempt], ['done', { n: 3 }, 3]);
      m.calls[3].resolve(); m.calls[4].resolve();
      await drain(() => dones('parallel') === 3);
      assert.deepStrictEqual([m.slot('run.parallel').value, m.slot('run.parallel').meta.attempt], [{ n: 3 }, 3], 'the older results were rejected by the guard');
      // switch: newest wins — the predecessor is aborted
      ran.length = 0;
      start('switch', 1); start('switch', 2);
      await seen(m.calls, 8);
      assert.deepStrictEqual([m.slot('run.switch').id, m.calls[6].signal.aborted], [2, true]);
      m.calls[7].resolve();
      await drain(() => m.slot('run.switch').status !== 'loading');
      assert.deepStrictEqual([m.slot('run.switch').status, m.slot('run.switch').value, dones('switch')], ['done', { n: 2 }, 1]);
      // exhaust: first wins — the second start is a state no-op, the first result lands
      ran.length = 0;
      start('exhaust', 1); start('exhaust', 2);
      await seen(m.calls, 9);
      assert.deepStrictEqual([m.slot('run.exhaust').id, m.calls.length], [1, 9]);
      m.calls[8].resolve();
      await drain(() => m.slot('run.exhaust').status !== 'loading');
      assert.deepStrictEqual([m.slot('run.exhaust').id, m.slot('run.exhaust').status, m.slot('run.exhaust').value, dones('exhaust')], [1, 'done', { n: 1 }, 1]);
      assert.deepStrictEqual(ran, ['run.exhaust:1']);
      assert.deepStrictEqual(m.errors, [], 'validateState accepted every transition');
    });

    it('reset releases a slot the host cancelled: start while loading is a state no-op; reset → idle with id/value/meta kept; a late completion of the cancelled id is rejected', async () => {
      const m = mount(shop, openClient(shop, {
        ...shopImpl(),
        'product.save': (/** @type {any} */ input) => ({ ...PRODUCT, id: input.id }),
      }), OPS);
      m.app.dispatch('contract/product.save/start', { id: 1, revision: 1, product: PRODUCT });
      await seen(m.calls, 1);
      m.calls[0].resolve();
      await drain(() => m.slot('product.save').status !== 'loading');
      const landed = m.slot('product.save');
      assert.deepStrictEqual([landed.id, landed.status, landed.value.id], [1, 'done', 1]);
      // a second attempt the host cancels: nothing dispatched, the slot stays loading
      m.app.dispatch('contract/product.save/start', { id: 2, revision: 1, product: PRODUCT });
      await seen(m.calls, 2);
      m.effect.cancel('product.save');
      // the cancel crosses as a frame on the port binding — wait for the hop
      await drain(() => m.calls[1].signal.aborted);
      assert.strictEqual(m.calls[1].signal.aborted, true);
      assert.strictEqual(m.dispatches.length, 1, 'the cancelled attempt dispatched nothing');
      assert.strictEqual(m.slot('product.save').status, 'loading');
      const seenTransitions = m.transitions.length;
      m.app.dispatch('contract/product.save/start', { id: 3, revision: 1, product: PRODUCT });
      assert.deepStrictEqual([m.slot('product.save').id, m.calls.length, m.transitions.length], [2, 2, seenTransitions], 'start while loading: no-op');
      // reset: the one way out — status idle, kind/error null; id, value, meta untouched
      m.app.dispatch('contract/product.save/reset');
      assert.deepStrictEqual(m.slot('product.save'), { id: 2, status: 'idle', kind: null, value: landed.value, error: null, meta: landed.meta });
      m.app.dispatch('contract/product.save/start', { id: 3, revision: 1, product: PRODUCT });
      await seen(m.calls, 3);
      assert.deepStrictEqual([m.slot('product.save').id, m.slot('product.save').status], [3, 'loading']);
      // a late completion of the cancelled attempt (id 2) is rejected by the id guard
      const before = m.transitions.length;
      m.app.dispatch('contract/product.save/done', { id: 2, result: { ok: true, value: { ...PRODUCT, id: 2 }, meta: { op: 'product.save', attempt: 2, trace: null, revision: null, etag: null, notModified: false } } });
      assert.deepStrictEqual([m.slot('product.save').status, m.slot('product.save').value.id, m.transitions.length], ['loading', 1, before]);
      m.calls[2].resolve();
      await drain(() => m.slot('product.save').status !== 'loading');
      assert.deepStrictEqual([m.slot('product.save').id, m.slot('product.save').status, m.slot('product.save').value.id], [3, 'done', 3]);
      // reset is also the ordinary "dismiss the error": error and kind go, value stays
      m.app.dispatch('contract/product.save/start', { id: 'x' });
      await drain(() => m.slot('product.save').status !== 'loading');
      assert.deepStrictEqual([m.slot('product.save').status, m.slot('product.save').kind], ['error', 'contract']);
      m.app.dispatch('contract/product.save/reset');
      assert.deepStrictEqual([m.slot('product.save').id, m.slot('product.save').status, m.slot('product.save').kind, m.slot('product.save').error, m.slot('product.save').value.id], [4, 'idle', null, null, 3]);
      assert.deepStrictEqual(m.errors, [], 'validateState accepted every transition');
    });
  });
}

suite('local', localClient);
suite('port', portClient);
