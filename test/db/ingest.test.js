import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createIngestion } from '@jarenjs/flow';
import { open, createDbIngestionStore } from '@jarenjs/linq/db';
import { nodeDriver } from '@jarenjs/db/node';
import { model, storeOptions, plan, proof, page, provider } from '../flow/fixtures/ingestion.js';

describe('durable ingestion transaction ownership', () => {
  it('reopening a file resumes committed pages without duplicate facts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jaren-ingest-'));
    let client;
    try {
      const filename = join(dir, 'staging.db');
      const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/ingest-crash.js', import.meta.url)), filename], { encoding: 'utf8' });
      assert.equal(child.signal, 'SIGKILL', child.stderr);
      client = await open(model, { driver: nodeDriver(), path: filename, validator: null });
      const store = createDbIngestionStore(client, storeOptions);
      const seen = [];
      const ingest = createIngestion({ provider: provider(seen), store, source: proof });
      assert.equal((await ingest.run(plan, { executor: {} })).changes, 4);
      assert.deepEqual(seen, [['north', 'next'], ['south', null]]);
      const second = await ingest.run(plan, { executor: {} });
      assert.deepEqual([second.changes, second.writes, second.revisions], [0, 0, 0]);
      assert.equal((await client.collections.facts.toArray()).length, 4);
    }
    finally { await client?.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it('page facts and checkpoints roll back together under an enclosing transaction', async () => {
    const client = await open(model, { driver: nodeDriver(), validator: null });
    const store = createDbIngestionStore(client, storeOptions);
    try {
      await store.begin(plan);
      await assert.rejects(client.transaction(async (tx) => {
        await createDbIngestionStore(tx, storeOptions).stage(plan, 'north', page('north'));
        throw new Error('crash before commit');
      }), /crash before commit/);
      const partial = await store.inspect(plan);
      assert.equal(partial.observations.length, 0);
      assert.equal(partial.checkpoint.partitions[0].cursor, null);
      assert.equal((await store.stage(plan, 'north', page('north'))).state, 'staged');
      assert.equal((await store.stage(plan, 'north', page('north'))).writes, 0);
      assert.equal((await store.inspect(plan)).observations.length, 1);
    }
    finally { await client.close(); }
  });

  it('publication, completion evidence and facts roll back when reconciliation fails', async () => {
    const client = await open(model, { driver: nodeDriver(), validator: null });
    let rows = 0;
    const store = createDbIngestionStore(client, { ...storeOptions, reconcile: (_existing, incoming) => {
      if (++rows === 2) throw new Error('injected policy failure');
      return incoming;
    } });
    try {
      await assert.rejects(createIngestion({ provider: provider(), store, source: proof }).run(plan, { executor: {} }));
      assert.equal(await store.current(plan.source), undefined);
      assert.equal((await client.collections.facts.toArray()).length, 0);
      assert.equal((await store.inspect(plan)).checkpoint.status, 'staging');
      assert.equal((await store.inspect(plan)).observations.length, 4);
      const repaired = createDbIngestionStore(client, storeOptions);
      assert.equal((await repaired.publish(plan, proof(plan))).changes, 4);
    }
    finally { await client.close(); }
  });

  it('injected reconciliation preserves manual provenance and equal facts do not bump revisions', async () => {
    const client = await open(model, { driver: nodeDriver(), validator: null });
    const store = createDbIngestionStore(client, { ...storeOptions,
      reconcile: (existing, incoming) => existing?.provenance === 'manual' ? existing : incoming });
    try {
      const id = JSON.stringify([plan.source, 'north', 'north-first']);
      await client.collections.facts.put({ id, source: plan.source, partition: 'north', providerId: 'north-first',
        value: { id: 'north-first', quantity: 7, provenance: 'manual' }, revision: 9 }, id);
      const ingest = createIngestion({ provider: provider(), store, source: proof });
      assert.equal((await ingest.run(plan, { executor: {} })).changes, 3);
      const manual = await client.collections.facts.get(id);
      assert.equal(manual.value.quantity, 7);
      assert.equal(manual.revision, 9);
      const second = await ingest.run({ ...plan, generation: 'new-generation', policyRevision: 'policy-2' }, { executor: {} });
      assert.equal(second.state, 'published');
      assert.deepEqual([second.changes, second.writes, second.revisions], [0, 0, 0]);
      assert.deepEqual(await client.collections.facts.get(id), manual);
    }
    finally { await client.close(); }
  });

  it('refuses missing partition evidence, changed plans and stale concurrent publication', async () => {
    const client = await open(model, { driver: nodeDriver(), validator: null });
    const store = createDbIngestionStore(client, storeOptions);
    try {
      await store.begin(plan);
      assert.equal((await store.publish(plan, proof(plan))).reason, 'incomplete');
      assert.equal((await store.begin({ ...plan, version: 'other' })).reason, 'generation-mismatch');
      const stale = { ...plan, generation: 'stale', policyRevision: 'policy-2' };
      await store.begin(stale);
      await createIngestion({ provider: provider(), store, source: proof }).run(plan, { executor: {} });
      for (const partition of stale.partitions) { await store.stage(stale, partition, page(partition)); await store.stage(stale, partition, page(partition, 'next')); }
      assert.equal((await store.publish(stale, proof(stale))).reason, 'publication-conflict');
      assert.equal((await store.current(plan.source)).generation, plan.generation);
    }
    finally { await client.close(); }
  });

  it('cancellation while publication waits for the transaction owner prevents every write', async () => {
    const client = await open(model, { driver: nodeDriver(), validator: null });
    const store = createDbIngestionStore(client, storeOptions);
    try {
      await store.begin(plan);
      for (const partition of plan.partitions) { await store.stage(plan, partition, page(partition)); await store.stage(plan, partition, page(partition, 'next')); }
      let release;
      const held = client.transaction(async () => { await new Promise((resolve) => { release = resolve; }); });
      await new Promise((resolve) => setImmediate(resolve));
      const controller = new AbortController();
      const publish = store.publish(plan, proof(plan), { signal: controller.signal });
      controller.abort();
      release();
      await held;
      assert.equal((await publish).reason, 'cancelled');
      assert.equal(await store.current(plan.source), undefined);
      assert.equal((await client.collections.facts.toArray()).length, 0);
      assert.equal((await store.inspect(plan)).checkpoint.status, 'staging');
    }
    finally { await client.close(); }
  });

  it('cancellation during reconciliation rolls back facts and the completion record', async () => {
    const client = await open(model, { driver: nodeDriver(), validator: null });
    const controller = new AbortController();
    let count = 0;
    const store = createDbIngestionStore(client, { ...storeOptions, reconcile: (_prior, incoming) => {
      if (++count === 2) controller.abort();
      return incoming;
    } });
    try {
      await store.begin(plan);
      for (const partition of plan.partitions) { await store.stage(plan, partition, page(partition)); await store.stage(plan, partition, page(partition, 'next')); }
      await assert.rejects(store.publish(plan, proof(plan), { signal: controller.signal }), /cancelled/);
      assert.equal(await store.current(plan.source), undefined);
      assert.equal((await client.collections.facts.toArray()).length, 0);
    }
    finally { await client.close(); }
  });
});
