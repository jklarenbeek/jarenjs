//@ts-check
/** The studio lifecycle over real contract ports and a real SQLite file. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { rmSync } from 'node:fs';
import { compileContract } from '@jarenjs/contract';
import { openPortClient, servePort } from '@jarenjs/contract/port';
import { nodeDriver } from '@jarenjs/db/node';
import { createDataHandlers } from '../../packages/website/src/db-handlers.js';
import { createDataRuntime, DATA_MODEL, DATA_QUERY } from '../../packages/website/src/boundaries/data.js';
import doc from '@jarenjs/studio/contracts/data.contract.json' with { type: 'json' };
import { tempDbPath } from '../db/helpers.js';

const contract = compileContract(doc);
const liveInput = { collection: 'notes', document: [{ $for: { it: '$[*]' }, $return: '$it' }] };
const indexed = () => {
  const model = structuredClone(DATA_MODEL);
  model.collections.notes.indexes.push({ name: 'by_title', path: '$.title' });
  return model;
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await tick();
  }
  assert.ok(check(), 'the expected lifecycle event arrived');
}

function setup(t, overrides = {}) {
  const { dbPath, cleanup } = tempDbPath();
  const notices = new Set();
  const resources = [];
  let unlinks = 0;
  const table = createDataHandlers({
    init: async () => ({ topology: 'owner', vfs: 'node', version: '3' }),
    makeDriver: () => nodeDriver(), makeScratchDriver: () => nodeDriver(),
    path: () => dbPath, vfs: () => 'node', durable: () => true,
    unlink: () => { unlinks++; rmSync(dbPath, { force: true }); },
    announce: (notice) => { for (const cb of notices) cb(notice); },
    operators: undefined, ...overrides,
  });
  const connect = (clientTab = false) => {
    const { port1, port2 } = new MessageChannel();
    const server = servePort(contract, clientTab ? table.clientHandlers : table.handlers, { channel: port1 });
    const client = openPortClient(contract, { channel: port2, timeoutMs: 2000 });
    resources.push(async () => { client.close(); await server.close(); port1.close(); port2.close(); });
    return client;
  };
  const runtime = (topology = 'owner') => {
    const client = connect(topology === 'client');
    const events = [];
    const requests = [];
    const transport = {
      boot: async () => ({ topology, vfs: 'node', version: '3' }),
      bounded: (_name, work) => work(), settled: () => {}, faults: () => {},
      stage: () => 'store-open', close: () => client.close(),
      notices: (cb) => notices.add(cb),
      request: async (op, input) => {
        requests.push({ op, input });
        const result = await client.invoke(op, input);
        if (!result.ok) throw new Error(result.error.details?.message ?? result.error.message);
        return result.value;
      },
      subscribe: (input, callbacks) => client.subscribe('data.live', input, callbacks),
    };
    const { effects } = createDataRuntime({ transport: () => transport });
    const dispatch = (name, payload) => events.push({ name, payload });
    return { events, requests, run: (name, props = {}) => effects[name](props, dispatch) };
  };
  t.after(async () => {
    notices.clear();
    for (const release of resources) await release();
    await table.dispose();
    cleanup();
  });
  return { table, connect, runtime, unlinks: () => unlinks };
}

it('a numeric DOMException code crosses the port as the declared db failure with its original message', async (t) => {
  const { connect } = setup(t, { init: async () => { throw new DOMException('the access handle is held', 'NoModificationAllowedError'); } });
  const result = await connect().invoke('data.init', null);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'db');
  assert.deepEqual(result.error.details, { code: '7', message: 'the access handle is held' });
});

it('reopen then resubscribe counts only the new registration, even after a stale close', async (t) => {
  const { connect } = setup(t);
  const client = connect();
  await client.invoke('data.open', { model: DATA_MODEL });
  const snapshots = [];
  const old = client.subscribe('data.live', liveInput, { onSnapshot: (value) => snapshots.push(value) });
  await until(() => snapshots.length === 1);
  await client.invoke('data.open', { model: DATA_MODEL });
  const current = client.subscribe('data.live', liveInput, { onSnapshot: (value) => snapshots.push(value) });
  await until(() => snapshots.length === 2);
  old.stop();
  assert.deepEqual((await client.invoke('data.lives', null)).value, { count: 1 });
  current.stop();
  assert.deepEqual((await client.invoke('data.lives', null)).value, { count: 0 });
});

it('migration with two subscribers cannot go negative when both old wrappers close', async (t) => {
  const { connect } = setup(t);
  const client = connect();
  await client.invoke('data.open', { model: DATA_MODEL });
  let snapshots = 0;
  const subs = [0, 1].map(() => client.subscribe('data.live', liveInput, { onSnapshot: () => snapshots++ }));
  await until(() => snapshots === 2);
  assert.equal((await client.invoke('data.migrate', { to: indexed(), id: 'title' })).ok, true);
  for (const sub of subs) sub.stop();
  const lives = await client.invoke('data.lives', null);
  assert.equal(lives.ok, true);
  assert.deepEqual(lives.value, { count: 0 });
});

it('a failed migration leaves the next plan on the baseline', async (t) => {
  const { connect, table } = setup(t);
  const client = connect();
  await client.invoke('data.open', { model: DATA_MODEL });
  await client.invoke('data.insert', { collection: 'notes', doc: { id: 'one', title: 'kept' } });
  const invalid = indexed();
  invalid.collections.notes.schema.required = ['absent'];
  const failed = await client.invoke('data.migrate', { to: invalid, id: 'refused' });
  assert.equal(failed.ok, false);
  assert.deepEqual(table.state.model, DATA_MODEL);
  const next = await client.invoke('data.migrate', { to: indexed(), id: 'title' });
  assert.equal(next.ok, true);
  assert.ok(next.value.planned.some((sql) => sql.includes('by_title')));
});

it('channel recreate and migration are declared refusals that preserve the owner and its live registration', async (t) => {
  const { connect, unlinks } = setup(t);
  const owner = connect();
  await owner.invoke('data.open', { model: DATA_MODEL });
  let ready = false;
  owner.subscribe('data.live', liveInput, { onSnapshot: () => { ready = true; } });
  await until(() => ready);
  const client = connect(true);
  for (const [op, input] of [
    ['data.open', { model: DATA_MODEL, reset: true }],
    ['data.migrate', { to: indexed(), id: 'client-title' }],
  ]) {
    const refused = await client.invoke(op, input);
    assert.equal(refused.ok, false, op);
    assert.equal(refused.error.code, 'db');
    assert.equal(refused.error.details.code, 'JD2061');
  }
  assert.equal(unlinks(), 0);
  assert.deepEqual((await owner.invoke('data.lives', null)).value, { count: 1 });
});

it('a client boundary blocks destructive effects before sending a request', async (t) => {
  const { runtime } = setup(t);
  const owner = runtime();
  await owner.run('data-boot');
  const client = runtime('client');
  await client.run('data-boot');
  const before = client.requests.length;
  await client.run('data-open', { text: JSON.stringify(DATA_MODEL) });
  await client.run('data-migrate');
  await tick();
  assert.equal(client.requests.slice(before).filter(({ op }) => ['data.open', 'data.migrate'].includes(op)).length, 0);
  assert.equal(client.events.filter(({ name }) => name === 'data/error').length, 2);
});

it('renaming notes to memos recreates, inserts, queries and migrates the active collection without stale subscriptions', async (t) => {
  const { runtime, connect } = setup(t);
  const owner = runtime();
  await owner.run('data-boot');
  const client = runtime('client');
  await client.run('data-boot');
  const memos = { ...DATA_MODEL, collections: { memos: structuredClone(DATA_MODEL.collections.notes) } };
  await owner.run('data-open', { text: JSON.stringify(memos) });
  await until(() => owner.events.some(({ name, payload }) => name === 'data/opened' && payload.collection === 'memos'));
  await owner.run('data-insert', { title: 'renamed collection' });
  await until(() => owner.events.some(({ name, payload }) => name === 'data/live-event' && JSON.stringify(payload).includes('renamed collection')));
  await until(() => client.events.some(({ name, payload }) => name === 'data/live-event' && JSON.stringify(payload).includes('renamed collection')));
  await owner.run('data-run', { text: JSON.stringify(DATA_QUERY) });
  await until(() => owner.events.some(({ name }) => name === 'data/results'));
  await owner.run('data-migrate');
  await until(() => owner.events.some(({ name }) => name === 'data/migrated'));
  assert.deepEqual(owner.events.filter(({ name }) => name === 'data/error'), []);
  assert.deepEqual(client.events.filter(({ name }) => name === 'data/error'), []);
  const attached = runtime('client');
  await attached.run('data-boot');
  await until(() => attached.events.some(({ name, payload }) => name === 'data/live' && JSON.stringify(payload).includes('renamed collection')));
  assert.deepEqual((await connect().invoke('data.lives', null)).value, { count: 3 });
});

it('a migration replaces both tabs live snapshots and subsequent writes still reach both panes', async (t) => {
  const { runtime } = setup(t);
  const owner = runtime();
  await owner.run('data-boot');
  const client = runtime('client');
  await client.run('data-boot');
  await until(() => client.events.some(({ name }) => name === 'data/live'));
  const before = [owner, client].map((tab) => tab.events.filter(({ name }) => name === 'data/live').length);
  await owner.run('data-migrate');
  await until(() => [owner, client].every((tab, i) => tab.events.filter(({ name }) => name === 'data/live').length > before[i]));
  await owner.run('data-insert', { title: 'after migration' });
  await until(() => [owner, client].every((tab) => tab.events.some(({ name, payload }) => name === 'data/live-event' && JSON.stringify(payload).includes('after migration'))));
  assert.deepEqual([owner, client].flatMap((tab) => tab.events.filter(({ name }) => name === 'data/error')), []);
});
