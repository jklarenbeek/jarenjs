import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { JarenValidator } from '@jarenjs/validate';

// A member name is one pointer token: `/` and `~` inside it are written
// `~1` and `~0` in `instancePath`, and the same escaped location is what a
// relative `$data` reference walks back up from.

function collecting(schema) {
  return new JarenValidator({ collectErrors: true, skipErrors: false }).compile(schema);
}

describe('instancePath escapes member names', function () {
  it('escapes a slash and a tilde in a properties member', function () {
    const validate = collecting({ properties: { 'a/b': { type: 'string' }, 'c~d': { type: 'string' } } });
    const errors = validate({ 'a/b': 1, 'c~d': 1 }).errors;
    assert.deepStrictEqual(errors.map((e) => e.instancePath).sort(), ['/a~1b', '/c~0d']);
  });

  it('escapes nested members and keeps plain names unchanged', function () {
    const validate = collecting({ properties: { 'a/b': { properties: { 'c~d': { type: 'string' }, plain: { type: 'string' } } } } });
    const errors = validate({ 'a/b': { 'c~d': 1, plain: 1 } }).errors;
    assert.deepStrictEqual(errors.map((e) => e.instancePath).sort(), ['/a~1b/c~0d', '/a~1b/plain']);
  });

  it('escapes the offending member of additionalProperties and patternProperties', function () {
    const additional = collecting({ additionalProperties: false });
    assert.deepStrictEqual(additional({ 'a/b': 1 }).errors.map((e) => e.instancePath), ['/a~1b']);
    const pattern = collecting({ patternProperties: { '': { type: 'string' } } });
    assert.deepStrictEqual(pattern({ 'a~/b': 1 }).errors.map((e) => e.instancePath), ['/a~0~1b']);
  });

  it('resolves a relative $data reference from a member whose name has a slash or a tilde', function () {
    const schema = {
      properties: { min: {}, 'a/b': { minimum: { $data: '1/min' } }, 'c~d': { minimum: { $data: '1/min' } } },
    };
    for (const options of [{}, { collectErrors: true }, { collectErrors: true, skipErrors: false }]) {
      const validate = new JarenValidator(options).compile(schema);
      const verdict = (data) => { const r = validate(data); return typeof r === 'object' ? r.valid : r; };
      assert.strictEqual(verdict({ 'a/b': 5, min: 10 }), false, JSON.stringify(options));
      assert.strictEqual(verdict({ 'a/b': 15, min: 10 }), true, JSON.stringify(options));
      assert.strictEqual(verdict({ 'c~d': 5, min: 10 }), false, JSON.stringify(options));
      assert.strictEqual(verdict({ 'c~d': 15, min: 10 }), true, JSON.stringify(options));
    }
  });

  it('resolves $data from members matched by additionalProperties and patternProperties', function () {
    const additional = new JarenValidator().compile({ properties: { min: {} }, additionalProperties: { minimum: { $data: '1/min' } } });
    assert.strictEqual(additional({ 'a/b': 5, min: 10 }), false);
    assert.strictEqual(additional({ 'a/b': 15, min: 10 }), true);
    const pattern = new JarenValidator().compile({ properties: { min: {} }, patternProperties: { '^x': { minimum: { $data: '1/min' } } } });
    assert.strictEqual(pattern({ 'x/y': 5, min: 10 }), false);
    assert.strictEqual(pattern({ 'x/y': 15, min: 10 }), true);
  });
});
