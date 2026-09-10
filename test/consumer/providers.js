//@ts-check
/** Portable provider acceptance through installed public exports only. */
import assert from 'node:assert/strict';
import { compileProvider, createProviderExecutor, withProviderRun } from '@jarenjs/contract/provider';
import { createIngestion } from '@jarenjs/flow';
import { open, createDbIngestionStore } from '@jarenjs/linq/db';

/** @param {any} definition @param {any[]} rows */
export async function runIngestionConsumer(definition, rows) {
  const started = performance.now();
  const driver = 'Bun' in globalThis ? (await import('@jarenjs/db/bun')).bunDriver() : (await import('@jarenjs/db/node')).nodeDriver();
  const model = { $model: '0.1', collections: Object.fromEntries(['staging', 'checkpoints', 'snapshots', 'facts'].map((name) => [name, {
    key: '/id', schema: { type: 'object' }, indexes: [],
  }])) };
  const client = await open(model, { driver, validator: null });
  const { pages: pageLimit, rows: rowLimit, bytes: byteLimit } = definition.budgets.providers;
  const data = rows.slice(0, rowLimit);
  const pageSize = Math.ceil(data.length / pageLimit);
  const doc = { $provider: '0.1', id: definition.id, apiVersion: '1', protocol: 'rest', method: 'GET', safety: 'safe-read',
    endpoint: `https://${definition.id}.example/items`, response: { rows: '$.items', id: '$.id', cursor: '$.next', version: '$.version' },
    pagination: { cursorParam: 'offset', empty: 'complete' }, limits: { pages: pageLimit, rows: rowLimit, bytes: byteLimit } };
  const provider = compileProvider(doc);
  const plan = { source: definition.id, version: 'snapshot-1', generation: 'generation-1', partitions: ['all'],
    input: {}, policyRevision: '1', consistency: 'snapshot' };
  const authority = { runId: definition.id, actor: 'reader', environment: definition.policy.environment,
    destination: definition.id, revision: '1', lease: `lease-${definition.id}` };
  let requests = 0, bytes = 0;
  let activeResources = 1;
  const host = {
    identify: () => ({ host: null }),
    acquire: (_input, _identity, enter) => {
      activeResources++;
      return enter({ host: { credential: 'host-private' }, release: () => { activeResources--; } });
    },
    current: () => authority,
    transport: async (request, context) => {
      assert.equal(context.host.credential, 'host-private');
      const offset = Number(new URL(request.url).searchParams.get('offset') ?? 0);
      requests++;
      const text = JSON.stringify({ items: data.slice(offset, offset + pageSize),
        next: offset + pageSize < data.length ? String(offset + pageSize) : null, version: plan.version });
      bytes += new TextEncoder().encode(text).byteLength;
      return new Response(text);
    },
  };
  const store = createDbIngestionStore(client, { staging: 'staging', checkpoints: 'checkpoints', publications: 'snapshots', facts: 'facts',
    reconcile: (existing, incoming) => existing?.provenance === 'manual' ? existing : incoming });
  const ingest = createIngestion({ provider, store, source: () => ({ version: plan.version, consistency: plan.consistency }),
    maxPages: pageLimit, maxRows: rowLimit, maxBytes: byteLimit });
  let first, second;
  try {
    const run = await withProviderRun(authority, host, async (scope) => {
      first = await ingest.run(plan, { executor: scope, authority: scope, signal: scope.signal });
      const before = requests;
      second = await ingest.run({ ...plan, generation: 'generation-2' }, { executor: scope, authority: scope, signal: scope.signal });
      assert.equal(requests, before);
      return { first, second };
    });
    assert.equal(run.state, 'complete');
    assert.equal(first.state, 'published');
    assert.equal(first.changes, data.length);
    assert.equal(second.state, 'unchanged');
    assert.deepEqual([second.changes, second.writes, second.revisions], [0, 0, 0]);
    const facts = await client.collections.facts.toArray();
    assert.deepEqual(facts.map((fact) => fact.value).sort((a, b) => a.id.localeCompare(b.id)), [...data].sort((a, b) => a.id.localeCompare(b.id)));
    assert.ok(requests <= pageLimit && bytes <= byteLimit);
    assert.ok(!JSON.stringify(run).includes('host-private'));
    const elapsedMs = performance.now() - started;
    const teardown = performance.now();
    await client.close();
    activeResources--;
    assert.equal(activeResources, 0);
    return { rows: data.length, requests, bytes, changes: first.changes, secondWrites: second.writes, secondRevisions: second.revisions,
      elapsedMs, teardownMs: performance.now() - teardown, remainingHandles: activeResources,
      sampledHeapBytes: process.memoryUsage().heapUsed, rssBytes: process.memoryUsage().rss };
  }
  finally { await client.close(); }
}

/** @param {any} fixture @param {any[]} descriptors */
export async function qualifyDialects(fixture, descriptors) {
  for (const [index, dialect] of fixture.dialects.entries()) {
    let sent = 0;
    const executor = createProviderExecutor({ transport: async () => new Response(JSON.stringify(dialect.pages[sent++])) });
    const provider = compileProvider(descriptors[index], { callbacks: {
      archiveCursor: (raw) => raw.link ? new URL(raw.link.match(/<([^>]+)>/)[1], 'https://archive.example').searchParams.get('cursor') : null,
    } });
    try {
      const result = await provider.pull({ environment: 'test' }, { executor });
      assert.deepEqual(result.observations.map((page) => page.raw), dialect.pages);
      assert.deepEqual(result.observations.flatMap((page) => page.ids), dialect.expectedIds);
      assert.equal(result.state, dialect.pages.some((page) => page.errors?.length) ? 'incomplete' : 'complete');
      assert.equal(sent, dialect.pages.length);
    }
    finally { await executor.close(); }
  }
}
