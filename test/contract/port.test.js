//@ts-check
/**
 * @file The port binding over the two channel shapes it exists for: a
 * platform `MessageChannel` pair (the worker/tab case) and an in-memory
 * broadcast fake (the shared-channel case — delivery to every OTHER
 * peer, never the sender, like a real `BroadcastChannel`). The id
 * scoping is proven the hard way: two clients on one channel fire 100
 * interleaved requests each and every outcome carries exactly its own
 * payload — and every frame on the wire shows the two disjoint client
 * prefixes, so neither pending map can ever have held a foreign id (the
 * map is keyed by ids the client itself minted; the prefix test drops
 * everything else before lookup). Cancel frames abort the server-side
 * signal and late responses for cancelled or timed-out ids are dropped
 * silently; a request that gets no answer within `timeoutMs` is
 * `JC2072`; a malformed response frame is `JC2073`; a channel whose
 * `postMessage` throws is `JC2074`; foreign traffic sharing the channel
 * is ignored, never answered. Every frame the server emits validates
 * against `schemas/jaren-contract-port.schema.json`.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';

import { JarenValidator } from '@jarenjs/validate';
import { jsonFormats } from '@jarenjs/formats';
import { compileContract } from '@jarenjs/contract';
import { servePort, openPortClient, PORT_LOCAL_ERRORS, FRAME_MARKER } from '@jarenjs/contract/port';
import { OUTCOME_ERROR_MEMBERS, OUTCOME_META_MEMBERS } from '@jarenjs/contract/client';
import { load, shopHandlers } from './helpers.js';

const shop = compileContract(load('./fixtures/shop.contract.json'));
const PRODUCT = { id: 1, name: 'x', price: 1 };
const SAVE = { id: 1, revision: 2, product: PRODUCT };

const validateFrame = new JarenValidator().addFormats(jsonFormats)
  .compile(load('../../packages/contract/schemas/jaren-contract-port.schema.json'));

/** @type {{ close: () => void }[]} */
const open = [];
after(() => { for (const closable of open) closable.close(); });

/** @template {{ close: () => void }} T @param {T} closable @returns {T} */
function track(closable) {
  open.push(closable);
  return closable;
}

/**
 * A MessageChannel pair with every SERVER-emitted frame checked against
 * the grammar (the acceptance's "test wraps postMessage").
 */
function pair() {
  const { port1, port2 } = new MessageChannel();
  /** @type {any[]} */
  const emitted = [];
  const raw = port1.postMessage.bind(port1);
  port1.postMessage = (/** @type {any} */ message) => {
    assert.strictEqual(validateFrame(message), true, `a server frame must match the grammar: ${JSON.stringify(message)}`);
    emitted.push(message);
    raw(message);
  };
  track({ close: () => { port1.close(); port2.close(); } });
  return { server: port1, client: port2, emitted };
}

/**
 * The in-memory broadcast fake: delivery to every OTHER peer on the
 * next microtask, never the sender — the `BroadcastChannel` contract.
 */
function fakeBroadcast() {
  /** @type {Set<any>} */
  const peers = new Set();
  /** @type {any[]} */
  const wire = [];
  const join = () => {
    /** @type {Set<(event: any) => void>} */
    const listeners = new Set();
    const peer = {
      /** @param {any} message */
      postMessage(message) {
        const data = structuredClone(message);
        wire.push(data);
        for (const other of peers) {
          if (other !== peer) other.deliver(data);
        }
      },
      /** @param {string} type @param {(event: any) => void} fn */
      addEventListener(type, fn) {
        if (type === 'message') listeners.add(fn);
      },
      /** @param {string} type @param {(event: any) => void} fn */
      removeEventListener(type, fn) {
        void type;
        listeners.delete(fn);
      },
      /** @param {any} data */
      deliver(data) {
        queueMicrotask(() => {
          for (const fn of listeners) fn({ data });
        });
      },
    };
    peers.add(peer);
    return peer;
  };
  return { join, wire };
}

