//@ts-check
/**
 * @file An `$id` whose fragment is spelled as a JSON Pointer (`#/a`,
 * `#%2Fa`) names nothing, as an anchor so spelled names nothing: `#/a` stays
 * a pointer into the document. A root `$id` is read without it — the URI
 * before it names the document — and a reference the pointer leads nowhere
 * is refused, naming the identifier and the repair.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { compileNormalizer } from '@jarenjs/validate/normalize';
import { compileEmitModel } from '@jarenjs/emit';

const DRAFTS = ['http://json-schema.org/draft-06/schema#', 'http://json-schema.org/draft-07/schema#',
  'https://json-schema.org/draft/2019-09/schema', 'https://json-schema.org/draft/2020-12/schema', undefined];
const D07 = 'http://json-schema.org/draft-07/schema#';
const ORIGIN = 'https://github.com/jklarenbeek/jarenjs';

/** @param {any} schema @param {unknown[]} values */
const verdicts = (schema, values) => {
  const validate = new JarenValidator().compile(schema);
  return values.map((value) => validate(value));
};
/** @param {string} id @param {string} [$schema] */
const document = (id, $schema) => ({ ...($schema ? { $schema } : {}), $id: id, definitions: { s: { type: 'string' } }, properties: { a: { $ref: '#/definitions/s' } } });

describe('a root $id spelled as a pointer names nothing', () => {
  it('the reported input: the reference reads the definition, in every draft (accepted { a: 1 })', () => {
    for (const $schema of DRAFTS) {
      assert.deepEqual(verdicts(document('#/definitions/s', $schema), [{ a: 1 }, { a: 's' }]), [false, true], String($schema));
      const held = new JarenValidator().addSchema(document('#/definitions/s', $schema), 'http://k.test/r.json').compile({ $ref: 'http://k.test/r.json' });
      assert.deepEqual([held({ a: 1 }), held({ a: 's' })], [false, true], String($schema));
    }
  });

  it('percent-encoded, and after a URI, which then names the document (was refused JK0009)', () => {
    assert.deepEqual(verdicts(document('#%2Fdefinitions%2Fs'), [{ a: 1 }, { a: 's' }]), [false, true]);
    assert.deepEqual(verdicts(document('http://x.test/r.json#/definitions/s'), [{ a: 1 }, { a: 's' }]), [false, true]);
    const held = new JarenValidator().addSchema(document('http://x.test/r.json#/definitions/s')).compile({ $ref: 'http://x.test/r.json' });
    assert.deepEqual([held({ a: 1 }), held({ a: 's' })], [false, true]);
  });

  it('a reference the pointer leads nowhere is refused, naming the identifier and the repair', () => {
    assert.throws(() => new JarenValidator().compile({ $id: '#/nowhere', properties: { a: { $ref: '#/nowhere' } } }), {
      code: 'JK0009',
      docPath: '#/properties/a/%24ref',
      reason: `Can not resolve schema for '${ORIGIN}#/nowhere': the fragment of the $id '#/nowhere' at '#/%24id' is a JSON Pointer, which names no place: the pointer reads the document; name the place with $anchor (draft-07 and earlier: an $id fragment with a plain name)`,
    });
  });
});

describe('an embedded $id spelled as a pointer names nothing either', () => {
  it('a reference spelling it reads the place the pointer names (read the $id\'s object)', () => {
    const schema = { $schema: D07, a: { type: 'boolean' }, definitions: { y: { $id: '#/a', type: 'string' } }, properties: { p: { $ref: '#/a' } } };
    assert.deepEqual(verdicts(schema, [{ p: true }, { p: 's' }]), [true, false]);
  });

  it('one the pointer leads nowhere is refused, naming the identifier', () => {
    assert.throws(() => new JarenValidator().compile({ $schema: D07, definitions: { y: { $id: '#/foo', type: 'string' } }, properties: { p: { $ref: '#/foo' } } }), {
      code: 'JK0009',
      reason: `Can not resolve schema for '${ORIGIN}#/foo': the fragment of the $id '#/foo' at '#/definitions/y/%24id' is a JSON Pointer, which names no place: the pointer reads the document; name the place with $anchor (draft-07 and earlier: an $id fragment with a plain name)`,
    });
  });
});

describe('what answered right answers as before', () => {
  it('a plain-name fragment, an empty one and none name the document as before', () => {
    for (const id of ['#root', 'http://x.test/r.json#', 'http://x.test/r.json', 'http://x.test/r.json#root'])
      assert.deepEqual(verdicts(document(id), [{ a: 1 }, { a: 's' }]), [false, true], id);
  });

  it('the normalizer and emit read the pointer as the validator now does', () => {
    const schema = { $id: '#/definitions/s', definitions: { s: { type: 'integer' } }, properties: { a: { $ref: '#/definitions/s' } } };
    assert.deepEqual(compileNormalizer(schema, { coerceTypes: true })({ a: '1' }), { a: 1 });
    const [declaration] = compileEmitModel(schema).declarations;
    assert.deepEqual([declaration.name, declaration.type], ['S', { kind: 'primitive', primitive: 'number' }]);
    assert.deepEqual(verdicts(schema, [{ a: 1 }, { a: '1' }]), [true, false]);
  });
});
