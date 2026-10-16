// A `$dynamicRef` or `$recursiveRef` whose target nothing resolves is refused
// JK0009 by the call that reaches it, as an unresolvable `$ref` is refused:
// answered, it was `false` on every instance, `true` under `not`. An instance
// that does not reach it answers, and every dynamic reference that resolves
// answers as before.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { JarenValidator, SchemaCompileError } from '@jarenjs/validate';
import { basicOutput } from '@jarenjs/validate/output';

const ORIGIN = 'https://github.com/jklarenbeek/jarenjs';
const D19 = 'https://json-schema.org/draft/2019-09/schema';
const D20 = 'https://json-schema.org/draft/2020-12/schema';
const UNHELD = 'no schema the validator holds has that URI; register it with addSchema, load it with compileAsync, or fix the reference';

/**
 * Compile a schema on a validator holding some documents.
 * @param {any} schema
 * @param {any[]} [held] - `addSchema` arguments, one array per call
 * @param {any} [options]
 */
const compiled = (schema, held = [], options = undefined) => {
  const validator = new JarenValidator(options);
  for (const args of held) validator.addSchema(...args);
  return validator.compile(schema);
};

/** Each instance's answer (`valid` of an output unit), or the code its call is refused with. */
const answers = (validate, instances) => instances.map((instance) => {
  try {
    const result = validate(instance);
    return typeof result === 'object' ? result.valid : result;
  }
  catch (error) {
    return error instanceof SchemaCompileError ? error.code : 'uncoded';
  }
});

/** The message a call throws. */
const thrown = (fn) => {
  try { fn(); }
  catch (error) { return error.message; }
  return 'no throw';
};

describe('a dynamic reference nothing resolves is refused JK0009 by the call that reaches it', () => {
  for (const [label, schema, uri] of [
    ['a $dynamicRef pointer into a document nothing holds', { $schema: D20, $dynamicRef: 'https://o.test/d.json#/x' }, 'https://o.test/d.json#/x'],
    ['a $dynamicRef anchor in a document nothing holds', { $schema: D20, $dynamicRef: 'https://o.test/d.json#foo' }, 'https://o.test/d.json#foo'],
    ['a $dynamicRef to a document nothing holds', { $schema: D20, $dynamicRef: 'https://o.test/d.json' }, 'https://o.test/d.json#'],
    ['a $dynamicRef anchor no schema declares', { $schema: D20, $dynamicRef: '#nope' }, `${ORIGIN}#nope`],
    ['a $dynamicRef in a schema that declares no draft', { $dynamicRef: 'https://o.test/d.json' }, 'https://o.test/d.json#'],
    // read as 2019-09 a $recursiveRef other than "#" is refused JK0011 (recursive-ref-value.test.js)
    ['a $recursiveRef in a schema that declares no draft', { $recursiveRef: 'https://o.test/d.json' }, 'https://o.test/d.json#'],
  ]) {
    it(label, () => {
      const validate = compiled(schema);
      assert.deepEqual(answers(validate, [1, 'a']), ['JK0009', 'JK0009']);
      assert.equal(thrown(() => validate(1)), `JK0009: Can not resolve schema for '${uri}': ${UNHELD}`);
    });
  }

  it('under not, refused where it read true', () => {
    const validate = compiled({ $schema: D20, not: { $dynamicRef: 'https://o.test/d.json#/x' } });
    assert.deepEqual(answers(validate, [1, 'a', null]), ['JK0009', 'JK0009', 'JK0009']);
  });

  it('a pointer that misses names the step that misses', () => {
    const validate = compiled({ $schema: D20, $dynamicRef: '#/$defs/nope' });
    assert.equal(thrown(() => validate(1)),
      `JK0009: Can not resolve schema for '${ORIGIN}#/$defs/nope': '/$defs' is not a schema in '${ORIGIN}#'; fix the pointer`);
  });

  it('a pointer that misses in a held document', () => {
    const validate = compiled({ $schema: D20, $dynamicRef: 'https://h.test/d.json#/$defs/x' }, [[{ $id: 'https://h.test/d.json', type: 'string' }]]);
    assert.deepEqual(answers(validate, [1, 'a']), ['JK0009', 'JK0009']);
    assert.equal(thrown(() => validate(1)),
      "JK0009: Can not resolve schema for 'https://h.test/d.json#/$defs/x': '/$defs' is not a schema in 'https://h.test/d.json#'; fix the pointer");
  });

  it('an anchor no schema declares is unresolvable, not a loop: the schema compiles', () => {
    assert.doesNotThrow(() => compiled({ $schema: D20, $dynamicRef: '#nope' }));
  });

  it('a $recursiveRef pointer that misses, in a 2020-12 schema', () => {
    const validate = compiled({ $schema: D20, properties: { a: { $recursiveRef: '#/$defs/nope' } } });
    assert.deepEqual(answers(validate, [{}, { a: 1 }]), [true, 'JK0009']);
    assert.equal(thrown(() => validate({ a: 1 })),
      `JK0009: Can not resolve schema for '${ORIGIN}#/$defs/nope': '/$defs' is not a schema in '${ORIGIN}#'; fix the pointer`);
  });
});