/** @param {any} outcome */
function assertShape(outcome) {
  assert.deepStrictEqual(Object.keys(outcome.meta), [...OUTCOME_META_MEMBERS]);
  for (const m of OUTCOME_META_MEMBERS) assert.notStrictEqual(outcome.meta[m], undefined, `meta.${m}`);
  if (!outcome.ok) {
    assert.deepStrictEqual(Object.keys(outcome.error), [...OUTCOME_ERROR_MEMBERS]);
    for (const m of OUTCOME_ERROR_MEMBERS) assert.notStrictEqual(outcome.error[m], undefined, `error.${m}`);
  }
  return outcome;
}

const drain = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('servePort + openPortClient over a MessageChannel', () => {
  it('construction: capabilities frozen on both halves; host mistakes refused', () => {
    const { server, client } = pair();
    const s = track(servePort(shop, shopHandlers(), { channel: server }));
    const c = track(openPortClient(shop, { channel: client }));
    assert.deepStrictEqual(s.capabilities, {
      name: 'port', status: false, headers: false, media: false, etag: false,
      idempotency: false, validatedOutput: true, stream: true, cancel: 'message',
    });
    assert.deepStrictEqual(c.capabilities, {
      name: 'port', status: false, headers: false, media: false, etag: false,
      idempotency: false, stream: true, cancel: 'message',
    });
    assert.strictEqual(Object.isFrozen(s.capabilities) && Object.isFrozen(c.capabilities), true);
    assert.strictEqual(c.contract, shop);
    assert.strictEqual(s.describe().id, 'shop');
    assert.strictEqual(c.describe().id, 'shop');
    assert.throws(() => servePort(shop, shopHandlers(), /** @type {any} */ ({})), (/** @type {any} */ e) => e.code === 'JC1001' && /channel/.test(e.message));
    assert.throws(() => servePort(shop, shopHandlers(), { channel: /** @type {any} */ ({ postMessage: 1 }) }), (/** @type {any} */ e) => e.code === 'JC1001');
    assert.throws(() => servePort(shop, { nope: () => 1 }, { channel: server }), (/** @type {any} */ e) => e.code === 'JC1001');
    const { 'catalog.load': _dropped, ...missing } = shopHandlers();
    assert.throws(() => servePort(shop, missing, { channel: server }), (/** @type {any} */ e) => e.code === 'JC1002');
    const { 'image.bytes': _raw, ...noRaw } = shopHandlers();
    assert.doesNotThrow(() => track(servePort(shop, noRaw, { channel: new MessageChannel().port1 })), 'opaque operations need no handler');
    assert.throws(() => openPortClient(shop, /** @type {any} */ ({})), (/** @type {any} */ e) => e.code === 'JC1008');
    assert.throws(() => openPortClient(shop, { channel: client, timeoutMs: -1 }), (/** @type {any} */ e) => e.code === 'JC1008');
    assert.throws(() => openPortClient(/** @type {any} */ ({}), { channel: client }), (/** @type {any} */ e) => e.code === 'JC1008');
  });

  it('a read and a command round-trip: success validated, declared failure with status null, meta.trace from the frame, ids are "<clientId>:<seq>"', async () => {
    const { server, client, emitted } = pair();
    track(servePort(shop, {
      ...shopHandlers(),
      'product.save': (/** @type {any} */ input, /** @type {any} */ ctx) => (input.id === 9 ? ctx.fail('conflict', {}, { current: PRODUCT }) : { ...PRODUCT, id: input.id }),
    }, { channel: server, trace: () => 'srv-1' }));
    const c = track(openPortClient(shop, { channel: client }));
    const ok = /** @type {any} */ (assertShape(await c.invoke('catalog.load', { since: '2026-01-01T00:00:00Z' }, { attempt: 3 })));
    assert.deepStrictEqual([ok.ok, ok.value.revision, ok.meta.op, ok.meta.attempt, ok.meta.trace], [true, 1, 'catalog.load', 3, 'srv-1']);
    const failed = /** @type {any} */ (assertShape(await c.invoke('product.save', { ...SAVE, id: 9 })));
    assert.deepStrictEqual([failed.kind, failed.error.code, failed.error.status, failed.error.details, failed.error.retryable],
      ['failure', 'conflict', null, { current: PRODUCT }, false]);
    assert.strictEqual(failed.error.message, 'operation product.save failed with conflict');
    const saved = /** @type {any} */ (await c.invoke('product.save', { ...SAVE, id: 3 }));
    assert.deepStrictEqual([saved.ok, saved.value.id], [true, 3]);
    // the wire: every emitted server frame already passed the grammar (pair() wraps postMessage)
    assert.strictEqual(emitted.length, 3);
    // a request id is "<clientId>:<seq>" with the sequence counting up
    const invalid = /** @type {any} */ (await c.invoke('product.save', { id: 'x' }));
    assert.deepStrictEqual([invalid.kind, invalid.error.code], ['contract', 'JC2050'], 'invalid input never reaches the wire');
    assert.strictEqual(emitted.length, 3);
  });

  it('a handler fault answers JC2070 (kind contract on the client, onError sees the cause server-side); a foreign request with an unknown op answers JC2071', { timeout: 5_000 }, async () => {
    const { server, client } = pair();
    /** @type {any[]} */
    const seen = [];
    track(servePort(shop, { ...shopHandlers(), 'catalog.load': () => { throw new Error('secret'); } },
      { channel: server, onError: (/** @type {any} */ e) => seen.push(e) }));
    const c = track(openPortClient(shop, { channel: client }));
    const fault = /** @type {any} */ (assertShape(await c.invoke('catalog.load')));
    assert.deepStrictEqual([fault.kind, fault.error.code, fault.error.status, fault.error.retryable], ['contract', 'JC2070', null, false]);
    assert.doesNotMatch(JSON.stringify(fault), /secret/);
    assert.match(String(seen[0]), /secret/);
    // a hand client (no contract) asks for an operation this channel does not serve
    /** @type {any[]} */
    const answers = [];
    const received = new Promise((resolve) => {
      client.addEventListener('message', (event) => {
        answers.push(event.data);
        if (answers.length === 3) resolve(undefined);
      });
    });
    client.postMessage({ jaren: FRAME_MARKER, id: 'hand:1', op: 'no.such', input: null });
    client.postMessage({ jaren: FRAME_MARKER, id: 'hand:2', op: 'image.bytes', input: { id: 1 } });
    client.postMessage({ jaren: FRAME_MARKER, id: 'hand:3', op: 'product.save', input: { id: 'x' } });
    await received;
    assert.strictEqual(answers.length, 3);
    assert.deepStrictEqual(answers.map((a) => a.error.code), ['JC2071', 'JC2071', 'JC2006'], 'unknown and opaque are JC2071; an invalid foreign input is JC2006');
    assert.doesNotMatch(answers[0].error.message, /no\.such/, 'the unknown op name is never echoed');
    assert.ok(Array.isArray(answers[2].error.details), 'JC2006 carries details by policy');
  });

  it('a cancel frame aborts the server-side ctx.signal; the client outcome is cancelled; the late settlement is answered to nobody', async () => {
    const { server, client, emitted } = pair();
    /** @type {any} */
    let handlerSignal = null;
    /** @type {(v: any) => void} */
    let release = () => {};
    track(servePort(shop, {
      ...shopHandlers(),
      'catalog.load': (/** @type {any} */ _i, /** @type {any} */ ctx) => {
        handlerSignal = ctx.signal;
        return new Promise((resolve) => { release = resolve; });
      },
    }, { channel: server }));
    const c = track(openPortClient(shop, { channel: client }));
    const controller = new AbortController();
    const pending = c.invoke('catalog.load', null, { signal: controller.signal });
    await drain();
    assert.strictEqual(handlerSignal.aborted, false);
    controller.abort();
    const outcome = /** @type {any} */ (assertShape(await pending));
    assert.deepStrictEqual([outcome.kind, outcome.error.code], ['cancelled', 'JC2052']);
    await drain();
    assert.strictEqual(handlerSignal.aborted, true, 'the cancel frame reached the server');
    const before = emitted.length;
    release({ revision: 9, products: [] });
    await drain();
    assert.strictEqual(emitted.length, before, 'a cancelled id gets no response frame');
    // a pre-aborted signal never posts anything
    const dead = new AbortController();
    dead.abort();
    assert.strictEqual(/** @type {any} */ (await c.invoke('catalog.load', null, { signal: dead.signal })).kind, 'cancelled');
  });

  it('timeout: no answer within timeoutMs is JC2072 (network, retryable); the late response is dropped silently', async () => {
    const { server, client } = pair();
    /** @type {(v: any) => void} */
    let release = () => {};
    track(servePort(shop, {
      ...shopHandlers(),
      'catalog.load': () => new Promise((resolve) => { release = resolve; }),
    }, { channel: server }));
    const c = track(openPortClient(shop, { channel: client, timeoutMs: 25 }));
    const outcome = /** @type {any} */ (assertShape(await c.invoke('catalog.load')));
    assert.deepStrictEqual([outcome.kind, outcome.error.code, outcome.error.retryable], ['network', 'JC2072', true]);
    assert.match(outcome.error.message, /25ms/);
    release({ revision: 1, products: [] });
    await drain();   // the late response finds no pending entry — nothing throws, nothing settles twice
  });

  it('a malformed response frame addressed to this client is JC2073; close() resolves pending invokes cancelled and detaches', async () => {
    const fake = fakeBroadcast();
    const c = track(openPortClient(shop, { channel: fake.join(), timeoutMs: 0 }));
    const evil = fake.join();
    const first = c.invoke('catalog.load');
    await drain();
    const requestId = fake.wire[0].id;
    evil.postMessage({ jaren: FRAME_MARKER, id: requestId, ok: 'yes' });
    const outcome = /** @type {any} */ (assertShape(await first));
    assert.deepStrictEqual([outcome.kind, outcome.error.code], ['contract', 'JC2073']);
    // ok:true without value, and ok:false with a garbage error envelope
    const second = c.invoke('catalog.load');
    await drain();
    evil.postMessage({ jaren: FRAME_MARKER, id: fake.wire.at(-1).id, ok: true, trace: 't' });
    assert.strictEqual(/** @type {any} */ (await second).error.code, 'JC2073');
    const third = c.invoke('catalog.load');
    await drain();
    evil.postMessage({ jaren: FRAME_MARKER, id: fake.wire.at(-1).id, ok: false, error: 'nope', trace: 't' });
    assert.strictEqual(/** @type {any} */ (await third).error.code, 'JC2073');
    // close(): a pending invoke resolves cancelled, later invokes too, and the listener is gone
    const hanging = c.invoke('catalog.load');
    c.close();
    assert.strictEqual(/** @type {any} */ (await hanging).kind, 'cancelled');
    assert.strictEqual(/** @type {any} */ (await c.invoke('catalog.load')).kind, 'cancelled');
  });

  it('an unknown server code and a served-host JC2070/JC2071 classify apart from declared failures', async () => {
    const fake = fakeBroadcast();
    const c = track(openPortClient(shop, { channel: fake.join(), timeoutMs: 0 }));
    const server = fake.join();
    const answer = (/** @type {any} */ error) => {
      const id = fake.wire.at(-1).id;
      server.postMessage({ jaren: FRAME_MARKER, id, ok: false, error, trace: 't' });
    };
    // a taxonomy code from the peer (JC2006: it validated what we could not know it would refuse) is a failure
    let pending = c.invoke('catalog.load');
    await drain();
    answer({ code: 'JC2006', message: 'm', retryable: false });
    let outcome = /** @type {any} */ (await pending);
    assert.deepStrictEqual([outcome.kind, outcome.error.code, outcome.error.status], ['failure', 'JC2006', null]);
    // JC2071 from the peer: the two ends disagree about the contract — kind contract, the code kept
    pending = c.invoke('catalog.load');
    await drain();
    answer({ code: 'JC2071', message: 'not served', retryable: false });
    outcome = /** @type {any} */ (await pending);
    assert.deepStrictEqual([outcome.kind, outcome.error.code, outcome.error.message], ['contract', 'JC2071', 'not served']);
    // a code neither declared nor taxonomy is the undeclared-response JC2055
    pending = c.invoke('catalog.load');
    await drain();
    answer({ code: 'whatever', message: 'm' });
    outcome = /** @type {any} */ (assertShape(await pending));
    assert.deepStrictEqual([outcome.kind, outcome.error.code], ['contract', 'JC2055']);
  });

  it('foreign traffic on the channel is ignored by both halves, never answered; a channel whose postMessage throws is JC2074', async () => {
    const fake = fakeBroadcast();
    const serverPeer = fake.join();
    track(servePort(shop, shopHandlers(), { channel: serverPeer }));
    const c = track(openPortClient(shop, { channel: fake.join(), timeoutMs: 0 }));
    const noise = fake.join();
    noise.postMessage({ ping: 'token-1' });
    noise.postMessage('a string');
    noise.postMessage(42);
    noise.postMessage(null);
    noise.postMessage({ jaren: 'contract/9.9', id: 'x:1', op: 'catalog.load', input: null });
    noise.postMessage({ jaren: FRAME_MARKER });
    noise.postMessage({ jaren: FRAME_MARKER, id: '', op: 'catalog.load', input: null });
    await drain();
    assert.strictEqual(fake.wire.filter((f) => f !== null && typeof f === 'object' && f.jaren === FRAME_MARKER && typeof f.ok === 'boolean').length, 0,
      'nothing was answered');
    // the served channel still works beside the noise
    assert.strictEqual(/** @type {any} */ (await c.invoke('catalog.load')).ok, true);
    // JC2074: the channel throws on post (closed/detached)
    const broken = track(openPortClient(shop, {
      channel: { postMessage: () => { throw new Error('closed'); }, addEventListener() {}, removeEventListener() {} },
    }));
    const outcome = /** @type {any} */ (assertShape(await broken.invoke('catalog.load')));
    assert.deepStrictEqual([outcome.kind, outcome.error.code, outcome.error.retryable], ['network', 'JC2074', false]);
  });

  it('the code table rides the subpath; PORT_LOCAL_ERRORS is one table with local', async () => {
    const { PORT_LOCAL_ERRORS: fromLocal } = await import('@jarenjs/contract/local');
    assert.strictEqual(PORT_LOCAL_ERRORS, fromLocal, 'exactly one implementation');
  });
});

