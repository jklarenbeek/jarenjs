import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { getSchemaDraftByVersion } from '@jarenjs/refs';

// A version is one of the four draft numbers; a name that merely exists on
// every object is not a draft.

describe('getSchemaDraftByVersion', function () {
  it('refuses the names every object inherits', function () {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.throws(() => getSchemaDraftByVersion(/** @type {any} */ (name)), /Unknown reference schema version/, name);
    }
  });

  it('still answers the four drafts by number or by numeric text', function () {
    assert.strictEqual(getSchemaDraftByVersion(7).draft, 'http://json-schema.org/draft-07/schema');
    assert.strictEqual(getSchemaDraftByVersion(/** @type {any} */ ('2020')).draft, 'https://json-schema.org/draft/2020-12/schema');
  });
});
