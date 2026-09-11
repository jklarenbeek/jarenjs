//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { formulaFacts } from '../../scripts/generate-formula-facts.js';
import { runFormulaConsumer } from '../consumer/formulas.js';
import { adoptionRows } from '../../scripts/lib/adoption.js';

const read = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
it('formula measurements retain the unchanged freeze, source outcomes and finite budgets', () => {
  const result = read('../../benchmark/formula-result.json'), manifest = read('../adoption/manifest.json');
  assert.equal(result.freezeHash, manifest.freezeHash);
  assert.equal(result.runnerHash, createHash('sha256').update(readFileSync(new URL('../../benchmark/formulas.js', import.meta.url))).digest('hex'));
  for (const definition of manifest.consumers) {
    const measured = result.consumers.find((row) => row.consumer === definition.id);
    assert.equal(measured.rows, definition.rows); assert.equal(measured.errors, 0);
    assert.ok(measured.evaluationMs < definition.budgets.formulas.evaluationMs);
    assert.ok(measured.sampledHeapBytes < definition.budgets.resources.sampledHeapBytes);
    assert.ok(measured.rssBytes < definition.budgets.resources.peakRssBytes);
  }
  assert.deepEqual(result.sources, { originals: 8, converted: 2, unresolved: 5, disabled: 1, originalByteChanges: 0, secondChanges: 0 });
  assert.ok(formulaFacts.facts()['formula.measurements']().includes('Static arithmetic'));
  const definition = manifest.consumers[0];
  assert.equal(runFormulaConsumer(definition, adoptionRows(definition).slice(0, 300)).errors, 0);
});
