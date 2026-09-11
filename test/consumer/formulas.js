//@ts-check
/** Portable formula semantics and bounded evaluation over installed public exports. */
import assert from 'node:assert/strict';
import { compileFormula } from '@jarenjs/json/formula';
import { compileFormulaBatch } from '@jarenjs/json/formula/batch';
import { migrateFormulas, rollbackFormula } from '@jarenjs/json/formula/migrate';
import { createTypeTestCompiler } from '@jarenjs/validate/query';
import { defineFormula } from '@jarenjs/linq/formula';
import { createRuleEditor } from '@jarenjs/rules';

/** Original-source parity and two-run migration/rollback, including unsupported originals. */
export async function qualifyFormulaSources(sources) {
  const first = await migrateFormulas(sources);
  let converted = 0;
  for (const record of first.records) {
    assert.deepEqual(record.original, sources.find((source) => source.id === record.id));
    if (record.native) {
      converted++;
      const formula = compileFormula(record.native.formula, { schemas: record.native.schemas, compileTypeTest: createTypeTestCompiler() });
      assert.deepEqual(formula.evaluate(record.original.input), record.original.expected);
      const restore = await rollbackFormula(record, record.original, record.native);
      assert.equal(restore.state, 'restored'); assert.equal(restore.source.body, record.original.body);
      assert.equal((await rollbackFormula(record, restore.source, restore.native)).changed, 0);
    }
  }
  assert.equal((await migrateFormulas(sources, first.records)).changed, 0);
  assert.equal(converted, 2);
  return { originals: sources.length, converted, unresolved: first.records.filter((r) => r.state === 'review-required').length, disabled: first.records.filter((r) => r.state === 'disabled-preserved').length, originalByteChanges: 0, secondChanges: 0 };
}

/** Formula costs include compilation and snapshots; the static arithmetic oracle is retained. */
export function runFormulaConsumer(definition, rows) {
  let reference = 0;
  const baselineStart = performance.now();
  for (const row of rows) reference += row.price * row.quantity;
  const baselineMs = performance.now() - baselineStart;
  const started = performance.now();
  // This application explicitly maps nullable quantity to zero; native operators never coerce it.
  const batch = compileFormulaBatch([{ id: 'amount', formula: defineFormula('amount', { $mul: ['$.price', { $if: [{ $eq: ['$.quantity', null] }, 0, '$.quantity'] }] }) }], { maxRows: 256, maxCells: 256, memoSize: 256 });
  let total = 0, errors = 0;
  for (let offset = 0; offset < rows.length; offset += 256) {
    const result = batch.evaluate(rows.slice(offset, offset + 256));
    errors += result.counts.error;
    for (const row of result.results) total += row.outcomes.amount.value;
  }
  const evaluationMs = performance.now() - started;
  assert.equal(total, reference); assert.equal(errors, 0);
  assert.ok(evaluationMs <= definition.budgets.formulas.evaluationMs, `Formula evaluation exceeds frozen ${definition.id} time ceiling: ${evaluationMs}`);
  const memory = process.memoryUsage();
  batch.clear();
  return { consumer: definition.id, rows: rows.length, baselineMs, evaluationMs, overhead: evaluationMs / Math.max(baselineMs, 0.001), errors, pageRows: 256, sampledHeapBytes: memory.heapUsed, rssBytes: memory.rss };
}

/** The composition host is supplied by the application, never imported from repository source. */
export async function qualifyRuleCommand(openExample, savedRule) {
  const driver = 'Bun' in globalThis ? (await import('@jarenjs/db/bun')).bunDriver() : (await import('@jarenjs/db/node')).nodeDriver();
  let authorized = true;
  const example = await openExample({ driver, count: 24, authorize: () => authorized });
  try {
    const text = JSON.stringify(savedRule), before = await example.rows(), plan = await example.preview(text);
    assert.deepEqual(await example.rows(), before);
    const editor = createRuleEditor({ text, preview: example.preview, command: (request) => example.command.execute(request) });
    await editor.preview(); editor.select(plan.changes.at(-1).id);
    assert.equal((await editor.commit()).state, 'committed');
    const after = await example.rows();
    assert.equal(after.filter((row) => row.revision === 1).length, 1);
    const replay = await editor.commit(); assert.equal(replay.state, 'replay');
    assert.deepEqual([replay.writes, replay.revisions], [0, 0]); assert.deepEqual(await example.rows(), after);
    const stale = await example.command.execute({ key: 'stale', plan, selection: [plan.changes[0].id] }); assert.equal(stale.state, 'uncommitted');
    authorized = false;
    assert.equal((await example.command.execute({ key: 'denied', plan, selection: [plan.changes[0].id] })).reason, 'unauthorized');
    assert.deepEqual(await example.rows(), after); editor.dispose();
    return { previewWrites: 0, applied: 1, secondWrites: 0, secondRevisions: 0, stale: 'uncommitted', unauthorized: 'refused' };
  }
  finally { await example.close(); }
}
