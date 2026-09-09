//@ts-check
/** Equal-correctness replication and live maintenance measurements. */
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { cpus, platform } from 'node:os';
import * as assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { liveOracle, replicationModel, replicaState } from '../test/db/oracle/replication.js';

const samples = 15;
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * .95)], max: sorted.at(-1) };
};
const model = { $model: '0.1', entities: {
  Author: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, name: { type: 'string' } } } },
  Post: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, author: { type: 'string', 'x-entity': { index: true } }, title: { type: 'string' } } } },
} };
const document = [{ $for: { p: '$.Post[*]', a: '$.Author[*]' }, $where: { $eq: ['$p.author', '$a.id'] }, $return: { id: '$p.id', name: '$a.name' } }];
const measurements = [];
const graphDocument = [{ $for: { a: '$.Author[*]' }, $return: { id: '$a.id', posts: [{ $for: { p: '$.Post[*]' }, $where: { $eq: ['$p.author', '$a.id'] }, $return: '$p' }] } }];
for (const [shape, fanout, liveDocument] of [['selective join', 1, document], ['high fan-out join', 200, document], ['graph', 1, graphDocument]]) {
  for (const mode of ['incremental', 'rerun']) {
    const store = await openStore(model, { driver: nodeDriver(), capture: true });
    try {
      await store.transaction(async (tx) => {
        for (let i = 0; i < 200; i++) {
          await tx.entity('Author').create({ id: `a${i}`, name: `name${i}` });
          await tx.entity('Post').create({ id: `p${i}`, author: fanout === 1 ? `a${i}` : 'a0' });
        }
      });
      globalThis.gc?.();
      const heap = process.memoryUsage().heapUsed;
      const start = performance.now();
      const live = await store.live(liveDocument, { mode });
      const initializationMs = performance.now() - start;
      const retainedHeapBytes = process.memoryUsage().heapUsed - heap;
      const oracle = liveOracle(live, () => store.execute(liveDocument)); await oracle.check();
      const times = []; const rebuild = [];
      for (let i = 0; i < samples; i++) {
        const at = performance.now();
        if (shape === 'graph') await store.entity('Post').update('p0', { title: `changed${i}` });
        else await store.entity('Author').update('a0', { name: `changed${i}` });
        times.push(performance.now() - at);
        const freshAt = performance.now(); await oracle.check(); rebuild.push(performance.now() - freshAt);
      }
      assert.equal(oracle.emissions, samples);
      measurements.push({ shape, mode, strategy: live.mode,
        rows: 200, fanout, initializationMs, retainedHeapBytes, mutationMs: stats(times), oracleMs: stats(rebuild), stats: live.stats() });
      oracle.close();
    }
    finally { await store.close(); }
  }
}
const groupedModel = { $model: '0.1', collections: { rows: { key: '/id', schema: { type: 'object', properties: {
  id: { type: 'string' }, region: { type: 'string' }, team: { type: 'string' }, score: { type: 'number' },
} } } } };
const nested = { $for: { row: '$[*]' }, $groupby: { region: '$row.region' }, $return: {
  region: '$region', teams: [{ $for: { leaf: '$row' }, $groupby: { team: '$leaf.team' }, $return: { team: '$team', n: { $count: '$leaf' } } }],
} };
const multiple = { $for: { row: '$[*]' }, $groupby: { region: '$row.region', team: '$row.team' },
  $return: { region: '$region', team: '$team', total: { $sum: '$row.score' } } };
for (const [shape, query] of [['multiple-key groups', [multiple]], ['group aggregate', [{ $sum: { ...multiple, $return: { $sum: '$row.score' } } }]],
  ['distinct', [{ $distinct: { $for: { row: '$[*]' }, $return: '$row.team' } }]], ['nested groups', [nested]], ['offset groups', [{ $subsequence: [nested, 1, 3] }]]]) {
  for (const mode of ['auto', 'rerun']) {
    const store = await openStore(groupedModel, { driver: nodeDriver(), capture: true });
    try {
      const rows = store.collection('rows');
      for (let i = 0; i < 200; i++) await rows.put({ id: `r${i}`, region: `region${i % 20}`, team: `team${i % 5}`, score: i });
      globalThis.gc?.(); const heap = process.memoryUsage().heapUsed; const start = performance.now();
      const live = await rows.live(query, { mode });
      const initializationMs = performance.now() - start; const retainedHeapBytes = process.memoryUsage().heapUsed - heap;
      const oracle = liveOracle(live, () => rows.execute(query)); await oracle.check();
      const times = []; const rebuild = [];
      for (let i = 0; i < samples; i++) {
        const at = performance.now(); await rows.put({ id: 'r1', region: 'region1', team: `moved${i}`, score: i });
        times.push(performance.now() - at);
        const freshAt = performance.now(); await oracle.check(); rebuild.push(performance.now() - freshAt);
      }
      assert.equal(oracle.emissions, samples);
      measurements.push({ shape, mode: live.mode.mode, strategy: live.mode, rows: 200, fanout: 10,
        initializationMs, retainedHeapBytes, mutationMs: stats(times), oracleMs: stats(rebuild), stats: live.stats() });
      oracle.close();
    }
    finally { await store.close(); }
  }
}
const replication = [];
for (const mode of ['session', 'journal']) {
  const source = await openStore(replicationModel, { driver: nodeDriver(), capture: { mode }, replication: { replica: 'source' } });
  const target = await openStore(replicationModel, { driver: nodeDriver(), capture: { mode }, replication: { replica: 'target' } });
  try {
    const apply = []; const replay = []; let bytes = 0; let operations = 0;
    for (let n = 0; n < samples; n++) {
      await source.collection('notes').put({ id: 'note/~😀', n });
      const envelope = (await source.replication.page({ after: n })).items[0];
      bytes += Buffer.byteLength(JSON.stringify(envelope)); operations += envelope.operations.length;
      let at = performance.now(); await target.replication.apply(envelope); apply.push(performance.now() - at);
      at = performance.now(); await target.replication.apply(envelope); replay.push(performance.now() - at);
      assert.deepEqual(await replicaState(source), await replicaState(target));
    }
    await source.collection('notes').put({ id: 'note/~😀', n: samples });
    await target.collection('notes').put({ id: 'note/~😀', n: -1 });
    const contender = (await source.replication.page({ after: samples })).items[0];
    const before = await replicaState(target); const frontier = await target.replication.frontier();
    const conflicts = [];
    for (let n = 0; n < samples; n++) {
      const at = performance.now(); const result = await target.replication.apply(contender);
      conflicts.push(performance.now() - at);
      assert.equal(result.status, 'conflict');
      assert.deepEqual(await replicaState(target), before);
      assert.deepEqual(await target.replication.frontier(), frontier);
      assert.equal((await target.replication.conflicts()).length, 1);
    }
    replication.push({ capture: mode, envelopes: samples, operations, bytes, applyMs: stats(apply), replayMs: stats(replay),
      conflictAttempts: samples, conflictMs: stats(conflicts) });
  }
  finally { await source.close(); await target.close(); }
}
const report = { $changeflowBenchmark: '0.1', recipe: 'node --expose-gc benchmark/changeflow.js',
  measuredAt: new Date().toISOString(), runtime: process.version, host: { platform: platform(), cpu: cpus()[0]?.model }, samples,
  correctness: 'Every mutation checked against fresh SQL and a patch-only consumer; every replication delivery checked against complete state.',
  memory: { rssBytes: process.memoryUsage().rss }, live: measurements, replication };
await writeFile(new URL('./changeflow-results.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
