//@ts-check
/**
 * @file The contract bindings over the runtime record: `runtime.uuid` is
 * the http/local/port server trace, the port client's id and the http
 * client's idempotency key, `runtime.now` the clock a ledger claim and a
 * key record are stamped with, and `runtime.random` the retry jitter —
 * each only where the explicit `trace`, `keys` and `now` options are
 * absent (the record injects, it does not replace), a malformed record
 * is refused as the binding's own host error, and with no record every
 * binding behaves as it always did.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { compileContract } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import { openLocalClient } from '@jarenjs/contract/local';
import { servePort, openPortClient } from '@jarenjs/contract/port';
import { openHttpClient } from '@jarenjs/contract/client';
import { createMemoryLedger } from '@jarenjs/contract/ledger';
import { createRuntime, RUNTIME_MEMBERS } from '@jarenjs/core/runtime';
import { load, shopHandlers, jsonReq, req } from './helpers.js';

const shop = compileContract(load('./fixtures/shop.contract.json'));
const SAVE = { revision: 1, product: { id: 1, name: 'x', price: 1 } };
/** The same save as a CLIENT sends it: the path member rides in the input. */
const CLIENT_SAVE = { id: 1, revision: 1, product: { id: 1, name: 'x', price: 1 } };
const SAVE_URL = '/api/products/1/master';
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
    const a = await server.dispatch(jsonReq('PUT', SAVE_URL, SAVE, { 'idempotency-key': 'k1' }));
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
    const a = await server.dispatch(jsonReq('PUT', SAVE_URL, SAVE, { 'idempotency-key': 'k2' }));
    assert.strictEqual(a.headers['x-jaren-trace'], 'explicit-1');
    const record = ledger.lookup({ op: 'product.save', scope: '', key: 'k2' });
    assert.strictEqual(record?.createdAt, 2_000);
    // only the record: the record wins over the built-in default
    const only = serveHttp(shop, shopHandlers(), { ledger, runtime });
    const b = await only.dispatch(jsonReq('PUT', SAVE_URL, SAVE, { 'idempotency-key': 'k3' }));
    assert.strictEqual(b.headers['x-jaren-trace'], 'record-1');
    assert.strictEqual(ledger.lookup({ op: 'product.save', scope: '', key: 'k3' })?.createdAt, 1_000);
  });

  it('behaves as it always did with no record: a v4 trace and the platform clock', async () => {
    const ledger = createMemoryLedger();
    const server = serveHttp(shop, shopHandlers(), { ledger });
    const before = Date.now();
    const a = await server.dispatch(jsonReq('PUT', SAVE_URL, SAVE, { 'idempotency-key': 'k4' }));
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
    const a = await server.dispatch(jsonReq('PUT', SAVE_URL, SAVE, { 'idempotency-key': 'k5' }));
    assert.match(String(a.headers['x-jaren-trace']), UUID_V4);
    assert.strictEqual(ledger.lookup({ op: 'product.save', scope: '', key: 'k5' })?.createdAt, 42);
  });
});

/**
 * A seeded source: the same sequence every run, so a jitter draw is a
 * number a test can name.
 * @param {number[]} draws
 */
function scripted(draws) {
  let i = 0;
  return () => draws[i++ % draws.length];
}

