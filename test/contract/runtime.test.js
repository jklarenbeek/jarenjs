//@ts-check
/**
 * @file The http binding over the runtime record: `runtime.uuid` is the
 * server trace and `runtime.now` the clock only where the explicit
 * `trace` and `now` options are absent (the record injects, it does not
 * replace), a malformed record is refused as a host error, and with no
 * record the binding behaves as it always did.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileContract } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import { createMemoryLedger } from '@jarenjs/contract/ledger';
import { createRuntime } from '@jarenjs/core/runtime';
import { load, shopHandlers, jsonReq, req } from './helpers.js';

const shop = compileContract(load('./fixtures/shop.contract.json'));
const SAVE = { revision: 1, product: { id: 1, name: 'x', price: 1 } };
const URL = '/api/products/1/master';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A counting identifier, so a trace is readable and reproducible. */
function counter(prefix) {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

describe('serveHttp — the runtime record', () => {
  it('generates the trace from runtime.uuid and stamps claims with runtime.now when neither option is given', async () => {
    // the ledger keeps its own clock for expiry, so it reads the same one
    const runtime = createRuntime({ uuid: counter('trace'), now: () => 1_700_000_000_000 });
    const ledger = createMemoryLedger({ now: runtime.now });
    const server = serveHttp(shop, shopHandlers(), { ledger, runtime });
    const a = await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'k1' }));
    const b = await server.dispatch(req('GET', '/api/catalog'));
    assert.strictEqual(a.status, 200);
    assert.strictEqual(a.headers['x-jaren-trace'], 'trace-1');
    assert.strictEqual(b.headers['x-jaren-trace'], 'trace-2');
    const record = ledger.lookup({ op: 'product.save', scope: '', key: 'k1' });
    assert.ok(record !== null);
    assert.strictEqual(record.createdAt, 1_700_000_000_000, 'the claim carries the record\'s clock');
  });

  it('lets the explicit trace and now win over the record (precedence, both directions)', async () => {
    const runtime = createRuntime({ uuid: counter('record'), now: () => 1_000 });
    const ledger = createMemoryLedger({ now: () => 1_000 });
    const server = serveHttp(shop, shopHandlers(), {
      ledger, runtime, trace: counter('explicit'), now: () => 2_000,
    });
    const a = await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'k2' }));
    assert.strictEqual(a.headers['x-jaren-trace'], 'explicit-1');
    const record = ledger.lookup({ op: 'product.save', scope: '', key: 'k2' });
    assert.strictEqual(record?.createdAt, 2_000);
    // only the record: the record wins over the built-in default
    const only = serveHttp(shop, shopHandlers(), { ledger, runtime });
    const b = await only.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'k3' }));
    assert.strictEqual(b.headers['x-jaren-trace'], 'record-1');
    assert.strictEqual(ledger.lookup({ op: 'product.save', scope: '', key: 'k3' })?.createdAt, 1_000);
  });

  it('behaves as it always did with no record: a v4 trace and the platform clock', async () => {
    const ledger = createMemoryLedger();
    const server = serveHttp(shop, shopHandlers(), { ledger });
    const before = Date.now();
    const a = await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'k4' }));
    assert.match(String(a.headers['x-jaren-trace']), UUID_V4);
    const record = ledger.lookup({ op: 'product.save', scope: '', key: 'k4' });
    assert.ok(record !== null && record.createdAt >= before && record.createdAt <= Date.now());
  });

  it('refuses a malformed record as a host error, naming the member', () => {
    const ledger = createMemoryLedger();
    assert.throws(() => serveHttp(shop, shopHandlers(), { ledger, runtime: /** @type {any} */ ({ clock: Date.now }) }),
      /JC1001.*options\.runtime: a runtime record has 'now', 'uuid', 'random', 'zoneProvider', not 'clock'/s);
    assert.throws(() => serveHttp(shop, shopHandlers(), { ledger, runtime: /** @type {any} */ ({ now: 5 }) }),
      /options\.runtime: runtime\.now is a function/);
    assert.throws(() => serveHttp(shop, shopHandlers(), { ledger, runtime: /** @type {any} */ ('now') }),
      /options\.runtime: a runtime record is an object/);
  });

  it('accepts a partial record and keeps the platform default for the rest', async () => {
    const ledger = createMemoryLedger({ now: () => 42 });
    const server = serveHttp(shop, shopHandlers(), { ledger, runtime: { now: () => 42 } });
    const a = await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'k5' }));
    assert.match(String(a.headers['x-jaren-trace']), UUID_V4);
    assert.strictEqual(ledger.lookup({ op: 'product.save', scope: '', key: 'k5' })?.createdAt, 42);
  });
});
