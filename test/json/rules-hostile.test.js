//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { compileRulePlan } from '@jarenjs/json/rules';
import { FormulaError } from '@jarenjs/json/formula';

it('a rule plan whose target is null is a coded refusal, not a TypeError', () => {
  for (const targets of [[null], [{ id: 'a', field: '/a', formula: null }, null]]) {
    assert.throws(
      () => compileRulePlan({ $rules: '1', id: 'adjust', revision: '1', targets }, { writableFields: ['/a'] }),
      (/** @type {any} */ error) => error instanceof FormulaError && error.code === 'JQ0015'
        && error.docPath === `/targets/${targets.length - 1}`);
  }
});

it('a scalar target keeps the not-writable refusal it always had', () => {
  for (const target of [5, 'x', true]) {
    assert.throws(
      () => compileRulePlan({ $rules: '1', id: 'adjust', revision: '1', targets: [target] }, { writableFields: ['/a'] }),
      (/** @type {any} */ error) => error instanceof FormulaError && error.code === 'JQ2015' && error.docPath === '/targets/0/field');
  }
});
