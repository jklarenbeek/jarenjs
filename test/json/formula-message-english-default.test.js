//@ts-check
/**
 * @file Every formula message a diagnostic or an error carries renders in
 * English through `renderQueryMessage` with no catalog: its params carry
 * its English as `reason`. The diagnostic of a cell whose computed input
 * produced no value carried only `formulaId`, so it rendered as its bare
 * message id.
 */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { renderQueryMessage } from '@jarenjs/json';
import { compileFormulaBatch } from '@jarenjs/json/formula/batch';
import { formulaMessagesEn } from '@jarenjs/json/formula';
import { defineFormula } from '@jarenjs/linq/formula';

/** @param {string} id @param {any} expression */
const target = (id, expression) => ({ id, formula: defineFormula(id, expression) });

it('a computed-missing diagnostic renders its English with no catalog', () => {
  const batch = compileFormulaBatch([target('a', '$.missing'), target('b', { $add: ['$computed.a', 1] })]);
  const missing = batch.evaluate([{ id: 1 }]).errors.find((e) => e.targetId === 'b');
  assert.equal(missing.messageId, 'query/formula/computed-missing');
  assert.equal(missing.message, 'b: computed dependency has no value');
  assert.deepEqual(missing.params, { formulaId: 'b', reason: 'b: computed dependency has no value' });
  assert.equal(renderQueryMessage(missing), missing.message);
  assert.equal(renderQueryMessage(missing, formulaMessagesEn), missing.message);
});

it('the computed-missing message is kept only while its params, English included, fit maxMessageChars', () => {
  const targets = [target('a', '$.missing'), target('b', { $add: ['$computed.a', 1] })];
  const fits = JSON.stringify({ formulaId: 'b', reason: 'b: computed dependency has no value' }).length;
  const at = (/** @type {number} */ maxMessageChars) => compileFormulaBatch(targets, { maxMessageChars })
    .evaluate([{ id: 1 }]).errors.find((e) => e.targetId === 'b');
  assert.equal(at(fits).messageId, 'query/formula/computed-missing');
  const over = at(fits - 1);
  assert.equal(over.messageId, undefined);
  assert.equal(over.params, undefined);
  assert.equal(over.message, 'b: computed dependency has no value'.slice(0, fits - 1));
});

it('a raised formula diagnostic and a formula error render their English with no catalog, as before', () => {
  const batch = compileFormulaBatch([target('c', { $substring: ['$.price', 1] })]);
  const raised = batch.evaluate([{ id: 1, price: 5 }]).errors[0];
  assert.equal(typeof raised.messageId, 'string');
  assert.equal(renderQueryMessage(raised), 'c: expected a string, got a number');
  assert.throws(() => compileFormulaBatch([target('d', '$.x'), target('d', '$.y')]), (error) => {
    assert.equal(renderQueryMessage(/** @type {any} */ (error)), /** @type {any} */ (error).reason);
    assert.match(/** @type {any} */ (error).messageId, /^query\/formula\//);
    return true;
  });
});
