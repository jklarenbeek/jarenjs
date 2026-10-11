//@ts-check

/**
 * A message key is looked up by own member only: `toString`, `constructor`,
 * `__proto__` and the other names every object inherits are misses like any
 * unknown key, so they fall through to the keyword's message instead of
 * rendering an inherited function.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  JarenValidator,
  ValidatorOptions,
  compileMessageCatalog,
  renderErrorMessage,
  localizeErrors,
} from '@jarenjs/validate';

const INHERITED = ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__'];

describe('renderErrorMessage with an inherited msgid', () => {
  for (const msgid of INHERITED) {
    it(`renders the keyword message for msgid '${msgid}'`, () => {
      const error = { keyword: 'type', msgid, params: { type: 'string' } };
      assert.strictEqual(renderErrorMessage(error), 'must be a string');
      const catalog = compileMessageCatalog({ type: 'moet {type} zijn' });
      assert.strictEqual(renderErrorMessage(error, catalog), 'moet string zijn');
    });
  }
});

describe('localizeErrors with an inherited msgid', () => {
  for (const msgid of INHERITED) {
    it(`re-renders through the keyword for msgid '${msgid}'`, () => {
      const errors = [{ keyword: 'type', msgid, params: { type: 'string' }, message: 'old' }];
      const catalog = compileMessageCatalog({ type: 'moet {type} zijn' });
      localizeErrors(/** @type {any} */ (errors), catalog);
      assert.strictEqual(errors[0].message, 'moet string zijn');
    });
  }
});

describe("errorMessage { $msgid } naming an inherited member", () => {
  /**
   * @param {object} spec
   * @returns {string}
   */
  function messageOf(spec) {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const validate = /** @type {any} */ (jaren.compile({ type: 'string', errorMessage: spec }));
    return validate(5).errors[0].message;
  }

  for (const msgid of INHERITED) {
    it(`'${msgid}' with an inline fallback renders the fallback`, () => {
      assert.strictEqual(messageOf({ $msgid: msgid, message: 'custom {type}' }), 'custom string');
    });

    it(`'${msgid}' alone falls back to the keyword message`, () => {
      assert.strictEqual(messageOf({ $msgid: msgid }), 'must be a string');
    });
  }
});
