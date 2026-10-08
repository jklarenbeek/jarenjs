//@ts-check
import { it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JarenValidator } from '@jarenjs/validate';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { cascadeModel, cascadeScenario } from './oracle/cascade.js';

it('the registered benchmark publishes correct comparisons, byte costs and losing cases', () => {
  const load = (name) => JSON.parse(readFileSync(new URL(`../../benchmark/${name}`, import.meta.url), 'utf8'));
  const report = load('changeflow-results.json');
  assert.equal(new JarenValidator().compile(load('changeflow-results.schema.json'))(report), true);
  for (const shape of ['selective join', 'high fan-out join', 'graph', 'nested groups', 'offset groups', 'multiple-key groups', 'group aggregate', 'distinct']) {
    const rows = report.live.filter((row) => row.shape === shape);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.mutationMs.p95 >= row.mutationMs.p50 && row.initializationMs >= 0));
    assert.ok(rows.every((row) => row.stats.emissions === report.samples));
    assert.ok(rows.some((row) => row.mode === 'rerun'));
  }
  for (const row of report.replication) {
    assert.equal(row.operations, row.envelopes); assert.ok(row.bytes > 0);
    assert.ok(row.applyMs.p50 > 0); assert.ok(row.replayMs.p50 > 0);
    assert.equal(row.conflictAttempts, report.samples); assert.ok(row.conflictMs.p50 > 0);
  }
  // the cascading delete rows, once measured: the same envelope from either capture mode
  if (report.cascade !== undefined) {
    assert.deepEqual(report.cascade.map((row) => row.capture).sort(), ['journal', 'session']);
    for (const row of report.cascade) {
      assert.equal(row.operations, 121);
      assert.equal(row.removed + row.nulled + 1, row.operations);
      assert.ok(row.bytes > 0 && row.deleteMs.p95 >= row.deleteMs.p50 && row.applyMs.p95 >= row.applyMs.p50);
    }
    assert.equal(report.cascade[0].bytes, report.cascade[1].bytes);
    assert.equal(report.cascade[0].removed, report.cascade[1].removed);
  }
});

it('the cascading delete case replicates the same envelope from either capture mode', async () => {
  const runs = [];
  for (const mode of ['session', 'journal']) {
    const store = await openStore(cascadeModel(), { driver: nodeDriver(), capture: { mode }, replication: { replica: 'source' } });
    const replica = await openStore(cascadeModel(), { driver: nodeDriver(), capture: { mode }, replication: { replica: 'target' } });
    try { runs.push(await cascadeScenario({ store, replica, rounds: 1, children: 3, notes: 2 })); }
    finally { await store.close(); await replica.close(); }
  }
  for (const run of runs) {
    assert.equal(run.operations, 6);
    assert.equal(run.removed, 3); assert.equal(run.nulled, 2);
    assert.ok(run.bytes > 0);
    assert.equal(run.deleteMs.length, 1); assert.equal(run.applyMs.length, 1);
    assert.ok(run.deleteMs[0] > 0 && run.applyMs[0] > 0);
  }
  assert.equal(runs[0].bytes, runs[1].bytes);
});
