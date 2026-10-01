//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migrateFormulas, rollbackFormula, resolveFormulaMigration } from '@jarenjs/json/formula/migrate';
import { compileFormula } from '@jarenjs/json/formula';
import { compileFormulaBatch } from '@jarenjs/json/formula/batch';
import { createTypeTestCompiler } from '@jarenjs/validate/query';
import { trustedBodies, SKIP } from '../adoption/trusted-bodies.js';

const sources = JSON.parse(readFileSync(new URL('../adoption/fixtures/formulas.json', import.meta.url), 'utf8')).formulas;
// the frozen corpus spells an explanation as a returned { explanation } object
const FROZEN = { translate: { explanationMember: 'explanation' } };

it('the frozen corpus translates what the query language can say, with parity, and reports the rest with its reason', async () => {
  const migration = await migrateFormulas(sources, [], FROZEN);
  assert.equal(migration.changed, 8);
  assert.deepEqual(migration.records.map((r) => r.state), ['translated-with-differences', 'translated', 'untranslatable', 'translated', 'translated', 'translated', 'untranslatable', 'disabled-preserved']);
  assert.deepEqual(migration.records.map((r) => r.reason), ['differences', 'translated', 'locale', 'translated', 'translated', 'translated', 'throw', 'disabled']);
  assert.deepEqual(migration.records[0].differences.map((d) => [d.kind, d.at.line, d.at.column]), [['nullish-arithmetic', 1, 8], ['nullish-arithmetic', 1, 20]]);
  assert.deepEqual(migration.records[2].reasons.map((r) => [r.kind, r.at.line, r.at.column]), [['locale', 1, 30]]);
  for (const record of migration.records) {
    const source = sources.find((source) => source.id === record.id);
    assert.deepEqual(record.original, source);
    if (record.native) {
      assert.deepEqual(record.native.schemas, {}, 'no input schema: the operators refuse what JavaScript would coerce');
      const compiled = compileFormula(record.native.formula, { schemas: record.native.schemas, compileTypeTest: createTypeTestCompiler() });
      assert.deepEqual(compiled.evaluate(source.input), source.expected);
      if (source.expected.kind === 'value') assert.equal(compiled.evaluate(source.input).value, trustedBodies[source.id](source.input, { SKIP }));
      if (source.id === 'amount') {
        // the coercion guard is the operator's now: text is refused where JavaScript would multiply it
        assert.throws(() => compiled.evaluate({ price: '2.5', quantity: 4 }), { code: 'JQ2001' });
        for (const price of [0, -2, 1.005, 0.1, 123456.789]) for (const quantity of [0, -3, 0.2, 4])
          assert.equal(compiled.evaluate({ price, quantity }).value, trustedBodies.amount({ price, quantity }, {}));
      }
    }
  }
  const again = await migrateFormulas(sources, migration.records, FROZEN);
  assert.equal(again.changed, 0); assert.deepEqual(again.changes, []); assert.deepEqual(again.records, migration.records);
});

it('a translation the host cannot compile is reported as one, naming what it lacks', async () => {
  const body = 'return slugOf(row.title);';
  const translate = { helpers: { slugOf: { call: { name: 'slug', version: '1' } } } };
  const { records } = await migrateFormulas([{ ...sources[0], body }], [], { translate, formula: {} });
  assert.equal(records[0].state, 'untranslatable');
  assert.equal(records[0].reasons[0].kind, 'compile');
  assert.match(records[0].reasons[0].message, /does not compile under the host's formula options.*slug@1/);
  const run = (/** @type {string} */ text) => text.toLowerCase();
  const ok = await migrateFormulas([{ ...sources[0], body }], [], { translate, formula: { helpers: { slug: { version: '1', run, trust: 'pure', cost: 1 } } } });
  assert.equal(ok.records[0].state, 'translated');
  assert.deepEqual(ok.records[0].native.formula.helpers, [{ name: 'slug', version: '1' }]);
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

it('every body is translated or reported with its reason and position, never guessed or executed', async () => {
  for (const [body, state, reason] of /** @type {[string, string, string][]} */ ([
    ['return row?.a;', 'translated', 'translated'],
    ['return row.a + row.b;', 'translated-with-differences', 'differences'],
    ['return row.a * row.b', 'translated-with-differences', 'differences'],
    ['return row.a * row.b; extra()', 'untranslatable', 'unreachable'],
    ['return null; malicious()', 'untranslatable', 'unreachable'],
    ['return row.a * row.;', 'untranslatable', 'syntax'],
    ['returnnull;', 'untranslatable', 'statement'],
    ['return\nnull;', 'untranslatable', 'return-line-break'],
    ['return \r\nrow.a * row.b;', 'untranslatable', 'return-line-break'],
    ['return row.💩 * row.b;', 'untranslatable', 'syntax'],
  ])) {
    const result = await migrateFormulas([{ ...sources[0], body }]);
    const record = result.records[0];
    assert.deepEqual([record.state, record.reason], [state, reason], body);
    assert.equal(record.original.body, body);
    assert.equal(record.native === null, state === 'untranslatable');
  }
  await assert.rejects(migrateFormulas([sources[0], sources[0]]), TypeError);
  await assert.rejects(migrateFormulas(sources, [], { maxRecords: 1 }), TypeError);
  await assert.rejects(migrateFormulas([{ ...sources[0], body: 'x'.repeat(100) }], [], { maxSourceChars: 2 }), TypeError);
});

it('two translated formulas reading different fields share a batch', async () => {
  const pair = [{ ...sources[0] }, { ...sources[0], id: 'weight', body: 'return row.grams * row.count;', input: { grams: 3, count: 2 }, expected: { kind: 'value', value: 6 } }];
  const { records } = await migrateFormulas(pair);
  assert.deepEqual(records.map((r) => r.state), ['translated-with-differences', 'translated-with-differences']);
  const batch = compileFormulaBatch(records.map((r) => ({ id: r.id, formula: r.native.formula, schemas: r.native.schemas })));
  const result = batch.evaluate([{ id: 1, price: 2.5, quantity: 4, grams: 3, count: 2 }]);
  assert.deepEqual([result.results[0].outcomes.amount.value, result.results[0].outcomes.weight.value], [10, 6]);
  // absent operands: JavaScript computes NaN, the query nothing, as the named difference says
  assert.equal(batch.evaluate([{ id: 2, price: 2.5, quantity: 4 }]).results[0].outcomes.weight.kind, 'empty');
  assert.deepEqual(records[1].differences.map((d) => d.kind), ['nullish-arithmetic', 'nullish-arithmetic']);
});
