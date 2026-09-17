import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureHybridRetrieval } from '../../benchmark/hybrid-retrieval.js';

test('hybrid instrument measures real lexical/vector lists, preserves provenance and replays corpus offline', async () => {
  const input = { take: 2, documents: [
    { id: 'a', text: 'red tea', vector: [1, 0] }, { id: 'b', text: 'black coffee', vector: [0.9, 0.1] },
    { id: 'c', text: 'green tea', vector: [0, 1] }, { id: 'd', text: 'herbal infusion', vector: [0.1, 0.9] },
  ], queries: [{ text: 'tea', vector: [1, 0], relevant: ['a', 'b'] }, { text: 'infusion', vector: [0, 1], relevant: ['c', 'd'] }] };
  const report = await measureHybridRetrieval(input);
  assert.deepEqual(report.replay, { transportCalls: 1, replayed: true });
  assert.deepEqual(report.queries.map(query => query.recall.lexical), [0.5, 0.5]);
  assert.ok(report.queries.every(query => query.rrf.every(row => row.contributions.length > 0)));
  assert.equal(report.comparisons.rrf.interval.estimate, 0.5);
  assert.deepEqual(await measureHybridRetrieval(input), report);
  await assert.rejects(measureHybridRetrieval({ documents: [], queries: [] }));
});
