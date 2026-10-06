//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { compileContract, ContractFailure, lintContract } from '@jarenjs/contract';
import { serveHttp, readBody } from '@jarenjs/contract/http';
import { openHttpClient } from '@jarenjs/contract/client';
import { openLocalClient } from '@jarenjs/contract/local';
import { openPortClient } from '@jarenjs/contract/port';
import { toNodeHandler, writeNodeResponse } from '@jarenjs/contract/node';

const contract = compileContract({ $contract: '0.1', operations: {
  'a.read': { kind: 'read', output: true, http: { method: 'GET', path: '/read' } },
  'a.raw': { kind: 'read', output: true, http: { method: 'GET', path: '/raw', media: 'text/plain' } },
  'a.live': { kind: 'subscribe', output: { type: 'object' }, http: { method: 'GET', path: '/live' } },
} });

function harness() {
  const counts = { attached: 0, posted: 0, fetched: 0, handled: 0 };
  const channel = {
    addEventListener() { counts.attached++; },
    removeEventListener() { counts.attached--; },
    postMessage() { counts.posted++; },
  };
  const fetch = async () => {
    counts.fetched++;
    return new Response('true', { headers: { 'content-type': 'application/json' } });
  };
  const handlers = Object.fromEntries(contract.ids.map(id => [id, () => { counts.handled++; return true; }]));
  return { counts, channel, fetch, handlers };
}

it('client factories admit only plain closed option records before installing listeners', () => {
  const { channel, counts, handlers } = harness();
  assert.throws(() => openHttpClient(contract, { timeoutms: 1 }),
    (error) => error.code === 'JC1008' && /timeoutMs/.test(error.message));
  assert.throws(() => openPortClient(contract, { channel, timeoutms: 1 }),
    (error) => error.code === 'JC1008' && /timeoutMs/.test(error.message));
  for (const options of [[], new Map(), new Date(), null]) {
    assert.throws(() => openHttpClient(contract, options), { code: 'JC1008' });
    assert.throws(() => openPortClient(contract, options), { code: 'JC1008' });
    assert.throws(() => openLocalClient(contract, handlers, options), { code: 'JC1001' });
  }
  assert.equal(counts.attached, 0);
  assert.equal(counts.posted, 0);
  for (const client of [
    openHttpClient(contract, Object.create(null)),
    openPortClient(contract, Object.assign(Object.create(null), { channel })),
    openLocalClient(contract, handlers, Object.create(null)),
  ]) client.close();
  assert.equal(counts.attached, 0);
});

it('all invocation contexts refuse typos, non-records and non-signals before transport or handler effects', async (t) => {
  const { counts, fetch, channel, handlers } = harness();
  const clients = [openHttpClient(contract, { fetch }), openPortClient(contract, { channel, timeoutMs: 5 }),
    openLocalClient(contract, handlers)];
  t.after(() => { for (const client of clients) client.close(); });
  const fake = { aborted: false, addEventListener() {}, removeEventListener() {} };
  for (const client of clients) {
    for (const ctx of [{ signl: new AbortController().signal }, [], new Map(), { signal: 5 }, { signal: fake }]) {
      await assert.rejects(Promise.resolve().then(() => client.invoke('a.read', null, ctx)), { code: 'JC1008' });
    }
    const controller = new AbortController();
    controller.abort();
    const outcome = await client.invoke('a.read', null, Object.assign(Object.create(null), { signal: controller.signal, attempt: 'kept' }));
    assert.equal(outcome.kind, 'cancelled');
    assert.equal(outcome.meta.attempt, 'kept');
  }
  assert.equal(counts.posted, 0);
  assert.equal(counts.fetched, 0);
  assert.equal(counts.handled, 0);
});

it('opaque and negotiation controls reject malformed options before fetch', async (t) => {
  const { counts, fetch } = harness();
  const client = openHttpClient(contract, { fetch });
  t.after(() => client.close());
  for (const options of [{ signal: 5 }, { signl: new AbortController().signal }, [], new Map()]) {
    await assert.rejects(client.bytes('a.raw', null, options), { code: 'JC1008' });
    await assert.rejects(client.negotiate(options), { code: 'JC1008' });
  }
  assert.equal(counts.fetched, 0);
});

