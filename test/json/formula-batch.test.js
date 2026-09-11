//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { compileFormulaBatch } from '@jarenjs/json/formula/batch';
import { defineFormula } from '@jarenjs/linq/formula';
import { createTypeTestCompiler } from '@jarenjs/validate/query';

const target = (id, expression, options = {}) => ({ id, formula: defineFormula(id, expression, options) });
it('batch isolates cells, distinguishes JSON outcomes, and bounds retained diagnostics', () => {
  const targets = [target('amount', { $mul: ['$.price', 2] }), target('null', null), target('empty', '$.missing'),
    target('skip', { kind: 'skip' }, { resultMode: 'outcome' }), target('explain', { kind: 'explanation', text: 'why', value: 3 }, { resultMode: 'outcome' }),
    { id: 'disabled', enabled: false, formula: { expression: 'broken' } }, target('invalid', { $bogus: 2 })];
  const batch = compileFormulaBatch(targets, { maxErrors: 1, maxMessageChars: 32 });
  const result = batch.evaluate([{ id: 'a', price: 'wrong' }, { id: 'b', price: 3 }]);
  assert.deepEqual(result.counts, { rows: 2, cells: 14, evaluated: 10, cached: 0, value: 3, empty: 2, skip: 2, explanation: 2, error: 3, disabled: 2 });
  assert.equal(result.results[1].outcomes.amount.value, 6);
  assert.equal(result.errors.length, 1); assert.equal(result.omittedErrors, 2);
  assert.ok(result.errors[0].message.length <= 32);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.equal(batch.evaluate([{ id: 'b', price: 3 }]).counts.cached, 5);
  batch.clear(); assert.equal(batch.evaluate([{ id: 'b', price: 3 }]).counts.cached, 0);
});

it('memo hits never hide invalid JSON or constraints outside the value projection', () => {
  const profile = target('value', '$.price', { inputSchema: { id: 'row', version: '1' } });
  const batch = compileFormulaBatch([profile], { schemas: { row: { version: '1', schema: { type: 'object', properties: { id: {}, price: {}, note: { type: 'string' } } } } }, compileTypeTest: createTypeTestCompiler() });
  assert.equal(batch.evaluate([{ id: 1, price: 2, note: 'ok' }]).counts.value, 1);
  assert.equal(batch.evaluate([{ id: 1, price: 2, note: 3 }]).counts.error, 1);
  const plain = compileFormulaBatch([target('value', '$.price')]);
  plain.evaluate([{ id: 1, price: 2 }]);
  assert.equal(plain.evaluate([{ id: 1, price: 2, bad: undefined }, { id: 2, price: 3 }]).counts.error, 1);
});

it('computed DAGs use values, invalidate relevant source/context/revisions, and refuse cycles', () => {
  const batch = compileFormulaBatch([target('total', { $add: ['$computed.amount', 1] }), target('amount', { $mul: ['$.price', 2] }), target('name', '$.name')]);
  assert.equal(batch.evaluate([{ id: 1, price: 3, name: 'one' }]).results[0].outcomes.total.value, 7);
  assert.equal(batch.evaluate([{ id: 1, price: 3, name: 'two' }]).counts.evaluated, 1);
  assert.equal(batch.evaluate([{ id: 1, price: 4, name: 'two' }]).counts.evaluated, 2);
  assert.equal(batch.evaluate([{ id: 1, price: 4, name: 'two' }], { revision: '2' }).counts.evaluated, 3);
  assert.equal(batch.evaluate([{ id: 1, price: 4, name: 'two' }], { context: { tax: 2 } }).counts.evaluated, 3);
  assert.throws(() => compileFormulaBatch([target('a', '$computed.b'), target('b', '$computed.a')]), { code: 'JQ0015' });
  assert.throws(() => compileFormulaBatch([target('a', '$computed.absent')]), { code: 'JQ0015' });
  assert.throws(() => compileFormulaBatch([target('a', 1), target('a', 2)]), { code: 'JQ0015' });
  const blocked = compileFormulaBatch([{ id: 'a', enabled: false }, target('b', '$computed.a')]);
  assert.equal(blocked.evaluate([{ id: 'a' }]).results[0].outcomes.b.kind, 'error');
  const all = compileFormulaBatch([target('all', '$')]);
  all.evaluate([{ id: 1, x: 1 }]); assert.equal(all.evaluate([{ id: 1, x: 2 }]).counts.evaluated, 1);
});

it('batch bounds and non-finite outputs never turn truncation into completeness', () => {
  const batch = compileFormulaBatch([target('a', 1)], { maxRows: 1, maxCells: 1 });
  assert.throws(() => batch.evaluate([{ id: 1 }, { id: 2 }]), { code: 'JQ2009' });
  assert.throws(() => batch.evaluate([{}]), { code: 'JQ2013' });
  assert.throws(() => compileFormulaBatch([target('a', 1)]).evaluate([{ id: 1 }, { id: 1 }]), { code: 'JQ2013' });
  const errors = compileFormulaBatch([target('a', { kind: 'error', message: 'x'.repeat(10000) }, { resultMode: 'outcome' })], { maxMessageChars: 16 });
  assert.equal(errors.evaluate([{ id: 1 }]).errors[0].message, 'x'.repeat(16));
  assert.equal(errors.evaluate([{ id: 1 }]).counts.cached, 0);
});
