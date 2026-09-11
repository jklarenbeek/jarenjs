//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { compileRulePlan, selectRuleChanges } from '@jarenjs/json/rules';
import { defineFormula } from '@jarenjs/linq/formula';

const target = (id, field, expression) => ({ id, field, formula: defineFormula(id, expression) });
const definition = (targets) => ({ $rules: '1', id: 'adjust', revision: '1', targets });
it('review plans are immutable, deterministic, read-only and content-verified', async () => {
  const rows = [{ id: 'a', count: 2 }, { id: 'b', count: 3 }];
  const compiled = compileRulePlan(definition([target('count', '/count', { $mul: ['$.count', 2] })]), { writableFields: ['/count'] });
  const plan = await compiled.preview({ rows, datasetRevision: '1' });
  assert.deepEqual(rows, [{ id: 'a', count: 2 }, { id: 'b', count: 3 }]);
  assert.equal(plan.changes.length, 2); assert.equal(Object.isFrozen(plan.changes[0]), true);
  const current = await compiled.preview({ rows, datasetRevision: '1' }); assert.deepEqual(current, plan);
  assert.deepEqual(await selectRuleChanges(JSON.parse(JSON.stringify(plan)), [plan.changes[1].id], current), [plan.changes[1]]);
  assert.deepEqual(await selectRuleChanges(plan, [], current), []);
  const stale = await compiled.preview({ rows, datasetRevision: '2' });
  await assert.rejects(selectRuleChanges(plan, [plan.changes[0].id], stale), { code: 'JQ2015' });
  const tampered = structuredClone(plan); tampered.changes[0].proposed = 999;
  await assert.rejects(selectRuleChanges(tampered, [plan.changes[0].id], current), { code: 'JQ2015' });
  await assert.rejects(selectRuleChanges(plan, ['missing'], current), { code: 'JQ2015' });
  await assert.rejects(selectRuleChanges(plan, [plan.changes[0].id, plan.changes[0].id], current), { code: 'JQ2015' });
});

it('conflicts include no-op targets; grouping, duplicates, disabled targets and errors have exact counts', async () => {
  const compiled = compileRulePlan(definition([target('same', '/count', '$.count'), target('other', '/count', 99),
    target('new', '/flag', true), target('duplicate', '/flag', true), target('bad', '/error', { $mul: ['bad', 2] }),
    { id: 'disabled', enabled: false, formula: { broken: true } }]), { writableFields: ['/count', '/flag', '/error'], groupKey: (row) => row.group });
  const plan = await compiled.preview({ rows: [{ id: 'a', count: 2, group: 'g' }, { id: 'b', count: 3, group: 'g' }], datasetRevision: '1' });
  assert.deepEqual(plan.counts, { rows: 1, cells: 6, value: 4, empty: 0, skip: 0, explanation: 0, error: 1, disabled: 1, inputRows: 2, candidates: 4, changes: 1, noops: 1, conflicts: 1, deduplicated: 2 });
  assert.equal(plan.changes[0].field, '/flag'); assert.deepEqual(plan.changes[0].before, { present: false });
  assert.deepEqual(plan.changes[0].targetIds, ['new', 'duplicate']); assert.equal(plan.errors.length, 2);
  assert.throws(() => compileRulePlan(definition([target('bad', '/secret', 1)]), { writableFields: [] }), { code: 'JQ2015' });
  await assert.rejects(compiled.preview({ rows: [], datasetRevision: '' }), { code: 'JQ2015' });
  await assert.rejects(compiled.preview({ rows: [{ id: 'a', group: 'g' }, { id: 'a', group: 'g' }], datasetRevision: '1' }), { code: 'JQ2015' });
});
