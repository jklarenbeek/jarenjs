//@ts-check
/**
 * @file The formula compile cache and the batch's input keys are
 * `semanticKey` identities: a value it cannot key surfaces as the coded
 * refusal `semanticKey` raises, a cycle `JO2002` and a nest past 10000
 * levels `JO2001`, never an uncoded error, and a nest within the bound is
 * keyed and answered.
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { compileFormula } from '@jarenjs/json/formula';
import { compileFormulaBatch } from '@jarenjs/json/formula/batch';
import { defineFormula } from '@jarenjs/linq/formula';

/** `n` nested arrays around `leaf`. @param {number} n @param {unknown} leaf */
const nestArrays = (n, leaf) => {
  /** @type {any} */
  let v = leaf;
  for (let i = 0; i < n; i++) v = [v];
  return v;
};
const cyclic = () => {
  /** @type {any} */
  const c = { x: 1 };
  c.self = c;
  return c;
};

it('refuses a compile option it cannot key with the code semanticKey raises', () => {
  const doc = defineFormula('f', '$.price');
  // the compile key is [document, capabilities, schemas, type test, limits, ...]: limits are its fifth member
  assert.throws(() => compileFormula(doc, { limits: cyclic() }), {
    name: 'JsonCycleError', code: 'JO2002', docPath: '/4/self',
    message: 'JO2002: a circular reference cannot be a cache identity at /4/self',
  });
  assert.throws(() => compileFormula(doc, { limits: { steps: nestArrays(10001, 1) } }), {
    name: 'JsonDepthError', code: 'JO2001',
    message: 'JO2001: a value nested deeper than 10000 levels cannot be a cache identity',
  });
  // within the bound the key answers, and the limits are judged on their own terms
  assert.throws(() => compileFormula(doc, { limits: { steps: nestArrays(8000, 1) } }), { code: 'JQ0013' });
});

it('reports a batch input it cannot key as a coded cell error, and answers one within the bound', () => {
  const batch = compileFormulaBatch([{ id: 'f', formula: defineFormula('f', '$.price') }]);
  const rows = [{ id: 'r', price: 2 }];
  // the input key is [formula, source, computed inputs, context, revision]: the revision is its fifth member
  assert.deepEqual(batch.evaluate(rows, { revision: cyclic() }).errors, [{
    targetId: 'f', rowId: 'r', code: 'JO2002', docPath: '/4/self',
    message: 'JO2002: a circular reference cannot be a cache identity at /4/self',
  }]);
  assert.deepEqual(batch.evaluate(rows, { revision: nestArrays(10001, 1) }).errors, [{
    targetId: 'f', rowId: 'r', code: 'JO2001', docPath: '',
    message: 'JO2001: a value nested deeper than 10000 levels cannot be a cache identity',
  }]);
  const answered = batch.evaluate(rows, { revision: nestArrays(8000, 1) });
  assert.deepEqual(answered.errors, []);
  assert.equal(answered.results[0].outcomes.f.value, 2);
});
