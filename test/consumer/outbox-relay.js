/** Separate-file host composition: source intent, destination receipt, then acknowledgment. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { compileContract } from '@jarenjs/contract';
import { createCommand } from '@jarenjs/contract/command';
import { open, createDbReceipts } from '@jarenjs/linq/db';

/** The source and destination may use different asynchronous SQLite hosts. */
export async function qualifyOutboxRelay(sourceFactory, destinationFactory = sourceFactory) {
  const directory = await mkdtemp(join(tmpdir(), 'jaren-outbox-relay-'));
  const sourceDriver = sourceFactory(), destinationDriver = destinationFactory();
  const model = { $model: '0.1', collections: Object.fromEntries(['items', 'receipts'].map(name => [name,
    { key: '/id', schema: { type: 'object' } }])) };
  let now = 1000, source, destination, command, handlerCalls = 0;
  const tenant = 'tenant-a';
  const contract = compileContract({ $contract: '0.1', operations: { 'stock.apply': { kind: 'command',
    input: { type: 'object', properties: { id: { type: 'string' }, tenant: { type: 'string' }, amount: { type: 'integer' } },
      required: ['id', 'tenant', 'amount'], additionalProperties: false }, output: { type: 'integer' },
  } } });
  async function connect() {
    source = await open(model, { driver: sourceDriver, path: join(directory, 'tenant.sqlite'), validator: null,
      jobs: { now: () => now }, capture: { mode: 'journal', log: true } });
    destination = await open(model, { driver: destinationDriver, path: join(directory, 'control.sqlite'), validator: null,
      capture: { mode: 'journal', log: true } });
    command = createCommand(contract.operations['stock.apply'], {
      repository: createDbReceipts(destination, { receipts: 'receipts', runtime: { now: () => now } }),
      identity: input => ({ tenant: input.tenant, environment: 'fixture', aggregate: 'stock', op: 'stock.apply',
        key: input.id, hashVersion: 'canonical/1', hash: canonicalizeJson(input) }),
      authorize: input => input.tenant === tenant,
      handler: async (input, context) => {
        handlerCalls++;
        const prior = await context.host.collections.items.get('stock') ?? { id: 'stock', amount: 0, revision: 0 };
        await context.host.collections.items.put({ id: 'stock', amount: prior.amount + input.amount, revision: prior.revision + 1 }, 'stock');
        return prior.amount + input.amount;
      },
    });
  }
  async function disconnect() {
    const results = await Promise.allSettled([source?.close(), destination?.close()]);
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  async function relay(loseAcknowledgment = false) {
    const job = await source.store.jobs.claim({ kinds: ['relay'], owner: 'relay-worker', leaseMs: 100 });
    if (!job) return { state: 'idle' };
    const result = await command.execute(job.payload, { carrier: 'job' });
    assert.ok(['committed', 'replay'].includes(result.state));
    if (loseAcknowledgment) throw new Error('delivered before acknowledgment');
    await source.store.jobs.complete(job.lease, { applied: job.payload.id });
    return result;
  }
  const page = client => client.store.changes.page({ after: 0, limit: 16, maxBytes: 16384 });
  try {
    await connect();
    await assert.rejects(source.transaction(async tx => {
      await tx.collections.items.put({ id: 'rolled', amount: 1 }, 'rolled');
      await tx.jobs.enqueue('relay', { id: 'rolled', tenant, amount: 1 }, { id: 'rolled' });
      throw new Error('producer rollback');
    }), /producer rollback/);
    assert.equal(await source.collections.items.get('rolled'), undefined);
    assert.equal(await source.store.jobs.get('rolled'), undefined);
    const input = { id: 'event-1', tenant, amount: 2 };
    await source.transaction(async tx => {
      await tx.collections.items.put({ id: 'source', amount: 2, revision: 1 }, 'source');
      await tx.jobs.enqueue('relay', input, { id: input.id });
    });
    await assert.rejects(relay(true), /delivered before acknowledgment/);
    assert.equal(handlerCalls, 1);
    const destinationPage = await page(destination);
    assert.ok(destinationPage.items.length > 0);
    const item = await destination.collections.items.get('stock');
    assert.deepEqual(item, { id: 'stock', amount: 2, revision: 1 });
    await disconnect(); now += 1000; await connect();
    const replay = await relay();
    assert.equal(replay.state, 'replay'); assert.equal(replay.writes, 0); assert.equal(replay.revisions, 0);
    assert.equal(handlerCalls, 1);
    assert.deepEqual(await destination.collections.items.get('stock'), item);
    assert.deepEqual(await page(destination), destinationPage);
    const job = await source.store.jobs.get(input.id);
    assert.equal(job.attempts, 2); assert.equal(job.state, 'done');
    assert.deepEqual(await relay(), { state: 'idle' });
    assert.deepEqual(await source.store.jobs.get(input.id), job);
    assert.deepEqual(await page(destination), destinationPage);
    assert.equal((await command.execute({ ...input, amount: 999 })).reason, 'identity-mismatch');
    assert.equal((await command.execute({ ...input, tenant: 'tenant-b' })).reason, 'unauthorized');
    assert.equal(handlerCalls, 1);
    assert.deepEqual(await destination.collections.items.get('stock'), item);
    return { source: sourceDriver.name, destination: destinationDriver.name, deliveries: 2, effects: handlerCalls,
      attempts: job.attempts, replayWrites: replay.writes, replayRevisions: replay.revisions, state: job.state };
  } finally {
    try { await disconnect(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
