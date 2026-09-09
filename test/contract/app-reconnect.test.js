//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '@jarenjs/app';
import { compileContract } from '@jarenjs/contract';
import { openHttpClient } from '@jarenjs/contract/client';
import { contractAppBinding, createContractSubscription } from '@jarenjs/contract/app';

const contract = compileContract({ $contract: '0.1', operations: {
  feed: { kind: 'subscribe', output: true, http: { method: 'GET', path: '/feed' }, policy: { stream: { resume: 'replay' } } },
} });

async function until(predicate, detail = () => '') {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate(), 'the expected stream transition settled: ' + detail());
}

it('an app slot resumes after network loss without a new start, and stopping during backoff prevents another request', async () => {
  const calls = [];
  let resume;
  const encoder = new TextEncoder();
  const client = openHttpClient(contract, {
    baseUrl: 'http://contract.test',
    sleep: () => new Promise((resolve) => { resume = resolve; }),
    fetch: async (url, init) => {
      calls.push(init);
      const seq = calls.length;
      const body = (seq === 1 ? 'event: snapshot\nid: 0\ndata: {"value":[],"resumed":false,"reset":false}\n\n' : '')
        + `event: patch\nid: ${seq}\ndata: ${JSON.stringify({ seq, patch: [{ op: 'add', path: '/-', value: seq }] })}\n\n`;
      return new Response(encoder.encode(body), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const binding = contractAppBinding(contract, { subs: { feed: { reconnect: { max: 3 } } } });
  const errors = [];
  const app = createApp({ state: { contract: binding.slice }, actions: binding.actions, subs: binding.subs,
    view: [{ match: '$', body: ['main', {}] }] }, {
    schedule: (flush) => flush(), subs: { 'contract-stream': createContractSubscription(client) }, onError: (e) => errors.push(e),
  });
  const slot = () => app.getState().contract.feed;
  try {
    app.dispatch('contract/feed/start');
    await until(() => resume !== undefined, () => JSON.stringify({ slot: slot(), errors }));
    assert.deepEqual(slot().value, [1]);
    assert.equal(slot().status, 'live');
    assert.equal(slot().id, 1);
    const firstResume = resume;
    resume = undefined;
    firstResume();
    await until(() => resume !== undefined);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].headers['last-event-id'], '1');
    assert.deepEqual(slot().value, [1, 2]);
    assert.equal(slot().seq, 2);
    assert.equal(slot().id, 1);
    assert.equal(slot().status, 'live');
    app.dispatch('contract/feed/stop');
    resume();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 2);
    assert.equal(slot().status, 'idle');
    assert.deepEqual(errors, []);
  }
  finally { app.destroy(); client.close(); }
});

it('reconnect exhaustion reaches the app slot as one network error', async () => {
  let attempts = 0;
  const client = openHttpClient(contract, { baseUrl: 'http://contract.test', sleep: async () => {},
    fetch: async () => { attempts++; throw new TypeError('offline'); } });
  const binding = contractAppBinding(contract, { subs: { feed: { reconnect: { max: 1 } } } });
  const app = createApp({ state: { contract: binding.slice }, actions: binding.actions, subs: binding.subs,
    view: [{ match: '$', body: ['main', {}] }] }, {
    schedule: (flush) => flush(), subs: { 'contract-stream': createContractSubscription(client) },
  });
  try {
    app.dispatch('contract/feed/start');
    await until(() => app.getState().contract.feed.status === 'error');
    const slot = app.getState().contract.feed;
    assert.equal(attempts, 2);
    assert.equal(slot.kind, 'network');
    assert.equal(slot.error.code, 'JC2097');
    assert.equal(slot.id, 1);
  }
  finally { app.destroy(); client.close(); }
});
