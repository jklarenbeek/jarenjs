//@ts-check
/** One public application composition; the host selects its driver and authority. */
import assert from 'node:assert/strict';
import { createApp, createTaskEffect } from '@jarenjs/app';
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { compileContract, ContractFailure } from '@jarenjs/contract';
import { createCommand } from '@jarenjs/contract/command';
import { openLocalClient } from '@jarenjs/contract/local';
import { contractAppBinding, createContractEffect } from '@jarenjs/contract/app';
import { open, createDbReceipts } from '@jarenjs/linq/db';
import { asyncLive } from '@jarenjs/db/async-live';
import { liveAppBinding, createLiveSubscription } from '@jarenjs/db/app';

/** Logical data and receipts use the same model on both backends. */
export const backendModel = { $model: '0.1', collections: {
  items: { key: '/id', schema: { type: 'object', required: ['id', 'scope', 'label', 'amount', 'revision'],
    properties: { id: { type: 'string' }, scope: { type: 'string' }, label: { type: 'string' },
      amount: { type: 'string' }, revision: { type: 'integer' } } } },
  receipts: { key: '/id', schema: { type: 'object' } },
} };
const query = [{ $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it' }];
const contract = compileContract({ $contract: '0.1', operations: { 'item.put': {
  kind: 'command', input: { type: 'object', additionalProperties: false,
    required: ['key', 'id', 'scope', 'label', 'amount'], properties: Object.fromEntries(
      ['key', 'id', 'scope', 'label', 'amount'].map(name => [name, { type: 'string', minLength: 1, maxLength: 128 }])) },
  output: backendModel.collections.items.schema, errors: { denied: { status: 403 } },
} } });

/** The app's completion observer has one subscription and a finite deadline.
 * @param {any} app @param {(state: any) => boolean} predicate */
function settled(app, predicate) {
  return new Promise((resolve, reject) => {
    let off = () => {};
    const timer = setTimeout(() => { off(); reject(new Error('backend app did not settle')); }, 5000);
    const accept = state => { if (predicate(state)) { clearTimeout(timer); off(); resolve(state); } };
    off = app.subscribe(accept); accept(app.getState());
  });
}

/** Runtime handles and authorization stay outside the JSON application document.
 * @param {any} target @param {{ now: () => number, authorize: Function }} host */
export async function openBackendApp(target, host) {
  const client = await open(backendModel, { ...target, jobs: { now: host.now },
    capture: { mode: 'journal', log: true },
    live: asyncLive({ maxQueries: 2, maxMaintained: 128, maxInputRows: 128,
      maxBytes: 65536, maxInputBytes: 65536, maxObservers: 2, pollMs: 20, pageRows: 8 }) });
  let app, local;
  try {
    const repository = createDbReceipts(client, { receipts: 'receipts', runtime: { now: host.now } });
    const command = createCommand(contract.operations['item.put'], {
      repository, authorize: input => host.authorize(input?.scope),
      identity: input => ({ tenant: input.scope, environment: 'qualification', aggregate: input.id,
        op: 'item.put', key: input.key, hashVersion: 'canonical/1', hash: canonicalizeJson(input) }),
      refuse: () => ContractFailure('denied'),
      handler: async (input, ctx) => {
        const previous = await ctx.host.collections.items.get(input.id);
        const row = { id: input.id, scope: input.scope, label: input.label, amount: input.amount,
          revision: (previous?.revision ?? 0) + 1 };
        await ctx.host.collections.items.put(row, row.id);
        await ctx.host.jobs.enqueue('notify', { id: row.id, revision: row.revision }, { id: input.key });
        return row;
      },
    });
    local = openLocalClient(contract, { 'item.put': command.handler });
    const tasks = contractAppBinding(contract);
    const binding = liveAppBinding({ statePath: '/live', collection: 'items', query, mode: 'resnapshot' });
    app = createApp({ state: { contract: tasks.slice, live: null, failure: null },
      view: [{ match: '$', body: ['main', {}, 'Portable store application'] }],
      actions: { ...tasks.actions, ...binding.actions,
        'db/liveChanged/error': { patch: [{ op: 'replace', path: '/failure', value: '$payload' }] } },
      subs: [binding.subscription],
    }, { effects: { contract: createContractEffect(local, { createTaskEffect }) },
      subs: { 'db/live': createLiveSubscription(client.store) } });
    return { app, client, command,
      async invoke(input) {
        const id = app.getState().contract['item.put'].id + 1;
        app.dispatch('contract/item.put/start', input);
        await settled(app, state => state.contract['item.put'].id === id
          && ['done', 'error'].includes(state.contract['item.put'].status));
        return app.getState().contract['item.put'];
      },
      async close() { app.destroy(); local.close(); await client.close(); },
    };
  }
  catch (error) { app?.destroy(); local?.close(); await client.close(); throw error; }
}

/** Identical assertions run from installed packages and relocated executables.
 * Each target owns its file/schema and a distinct durable replica identity.
 * @param {any} target @param {any} peer */
export async function qualifyBackendApp(target, peer) {
  let now = 1000, allowed = true, running, replica;
  const host = { now: () => now, authorize: scope => allowed && scope === 'tenant-a' };
  const input = { key: 'request-1', id: 'item/~😀', scope: 'tenant-a',
    label: 'Green tea', amount: '9007199254740993.123456' };
  const expected = { id: input.id, scope: input.scope, label: input.label, amount: input.amount, revision: 1 };
  const started = performance.now();
  try {
    running = await openBackendApp(target, host);
    await settled(running.app, state => state.live !== null);
    assert.equal(running.client.capabilities.validated, true);
    assert.equal((await running.invoke(input)).status, 'done');
    await settled(running.app, state => state.live?.rows[0]?.revision === 1);
    assert.deepEqual(running.app.getState().live.rows, [expected]);
    assert.equal(running.app.getState().failure, null);
    assert.deepEqual(JSON.parse(JSON.stringify(running.app.getState())), running.app.getState());
    const store = running.client.store;
    const before = await store.changes.page({ after: 0, limit: 8, maxBytes: 65536 });
    assert.deepEqual(before.items.map(record => record.seq), [1]);
    assert.equal((await running.invoke(input)).status, 'done');
    assert.equal((await running.command.execute(input)).state, 'replay');
    assert.deepEqual(await store.changes.page({ after: 0, limit: 8, maxBytes: 65536 }), before);
    assert.equal((await store.jobs.get(input.key)).payload.revision, 1);
    allowed = false;
    assert.equal((await running.invoke(input)).error.code, 'denied');
    allowed = true;
    assert.equal((await running.invoke({ ...input, scope: 'tenant-b' })).error.code, 'denied');
    assert.deepEqual(await store.changes.page({ after: 0, limit: 8, maxBytes: 65536 }), before);
    await assert.rejects(running.client.transaction(async tx => {
      await tx.collections.items.put({ ...expected, id: 'rolled' }, 'rolled');
      await tx.jobs.enqueue('notify', {}, { id: 'rolled' });
      throw new Error('rollback oracle');
    }), /rollback oracle/);
    assert.equal(await store.jobs.get('rolled'), undefined);
    assert.equal(await running.client.collections.items.get('rolled'), undefined);
    const envelope = (await store.replication.page({ limit: 8, maxBytes: 65536 })).items[0];
    assert.ok(envelope);
    const old = await store.jobs.claim({ owner: 'first', kinds: ['notify'], leaseMs: 100 });
    await store.jobs.checkpointsFor(old).save(input.key, 'prepared', { id: input.id });
    const capabilities = store.capabilities;
    await running.close(); running = null;
    assert.equal(store.stats().liveQueries, 0);

    replica = await open(backendModel, { ...peer, capture: { mode: 'journal', log: true } });
    assert.equal((await replica.store.replication.apply(envelope)).status, 'applied');
    const revision = await replica.store.changes.bounds();
    assert.equal((await replica.store.replication.apply(envelope)).status, 'duplicate');
    assert.deepEqual(await replica.store.changes.bounds(), revision);
    assert.deepEqual(await replica.store.collection('items').execute(query), [expected]);
    assert.deepEqual((await replica.store.replication.page()).items, []);
    await replica.close(); replica = null;

    now = 1101;
    running = await openBackendApp(target, host);
    await settled(running.app, state => state.live?.rows.length === 1);
    assert.equal((await running.command.execute(input)).state, 'replay');
    const fresh = await running.client.store.jobs.claim({ owner: 'recovered', kinds: ['notify'] });
    assert.equal(fresh.lease.generation, 2);
    const checkpoints = running.client.store.jobs.checkpointsFor(fresh);
    assert.deepEqual(await checkpoints.load(input.key), { values: { prepared: { id: input.id } } });
    await assert.rejects(async () => running.client.store.jobs.checkpointsFor(old).save(input.key, 'late', {}), { code: 'JD2066' });
    await checkpoints.complete(input.key, { notified: true });
    assert.equal((await running.client.store.jobs.get(input.key)).state, 'done');
    assert.deepEqual(await running.client.store.changes.page({ after: 0, limit: 8, maxBytes: 65536 }), before);
    await running.close(); running = null;

    // Destroy before asynchronous live registration can publish into the new app.
    running = await openBackendApp(target, host);
    const closingStore = running.client.store;
    await running.close(); running = null;
    assert.equal(closingStore.stats().liveQueries, 0);
    const metrics = target.driver.metrics?.();
    if (metrics) { assert.equal(metrics.active, 0); assert.equal(metrics.queued, 0); }
    return { application: true, contract: true, authorizedScope: true, exactValues: true,
      atomicJobs: true, durableReplay: true, journalRollback: true, asyncLive: true,
      replication: true, noEcho: true, checkpointResume: true, earlyDestroy: true,
      capabilities, elapsedMs: performance.now() - started, rssBytes: process.memoryUsage().rss,
      heapBytes: process.memoryUsage().heapUsed, peakRssBytes: process.resourceUsage().maxRSS * 1024 };
  }
  finally { try { await replica?.close(); } finally { await running?.close(); } }
}
