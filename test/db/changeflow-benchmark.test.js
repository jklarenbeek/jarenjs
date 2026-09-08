//@ts-check
import { it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JarenValidator } from '@jarenjs/validate';

it('the registered benchmark publishes correct comparisons, byte costs and losing cases', () => {
  const load = (name) => JSON.parse(readFileSync(new URL(`../../benchmark/${name}`, import.meta.url), 'utf8'));
  const report = load('changeflow-results.json');
  assert.equal(new JarenValidator().compile(load('changeflow-results.schema.json'))(report), true);
  for (const shape of ['selective join', 'high fan-out join', 'graph', 'nested groups', 'offset groups']) {
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
});
