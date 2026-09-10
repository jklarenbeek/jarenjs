//@ts-check
/** Portable application composition; every dependency is an installed public export. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { compileContract, ContractFailure } from '@jarenjs/contract';
import { createCommand } from '@jarenjs/contract/command';
import { createProviderExecutor } from '@jarenjs/contract/provider';
import { createRunPageHandler } from '@jarenjs/contract/app';
import { openLocalClient } from '@jarenjs/contract/local';
import { open, createDbReceipts, createDbEffectStore, createDbRunStore } from '@jarenjs/linq/db';
import { createExternalEffects, createDomainRun } from '@jarenjs/flow';
import { createRunObservation } from '@jarenjs/app';

/** @param {number} count @param {any} limits */
export async function runDurableConsumer(count, limits) {
  const driver = 'Bun' in globalThis ? (await import('@jarenjs/db/bun')).bunDriver() : (await import('@jarenjs/db/node')).nodeDriver();
  const model = { $model: '0.1', collections: Object.fromEntries(['receipts', 'leases', 'items', 'operations', 'runs', 'events'].map((name) => [name, { key: '/id', schema: { type: 'object' }, indexes: [] }])) };
  const contract = compileContract({ $contract: '0.1', operations: { 'item.add': {
    kind: 'command', input: { type: 'object', properties: { key: { type: 'string' }, expected: { type: 'integer' } }, required: ['key', 'expected'] },
    output: { type: 'integer' }, errors: { conflict: { status: 409 } }, http: { method: 'POST', path: '/add' },
  } } });
  const identity = (input) => ({ tenant: 'neutral', environment: 'test', aggregate: 'item', op: 'item.add', key: input.key, hashVersion: 'canonical/1', hash: canonicalizeJson(input) });
  const mutate = async (input, ctx) => {
    const prior = await ctx.host.collections.items.get('item') ?? { id: 'item', count: 0 };
    if (prior.count !== input.expected) return ctx.fail('conflict');
    await ctx.host.collections.items.put({ id: 'item', count: prior.count + 1 }, 'item');
    await ctx.host.jobs.enqueue('notify', { count: prior.count + 1 }, { id: input.key });
    return prior.count + 1;
  };
  const baseline = await open(model, { driver, validator: null, jobs: true });
  const startBaseline = performance.now();
  try { for (let i = 0; i < count; i++) await baseline.transaction((tx) => mutate({ key: `command-${i}`, expected: i }, { host: tx, fail: ContractFailure }), { mode: 'immediate' }); }
  finally { await baseline.close(); }
  const baselineMs = performance.now() - startBaseline;
  let now = 100;
  const client = await open(model, { driver, validator: null, jobs: { now: () => now } });
  let sends = 0, resources = 1;
  const executor = createProviderExecutor({ attempts: 4, transport: async () => {
    sends++;
    // Opening another root transaction proves the effect released its lock.
    await client.transaction(() => null);
    if (sends === 2) throw new Error('ambiguous response');
    return new Response('{"correlation":"confirmed-1"}');
  } });
  resources++;
  let elapsedMs, replayMs, events = 0;
  try {
    const receipts = createDbReceipts(client, { receipts: 'receipts', leases: 'leases', runtime: { now: () => now } });
    let authorized = true;
    const command = createCommand(contract.operations['item.add'], { repository: receipts, identity, authorize: () => authorized, handler: mutate });
    const local = openLocalClient(contract, { 'item.add': command.handler });
    const start = performance.now();
    for (let i = 0; i < count; i++) {
      const result = await local.invoke('item.add', { key: `command-${i}`, expected: i });
      assert.equal(result.ok, true);
      assert.equal(result.value, i + 1);
    }
    elapsedMs = performance.now() - start;
    now += 86400000;
    const replayStart = performance.now();
    for (let i = 0; i < count; i++) {
      const result = await command.execute({ key: `command-${i}`, expected: i }, { carrier: 'job' });
      assert.equal(result.state, 'replay');
      assert.deepEqual([result.writes, result.revisions], [limits.secondWrites, limits.secondRevisions]);
    }
    replayMs = performance.now() - replayStart;
    authorized = false;
    assert.equal((await command.execute({ key: 'command-0', expected: 0 })).reason, 'unauthorized');
    assert.equal((await client.collections.items.get('item')).count, count);
    local.close();
    const effects = createDbEffectStore(client, { operations: 'operations', maxLegs: limits.legs });
    const plan = { id: 'operation', jobId: 'effect-job', kind: 'external', actor: 'reviewer', reason: 'reviewed selection', hashVersion: 'canonical/1',
      legs: ['one', 'two'].map((id) => ({ id, maxAttempts: limits.attemptsPerLeg, request: { url: `https://fixture.example/${id}`, method: 'POST', body: '{}', safety: 'single-send' } })) };
    await effects.prepare(plan);
    assert.equal((await effects.prepare(plan)).writes, 0);
    const job1 = await client.store.jobs.claim({ kinds: ['external'], owner: 'one', leaseMs: 1000 });
    const external = createExternalEffects({ store: effects, executor, authorize: () => true,
      classify: (response) => ({ state: 'confirmed', evidence: JSON.parse(response.text) }) });
    assert.equal((await external.run('operation', { lease: job1.lease })).state, 'unresolved');
    now += 1001;
    const job2 = await client.store.jobs.claim({ kinds: ['external'], owner: 'two', leaseMs: 1000 });
    assert.equal((await external.run('operation', { lease: job2.lease })).state, 'unresolved');
    assert.equal(sends, 2);
    let record = await effects.get('operation');
    const decision = { id: 'readback-1', action: 'confirm', actor: 'operator', reason: 'authoritative correlation', evidence: { providerId: 'confirmed-2' } };
    const revised = await effects.reconcile('operation', 'two', record.revision, job2.lease, decision);
    assert.equal((await effects.reconcile('operation', 'two', record.revision, job2.lease, decision)).writes, 0);
    record = revised.record;
    assert.deepEqual(record.legs.map((leg) => leg.state), ['confirmed', 'confirmed']);
    await client.store.jobs.complete(job2.lease, { state: 'complete' });
    const runStore = createDbRunStore(client, { runs: 'runs', events: 'events', maxPage: limits.pageSize, maxBytes: limits.pageBytes });
    await client.store.jobs.enqueue('workflow', {}, { id: 'workflow-job' });
    const job = await client.store.jobs.claim({ kinds: ['workflow'], owner: 'runner', leaseMs: 1000 });
    const doc = { $workflow: '0.2', revision: '1', initial: 'run', states: { run: { work: { task: 'summarize', version: '1' }, then: 'done' }, done: { final: true } } };
    const runner = createDomainRun(doc, { store: runStore, schemaVersion: '1', tasks: { summarize: { version: '1', run: () => ({ count }) } } });
    const result = await runner.run('existing-run', {}, { lease: job.lease });
    assert.equal(result.result.count, count);
    let cursor = 0, more = true;
    while (more) { const page = await runStore.page('existing-run', { after: cursor, limit: limits.pageSize }); events += page.events.length; cursor = page.cursor; more = page.more; }
    const reader = createRunPageHandler({ page: runStore.page, authorize: () => true, maxPage: limits.pageSize });
    const done = Promise.withResolvers();
    const observe = createRunObservation({ readPage: reader, wake: (signal) => new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })), pageSize: limits.pageSize, maxBytes: limits.pageBytes });
    const detach = observe({ id: 1, runId: 'existing-run', cursor, update: 'progress', error: 'error' }, (name, value) => done.resolve({ name, value }));
    assert.equal((await done.promise).name, 'progress');
    detach(); observe.dispose();
    assert.equal((await runStore.get('existing-run')).status, 'done');
    await client.store.jobs.complete(job.lease, result.result);
    const heap = process.memoryUsage().heapUsed, rss = process.memoryUsage().rss;
    assert.ok(heap <= limits.heapBytes, `heap ${heap} > ${limits.heapBytes}`);
    assert.ok(rss <= limits.rssBytes, `RSS ${rss} > ${limits.rssBytes}`);
    const teardown = performance.now();
    await executor.close(); resources--; await client.close(); resources--;
    assert.equal(resources, limits.remainingResources);
    return { commands: count, baselineMs, commandMs: elapsedMs, replayMs, sends, unresolvedResends: sends - limits.legs,
      secondWrites: 0, secondRevisions: 0, events, sampledHeapBytes: heap, rssBytes: rss,
      teardownMs: performance.now() - teardown, remainingResources: resources };
  }
  finally { await executor.close(); await client.close(); }
}

