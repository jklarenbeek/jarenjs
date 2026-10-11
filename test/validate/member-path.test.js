import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { JarenValidator } from '@jarenjs/validate';

// Member locations come from a bounded table of escaped names; the table must
// never change an answer, however many distinct or long names pass through it.

describe('member locations through the name table', function () {
  const validate = new JarenValidator({ collectErrors: true, skipErrors: false }).compile({ additionalProperties: { type: 'string' } });
  const path = (name) => validate({ [name]: 1 }).errors.map((e) => e.instancePath).filter((p) => p.length > 0)[0];

  it('escapes the same name the same way on every use', function () {
    for (let round = 0; round < 3; round++) {
      assert.strictEqual(path('a/b'), '/a~1b');
      assert.strictEqual(path('c~d'), '/c~0d');
      assert.strictEqual(path('plain'), '/plain');
    }
  });

  it('stays correct after thousands of distinct names and for names longer than the table keeps', function () {
    for (let i = 0; i < 3000; i++) assert.strictEqual(path(`k${i}/x`), `/k${i}~1x`);
    const long = 'p/'.repeat(100);
    assert.strictEqual(path(long), '/' + 'p~1'.repeat(100));
    assert.strictEqual(path('a/b'), '/a~1b');
    assert.strictEqual(path('plain'), '/plain');
  });
});
