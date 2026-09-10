//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fixture from '../adoption/fixtures/search.json' with { type: 'json' };
import { compileLexical } from '@jarenjs/core/search';
import { compileJsonQuery } from '@jarenjs/json/query';

const definition = { version: 1, fields: fixture.fields, ...fixture.options };
const documents = fixture.documents.map((row) => ({ ...row, title: row.title.replaceAll('&amp;', '&') }));

describe('resident lexical compatibility', () => {
  for (const query of fixture.queries) it(`frozen cold membership, scores and ties: ${JSON.stringify(query.text)}`, () => {
    const index = compileLexical(definition).create();
    assert.equal(index.rebuild(documents, { generation: 1, sourceRevision: 'catalog-1' }).state, 'complete');
    const result = index.search(query.text);
    assert.equal(result.state, 'complete');
    assert.deepEqual(result.hits.map((hit) => hit.id), fixture.expected[query.id].map((hit) => hit.id));
    result.hits.forEach((hit, i) => assert.ok(Math.abs(hit.score - fixture.expected[query.id][i].score) < 1e-12));
  });
  it('keeps regex search unchanged and validates a closed versioned definition', () => {
    assert.equal(compileJsonQuery({ $search: ['green tea', 'gren'] })(null), false);
    for (const change of [{ version: 2 }, { fields: [] }, { fields: ['title', 'title'] },
      { fuzzy: -1 }, { combineWith: 'XOR' }, { prefix: 'yes' }, { boost: { missing: 2 } },
      { limits: { maxResults: Infinity } }, { mystery: true }])
      assert.throws(() => compileLexical({ ...definition, ...change }));
  });
  it('preserves leading zeros, accents, punctuation and repeated-term scoring', () => {
    const index = compileLexical({ version: 1, fields: ['title', 'sku'], prefix: false, fuzzy: 0 }).create();
    index.rebuild([{ id: 'a', title: 'Élan élan', sku: '00120' }, { id: 'b', title: 'Elan', sku: '120' }]);
    assert.deepEqual(index.search('00120').hits.map((hit) => hit.id), ['a']);
    assert.deepEqual(index.search('120').hits.map((hit) => hit.id), ['b']);
    assert.deepEqual(index.search('élan').hits.map((hit) => hit.id), ['a']);
    assert.equal(index.search('élan élan').hits[0].score, 2 * index.search('élan').hits[0].score);
    assert.deepEqual(index.search('...').hits, []);
  });
  it('application ordering changes only membership order and limits are explicit', () => {
    const index = compileLexical(definition).create(); index.rebuild(documents);
    const ranked = index.search('0000000007');
    const sorted = index.search('0000000007', { compare: (a, b) => a.id.localeCompare(b.id) });
    assert.deepEqual(sorted.hits.map((hit) => hit.id).sort(), ranked.hits.map((hit) => hit.id).sort());
    const limited = index.search('0000000007', { limit: 1 });
    assert.equal(limited.state, 'complete'); assert.equal(limited.total, 7);
    assert.equal(limited.hits.length, 1); assert.equal(limited.hasMore, true);
    const exhausted = index.search('0000000007', { credits: { work: 0 } });
    assert.equal(exhausted.state, 'budget-exhausted'); assert.equal(exhausted.total, null);
    assert.deepEqual(exhausted.hits, []);
  });
});

it('prototype-looking field names and IDs are ordinary own text and never inherited boosts', () => {
  const index = compileLexical({ version: 1, fields: ['__proto__', 'constructor'] }).create();
  const rows = [JSON.parse('{"id":"__proto__","__proto__":"green tea"}'), { id: 'constructor', constructor: 'green tea' }];
  assert.equal(index.rebuild(rows).state, 'complete');
  assert.equal(index.search('tea').total, 2); assert.ok(index.search('tea').hits.every(hit => Number.isFinite(hit.score)));
  const copy = compileLexical({ version: 1, fields: ['__proto__', 'constructor'] }).create();
  assert.equal(copy.restore(index.snapshot(), { sourceRevision: '' }).state, 'complete');
  assert.deepEqual(copy.search('tea').hits, index.search('tea').hits); index.dispose(); copy.dispose();
});
