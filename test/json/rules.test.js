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

it('every refusal and the conflict diagnostic name a message of the formula catalog, which a pack renders in its language', async () => {
  const { formulaMessagesEn } = await import('@jarenjs/json/formula');
  const { renderQueryMessage } = await import('@jarenjs/json');
  const { nl } = await import('@jarenjs/locales');
  /** @param {() => unknown} run */
  const refusal = async (run) => {
    try { await run(); }
    catch (error) { return /** @type {any} */ (error); }
    throw new Error('expected a refusal');
  };
  const compiled = compileRulePlan(definition([target('same', '/count', '$.count'), target('other', '/count', 99)]), { writableFields: ['/count'] });
  const rows = [{ id: 'a', count: 2 }];
  const plan = await compiled.preview({ rows, datasetRevision: '1' });
  const current = await compiled.preview({ rows, datasetRevision: '2' });
  const refusals = [
    [await refusal(() => compileRulePlan(definition([]), /** @type {any} */ ({}))), 'query/formula/rule-identity', 'adjust: rule identity, targets and writable fields required'],
    [await refusal(() => compileRulePlan(definition([target('bad', '/secret', 1)]), { writableFields: [] })), 'query/formula/rule-field-not-writable', 'adjust: target field is not writable'],
    [await refusal(() => compiled.preview({ rows: [], datasetRevision: '' })), 'query/formula/rule-rows', 'adjust: bounded rows and dataset revision required'],
    [await refusal(() => compiled.preview({ rows: [{ id: 'a' }, { id: 'a' }], datasetRevision: '1' })), 'query/formula/rule-entity-duplicate', 'adjust: duplicate entity identity'],
    [await refusal(() => selectRuleChanges(plan, [], current)), 'query/formula/rule-preview-stale', 'adjust: stale or modified preview'],
    [await refusal(() => selectRuleChanges(plan, ['x', 'x'], plan)), 'query/formula/rule-selection-duplicate', 'adjust: selection must contain unique change IDs'],
    [await refusal(() => selectRuleChanges(plan, ['missing'], plan)), 'query/formula/rule-selection-unknown', 'adjust: unknown selected change'],
  ];
  for (const [error, messageId, reason] of refusals) {
    assert.deepEqual([error.code, error.messageId, error.reason], ['JQ2015', messageId, reason]);
    assert.ok(Object.hasOwn(formulaMessagesEn, messageId), messageId);
    assert.equal(renderQueryMessage(error), reason);
    assert.notEqual(renderQueryMessage(error, nl), reason, `${messageId} renders in Dutch`);
  }
  const conflict = plan.errors.find((/** @type {any} */ e) => e.code === 'JQ2015');
  assert.deepEqual(conflict, { rowId: 'a', targetId: 'other', code: 'JQ2015', docPath: '/targets', message: 'adjust: conflicting target values',
    messageId: 'query/formula/rule-conflict', params: { formulaId: 'adjust', reason: 'adjust: conflicting target values' } });
  assert.equal(renderQueryMessage(conflict), conflict.message);
  assert.equal(renderQueryMessage(conflict, nl), 'adjust: tegenstrijdige waarden voor hetzelfde veld');
});