/** Adopt a pre-existing column-only receipt table through installed mappings. */
export async function runPhysicalReceiptConsumer() {
  const directory = mkdtempSync(join(tmpdir(), 'jaren-durable-physical-'));
  const dbPath = join(directory, 'existing.sqlite');
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  const driver = 'Bun' in globalThis ? (await import('@jarenjs/db/bun')).bunDriver() : (await import('@jarenjs/db/node')).nodeDriver();
  const identity = () => ({ tenant: 'neutral', environment: 'test', aggregate: 'item', op: 'item.add', key: 'one', hashVersion: 'canonical/1', hash: 'input' });
  const connection = await driver.open(dbPath);
  connection.exec('CREATE TABLE business_history (tenant TEXT NOT NULL, environment TEXT NOT NULL, aggregate_id TEXT NOT NULL, operation TEXT NOT NULL, command_key TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(tenant,environment,aggregate_id,operation,command_key))');
  await connection.close();
  const names = ['tenant', 'environment', 'aggregate', 'op', 'key'];
  const physicalNames = ['tenant', 'environment', 'aggregate_id', 'operation', 'command_key'];
  const entity = {
    schema: { type: 'object', properties: { ...Object.fromEntries(names.map((name) => [name, { type: 'string', 'x-entity': { key: true } }])), body: {} } },
    physical: { table: 'business_history', keys: names, columns: { ...Object.fromEntries(names.map((name, i) => [name, { name: physicalNames[i], codec: 'text', null: 'reject' }])), body: { name: 'body', codec: 'json', null: 'reject' } } },
  };
  const adopted = { $model: '0.1', entities: { History: entity } };
  const key = (id) => Object.fromEntries(names.map((name, i) => [name, JSON.parse(id)[i]]));
  const mapping = { entity: 'History', key, read: (stored) => stored.body, write: (record) => ({ ...key(record.id), body: record }) };
  let client = await open(adopted, { driver: driver, path: dbPath, adopt: true, validator: null });
  try {
    let receipts = createDbReceipts(client, { receipts: mapping });
    const first = await receipts.execute(identity(), async () => ({ outcome: { kind: 'value', value: 1 }, references: ['historic-event'] }));
    assert.equal(first.state, 'committed');
    assert.equal((await receipts.execute(identity(), async () => assert.fail('replay executed'))).state, 'replay');
    assert.equal((await receipts.compact(identity(), { retainReplay: true, retainReferences: true, actor: 'operator', reason: 'retain references' })).writes, 1);
    await client.close();
    client = await open(adopted, { driver: driver, path: dbPath, adopt: true, validator: null });
    receipts = createDbReceipts(client, { receipts: mapping });
    assert.equal((await receipts.lookup(identity())).state, 'replay');
    const check = await driver.open(dbPath);
    try {
      assert.equal(check.prepare('SELECT COUNT(*) AS n FROM business_history').get([]).n, 1);
      const tables = check.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all([]).map((row) => row.name);
      assert.deepEqual(tables, ['business_history']);
    }
    finally { await check.close(); }
  }
  finally { await client.close(); cleanup(); }
}
