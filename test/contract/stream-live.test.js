//@ts-check
/**
 * @file The end state's live half, proven with a REAL `@jarenjs/db`
 * store (in-memory node driver, capture on — a test-side import; the
 * package itself never imports db, the handler shape is duck-typed): a
 * `live()` object returned by the handler AS IS streams its snapshot
 * and its `{ patch, seq }` emissions over SSE (a real `node:http` wire)
 * and over port (a `MessageChannel`), the client applies the patches
 * with `@jarenjs/json/patch`, and after N writes the applied document
 * deep-equals `live.result` — structural sharing end to end, one diff
 * format from the store to the subscriber.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { once } from 'node:events';

import { applyJSONPatch } from '@jarenjs/json/patch';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { compileContract } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import { toNodeHandler } from '@jarenjs/contract/node';
import { openHttpClient } from '@jarenjs/contract/client';
import { servePort, openPortClient } from '@jarenjs/contract/port';

const MODEL = {
  $model: '0.1',
  collections: {
    notes: {
      schema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, points: { type: 'integer' } } },
      key: '/id',
    },
  },
};

// Over the port, JSON frames carry any input member — the query
// document included. Over HTTP a subscribe's input travels as QUERY
// STRINGS (the read rule), and the transport coercion is scalar-only
// (its rationale: query strings, form fields), so an object-valued
// member does not round-trip on that carrier — the SSE contract keys
// the subscription by a scalar and the handler owns the query document.
const PORT_CONTRACT = compileContract({
  $contract: '0.1',
  operations: {
    'data.live': {
      kind: 'subscribe',
      input: { type: 'object', required: ['collection', 'document'], properties: { collection: { type: 'string' }, document: true } },
      output: { type: 'object', required: ['rows'], properties: { rows: { type: 'array' } } },
    },
  },
});

const SSE_CONTRACT = compileContract({
  $contract: '0.1',
  operations: {
    'data.live': {
      kind: 'subscribe',
      input: { type: 'object', required: ['collection'], properties: { collection: { type: 'string' } } },
      output: { type: 'object', required: ['rows'], properties: { rows: { type: 'array' } } },
    },
  },
});

const SCAN = [{ $for: { it: '$[*]' }, $return: '$it' }];

/** Poll (bounded) until a condition holds. @param {() => boolean} until */
async function wait(until) {
  for (let i = 0; i < 400 && !until(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(until(), 'the condition never held');
}

/** @type {(() => void | Promise<void>)[]} */
const cleanups = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

/**
 * A consumer document maintained by applying the stream's events.
 */
function consumerDoc() {
  /** @type {{ doc: any, seqs: number[], errors: any[] }} */
  const state = { doc: null, seqs: [], errors: [] };
  return {
    state,
    callbacks: {
      onSnapshot: (/** @type {any} */ value) => {
        state.doc = value;
      },
      onPatch: (/** @type {{ patch: any[], seq: number }} */ emission) => {
        state.doc = applyJSONPatch(state.doc, emission.patch);
        state.seqs.push(emission.seq);
      },
      onError: (/** @type {any} */ outcome) => state.errors.push(outcome),
    },
  };
}

describe('a real @jarenjs/db live() over the stream binding', () => {
  it('over SSE: the handler returns live() as is; N writes later the applied document equals live.result', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), capture: true });
    cleanups.push(() => store.close());
    /** @type {any[]} */
    const lives = [];
    const dispatcher = serveHttp(SSE_CONTRACT, {
      'data.live': async (/** @type {any} */ input) => {
        const live = await store.collection(input.collection).live(SCAN);
        lives.push(live);
        return live;
      },
    });
    const server = http.createServer(toNodeHandler(dispatcher));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = /** @type {import('node:net').AddressInfo} */ (server.address());
    cleanups.push(async () => {
      dispatcher.close();
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    });
    const client = openHttpClient(SSE_CONTRACT, { baseUrl: `http://127.0.0.1:${address.port}` });
    cleanups.push(() => client.close());

    await store.collection('notes').insert({ id: 'n1', title: 'first', points: 5 });
    const consumer = consumerDoc();
    const sub = client.subscribe('data.live', { collection: 'notes' }, consumer.callbacks);
    await wait(() => consumer.state.doc !== null);
    assert.deepStrictEqual(consumer.state.doc, { rows: [{ id: 'n1', title: 'first', points: 5 }] });

    await store.collection('notes').insert({ id: 'n2', title: 'second', points: 40 });
    await store.collection('notes').insert({ id: 'n3', title: 'third', points: 25 });
    await store.collection('notes').put({ id: 'n1', title: 'first!', points: 6 }, 'n1');
    await store.collection('notes').delete('n2');
    await wait(() => consumer.state.seqs.length === 4);

    assert.deepStrictEqual(consumer.state.doc, lives[0].result, 'the applied document deep-equals live.result');
    assert.strictEqual(consumer.state.doc.rows.length, 2);
    assert.deepStrictEqual(consumer.state.errors, []);
    const seqs = consumer.state.seqs;
    assert.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), 'seq strictly increases');

    sub.stop();
  });

  it('over port: the same live() shape streams push frames; the row count matches the store after writes', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), capture: true });
    cleanups.push(() => store.close());
    const { port1, port2 } = new MessageChannel();
    cleanups.push(() => {
      port1.close();
      port2.close();
    });
    const portServer = servePort(PORT_CONTRACT, {
      'data.live': (/** @type {any} */ input) => store.collection(input.collection).live(input.document),
    }, { channel: port1 });
    cleanups.push(() => portServer.close());
    const client = openPortClient(PORT_CONTRACT, { channel: port2 });
    cleanups.push(() => client.close());

    const consumer = consumerDoc();
    const sub = client.subscribe('data.live', { collection: 'notes', document: SCAN }, consumer.callbacks);
    await wait(() => consumer.state.doc !== null);
    assert.deepStrictEqual(consumer.state.doc, { rows: [] });

    for (let i = 0; i < 5; i++) {
      await store.collection('notes').insert({ id: `p${i}`, title: `t${i}`, points: i });
    }
    await wait(() => consumer.state.seqs.length === 5);
    const rows = await store.collection('notes').execute(SCAN);
    assert.strictEqual(consumer.state.doc.rows.length, /** @type {any[]} */ (rows).length,
      "the client's row count equals the store's after the writes");
    assert.deepStrictEqual(consumer.state.errors, []);
    sub.stop();
  });
});