it('HTTP and port subscriptions refuse signal and reconnect mistakes before dispatch', (t) => {
  const { counts, fetch, channel } = harness();
  const clients = [openHttpClient(contract, { fetch }), openPortClient(contract, { channel })];
  t.after(() => { for (const client of clients) client.close(); });
  for (const client of clients) {
    for (const options of [{ signal: 5 }, { signl: new AbortController().signal }, [], new Map(),
      { reconnect: { max: 1, maax: 2 } }, { reconnect: Object.assign([], { max: 1 }) }]) {
      assert.throws(() => client.subscribe('a.live', null, options), { code: 'JC1008' });
    }
    const controller = new AbortController(); controller.abort();
    const subscription = client.subscribe('a.live', null, { signal: controller.signal, reconnect: { max: 0 } });
    subscription.stop();
  }
  assert.equal(counts.posted, 0);
  assert.equal(counts.fetched, 0);
});

it('serveHttp refuses non-boolean head and partial controls at admission', async () => {
  const { handlers, counts } = harness();
  for (const name of ['head', 'partial']) {
    for (const value of ['yes', 0, 1, null]) {
      assert.throws(() => serveHttp(contract, handlers, { [name]: value }), { code: 'JC1001' });
    }
  }
  for (const options of [[], new Map()]) assert.throws(() => serveHttp(contract, handlers, options), { code: 'JC1001' });
  assert.equal(counts.handled, 0);
  const enabled = serveHttp(contract, handlers, { head: true, partial: false });
  assert.equal((await enabled.dispatch({ method: 'HEAD', url: '/read', headers: {}, body: null })).status, 200);
  const disabled = serveHttp(contract, handlers, { head: false });
  assert.equal((await disabled.dispatch({ method: 'HEAD', url: '/read', headers: {}, body: null })).status, 405);
  const partial = serveHttp(contract, {}, { partial: true });
  assert.equal((await partial.dispatch({ method: 'GET', url: '/read', headers: {}, body: null })).status, 501);
});

it('Node adapter options refuse typos, invalid grace periods and foreign request provenance before writing', () => {
  const { handlers } = harness();
  const dispatcher = serveHttp(contract, handlers);
  let writes = 0;
  const response = { writeHead() { writes++; }, end() { writes++; } };
  const result = { status: 200, headers: {}, body: 'ok' };
  for (const lingerMs of [-1, Infinity, NaN, '5', null]) {
    assert.throws(() => toNodeHandler(dispatcher, { lingerMs }), /lingerMs.*non-negative finite/);
    assert.throws(() => writeNodeResponse(response, result, { lingerMs }), /lingerMs.*non-negative finite/);
  }
  assert.throws(() => toNodeHandler(dispatcher, { requst() {} }), /request/);
  assert.throws(() => writeNodeResponse(response, result, { lingerMz: 1 }), /lingerMs/);
  for (const options of [[], new Map()]) {
    assert.throws(() => toNodeHandler(dispatcher, options), TypeError);
    assert.throws(() => writeNodeResponse(response, result, options), TypeError);
  }
  for (const from of ['x', null, {}, { body: { state: { started: false } } }]) {
    assert.throws(() => writeNodeResponse(response, result, { from }), /nodeRequest/);
  }
  assert.equal(writes, 0);
  assert.equal(typeof toNodeHandler(dispatcher, { lingerMs: 0 }), 'function');
  writeNodeResponse(response, result, { lingerMs: 0 });
  assert.equal(writes, 2);
});

it('readBody rejects malformed controls before pulling even when a text body needs no decoding', async () => {
  let pulls = 0;
  const source = { async *[Symbol.asyncIterator]() { pulls++; yield new Uint8Array([1]); } };
  for (const options of [[], new Map(), { as: 'text', signal: 42 }, { as: 'text', signl: null },
    { signal: { aborted: false, addEventListener() {}, removeEventListener() {} } }]) {
    await assert.rejects(readBody('hi', options), TypeError);
    await assert.rejects(readBody(source, options), TypeError);
  }
  assert.equal(pulls, 0);
  assert.equal(await readBody('hi', Object.assign(Object.create(null), { as: 'text', signal: null })), 'hi');
  const reason = new Error('cancelled');
  await assert.rejects(readBody('hi', { as: 'text', signal: AbortSignal.abort(reason) }), (error) => error === reason);
});

