//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migrateFormulas, rollbackFormula, resolveFormulaMigration } from '@jarenjs/json/formula/migrate';
import { compileFormula } from '@jarenjs/json/formula';
import { createTypeTestCompiler } from '@jarenjs/validate/query';
import { trustedBodies } from '../adoption/trusted-bodies.js';

const sources = JSON.parse(readFileSync(new URL('../adoption/fixtures/formulas.json', import.meta.url), 'utf8')).formulas;
it('the frozen corpus converts only measured numeric/null bodies with exact native/reference parity', async () => {
  const migration = await migrateFormulas(sources);
  assert.equal(migration.changed, 8);
  assert.deepEqual(migration.records.map((r) => r.state), ['converted', 'review-required', 'review-required', 'review-required', 'converted', 'review-required', 'review-required', 'disabled-preserved']);
  assert.deepEqual(migration.records.map((r) => r.reason), ['numeric-fields-or-null', 'statements', 'intl-formatting', 'application-helper', 'numeric-fields-or-null', 'result-policy', 'throw-statement', 'disabled']);
  for (const record of migration.records) {
    const source = sources.find((source) => source.id === record.id);
    assert.deepEqual(record.original, source);
    if (record.native) {
      const compiled = compileFormula(record.native.formula, { schemas: record.native.schemas, compileTypeTest: createTypeTestCompiler() });
      assert.deepEqual(compiled.evaluate(source.input), source.expected);
      assert.equal(compiled.evaluate(source.input).value, trustedBodies[source.id](source.input, {}));
      if (source.id === 'amount') {
        assert.throws(() => compiled.evaluate({ price: '2.5', quantity: 4 }), { code: 'JQ2013' });
        for (const price of [0, -2, 1.005, 0.1, 123456.789]) for (const quantity of [0, -3, 0.2, 4])
          assert.equal(compiled.evaluate({ price, quantity }).value, trustedBodies.amount({ price, quantity }, {}));
      }
    }
  }
  const again = await migrateFormulas(sources, migration.records);
  assert.equal(again.changed, 0); assert.deepEqual(again.changes, []); assert.deepEqual(again.records, migration.records);
});

it('manual review preserves originals, previous native versions and repeated resolution is a no-op', async () => {
  const { records } = await migrateFormulas(sources);
  const original = records.find((record) => record.id === 'explain');
  const native = { formula: { $formula: '1', id: 'explain', revision: '1', resultMode: 'outcome', expression: { kind: 'explanation', text: 'protected provenance' } }, schemas: {} };
  const review = { actor: 'reviewer', reason: 'Explicit result policy', sourceHash: original.sourceHash, expectedNativeHash: original.nativeHash };
  const resolved = await resolveFormulaMigration(original, native, review);
  assert.equal(resolved.state, 'resolved'); assert.deepEqual(resolved.record.original, original.original); assert.equal(resolved.record.history.length, 1);
  assert.deepEqual(compileFormula(native.formula).evaluate({}), original.original.expected);
  assert.equal((await resolveFormulaMigration(resolved.record, native, { ...review, expectedNativeHash: resolved.record.nativeHash })).changed, 0);
  assert.equal((await resolveFormulaMigration(resolved.record, native, review)).state, 'conflict');
  await assert.rejects(resolveFormulaMigration(original, native, { ...review, actor: '' }), TypeError);
});

it('migration and rollback retain original bytes and detect later source/native edits', async () => {
  const migration = await migrateFormulas(sources);
  const edited = structuredClone(migration.records);
  edited[0].native.formula.expression = 99;
  assert.deepEqual((await migrateFormulas(sources, edited)).records, edited);
  assert.equal((await rollbackFormula(migration.records[0], sources[0], edited[0].native)).reason, 'native-edited');
  const updatedSources = structuredClone(sources); updatedSources[0].body += '\r\n';
  const conflict = await migrateFormulas(updatedSources, edited);
  assert.equal(conflict.changed, 1); assert.equal(conflict.records[0].state, 'conflict');
  assert.equal(conflict.records[0].original.body, sources[0].body);
  assert.equal(conflict.records[0].current.body, updatedSources[0].body);
  assert.equal((await migrateFormulas(updatedSources, conflict.records)).changed, 0);
  assert.equal((await rollbackFormula(migration.records[0], updatedSources[0], migration.records[0].native)).reason, 'source-edited');
  const restore = await rollbackFormula(migration.records[0], sources[0], migration.records[0].native);
  assert.equal(restore.state, 'restored'); assert.equal(restore.source.body, sources[0].body);
  assert.equal((await rollbackFormula(migration.records[0], restore.source, restore.native)).changed, 0);
});

it('unsupported and malformed bodies remain visible, never guessed or executed', async () => {
  const bodies = ['return row?.a;', 'return row.a + row.b;', 'return row.a * row.b; extra()', 'return row.a * row.;', 'returnnull;', 'return row.a * row.b', 'return null; malicious()', 'return\nnull;', 'return \r\nrow.a * row.b;', 'return row.💩 * row.b;'];
  for (const body of bodies) {
    const result = await migrateFormulas([{ ...sources[0], body }]);
    assert.equal(result.records[0].state, 'review-required'); assert.equal(result.records[0].original.body, body);
  }
  await assert.rejects(migrateFormulas([sources[0], sources[0]]), TypeError);
  await assert.rejects(migrateFormulas(sources, [], { maxRecords: 1 }), TypeError);
  await assert.rejects(migrateFormulas([{ ...sources[0], body: 'x'.repeat(100) }], [], { maxSourceChars: 2 }), TypeError);
});
