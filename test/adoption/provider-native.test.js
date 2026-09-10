import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adoptionRows } from '../../scripts/lib/adoption.js';
import { runIngestionConsumer, qualifyDialects } from '../consumer/providers.js';

const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url)));
const fixture = JSON.parse(readFileSync(new URL('./fixtures/providers.json', import.meta.url)));
const descriptors = JSON.parse(readFileSync(new URL('../contract/fixtures/provider-descriptors.json', import.meta.url)));

describe('native provider replacement evidence', () => {
  it('preserves all three frozen dialect transcripts through public exports', () => qualifyDialects(fixture, descriptors));
  for (const definition of manifest.consumers) it(`${definition.id} meets frozen ingestion credits and no-op recovery`, async () => {
    const result = await runIngestionConsumer(definition, adoptionRows(definition));
    assert.equal(result.rows, definition.budgets.providers.rows);
    assert.ok(result.requests <= definition.budgets.providers.pages);
    assert.ok(result.bytes <= definition.budgets.providers.bytes);
    assert.equal(result.remainingHandles, 0);
    assert.deepEqual([result.secondWrites, result.secondRevisions], [0, 0]);
  });
});