it('revision validation rejects through the Promise while valid calls retain memo identity', async () => {
  const own = compileContract({ $contract: '0.1', operations: { 'a.read': { kind: 'read', output: true } } });
  const publicRevision = own.revision();
  const hostRevision = own.revision({ audience: 'all' });
  assert.equal(own.revision(), publicRevision);
  assert.equal(own.revision({ audience: 'public' }), publicRevision);
  assert.equal(own.revision({ audience: 'all' }), hostRevision);
  for (const options of [{ audience: 'x' }, { audiance: 'all' }, [], new Map(), null]) {
    let result;
    assert.doesNotThrow(() => { result = own.revision(options); });
    assert.ok(result instanceof Promise);
    await assert.rejects(result, { code: 'JC1008' });
    assert.equal(own.revision(), publicRevision);
  }
  await Promise.all([publicRevision, hostRevision]);
});

it('ctx.fail rejects non-record option bags and keeps literal/null-prototype hints', () => {
  for (const options of [[], new Map([['retryable', true]]), new Date()]) {
    assert.throws(() => ContractFailure('busy', {}, undefined, options), /plain object/);
  }
  for (const options of [undefined, null]) assert.equal(ContractFailure('busy', {}, undefined, options).retryable, null);
  const failure = ContractFailure('busy', {}, undefined, Object.assign(Object.create(null), { retryable: true, retryAfterMs: 50 }));
  assert.equal(failure.retryable, true);
  assert.equal(failure.retryAfterMs, 50);
});

it('body-limit lint warns about UTF-8 and JSON escape witnesses admitted by maxLength', async () => {
  const make = (maxBodyBytes) => compileContract({ $contract: '0.1', operations: {
    'a.put': { kind: 'command', input: { type: 'object', required: ['q'], properties: { q: { type: 'string', maxLength: 10 } } },
      output: true, http: { method: 'POST', path: '/put' }, policy: { limits: { maxBodyBytes } } },
  } });
  for (const [value, limit] of [['€'.repeat(10), 12], ['\u0000'.repeat(10), 42]]) {
    const bounded = make(limit);
    const findings = lintContract(bounded);
    assert.deepEqual(findings.map(finding => finding.rule), ['body-limit-exceedable']);
    assert.match(findings[0].message, /62 bytes/);
    const body = JSON.stringify({ q: value });
    assert.ok(Buffer.byteLength(body) > limit);
    let calls = 0;
    const served = serveHttp(bounded, { 'a.put': () => { calls++; return true; } });
    const response = await served.dispatch({ method: 'POST', url: '/put', headers: { 'content-type': 'application/json' }, body });
    assert.equal(response.status, 413);
    assert.equal(calls, 0);
  }
  assert.deepEqual(lintContract(make(62)), []);
});

it('body-limit witnesses stay conservative around narrowing assertions and reference siblings', () => {
  const inspect = (text, wrap = value => value) => lintContract({ $contract: '0.1', $defs: {
    text: { type: 'string', maxLength: 10 },
  }, operations: { 'a.put': { kind: 'command', output: true, http: { method: 'POST', path: '/put' },
    input: wrap({ type: 'object', properties: { q: text } }), policy: { limits: { maxBodyBytes: 12 } } } } });
  for (const narrowed of [
    { pattern: '^a*$' }, { format: 'date' }, { enum: ['a'] }, { const: 'a' },
    { allOf: [{ maxLength: 1 }] }, { not: { minLength: 2 } },
    { if: { type: 'string' }, then: { maxLength: 1 } }, { contentEncoding: 'base64' },
  ]) {
    assert.deepEqual(inspect({ type: 'string', maxLength: 10, ...narrowed }), [], JSON.stringify(narrowed));
  }
  assert.deepEqual(inspect({ $ref: '#/$defs/text', maxLength: 1 }), [], 'reference assertion siblings may narrow the witness');
  assert.deepEqual(inspect({ type: 'string', maxLength: 10 }, value => ({ ...value, const: { q: 'a' } })), [],
    'an ancestor value restriction can make an otherwise unrestricted member unreachable');
});
