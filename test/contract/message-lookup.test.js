//@ts-check

/**
 * A message id is looked up by own member only, in the host catalog and in
 * the built-in English one, so an inherited name is a miss and the fixed
 * fallback answers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileMessageCatalog } from '@jarenjs/core/message';
import { renderMessage } from '../../packages/contract/src/http/wire.js';

describe('renderMessage with an inherited msgid', () => {
  for (const msgid of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
    it(`answers the fallback for '${msgid}'`, () => {
      const fallback = renderMessage(null, 'contract/no-such-message', {});
      assert.strictEqual(renderMessage(null, msgid, { a: 1 }), fallback);
      const host = compileMessageCatalog({ 'contract/handler-error': 'mislukt' });
      assert.strictEqual(renderMessage(host, msgid, { a: 1 }), fallback);
    });
  }

  it('still renders an own host entry and falls back to English for the rest', () => {
    const host = compileMessageCatalog({ 'contract/handler-error': 'mislukt' });
    assert.strictEqual(renderMessage(host, 'contract/handler-error', {}), 'mislukt');
    assert.strictEqual(renderMessage(null, 'contract/handler-error', { op: 'a', code: 'X' }), 'operation a failed with X');
  });
});
