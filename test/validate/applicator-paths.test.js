import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { JarenValidator } from '@jarenjs/validate';

// A subschema is handed the location of the instance it applies to. That
// location is what its errors report and what a relative `$data` reference
// inside it is resolved against.

const MODES = [
  ['first-failure', {}],
  ['collecting', { collectErrors: true, skipErrors: false }],
];

function verdict(options, schema, data) {
  const result = new JarenValidator(options).compile(schema)(data);
  return typeof result === 'object' ? result.valid : result;
}

function paths(schema, data, options = {}) {
  const errors = new JarenValidator({ collectErrors: true, skipErrors: false, ...options }).compile(schema)(data).errors;
  return errors.map((e) => `${e.keyword}@${e.instancePath}`);
}

describe('relative $data inside applicators that reach the object or a member', function () {
  for (const [label, options] of MODES) {
    it(`dependentSchemas resolves against the object that holds the trigger (${label})`, function () {
      const schema = { dependentSchemas: { x: { properties: { y: { minimum: { $data: '1/min' } } } } } };
      assert.strictEqual(verdict(options, schema, { x: 1, y: 5, min: 10 }), false);
      assert.strictEqual(verdict(options, schema, { x: 1, y: 15, min: 10 }), true);
      assert.strictEqual(verdict(options, schema, { y: 5, min: 10 }), true);
    });

    it(`dependencies (schema form) resolves against the object (${label})`, function () {
      const schema = { dependencies: { x: { properties: { y: { minimum: { $data: '1/min' } } } } } };
      assert.strictEqual(verdict(options, schema, { x: 1, y: 5, min: 10 }), false);
      assert.strictEqual(verdict(options, schema, { x: 1, y: 15, min: 10 }), true);
    });

    it(`unevaluatedProperties resolves against the member it checks (${label})`, function () {
      const schema = { properties: { min: {} }, unevaluatedProperties: { minimum: { $data: '1/min' } } };
      assert.strictEqual(verdict(options, schema, { z: 5, min: 10 }), false);
      assert.strictEqual(verdict(options, schema, { z: 15, min: 10 }), true);
    });
  }
});

describe('error locations of applicator subschemas', function () {
  it('reports a dependentSchemas failure at the object, not at the trigger member', function () {
    assert.deepStrictEqual(paths({ dependentSchemas: { x: { required: ['q'] } } }, { x: 1 }), ['required@']);
    assert.deepStrictEqual(paths({ properties: { o: { dependentSchemas: { x: { required: ['q'] } } } } }, { o: { x: 1 } }), ['required@/o']);
    assert.deepStrictEqual(paths({ dependencies: { x: { required: ['q'] }, y: ['z'] } }, { x: 1 }), ['required@']);
  });

  it('reports the failure of an unevaluated member or item at that member or item', function () {
    assert.deepStrictEqual(paths({ unevaluatedProperties: { type: 'string' } }, { a: 1, 'b/c': 2 }),
      ['type@/a', 'unevaluatedProperties@', 'type@/b~1c', 'unevaluatedProperties@']);
    assert.deepStrictEqual(paths({ prefixItems: [{}], unevaluatedItems: { type: 'string' } }, [0, 1, 'x', 2]),
      ['type@/1', 'unevaluatedItems@', 'type@/3', 'unevaluatedItems@']);
  });

  it('names the failed keyword of a draft 7 array dependency, not the member', function () {
    for (const schema of [{ dependencies: { x: ['q'] } }, { dependencies: { x: ['q'], y: { required: ['z'] } } }]) {
      const [error] = new JarenValidator({ collectErrors: true, skipErrors: false }).compile(schema)({ x: 1 }).errors;
      assert.strictEqual(error.keyword, 'dependencies');
      assert.strictEqual(error.msgid, 'dependencies');
      assert.strictEqual(error.instancePath, '/x');
    }
  });
});
