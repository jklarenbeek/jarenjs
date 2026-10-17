// A reference that resolves to no schema the validator holds is refused with
// a code and the repair. A refusal that comes when the schema compiles stays
// there; a reference resolved on first use is refused on the first call that
// reaches it, so an instance that never reaches it answers as before.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { JarenValidator, SchemaCompileError, VALIDATE_CODES } from '@jarenjs/validate';

const BASE = 'https://github.com/jklarenbeek/';
const D7 = 'http://json-schema.org/draft-07/schema#';
const D20 = 'https://json-schema.org/draft/2020-12/schema';
const UNHELD = 'no schema the validator holds has that URI; register it with addSchema, load it with compileAsync, or fix the reference';
const IGNORED_ID = 'a draft-07 $ref ignores the $id beside it; register that URI, or declare $schema 2019-09 or later';

/** The refusal `compile` (or a call) throws, as `[code, message]`. */
const refusal = (fn) => {
  try { fn(); }
  catch (error) {
    return [error instanceof SchemaCompileError ? error.code : 'uncoded', error.message];
  }
  return ['no throw', ''];
};

describe('a reference nothing holds is refused JK0009 when the schema compiles', () => {
  it('is in the code table', () => {
    assert.equal(VALIDATE_CODES.JK0009, 'a reference resolves to no schema the validator holds');
  });

  for (const [label, schema, uri] of [
    ['a document nothing holds', { $ref: 'nope.json' }, `${BASE}nope.json#`],
    ['a draft-07 one', { $schema: D7, $ref: 'nope.json' }, `${BASE}nope.json#`],
    ['a pointer into a document nothing holds', { $ref: 'https://other.test/doc.json#/$defs/x' }, 'https://other.test/doc.json#/$defs/x'],
    ['an anchor in a document nothing holds', { $ref: 'https://other.test/doc.json#foo' }, 'https://other.test/doc.json#foo'],
  ]) {
    it(label, () => {
      assert.deepEqual(refusal(() => new JarenValidator().compile(schema)),
        ['JK0009', `JK0009: Can not resolve schema for '${uri}': ${UNHELD} at #/%24ref`]);
    });
  }

  it('a pointer that misses in a held document names the step that misses', () => {
    assert.deepEqual(refusal(() => new JarenValidator().compile({ $ref: '#/$defs/missing' })),
      ['JK0009', `JK0009: Can not resolve schema for '${BASE}jarenjs#/$defs/missing': '/$defs' is not a schema in '${BASE}jarenjs#'; fix the pointer at #/%24ref`]);
    const held = new JarenValidator().addSchema({ $id: 'https://h.test/d.json', $defs: {} });
    assert.deepEqual(refusal(() => held.compile({ $ref: 'https://h.test/d.json#/$defs/x' })),
      ['JK0009', "JK0009: Can not resolve schema for 'https://h.test/d.json#/$defs/x': '/$defs/x' is not a schema in 'https://h.test/d.json#'; fix the pointer at #/%24ref"]);
  });

  it('carries the reason apart from the code', () => {
    try { new JarenValidator().compile({ $ref: 'nope.json' }); assert.fail('compiled'); }
    catch (error) {
      assert.equal(error.name, 'SchemaCompileError');
      assert.equal(error.reason, `Can not resolve schema for '${BASE}nope.json#': ${UNHELD}`);
    }
  });

  // These were refused when they compiled before; they still are, now coded.
  for (const [label, schema, place] of [
    ['under an anyOf branch', { anyOf: [{ type: 'string' }, { $ref: 'nope.json' }] }, ' at #/anyOf/1/%24ref'],
    ['under a property', { properties: { a: { $ref: 'nope.json' } } }, ' at #/properties/a/%24ref'],
    ['in a registered document', null, ''],
  ]) {
    it(`${label}, still at compile`, () => {
      const validator = new JarenValidator();
      if (schema === null) validator.addSchema({ $id: 'https://h.test/b.json', properties: { x: { $ref: 'https://h.test/missing.json' } } });
      assert.deepEqual(refusal(() => validator.compile(schema ?? { type: 'object' })),
        ['JK0009', `JK0009: Can not resolve schema for '${schema === null ? 'https://h.test/missing.json#' : `${BASE}nope.json#`}': ${UNHELD}${place}`]);
    });
  }

  it('a reference that resolves still compiles and answers', () => {
    const validate = new JarenValidator().addSchema({ type: 'string' }, `${BASE}name.json`).compile({ $ref: 'name.json' });
    assert.deepEqual([validate('x'), validate(5)], [true, false]);
  });
});

// A registered document that declares no draft, read by a draft-07 (or
// undeclared) compile: its `$ref` beside `$id: 'sub/a.json'` resolves against
// the enclosing base, `https://held.test/name.json`, which nothing holds.
// The reference is resolved on first use, so only a call that reaches it is
// refused.
const HELD = () => ({ $id: 'https://held.test/root.json', $defs: { a: { $id: 'sub/a.json', $ref: 'name.json' } } });
const A = 'https://held.test/sub/a.json';
const residual = (schema) => new JarenValidator().addSchema(HELD())
  .addSchema({ type: 'number' }, 'https://held.test/sub/name.json').compile(schema);
const CALL_REFUSAL = ['JK0008', `JK0008: Can not resolve schema for 'https://held.test/name.json#': ${IGNORED_ID} at ${A}#/%24ref`];
const answers = (validate, data) => data.map((d) => {
  try { return validate(d); }
  catch (error) { return [error instanceof SchemaCompileError ? error.code : 'uncoded', error.message]; }
});

describe('a reference resolved on first use that resolves to nothing is refused coded on the call that reaches it', () => {
  for (const [label, $schema] of [['undeclared', undefined], ['draft-07', D7]]) {
    it(`${label}: every call reaches it`, () => {
      const validate = residual({ ...($schema ? { $schema } : {}), $ref: A });
      assert.deepEqual(answers(validate, ['x', 5]), [CALL_REFUSAL, CALL_REFUSAL]);
    });
  }

  // Each shape answered the instances that do not reach the reference before;
  // they still do, and only the instances that reach it are refused.
  for (const [label, schema, data, expected] of [
    ['an anyOf branch after one that passes', { anyOf: [{ type: 'string' }, { $ref: A }] }, ['x', 5], [true, CALL_REFUSAL]],
    ['a oneOf branch (every branch runs)', { oneOf: [{ type: 'string' }, { $ref: A }] }, ['x'], [CALL_REFUSAL]],
    ['an else branch', { if: { type: 'string' }, then: true, else: { $ref: A } }, ['x', 5], [true, CALL_REFUSAL]],
    ['a then branch', { if: { type: 'number' }, then: { $ref: A } }, ['x', 5], [true, CALL_REFUSAL]],
    ['a property never present', { properties: { a: { $ref: A } } }, [{}, { b: 1 }, { a: 1 }], [true, true, CALL_REFUSAL]],
    ['a dependency', { dependencies: { a: { $ref: A } } }, [{}, { a: 1 }], [true, CALL_REFUSAL]],
    ['under not', { not: { $ref: A } }, [1], [CALL_REFUSAL]],
  ]) {
    it(label, () => {
      assert.deepEqual(answers(residual(schema), data), expected);
    });
  }

  it('a pointer that misses in the document draft-07 reads is refused the same way', () => {
    const validate = new JarenValidator()
      .addSchema({ $id: 'https://held.test/root.json', $defs: { a: { $id: 'sub/a.json', $ref: 'name.json#/definitions/x' } } })
      .addSchema({ definitions: { x: { type: 'number' } } }, 'https://held.test/sub/name.json')
      .addSchema({ definitions: {} }, 'https://held.test/name.json')
      .compile({ $ref: A });
    assert.deepEqual(answers(validate, [5]), [['JK0008',
      `JK0008: Can not resolve schema for 'https://held.test/name.json#/definitions/x': ${IGNORED_ID} at ${A}#/%24ref`]]);
  });

  it('an $id that names the base it sits under changes nothing, and the refusal says JK0009', () => {
    const validate = new JarenValidator()
      .addSchema({ $id: 'https://held.test/root.json', $defs: { a: { $id: 'https://held.test/root.json', $ref: 'name.json' } } })
      .compile({ $ref: 'https://held.test/root.json#/$defs/a' });
    assert.deepEqual(answers(validate, ['x']), [['JK0009', `JK0009: Can not resolve schema for 'https://held.test/name.json#': ${UNHELD} at https://held.test/root.json#/$defs/a/%24ref`]]);
  });

  it('a target that resolves but does not compile reports its own error', () => {
    const validate = new JarenValidator().addSchema(HELD()).addSchema({ type: 'number' }, 'https://held.test/sub/name.json')
      .addSchema({ pattern: '(' }, 'https://held.test/name.json').compile({ $ref: A });
    const [code, message] = answers(validate, ['x'])[0];
    assert.equal(code, 'JK0014');
    assert.match(message, /^JK0014: 'pattern' takes a regular expression, got '\(', which does not compile \(Invalid regular expression: /);
  });

  it('answers once the URI the draft-07 reading names is registered too', () => {
    const validate = new JarenValidator().addSchema(HELD()).addSchema({ type: 'number' }, 'https://held.test/sub/name.json')
      .addSchema({ type: 'string' }, 'https://held.test/name.json').compile({ $ref: A });
    assert.deepEqual([validate('x'), validate(5)], [true, false]);
  });

  it('a 2020-12 compile reads the $id as the base and answers, as before', () => {
    const validate = residual({ $schema: D20, $ref: A });
    assert.deepEqual([validate('x'), validate(5)], [false, true]);
  });
});
