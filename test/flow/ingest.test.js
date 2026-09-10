import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createIngestion } from '@jarenjs/flow';
import { open, createDbIngestionStore } from '@jarenjs/linq/db';
import { nodeDriver } from '@jarenjs/db/node';
import { model, storeOptions, plan, proof, page, provider } from './fixtures/ingestion.js';

async function setup() {
  const client = await open(model, { driver: nodeDriver(), validator: null });
  return { client, store: createDbIngestionStore(client, storeOptions) };
}
const resources = { executor: {} };

describe('complete bounded ingestion', () => {
  it('resumes partition cursors and identical input is a zero-write second run', async () => {
    const { client, store } = await setup();
    try {
      const seen = [];
      let interrupted = true;
      const ingest = createIngestion({ provider: provider(seen, () => interrupted), store, source: proof });
      assert.equal((await ingest.run(plan, resources)).reason, 'interrupted');
      assert.equal(await store.current(plan.source), undefined);
      const partial = await store.inspect(plan);
      assert.equal(partial.observations.length, 1);
      assert.deepEqual(JSON.parse(partial.observations[0].page.text), partial.observations[0].page.raw);
      interrupted = false;
      const published = await ingest.run(plan, resources);
      assert.equal(published.state, 'published');
      assert.equal(published.changes, 4);
      assert.deepEqual(seen, [['north', null], ['north', 'next'], ['south', null]]);
      const before = await client.collections.facts.toArray();
      const second = await ingest.run({ ...plan, generation: 'another-run' }, resources);
      assert.equal(second.state, 'unchanged');
      assert.deepEqual([second.changes, second.writes, second.revisions], [0, 0, 0]);
      assert.deepEqual(await client.collections.facts.toArray(), before);
      assert.equal((await client.collections.checkpoints.toArray()).length, 1);
      assert.equal(seen.length, 3);
    }
    finally { await client.close(); }
  });

  it('missing or failed partitions never replace the current complete snapshot', async () => {
    const { client, store } = await setup();
    try {
      const initial = await createIngestion({ provider: provider(), store, source: proof }).run(plan, resources);
      const changed = { ...plan, generation: 'new', policyRevision: 'policy-2' };
      const missing = { async *pages(_input, { partition }) {
        if (partition === 'south') { yield { state: 'incomplete', reason: 'partition-failed' }; return; }
        yield page(partition, null);
        yield page(partition, 'next');
        yield { state: 'complete' };
      } };
      const result = await createIngestion({ provider: missing, store, source: proof }).run(changed, resources);
      assert.equal(result.reason, 'partition-failed');
      assert.deepEqual(await store.current(plan.source), initial.manifest);
      assert.equal((await store.inspect(changed)).observations.length, 2);
    }
    finally { await client.close(); }
  });

  it('a changed source invalidates the generation and never certifies local generation numbers', async () => {
    const { client, store } = await setup();
    try {
      let checks = 0;
      const ingest = createIngestion({ provider: provider(), store, source: () => ({ version: ++checks > 2 ? 'source-2' : plan.version, consistency: 'snapshot' }) });
      assert.equal((await ingest.run(plan, resources)).reason, 'source-changed');
      assert.equal(await store.current(plan.source), undefined);
      assert.equal((await store.inspect(plan)).checkpoint.status, 'source-changed');
      assert.equal((await createIngestion({ provider: provider(), store, source: proof }).run(plan, resources)).reason, 'source-changed');
      assert.equal((await createIngestion({ provider: provider(), store, source: () => ({ version: plan.generation }) }).run({ ...plan, generation: 'g2' }, resources)).reason, 'source-changed');
    }
    finally { await client.close(); }
  });

  it('bounds total pages, rows, bytes and partition count across resumed pulls', async () => {
    for (const bounds of [{ maxPages: 1 }, { maxRows: 1 }, { maxBytes: 1 }]) {
      const { client, store } = await setup();
      try {
        const ingest = createIngestion({ provider: provider(), store, source: proof, ...bounds });
        assert.equal((await ingest.run(plan, resources)).reason, 'ingestion-limit');
        assert.equal(await store.current(plan.source), undefined);
      }
      finally { await client.close(); }
    }
    const { client, store } = await setup();
    try {
      const ingest = createIngestion({ provider: provider(), store, source: proof, maxPartitions: 1 });
      await assert.rejects(ingest.run(plan, resources), /bounded partitions/);
      assert.throws(() => createIngestion({ provider: provider(), store, source: proof, maxBytes: Infinity }), /finite/);
    }
    finally { await client.close(); }
  });

  it('rechecks authority before staging and publication', async () => {
    const { client, store } = await setup();
    try {
      const authority = { check: async () => true, publish: () => ({ state: 'refused', reason: 'authority-changed' }) };
      const result = await createIngestion({ provider: provider(), store, source: proof }).run(plan, { ...resources, authority });
      assert.equal(result.reason, 'authority-changed');
      assert.equal(await store.current(plan.source), undefined);
      assert.equal((await store.inspect(plan)).observations.length, 4);
    }
    finally { await client.close(); }
  });
});
