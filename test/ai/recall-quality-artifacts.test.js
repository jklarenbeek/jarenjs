//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JarenValidator } from '@jarenjs/validate';
import { annMetrics } from '../../benchmark/lib/relevance-ann.js';

const read = (name) => JSON.parse(readFileSync(new URL(`../../benchmark/${name}`, import.meta.url), 'utf8'));
const schema = read('recall-quality.schema.json');
const validate = new JarenValidator({ skipErrors: false, collectErrors: true }).compile(schema);
const names = ['scifact-live', 'pressure-live', 'pressure-hash'];

describe('recall quality measurement registry', () => {
  for (const name of names) it(`validates and bounds ${name}, including the declared policy decision`, () => {
    const data = read(`recall-quality-${name}.json`);
    const outcome = validate(data);
    assert.equal(outcome.valid, true, JSON.stringify(outcome.errors));
    const walk = (value) => {
      if (!value || typeof value !== 'object') return;
      for (const [key, entry] of Object.entries(value)) {
        assert.ok(!/^(apiKey|authorization|password|text|prompt|input|raw)$/i.test(key), `unsafe measurement member ${key}`);
        walk(entry);
      }
    };
    walk(data);
    if (data.rows) {
      assert.ok(data.rows.every((r) => r.datasetClass === data.dataset.datasetClass && r.model === data.embedding.model));
      assert.ok(data.rows.filter((r) => r.decision).every((r) => r.decision.pass === Object.values(r.decision.checks).every(Boolean)));
      for (const row of data.rows.filter((r) => r.oracle)) {
        const exact = data.rows.find((r) => r.size === row.size && r.policy === 'exact');
        assert.deepEqual(row.oracle, annMetrics(exact.rankings.map((r) => r.ids), row.rankings.map((r) => r.ids)));
      }
      assert.ok(data.live.usage.some((r) => r.requests > 0), 'paid usage survives a cache-only re-score');
      const invalid = structuredClone(data); invalid.rows[0].recall['10'] = 2;
      assert.equal(validate(invalid).valid, false);
    }
    else {
      const benchmark = data.results.find((r) => r.policy === 'exact-evidence');
      const runtime = data.results.find((r) => r.policy === 'runtime-exact-evidence');
      assert.equal(runtime.decision.pass, true);
      assert.deepEqual(runtime.waves, benchmark.waves);
      assert.equal(data.results.find((r) => r.policy === 'similarity-only').decision.pass, false);
      for (const row of data.results.flatMap((r) => r.waves)) {
        assert.equal(row.similarity.pairs, row.records * (row.records - 1) / 2);
        assert.equal(Object.values(row.similarity.bands).reduce((a, b) => a + b, 0), row.similarity.pairs);
      }
    }
  });
});
