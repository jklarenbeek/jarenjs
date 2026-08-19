//@ts-check
/**
 * @file docs/APP-INTEGRATION.md, run verbatim: its two ```json blocks —
 * the contract and the app document — are extracted from the file,
 * composed exactly as the doc says (`state.contract = slice`, the
 * generated actions spread beside the app's own), validated against the
 * shipped `jaren-app.schema.json`, mounted headless with `validateState`
 * from the generated schema, and driven against a real `serveHttp`
 * dispatcher: reload → done, a conflicting save → error with the draft
 * and the last value untouched, a later save → done; the staleness
 * scenario the doc walks through, whose exhaust tail proves the
 * double-click runs once AND lands (03A).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { createApp, createTaskEffect } from '@jarenjs/app';
import { JarenValidator } from '@jarenjs/validate';
import { compileContract } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import { toFetchHandler } from '@jarenjs/contract/fetch';
import { createMemoryLedger } from '@jarenjs/contract/ledger';
import { openHttpClient } from '@jarenjs/contract/client';
import { contractAppBinding, createContractEffect } from '@jarenjs/contract/app';

const DOC = new URL('../../packages/contract/docs/APP-INTEGRATION.md', import.meta.url);
const load = (/** @type {string} */ rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));

/** The two json blocks of the doc: the contract, then the app document. */
function blocks() {
  const md = readFileSync(DOC, 'utf8');
  const found = [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
  assert.strictEqual(found.length, 2, 'APP-INTEGRATION.md carries exactly two json blocks: the contract and the app document');
  return { contractDoc: found[0], appDoc: found[1] };
}

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

describe('the worked example (docs/APP-INTEGRATION.md, run verbatim)', () => {
  const { contractDoc, appDoc } = blocks();
  const contract = compileContract(contractDoc);
  const { slice, actions, schema } = contractAppBinding(contract, { ops: ['catalog.load', 'product.save'] });
  const composed = { ...appDoc, state: { ...appDoc.state, contract: slice }, actions: { ...actions, ...appDoc.actions } };

  it('the composed document validates against the shipped app meta-schema; the contract compiles', () => {
    const validate = new JarenValidator()
      .addSchema(load('../../packages/json/schemas/jaren-query.schema.json'))
      .addSchema(load('../../packages/json/schemas/jaren-jslt.schema.json'))
      .compile(load('../../packages/app/schemas/jaren-app.schema.json'));
    assert.strictEqual(validate(composed), true, 'generated actions are ordinary query documents — no schema extension');
    assert.deepStrictEqual(contract.ids, ['catalog.load', 'product.save']);
    assert.deepStrictEqual(appDoc.state.contract, {}, 'the doc mounts the slice at state.contract');
  });

  /**
   * Mount the composed app over a real server whose handlers are the
   * doc's story: a catalog, and a save that conflicts on price 13.
   */
  function mountDoc() {
    /** @type {any[]} */
    let catalog = [{ id: 1, name: 'Kettle', price: 12 }, { id: 2, name: 'Teapot', price: 30 }];
    /** @type {{ url: string, init: any, resolve: () => void }[]} */
    const calls = [];
    let saved = 0;
    const server = serveHttp(contract, {
      'catalog.load': () => catalog,
      'product.save': (input, ctx) => {
        saved++;
        if (input.product.price === 13) return ctx.fail('conflict', {}, catalog[0]);
        catalog = catalog.map((p) => (p.id === input.id ? input.product : p));
        return input.product;
      },
    }, { ledger: createMemoryLedger() });
    const handler = toFetchHandler(server);
    const client = openHttpClient(contract, { fetch: (url, init) => new Promise((resolve, reject) => {
      calls.push({ url, init, resolve: () => handler(new Request('http://x' + url, init)).then(resolve, reject) });
      if (init.signal) init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }) });
    const validate = new JarenValidator().compile({
      type: 'object',
      required: ['contract', 'draft'],
      properties: { contract: schema, draft: { type: 'object' } },
    });
    /** @type {any[]} */
    const errors = [];
    /** @type {any[]} */
    const transitions = [];
    const app = createApp(composed, {
      schedule: (f) => f(),
      effects: { contract: createContractEffect(client, { createTaskEffect }) },
      validateState: (state) => validate(state),
      onError: (err) => errors.push(err),
    });
    app.subscribe((s) => transitions.push(s));
    return { app, calls, errors, transitions, saves: () => saved, slot: (/** @type {string} */ op) => app.getState().contract[op] };
  }

  it('reload → done with the catalog; a conflicting save → error, draft and value untouched; a later save → done', async () => {
    const { app, calls, errors, slot } = mountDoc();
    app.dispatch('contract/catalog.load/start', { since: '2026-01-01T00:00:00Z' });
    assert.deepStrictEqual(slot('catalog.load'), { id: 1, status: 'loading', kind: null, value: null, error: null, meta: null });
    assert.strictEqual(calls[0].url, '/api/catalog?since=2026-01-01T00%3A00%3A00Z');
    calls[0].resolve();
    await drain(() => slot('catalog.load').status !== 'loading');
    assert.strictEqual(slot('catalog.load').status, 'done');
    assert.deepStrictEqual(slot('catalog.load').value.map((/** @type {any} */ p) => p.name), ['Kettle', 'Teapot']);
    assert.strictEqual(slot('catalog.load').meta.attempt, 1);
    // the draft is the app's own state; a conflicting save
    app.dispatch('draft/name', 'Kettle XL');
    app.dispatch('contract/product.save/start', { id: 1, product: { ...app.getState().draft, price: 13 } });
    assert.strictEqual(calls[1].url, '/api/products/1');
    assert.strictEqual(calls[1].init.method, 'PUT');
    assert.ok(typeof calls[1].init.headers['idempotency-key'] === 'string', 'a required key was generated');
    calls[1].resolve();
    await drain(() => slot('product.save').status !== 'loading');
    const failed = slot('product.save');
    assert.deepStrictEqual([failed.status, failed.kind, failed.value, failed.error.code, failed.error.status], ['error', 'failure', null, 'conflict', 409]);
    assert.deepStrictEqual(failed.error.details, { id: 1, name: 'Kettle', price: 12 });
    assert.deepStrictEqual(app.getState().draft, { id: 1, name: 'Kettle XL', price: 12 }, 'the draft is untouched');
    // a later save lands; the failed value slot had nothing to keep, the catalog slot still has its list
    app.dispatch('contract/product.save/start', { id: 1, product: app.getState().draft });
    calls[2].resolve();
    await drain(() => slot('product.save').status !== 'loading');
    assert.deepStrictEqual([slot('product.save').status, slot('product.save').value, slot('product.save').error], ['done', { id: 1, name: 'Kettle XL', price: 12 }, null]);
    assert.strictEqual(slot('catalog.load').value.length, 2);
    assert.deepStrictEqual(errors, [], 'validateState accepted every transition');
  });

  it('the staleness scenario: two quick reloads, the older response is a provable no-op', async () => {
    const { app, calls, transitions, slot, saves } = mountDoc();
    app.dispatch('contract/catalog.load/start');
    app.dispatch('contract/catalog.load/start');
    assert.strictEqual(slot('catalog.load').id, 2);
    assert.strictEqual(calls[0].init.signal.aborted, true, 'switch: request 1 was aborted');
    calls[1].resolve();
    await drain(() => slot('catalog.load').status !== 'loading');
    assert.strictEqual(slot('catalog.load').status, 'done');
    const seen = transitions.length;
    // request 1 "arrives anyway": its completion is dispatched by hand with the stale id
    app.dispatch('contract/catalog.load/done', { id: 1, result: { ok: true, value: [], meta: { op: 'catalog.load', attempt: 1, trace: null, revision: null, etag: null, notModified: false } } });
    assert.strictEqual(slot('catalog.load').value.length, 2, 'the id guard kept id 2\'s result');
    assert.strictEqual(transitions.length, seen, 'no transition fired');
    // the exhaust command: a double start runs once — the second start is a state no-op, so the one completion lands
    app.dispatch('contract/product.save/start', { id: 2, product: { id: 2, name: 'Teapot', price: 31 } });
    app.dispatch('contract/product.save/start', { id: 2, product: { id: 2, name: 'Teapot', price: 31 } });
    assert.deepStrictEqual([slot('product.save').id, calls.length], [1, 3], 'one request for two starts; the slot stays at id 1');
    calls[2].resolve();
    await drain(() => slot('product.save').status !== 'loading');
    assert.strictEqual(saves(), 1, 'the handler ran once');
    assert.deepStrictEqual([slot('product.save').id, slot('product.save').status, slot('product.save').value], [1, 'done', { id: 2, name: 'Teapot', price: 31 }], 'the result landed');
    // reset releases the slot without touching id, value or meta
    app.dispatch('contract/product.save/reset');
    assert.deepStrictEqual([slot('product.save').id, slot('product.save').status, slot('product.save').value.price], [1, 'idle', 31]);
  });
});
