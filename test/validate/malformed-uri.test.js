// A `$ref`, `$dynamicRef`, `$recursiveRef` or `$id` that is no valid URI
// reference is refused JK0010, naming the keyword, the text and where it
// sits, where it threw an uncoded `TypeError` (`ERR_INVALID_URL`).
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { JarenValidator, SchemaCompileError, TraverseOptions, VALIDATE_CODES } from '@jarenjs/validate';

const ORIGIN = 'https://github.com/jklarenbeek/jarenjs';
const D20 = 'https://json-schema.org/draft/2020-12/schema';
const REPAIR = 'is not a valid URI reference; correct it, percent-encoding any character a URI does not allow';

/** The refusal a call throws, as `[code, message]`. */
const refusal = (fn) => {
  try { fn(); }
  catch (error) {
    return [error instanceof SchemaCompileError ? error.code : 'uncoded', error.message];
  }
  return ['no throw', ''];
};

describe('a malformed reference or identifier is refused JK0010', () => {
  it('is in the code table', () => {
    assert.equal(VALIDATE_CODES.JK0010, 'a reference or an identifier is not a valid URI reference');
  });

  for (const [label, schema, named, at] of [
    ['a $ref', { $ref: 'http://[x' }, "$ref 'http://[x'", '#/%24ref'],
    ['a $ref with a port past 65535', { $ref: 'http://a.test:99999/x' }, "$ref 'http://a.test:99999/x'", '#/%24ref'],
    ['a network-path $ref', { $ref: '//[x' }, "$ref '//[x'", '#/%24ref'],
    ['a $ref under properties', { properties: { a: { $ref: 'http://[x' } } }, "$ref 'http://[x'", '#/properties/a/%24ref'],
    ['a root $id', { $id: 'http://[x', type: 'string' }, "$id 'http://[x'", '#/%24id'],
    ['a nested $id', { properties: { a: { $id: 'http://[x' } } }, "$id 'http://[x'", '#/properties/a/%24id'],
    ['a draft-04 id', { id: 'http://[x', type: 'string' }, "id 'http://[x'", '#/id'],
    ['a $dynamicRef', { $schema: D20, properties: { a: { $dynamicRef: 'http://[x' } } }, "$dynamicRef 'http://[x'", `${ORIGIN}#/properties/a/%24dynamicRef`],
  ]) {
    it(`${label}, when the schema compiles`, () => {
      assert.deepEqual(refusal(() => new JarenValidator().compile(schema)),
        ['JK0010', `JK0010: ${named} ${REPAIR} at ${at}`]);
    });
  }

  it('keeps the parse failure as its cause', () => {
    try {
      new JarenValidator().compile({ $ref: 'http://[x' });
      assert.fail('compiled');
    }
    catch (error) {
      assert.ok(error.cause instanceof TypeError);
    }
  });

  it('a $ref in a registered document, by the first call that builds it', () => {
    const validator = new JarenValidator();
    validator.addSchema({ $id: 'https://a.test/a.json', properties: { a: { $ref: 'http://[x' } } });
    const validate = validator.compile({ $ref: 'https://a.test/a.json' });
    assert.deepEqual(refusal(() => validate({})),
      ['JK0010', `JK0010: $ref 'http://[x' ${REPAIR} at https://a.test/a.json#/properties/a/%24ref`]);
  });

  it('a registered document whose $id is malformed, when a compile reads what the validator holds', () => {
    const validator = new JarenValidator();
    validator.addSchema({ $id: 'http://[x', type: 'string' });
    assert.deepEqual(refusal(() => validator.compile({ type: 'string' })),
      ['JK0010', `JK0010: $id 'http://[x' ${REPAIR} at http://[x#/%24id`]);
  });

  it('an origin that is no URI is named as the base', () => {
    const validator = () => new JarenValidator({ traverse: new TraverseOptions('http://[x') });
    assert.deepEqual(refusal(() => validator().compile({ type: 'string' })),
      ['JK0010', "JK0010: the base 'http://[x' is not a valid URI; correct the origin or the $id that names it"]);
    assert.deepEqual(refusal(() => validator().compile({ $id: 'https://a.test/s.json', type: 'string' })),
      ['JK0010', "JK0010: $id 'https://a.test/s.json' resolves against 'http://[x', which is not a valid URI; correct the origin or the $id that names it at #/%24id"]);
  });

  it('a $recursiveRef other than "#" in a schema that declares no draft, by the call that reaches it', () => {
    // read as 2019-09 it is refused JK0011 (recursive-ref-value.test.js)
    const validate = new JarenValidator().compile({ properties: { a: { $recursiveRef: 'http://[x' } } });
    assert.equal(validate({}), true);
    assert.deepEqual(refusal(() => validate({ a: 1 })),
      ['JK0010', `JK0010: $recursiveRef 'http://[x' ${REPAIR} at ${ORIGIN}#/properties/a/%24recursiveRef`]);
  });
});

describe('what parses answers as before', () => {
  for (const [label, schema, instances, expected] of [
    ['a urn: $id', { $id: 'urn:example:root', $defs: { a: { type: 'string' } }, $ref: '#/$defs/a' }, [1, 'a'], [false, true]],
    ['an $id with an empty fragment', { $id: 'https://t.test/x.json#', $defs: { a: { type: 'string' } }, $ref: '#/$defs/a' }, [1, 'a'], [false, true]],
    ['a relative $id', { $id: 'https://t.test/a/root.json', $defs: { a: { $id: 'b/a.json', type: 'string' } }, properties: { p: { $ref: 'b/a.json' } } }, [{ p: 1 }, { p: 'a' }], [false, true]],
    ['a malformed $schema, which names no draft', { $schema: 'http://[x', type: 'string' }, [1, 'a'], [false, true]],
  ]) {
    it(label, () => {
      const validate = new JarenValidator().compile(schema);
      assert.deepEqual(instances.map((x) => validate(x)), expected);
    });
  }

  it('a registered document whose malformed $id the compile does not read', () => {
    const validator = new JarenValidator();
    validator.addSchema({ $id: 'https://a.test/b.json', $defs: { x: { $id: 'http://[x' } }, type: 'number' });
    const validate = validator.compile({ $ref: 'https://a.test/b.json' });
    assert.deepEqual([validate(1), validate('a')], [true, false]);
  });
});
