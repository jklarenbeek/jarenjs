//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nodeDriver } from '@jarenjs/db/node';
import { qualifyFormulaSources, qualifyRuleCommand } from '../consumer/formulas.js';
import { openRuleExample, savedRule } from '../../packages/website/src/examples/reviewed-rules.js';

const sources = JSON.parse(readFileSync(new URL('../adoption/fixtures/formulas.json', import.meta.url), 'utf8')).formulas;
it('portable formula and durable review composition qualifies without source evaluation', async () => {
  assert.equal((await qualifyFormulaSources(sources)).converted, 2);
  assert.equal((await qualifyRuleCommand(openRuleExample, savedRule)).secondWrites, 0);
});

it('transaction rechecks authorization, revisions and admissible values before effects', async () => {
  let checks = 0;
  const example = await openRuleExample({ driver: nodeDriver(), count: 3, authorize: (_value, ctx) => { checks++; return !ctx.host; } });
  try {
    const before = await example.rows(), plan = await example.preview(JSON.stringify(savedRule));
    const result = await example.command.execute({ key: 'inside-denied', plan, selection: [plan.changes[0].id] });
    assert.equal(result.state, 'uncommitted'); assert.equal(checks, 2);
    assert.deepEqual(await example.rows(), before);
    assert.equal((await example.client.collections.receipts.toArray()).length, 0);
  }
  finally { await example.close(); }
  const allowed = await openRuleExample({ driver: nodeDriver(), count: 3 });
  try {
    const before = await allowed.rows(), plan = await allowed.preview(JSON.stringify(savedRule));
    const modified = structuredClone(plan); modified.changes[0].proposed = 'bad';
    assert.equal((await allowed.command.execute({ key: 'tampered', plan: modified, selection: [modified.changes[0].id] })).state, 'uncommitted');
    const changed = structuredClone(savedRule); changed.revision = '2';
    await allowed.client.collections.settings.put({ id: 'saved-rule', definition: changed }, 'saved-rule');
    assert.equal((await allowed.command.execute({ key: 'rule-revision', plan, selection: [plan.changes[0].id] })).state, 'uncommitted');
    changed.targets[0].formula.expression = 'bad';
    await allowed.client.collections.settings.put({ id: 'saved-rule', definition: changed }, 'saved-rule');
    const invalid = await allowed.preview(JSON.stringify(changed));
    assert.equal((await allowed.command.execute({ key: 'invalid-output', plan: invalid, selection: [invalid.changes[0].id] })).state, 'uncommitted');
    assert.deepEqual(await allowed.rows(), before); assert.equal((await allowed.client.collections.receipts.toArray()).length, 0);
  }
  finally { await allowed.close(); }
});