/**
 * A live() whose store-coded error is mapped to a code the operation
 * declares: declared codes are lowercase by grammar, a store's `JD2060`
 * is not one, so the handler maps it — the cause rides along for the
 * server's observer.
 * @param {any} live
 */
function declaring(live) {
  return {
    get result() {
      return live.result;
    },
    subscribe: (/** @type {(e: any) => void} */ cb) => live.subscribe((/** @type {any} */ e) => cb(
      Object.hasOwn(e, 'error') && e.error?.code === 'JD2060' ? { error: { code: 'overflow', cause: e.error } } : e)),
    close: () => live.close(),
  };
}

describe('a live() source error over the stream binding', () => {
  const SSE_DECLARING = compileContract({
    $contract: '0.1',
    operations: {
      'data.live': {
        kind: 'subscribe',
        input: { type: 'object', required: ['collection'], properties: { collection: { type: 'string' } } },
        output: { type: 'object', required: ['rows'], properties: { rows: { type: 'array' } } },
        errors: { overflow: { status: 507 } },
      },
    },
  });
  const PORT_DECLARING = compileContract({
    $contract: '0.1',
    operations: {
      'data.live': {
        kind: 'subscribe',
        input: { type: 'object', required: ['collection', 'document'], properties: { collection: { type: 'string' }, document: true } },
        output: { type: 'object', required: ['rows'], properties: { rows: { type: 'array' } } },
        errors: { overflow: { status: 507 } },
      },
    },
  });

  /** A store whose live queries hold at most two entries: the third insert is a real JD2060. */
  async function boundedStore() {
    const store = await openStore(MODEL, { driver: nodeDriver(), capture: true, live: { maxMaintained: 2 } });
    cleanups.push(() => store.close());
    await store.collection('notes').insert({ id: 'n1', title: 'first', points: 5 });
    return store;
  }

  /** Cross the bound: two more inserts, the second past `maxMaintained`. @param {any} store */
  async function overflow(store) {
    await store.collection('notes').insert({ id: 'n2', title: 'second', points: 6 });
    await store.collection('notes').insert({ id: 'n3', title: 'third', points: 7 });
  }

  /** @param {any} contract @param {(live: any) => any} shape @param {any[]} observed */
  async function sse(contract, shape, observed) {
    const store = await boundedStore();
    const dispatcher = serveHttp(contract, {
      'data.live': async (/** @type {any} */ input) => shape(await store.collection(input.collection).live(SCAN)),
    }, { onError: (/** @type {unknown} */ error) => observed.push(error) });
    const server = http.createServer(toNodeHandler(dispatcher));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = /** @type {import('node:net').AddressInfo} */ (server.address());
    cleanups.push(async () => {
      dispatcher.close();
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    });
    const client = openHttpClient(contract, { baseUrl: `http://127.0.0.1:${address.port}` });
    cleanups.push(() => client.close());
    const consumer = consumerDoc();
    client.subscribe('data.live', { collection: 'notes' }, consumer.callbacks);
    await wait(() => consumer.state.doc !== null);
    await overflow(store);
    await wait(() => consumer.state.errors.length === 1);
    return consumer.state.errors[0];
  }

  /** @param {any} contract @param {(live: any) => any} shape @param {any[]} observed */
  async function port(contract, shape, observed) {
    const store = await boundedStore();
    const { port1, port2 } = new MessageChannel();
    cleanups.push(() => {
      port1.close();
      port2.close();
    });
    const portServer = servePort(contract, {
      'data.live': async (/** @type {any} */ input) => shape(await store.collection(input.collection).live(input.document)),
    }, { channel: port1, onError: (/** @type {unknown} */ error) => observed.push(error) });
    cleanups.push(() => portServer.close());
    const client = openPortClient(contract, { channel: port2 });
    cleanups.push(() => client.close());
    const consumer = consumerDoc();
    client.subscribe('data.live', { collection: 'notes', document: SCAN }, consumer.callbacks);
    await wait(() => consumer.state.doc !== null);
    await overflow(store);
    await wait(() => consumer.state.errors.length === 1);
    return consumer.state.errors[0];
  }

  /** The undeclared shape: the store's error crosses as the host fault, its text never on the wire. @param {any} outcome @param {string} hostCode @param {any[]} observed */
  function assertUndeclared(outcome, hostCode, observed) {
    assert.strictEqual(outcome.kind, 'contract');
    assert.strictEqual(outcome.error.code, 'JC2093');
    assert.strictEqual(outcome.error.details.code, hostCode);
    const wire = JSON.stringify(outcome);
    assert.ok(!wire.includes('JD2060') && !wire.includes('maxMaintained'), `the store's error text stays off the wire: ${wire}`);
    assert.strictEqual(observed.length, 1);
    assert.strictEqual(observed[0].name, 'DbRuntimeError');
    assert.strictEqual(observed[0].code, 'JD2060');
  }

  /** The declared shape: one failure outcome under the declared code. @param {any} outcome @param {any[]} observed */
  function assertDeclared(outcome, observed) {
    assert.strictEqual(outcome.kind, 'failure');
    assert.strictEqual(outcome.error.code, 'overflow');
    assert.strictEqual(outcome.error.retryable, false);
    assert.strictEqual(outcome.error.details, null, 'no details crossed');
    assert.strictEqual(outcome.error.message, 'operation data.live failed with overflow');
    assert.strictEqual(observed.length, 1);
    assert.strictEqual(observed[0].cause.code, 'JD2060');
  }

  it('over SSE, returned as is: JD2060 is the host fault JC2008 on the wire and JC2093 at the client; the observer gets the DbRuntimeError', async () => {
    /** @type {any[]} */
    const observed = [];
    assertUndeclared(await sse(SSE_CONTRACT, (live) => live, observed), 'JC2008', observed);
  });

  it('over SSE, mapped to a declared code: one failure outcome under that code, the cause observed', async () => {
    /** @type {any[]} */
    const observed = [];
    assertDeclared(await sse(SSE_DECLARING, declaring, observed), observed);
  });

  it('over port, returned as is: the host fault JC2070 on the wire and JC2093 at the client', async () => {
    /** @type {any[]} */
    const observed = [];
    assertUndeclared(await port(PORT_CONTRACT, (live) => live, observed), 'JC2070', observed);
  });

  it('over port, mapped to a declared code: the same failure outcome as SSE', async () => {
    /** @type {any[]} */
    const observed = [];
    assertDeclared(await port(PORT_DECLARING, declaring, observed), observed);
  });
});