describe('an instance that does not reach the reference answers', () => {
  const unheld = { $dynamicRef: 'https://o.test/d.json' };
  it('under properties', () => {
    assert.deepEqual(answers(compiled({ $schema: D20, properties: { a: unheld } }), [{}, { b: 1 }, { a: 1 }]), [true, true, 'JK0009']);
  });
  it('under anyOf, behind a branch that answers first', () => {
    assert.deepEqual(answers(compiled({ $schema: D20, anyOf: [{ type: 'string' }, unheld] }), ['a', 1]), [true, 'JK0009']);
  });
  it('under anyOf with collectErrors', () => {
    assert.deepEqual(answers(compiled({ $schema: D20, anyOf: [{ type: 'string' }, unheld] }, [], { collectErrors: true }), ['a', 1]), [true, 'JK0009']);
  });
  it('an output format runs every branch, so every instance reaches it', () => {
    assert.deepEqual(answers(compiled({ $schema: D20, anyOf: [{ type: 'string' }, unheld] }, [], { outputFormat: basicOutput }), ['a', 1]), ['JK0009', 'JK0009']);
  });
  it('a $recursiveRef under properties, in a schema that declares no draft', () => {
    assert.deepEqual(answers(compiled({ properties: { a: { $recursiveRef: 'https://o.test/d.json' } } }), [{}, { a: 1 }]), [true, 'JK0009']);
  });
});

describe('every dynamic reference that resolves answers as before', () => {
  for (const [label, schema, held, instances, expected] of [
    ['a $dynamicRef pointer', { $schema: D20, $defs: { x: { type: 'string' } }, properties: { a: { $dynamicRef: '#/$defs/x' } } }, [], [{ a: 1 }, { a: 's' }], [false, true]],
    ['a $dynamicRef to a held document', { $schema: D20, $dynamicRef: 'https://h.test/d.json' }, [[{ $id: 'https://h.test/d.json', type: 'string' }]], [1, 'a'], [false, true]],
    ['a $dynamicRef to a $dynamicAnchor', { $schema: D20, $defs: { x: { $dynamicAnchor: 'a', type: 'string' } }, properties: { p: { $dynamicRef: '#a' } } }, [], [{ p: 1 }, { p: 's' }], [false, true]],
    ['a $dynamicRef to an $anchor', { $schema: D20, $defs: { x: { $anchor: 'a', type: 'string' } }, properties: { p: { $dynamicRef: '#a' } } }, [], [{ p: 1 }, { p: 's' }], [false, true]],
    ['an $anchor of a held document', { $schema: D20, properties: { p: { $dynamicRef: 'https://h.test/d.json#a' } } }, [[{ $id: 'https://h.test/d.json', $defs: { x: { $anchor: 'a', type: 'string' } } }]], [{ p: 1 }, { p: 's' }], [false, true]],
    ['a $dynamicAnchor of a held document', { $schema: D20, properties: { p: { $dynamicRef: 'https://h.test/d.json#b' } } }, [[{ $id: 'https://h.test/d.json', $defs: { y: { $dynamicAnchor: 'b', type: 'string' } } }]], [{ p: 1 }, { p: 's' }], [false, true]],
    ['a bookending $dynamicAnchor resolves to the outermost scope', { $schema: D20, $id: 'https://t.test/root', $ref: 'list', $defs: { foo: { $dynamicAnchor: 'items', type: 'string' }, list: { $id: 'list', type: 'array', items: { $dynamicRef: '#items' }, $defs: { items: { $dynamicAnchor: 'items' } } } } }, [], [['a'], [1]], [true, false]],
    ['a $recursiveAnchor: true chain', { $schema: D19, $id: 'https://t.test/strict', $recursiveAnchor: true, $ref: 'tree', unevaluatedProperties: false }, [[{ $schema: D19, $id: 'https://t.test/tree', $recursiveAnchor: true, type: 'object', properties: { data: true, children: { type: 'array', items: { $recursiveRef: '#' } } } }]], [{ children: [{ data: 1 }] }, { children: [{ daat: 1 }] }], [true, false]],
    ['a relative $id', { $schema: D20, $id: 'https://t.test/a/root.json', $defs: { x: { $id: 'x.json', $dynamicAnchor: 'n', type: 'string' } }, properties: { p: { $dynamicRef: 'x.json#n' } } }, [], [{ p: 1 }, { p: 's' }], [false, true]],
    ['a urn: $id', { $schema: D20, $id: 'urn:uuid:deadbeef-1234-ffff-ffff-4321feebdaed', $defs: { s: { $dynamicAnchor: 's', type: 'string' } }, properties: { p: { $dynamicRef: '#s' } } }, [], [{ p: 1 }, { p: 's' }], [false, true]],
    ['an $id with an empty fragment', { $schema: D20, $id: 'https://t.test/f.json#', $defs: { x: { type: 'string' } }, properties: { p: { $dynamicRef: '#/$defs/x' } } }, [], [{ p: 1 }, { p: 's' }], [false, true]],
    ['a held false document', { $schema: D20, $dynamicRef: 'https://h.test/f.json' }, [[false, 'https://h.test/f.json']], [1], [false]],
    ['a false subschema', { $schema: D20, $defs: { f: false }, properties: { p: { $dynamicRef: '#/$defs/f' } } }, [], [{}, { p: 1 }], [true, false]],
    // a draft that does not define $recursiveRef applies nothing for another value that names a held schema
    ['a $recursiveRef other than "#" that resolves, draft-07', { $defs: { x: { type: 'string' } }, properties: { a: { $recursiveRef: '#/$defs/x' } } }, [], [{ a: 1 }, { a: 's' }], [true, true]],
    ['a $recursiveRef other than "#" that resolves, 2020-12', { $schema: D20, $defs: { x: { type: 'string' } }, properties: { a: { $recursiveRef: '#/$defs/x' } } }, [], [{ a: 1 }, { a: 's' }], [true, true]],
  ]) {
    it(label, () => {
      assert.deepEqual(answers(compiled(schema, held), instances), expected);
    });
  }
});
