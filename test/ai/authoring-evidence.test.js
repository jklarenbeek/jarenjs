//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { measureAuthoring, legacyAuthoringEvidence } from '../../benchmark/lib/authoring.js';
import { authoringScorecard } from '../../benchmark/lib/authoring-probes.js';
import { AUTHORING_ATTEMPT_SCHEMA } from '../../benchmark/lib/authoring-schema.js';
import { JarenValidator } from '@jarenjs/validate';
import { readFileSync } from 'node:fs';

describe('authoring evidence', () => {
  const base = { profile: { name: 'fixture', provider: 'scripted', model: 'test', deadlineMs: 10 },
    grammar: 'program', schema: { type: 'object' }, messages: [{ role: 'user', content: 'test' }],
    measuredAt: 'fixture' };
  const client = (reply) => ({ endpoint: { provider: 'openrouter' }, complete: async () => reply });
  it('retains timeout, provider, malformed, compile, gate, wrong and correct outcomes', async () => {
    const cases = [
      ['timeout', { ...client(null), complete: () => new Promise(() => {}) }, {}],
      ['provider', { ...client(null), complete: async () => { throw new Error('transport'); } }, {}],
      ['schema', client({ message: { content: 'not-json' } }), {}],
      ['compile', client({ message: { content: '{}' } }), { gate: () => ({ valid: false, errors: [{ code: 'AI0201' }] }) }],
      ['gate', client({ message: { content: '{}' } }), { gate: () => false }],
      ['wrong', client({ message: { content: '{}' } }), { check: () => false }],
      ['correct', client({ message: { content: '{}' }, usage: { total_tokens: 12 } }), { check: () => true }],
    ];
    for (const [outcome, endpoint, extra] of cases) {
      const rows = await measureAuthoring({ ...base, client: endpoint, ...extra });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].outcome, outcome);
      assert.ok(rows[0].schemaBytes > 0);
      assert.equal(rows[0].schemaHash.length, 64);
      assert.equal(rows[0].deadlineMs, 10);
      assert.equal(Object.hasOwn(rows[0], 'raw'), false);
    }
  });
  it('keeps legacy aggregates intact and marks absent provenance unknown', () => {
    const old = { meta: { model: 'historic', authoring: { compiled: 2, trials: 3 } } };
    const record = legacyAuthoringEvidence(old);
    assert.deepEqual(record.authoring, old.meta.authoring);
    assert.equal(record.measuredAt, null);
    assert.ok(record.missing.includes('attempts'));
  });
  it('reproduces fixture evidence byte for byte through the benchmark entry', async () => {
    const a = await authoringScorecard({ live: false, trials: 1 });
    const b = await authoringScorecard({ live: false, trials: 1 });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.ok(a.rows.every((row) => row.outcome === 'correct'), JSON.stringify(a.rows));
    const check = new JarenValidator().compile(AUTHORING_ATTEMPT_SCHEMA);
    for (const name of ['authoring-fixture', 'authoring-live', 'authoring-remeasured-live']) {
      const artifact = JSON.parse(readFileSync(new URL(`../../benchmark/programmind-${name}.json`, import.meta.url), 'utf8'));
      assert.ok(artifact.rows.every((row) => check(row) === true));
    }
  });
});