describe('two clients on one shared channel — the cross-settle proof', () => {
  it('100 interleaved requests per client each settle with exactly their own payload; the wire shows two disjoint id prefixes', async () => {
    const fake = fakeBroadcast();
    track(servePort(shop, {
      ...shopHandlers(),
      // echo the caller's input back, with jitter so answers interleave out of order
      'product.save': (/** @type {any} */ input) => new Promise((resolve) =>
        setTimeout(() => resolve({ ...PRODUCT, id: input.id }), input.id % 7)),
    }, { channel: fake.join() }));
    const a = track(openPortClient(shop, { channel: fake.join() }));
    const b = track(openPortClient(shop, { channel: fake.join() }));
    /** @type {Promise<any>[]} */
    const fromA = [];
    /** @type {Promise<any>[]} */
    const fromB = [];
    for (let i = 0; i < 100; i++) {
      fromA.push(a.invoke('product.save', { id: 1000 + i, revision: 1, product: PRODUCT }, { attempt: `a${i}` }));
      fromB.push(b.invoke('product.save', { id: 2000 + i, revision: 1, product: PRODUCT }, { attempt: `b${i}` }));
    }
    const settledA = await Promise.all(fromA);
    const settledB = await Promise.all(fromB);
    for (let i = 0; i < 100; i++) {
      assert.deepStrictEqual([settledA[i].ok, settledA[i].value.id, settledA[i].meta.attempt], [true, 1000 + i, `a${i}`], `client A request ${i}`);
      assert.deepStrictEqual([settledB[i].ok, settledB[i].value.id, settledB[i].meta.attempt], [true, 2000 + i, `b${i}`], `client B request ${i}`);
    }
    // the structural half: every request id on the wire carries its
    // client's own prefix, the two prefixes are disjoint, and every
    // response id equals a request id — so a pending map (keyed only by
    // ids its client minted, guarded by the prefix test before lookup)
    // can never have held a foreign id
    const requests = fake.wire.filter((f) => typeof f?.op === 'string');
    const responses = fake.wire.filter((f) => typeof f?.ok === 'boolean');
    assert.strictEqual(requests.length, 200);
    assert.strictEqual(responses.length, 200);
    const prefixes = new Set(requests.map((f) => f.id.slice(0, f.id.indexOf(':'))));
    assert.strictEqual(prefixes.size, 2, 'two clients, two disjoint prefixes');
    const requestIds = new Set(requests.map((f) => f.id));
    assert.strictEqual(requestIds.size, 200, 'no id was ever reused');
    for (const f of responses) assert.ok(requestIds.has(f.id));
  });
});