describe('every binding and the memory ledger over one runtime record', () => {
  /** The one record a deterministic run configures. */
  const record = () => createRuntime({ uuid: counter('id'), now: () => 1_700_000_000_000, random: scripted([0.5]) });

  it('local: the trace is the record\'s uuid; an explicit trace wins; no record is a v4 uuid', async () => {
    const fromRecord = openLocalClient(shop, shopHandlers(), { runtime: record() });
    const a = await fromRecord.invoke('catalog.load');
    const b = await fromRecord.invoke('catalog.load');
    assert.deepStrictEqual([a.meta.trace, b.meta.trace], ['id-1', 'id-2']);
    const explicit = openLocalClient(shop, shopHandlers(), { runtime: record(), trace: counter('explicit') });
    assert.strictEqual((await explicit.invoke('catalog.load')).meta.trace, 'explicit-1');
    const plain = openLocalClient(shop, shopHandlers());
    assert.match(String((await plain.invoke('catalog.load')).meta.trace), UUID_V4);
    assert.throws(() => openLocalClient(shop, shopHandlers(), { runtime: /** @type {any} */ ({ clock: Date.now }) }),
      /JC1001.*options\.runtime: a runtime record has 'now', 'uuid', 'random', 'zoneProvider', not 'clock'/s);
  });

  it('port: the server trace and the client id prefix are the record\'s; explicit trace wins; no record is v4', async () => {
    const { port1, port2 } = new MessageChannel();
    /** @type {any[]} */
    const frames = [];
    const raw = port2.postMessage.bind(port2);
    port2.postMessage = (/** @type {any} */ message) => {
      frames.push(message);
      raw(message);
    };
    const runtime = record();
    const server = servePort(shop, shopHandlers(), { channel: port1, runtime });
    const client = openPortClient(shop, { channel: port2, runtime });
    try {
      const a = await client.invoke('catalog.load');
      const b = await client.invoke('catalog.load');
      // the client id is the FIRST identifier the record minted (the
      // client was opened after the server, which minted none at open)
      assert.ok(frames.every((frame) => String(frame.id).startsWith('id-1:')), `every request id carries the client prefix: ${JSON.stringify(frames.map((f) => f.id))}`);
      assert.deepStrictEqual([a.meta.trace, b.meta.trace], ['id-2', 'id-3'], 'the server traces follow from the same counter');
    }
    finally {
      client.close();
      server.close();
      port1.close();
      port2.close();
    }
    const pair = new MessageChannel();
    const explicit = servePort(shop, shopHandlers(), { channel: pair.port1, runtime: record(), trace: counter('explicit') });
    const plainClient = openPortClient(shop, { channel: pair.port2 });
    try {
      assert.strictEqual((await plainClient.invoke('catalog.load')).meta.trace, 'explicit-1');
    }
    finally {
      plainClient.close();
      explicit.close();
      pair.port1.close();
      pair.port2.close();
    }
    const plainPair = new MessageChannel();
    /** @type {any[]} */
    const plainFrames = [];
    const plainRaw = plainPair.port2.postMessage.bind(plainPair.port2);
    plainPair.port2.postMessage = (/** @type {any} */ message) => {
      plainFrames.push(message);
      plainRaw(message);
    };
    const plainServer = servePort(shop, shopHandlers(), { channel: plainPair.port1 });
    const plain = openPortClient(shop, { channel: plainPair.port2 });
    try {
      const o = await plain.invoke('catalog.load');
      assert.match(String(o.meta.trace), UUID_V4);
      assert.match(String(plainFrames[0].id).split(':')[0], UUID_V4, 'the client id is a v4 uuid with no record');
    }
    finally {
      plain.close();
      plainServer.close();
      plainPair.port1.close();
      plainPair.port2.close();
    }
    assert.throws(() => servePort(shop, shopHandlers(), { channel: new MessageChannel().port1, runtime: /** @type {any} */ ({ now: 1 }) }),
      /JC1001.*options\.runtime: runtime\.now is a function/s);
    assert.throws(() => openPortClient(shop, { channel: new MessageChannel().port1, runtime: /** @type {any} */ ('now') }),
      /JC1008.*options\.runtime: a runtime record is an object/s);
  });

  it('http client: keys, key-record stamps and retry jitter are the record\'s; explicit keys/now win; no record is v4 and Math.random', async () => {
    /** @type {string[]} */
    const sent = [];
    /** @type {number[]} */
    const delays = [];
    let calls = 0;
    const fetch = async (/** @type {string} */ _url, /** @type {any} */ init) => {
      calls++;
      sent.push(init.headers['idempotency-key']);
      if (calls === 1) throw new TypeError('offline');
      return new Response(JSON.stringify({ id: 1, name: 'x', price: 1 }), { status: 200, headers: { 'x-jaren-trace': 't' } });
    };
    /** @type {any} */
    let stored;
    const storage = { read: () => stored, write: (/** @type {any} */ value) => { stored = value; } };
    // product.save declares idempotency and retry { max: 2 }; the memory
    // storage keeps the key record with its `at` stamp until the outcome settles
    /** @type {any[]} */
    const stamps = [];
    const recording = { read: () => stored, write: (/** @type {any} */ value) => {
      stored = value;
      const records = value?.['jaren-contract']?.shop?.['product.save'];
      if (records) for (const key of Object.keys(records)) stamps.push([key, records[key].at]);
    } };
    void storage;
    const client = openHttpClient(shop, { fetch, storage: recording, runtime: record(), sleep: async (/** @type {number} */ ms) => { delays.push(ms); } });
    const o = await client.invoke('product.save', CLIENT_SAVE);
    assert.strictEqual(o.ok, true);
    assert.deepStrictEqual(sent, ['id-1', 'id-1'], 'one key from the record, resent on retry');
    assert.ok(stamps.some(([key, at]) => key === 'id-1' && at === 1_700_000_000_000), `the key record is stamped with the record's clock: ${JSON.stringify(stamps)}`);
    assert.deepStrictEqual(delays, [1000 + Math.floor(0.5 * 250)], 'backoff 1000 ms plus the record\'s jitter draw of 0.5 × 250');

    // explicit keys and now win over the record
    sent.length = 0;
    stamps.length = 0;
    calls = 0;
    const explicit = openHttpClient(shop, {
      fetch, storage: recording, runtime: record(), keys: counter('explicit'), now: () => 42, sleep: async () => {},
    });
    await explicit.invoke('product.save', CLIENT_SAVE);
    assert.deepStrictEqual(sent, ['explicit-1', 'explicit-1']);
    assert.ok(stamps.some(([key, at]) => key === 'explicit-1' && at === 42));

    // no record: v4 keys and the platform's jitter window
    sent.length = 0;
    delays.length = 0;
    calls = 0;
    const plain = openHttpClient(shop, { fetch, sleep: async (/** @type {number} */ ms) => { delays.push(ms); } });
    await plain.invoke('product.save', CLIENT_SAVE);
    assert.match(sent[0], UUID_V4);
    assert.ok(delays[0] >= 1000 && delays[0] < 1250, `${delays[0]}`);
    assert.throws(() => openHttpClient(shop, { runtime: /** @type {any} */ ({ random: 1 }) }),
      /JC1008.*options\.runtime: runtime\.random is a function/s);
  });

  it('memory ledger: claims are stamped by the record\'s now; explicit now wins; no record is the platform clock', () => {
    const fromRecord = createMemoryLedger({ runtime: record() });
    const claimed = fromRecord.claim({ op: 'o', scope: '', key: 'k', hash: 'h' });
    assert.strictEqual(claimed.state, 'new');
    assert.strictEqual(fromRecord.lookup({ op: 'o', scope: '', key: 'k' })?.createdAt, 1_700_000_000_000);
    const explicit = createMemoryLedger({ runtime: record(), now: () => 7 });
    explicit.claim({ op: 'o', scope: '', key: 'k', hash: 'h' });
    assert.strictEqual(explicit.lookup({ op: 'o', scope: '', key: 'k' })?.createdAt, 7);
    const before = Date.now();
    const plain = createMemoryLedger();
    plain.claim({ op: 'o', scope: '', key: 'k', hash: 'h' });
    const at = plain.lookup({ op: 'o', scope: '', key: 'k' })?.createdAt ?? -1;
    assert.ok(at >= before && at <= Date.now());
    assert.throws(() => createMemoryLedger({ runtime: /** @type {any} */ ({ clock: Date.now }) }),
      /createMemoryLedger: runtime: a runtime record has 'now'/);
  });

  it('one record drives a server, its ledger and a client together, and the run repeats byte for byte', async () => {
    const run = async () => {
      const runtime = record();
      const ledger = createMemoryLedger({ runtime });
      const server = serveHttp(shop, shopHandlers(), { ledger, runtime });
      const client = openHttpClient(shop, {
        runtime, sleep: async () => {},
        fetch: async (/** @type {string} */ url, /** @type {any} */ init) => {
          const response = await server.dispatch({
            method: init.method, url, headers: Object.fromEntries(Object.entries(init.headers ?? {})),
            body: init.body ?? null,
          });
          return new Response(response.body, { status: response.status, headers: /** @type {any} */ (response.headers) });
        },
      });
      const out = [];
      out.push(await client.invoke('product.save', CLIENT_SAVE));
      out.push(await client.invoke('product.save', CLIENT_SAVE));
      out.push(ledger.lookup({ op: 'product.save', scope: '', key: 'id-1' }));
      return JSON.stringify(out);
    };
    const a = await run();
    assert.strictEqual(a, await run());
    assert.ok(a.includes('"id-1"') && a.includes('1700000000000'), a);
  });

  it('reads the record through one resolver: every binding imports the same helper and no ambient host fact remains', () => {
    const files = ['http/serve.js', 'local/index.js', 'port/serve.js', 'port/client.js', 'client/http.js'];
    for (const file of files) {
      const source = readFileSync(new URL(`../../packages/contract/src/${file}`, import.meta.url), 'utf8');
      assert.ok(source.includes("from '../runtime.js'"), `${file} resolves the record through the package helper`);
      assert.ok(!/\bDate\.now\b|\bMath\.random\b|randomUUID\(/.test(source.replace(/^\s*\*.*$/gm, '')),
        `${file} reads a host fact from the platform`);
    }
    const ledger = readFileSync(new URL('../../packages/contract/src/ledger.js', import.meta.url), 'utf8');
    assert.ok(!/\bDate\.now\b/.test(ledger.replace(/^\s*\*.*$/gm, '')), 'the ledger reads the platform clock');
    const helper = readFileSync(new URL('../../packages/contract/src/runtime.js', import.meta.url), 'utf8');
    assert.strictEqual((helper.match(/resolveRuntime\(/g) ?? []).length, 1, 'the helper resolves; it does not re-implement');
    assert.deepStrictEqual([...RUNTIME_MEMBERS], ['now', 'uuid', 'random', 'zoneProvider']);
  });
});

describe('one clock judges a ledger record from claim to expiry', () => {
  it('a ledger without a clock follows the binding: an injected server clock never expires its own claims under the platform\'s', async () => {
    // the reproduction: a default ledger beside a server on a fixed clock —
    // sweep() and lookup() used the platform clock, 24 h "expired" every
    // claim, and the command ran twice
    let calls = 0;
    const handlers = { ...shopHandlers(), 'product.save': (/** @type {any} */ input) => { calls++; return { id: input.id, name: 'x', price: 1 }; } };
    const ledger = createMemoryLedger();
    const server = serveHttp(shop, handlers, { ledger, runtime: createRuntime({ now: () => 1_700_000_000_000 }) });
    const first = await server.dispatch(jsonReq('PUT', SAVE_URL, SAVE, { 'idempotency-key': 'k1' }));
    assert.strictEqual(first.status, 200);
    assert.strictEqual(ledger.sweep(), 0, 'nothing expired: the ledger keeps the binding\'s time');
    const record = ledger.lookup({ op: 'product.save', scope: '', key: 'k1' });
    assert.ok(record !== null, 'the claim is still there');
    assert.strictEqual(record.createdAt, 1_700_000_000_000);
    assert.strictEqual(record.updatedAt, 1_700_000_000_000, 'the settlement was stamped by the same clock as the claim');
    const again = await server.dispatch(jsonReq('PUT', SAVE_URL, SAVE, { 'idempotency-key': 'k1' }));
    assert.strictEqual(again.headers['idempotent-replayed'], 'true');
    assert.strictEqual(calls, 1, 'the command ran once');
    // a host-side call may pass its own instant; the ledger's TTL then applies to it
    assert.strictEqual(ledger.sweep(1_700_000_000_000 + 86_400_000), 1, 'expired at the binding\'s clock plus the TTL');
  });

  it('a ledger with its own clock uses it for every judgement, and is given the same record as the server', async () => {
    const runtime = createRuntime({ now: () => 5_000 });
    const ledger = createMemoryLedger({ runtime, ttlMs: 1_000 });
    const server = serveHttp(shop, shopHandlers(), { ledger, runtime });
    await server.dispatch(jsonReq('PUT', SAVE_URL, SAVE, { 'idempotency-key': 'k2' }));
    const record = ledger.lookup({ op: 'product.save', scope: '', key: 'k2' });
    assert.deepStrictEqual([record?.createdAt, record?.updatedAt, record?.expiresAt], [5_000, 5_000, 6_000]);
    assert.strictEqual(ledger.lookup({ op: 'product.save', scope: '', key: 'k2', now: 6_000 }), null, 'a passed instant expires it');
    assert.strictEqual(ledger.size, 0);
  });
});

describe('a host-supplied generator that throws is the host\'s own mistake', () => {
  const throwing = () => { throw new Error('boom'); };

  it('the port client refuses a throwing or non-string uuid as JC1008 where the record was passed', () => {
    const { port1 } = new MessageChannel();
    try {
      assert.throws(() => openPortClient(shop, { channel: port1, runtime: { uuid: throwing } }),
        /JC1008.*options\.runtime: uuid\(\) threw \(boom\)/s);
      assert.throws(() => openPortClient(shop, { channel: port1, runtime: { uuid: /** @type {any} */ (() => 42) } }),
        /JC1008.*uuid\(\) must answer a non-empty string/s);
    }
    finally {
      port1.close();
    }
  });

  it('the http client rejects invoke with JC1008 for a throwing keys, now or random — never a storage or network outcome', async () => {
    let fetches = 0;
    const fetch = async () => { fetches++; throw new TypeError('offline'); };
    const storage = { read: () => undefined, write: () => {} };
    await assert.rejects(openHttpClient(shop, { fetch, keys: throwing }).invoke('product.save', CLIENT_SAVE),
      /JC1008.*options\.keys threw \(boom\)/s);
    await assert.rejects(openHttpClient(shop, { fetch, storage, now: throwing }).invoke('product.save', CLIENT_SAVE),
      /JC1008.*options\.now threw \(boom\)/s);
    assert.strictEqual(fetches, 0, 'nothing was sent before the host\'s mistake was refused');
    await assert.rejects(openHttpClient(shop, { fetch, sleep: async () => {}, runtime: { random: throwing } }).invoke('product.save', CLIENT_SAVE),
      /JC1008.*options\.random \(the runtime record\) threw \(boom\)/s);
  });
});
