// Draft 2019-09 defines `$recursiveRef` only as "#" and lets another value be
// an error. Read as 2019-09, another value is refused JK0011, naming the
// `$ref` that applies the schema it names, by the call that reaches it: it
// applied nothing (a `$recursiveRef: '#/$defs/x'` to a string schema answered
// `true` for a number), or was refused JK0009/JK0010 with a repair that led
// there. A draft that does not define the keyword reads it as before.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { JarenValidator, SchemaCompileError, VALIDATE_CODES } from '@jarenjs/validate';
import { basicOutput } from '@jarenjs/validate/output';

const ORIGIN = 'https://github.com/jklarenbeek/jarenjs';
const D19 = 'https://json-schema.org/draft/2019-09/schema';
const D20 = 'https://json-schema.org/draft/2020-12/schema';
const STRINGS = { x: { type: 'string' } };

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

/** The refusal of `$recursiveRef: value` at `place` of the schema `uri` names. */
const refusal = (value, uri, place) =>
  `JK0011: $recursiveRef '${value}' is defined only as "#"; to apply the schema it names, write $ref '${value}' at ${uri}#${place}/%24recursiveRef`;

describe('a $recursiveRef other than "#" read as 2019-09 is refused JK0011', () => {
  it('is in the code table', () => {
    assert.equal(VALIDATE_CODES.JK0011, 'a $recursiveRef read as draft 2019-09 is not "#"');
  });

  it('one that names a held schema, by the call that reaches it', () => {
    const validate = new JarenValidator().compile({ $schema: D19, $defs: STRINGS, properties: { a: { $recursiveRef: '#/$defs/x' } } });
    assert.deepEqual(answers(validate, [{}, { b: 1 }, { a: 1 }, { a: 's' }]), [true, true, 'JK0011', 'JK0011']);
    assert.equal(thrown(() => validate({ a: 1 })), refusal('#/$defs/x', '', '/properties/a'));
  });

  it('the repair it names answers', () => {
    const validate = new JarenValidator().compile({ $schema: D19, $defs: STRINGS, properties: { a: { $ref: '#/$defs/x' } } });
    assert.deepEqual(answers(validate, [{}, { a: 1 }, { a: 's' }]), [true, false, true]);
  });

  for (const [label, value] of [
    ['one that names a document nothing holds (was JK0009)', 'https://o.test/d.json'],
    ['a pointer that misses (was JK0009)', '#/$defs/nope'],
    ['one that is no URI reference (was JK0010)', 'http://[x'],
    ['the document by its URI', `${ORIGIN}#`],
  ]) {
    it(label, () => {
      const validate = new JarenValidator().compile({ $schema: D19, properties: { a: { $recursiveRef: value } } });
      assert.deepEqual(answers(validate, [{}, { a: 1 }]), [true, 'JK0011']);
      assert.equal(thrown(() => validate({ a: 1 })), refusal(value, '', '/properties/a'));
    });
  }

  it('under not, where applying nothing read as failure answered every instance true', () => {
    const validate = new JarenValidator().compile({ $schema: D19, $defs: STRINGS, not: { $recursiveRef: '#/$defs/x' } });
    assert.deepEqual(answers(validate, [1, 's']), ['JK0011', 'JK0011']);
  });

  it('with collectErrors and under an output format', () => {
    const schema = { $schema: D19, $defs: STRINGS, properties: { a: { $recursiveRef: '#/$defs/x' } } };
    assert.deepEqual(answers(new JarenValidator({ collectErrors: true }).compile(schema), [{}, { a: 1 }]), [true, 'JK0011']);
    assert.deepEqual(answers(new JarenValidator({ outputFormat: basicOutput }).compile(schema), [{}, { a: 1 }]), [true, 'JK0011']);
  });

  it('in a registered document that declares 2019-09, whatever draft the compile names', () => {
    const validator = new JarenValidator().addSchema({ $schema: D19, $id: 'https://h.test/u.json', $defs: STRINGS, properties: { a: { $recursiveRef: '#/$defs/x' } } });
    assert.deepEqual(answers(validator.compile({ $ref: 'https://h.test/u.json' }), [{}, { a: 1 }]), [true, 'JK0011']);
    assert.equal(thrown(() => validator.compile({ $ref: 'https://h.test/u.json' })({ a: 1 })), refusal('#/$defs/x', 'https://h.test/u.json', '/properties/a'));
  });

  it('in a registered document that declares no draft, as the compile reads it', () => {
    const validator = new JarenValidator().addSchema({ $id: 'https://h.test/u.json', $defs: STRINGS, properties: { a: { $recursiveRef: '#/$defs/x' } } });
    assert.deepEqual(answers(validator.compile({ $schema: D19, $ref: 'https://h.test/u.json' }), [{}, { a: 1 }]), [true, 'JK0011']);
    assert.deepEqual(answers(validator.compile({ $ref: 'https://h.test/u.json' }), [{}, { a: 1 }]), [true, true]);
  });
});

describe('what answered right answers as before', () => {
  for (const [label, schema, instances, expected] of [
    ['a $recursiveRef "#" read as 2019-09', { $schema: D19, type: 'object', properties: { a: { $recursiveRef: '#' } } }, [{ a: 1 }, { a: {} }, { a: { a: 's' } }], [false, true, false]],
    ['another value, draft-07 (no such keyword): applies nothing', { $defs: STRINGS, properties: { a: { $recursiveRef: '#/$defs/x' } } }, [{ a: 1 }, { a: 's' }], [true, true]],
    ['another value, 2020-12 (no such keyword): applies nothing', { $schema: D20, $defs: STRINGS, properties: { a: { $recursiveRef: '#/$defs/x' } } }, [{ a: 1 }, { a: 's' }], [true, true]],
  ]) {
    it(label, () => {
      assert.deepEqual(answers(new JarenValidator().compile(schema), instances), expected);
    });
  }
});
