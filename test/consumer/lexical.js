//@ts-check
/** Installed consumer: the retained search dependency is absent from this package closure. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileLexical } from '@jarenjs/core/search';
const fixture = JSON.parse(readFileSync(new URL('./lexical-fixture.json', import.meta.url), 'utf8'));
const compiled = compileLexical({ version: 1, fields: fixture.fields, ...fixture.options });
const index = compiled.create();
index.rebuild(fixture.documents.map((row) => ({ ...row, title: row.title.replaceAll('&amp;', '&') })), { sourceRevision: 'fixture-1' });
for (const query of fixture.queries) {
  const result = index.search(query.text), expected = fixture.expected[query.id];
  assert.equal(result.state, 'complete'); assert.deepEqual(result.hits.map((h) => h.id), expected.map((h) => h.id));
  result.hits.forEach((hit, i) => assert.ok(Math.abs(hit.score - expected[i].score) < 1e-12));
}
index.dispose();
const consumers = JSON.parse(readFileSync(new URL('./lexical-consumers.json', import.meta.url), 'utf8'));
for (const { definition, rows } of consumers) {
  const compiled = compileLexical({ version: 1, fields: fixture.fields, ...fixture.options,
    limits: { maxResults: rows.length, maxIndexBytes: definition.budgets.search.indexBytes,
      maxTemporaryBytes: definition.budgets.resources.peakHeapBytes } });
  const index = compiled.create(); assert.equal(index.rebuild(rows, { sourceRevision: 'portable-1' }).state, 'complete');
  const result = index.search('gren tea');
  assert.equal(result.state, 'complete'); assert.equal(result.hasMore, false);
  assert.deepEqual(result.hits.map((hit) => hit.id), rows.filter((row) => row.title === 'Green tea').map((row) => row.id));
  const snapshot = index.snapshot(); index.dispose();
  const restored = compiled.create(); assert.equal(restored.restore(snapshot, { sourceRevision: 'portable-1' }).state, 'complete');
  assert.deepEqual(restored.search('gren tea').hits, result.hits);
  assert.equal(restored.rebuild(rows, { sourceRevision: 'portable-1' }).changes, 0);
  restored.dispose(); assert.equal(restored.stats().postings, 0);
}
