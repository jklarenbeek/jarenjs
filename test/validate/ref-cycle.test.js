//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';

describe('a schema that references itself', () => {
  /** @param {any} schema @param {any} [options] */
  const compile = (schema, options) => new JarenValidator(options).compile(schema);
  const message = /^\$ref cycle: \S+# refers to itself and never reads the instance$/;

  it('is refused when the schema is compiled, not when it validates', () => {
    for (const options of [undefined, { collectErrors: true }, { draftVersion: 2020 }, { draftVersion: 7 }]) {
      assert.throws(() => compile({ $ref: '#' }, options), { name: 'Error', message });
    }
  });

  it('is refused with siblings and where it is nested', () => {
    assert.throws(() => compile({ $ref: '#', type: 'object' }, { draftVersion: 2020 }), { message });
    assert.throws(() => compile({ properties: { a: { $ref: '#/properties/a' } } }), {
      message: /^\$ref cycle: \S+#\/properties\/a refers to itself and never reads the instance$/,
    });
  });

  it('keeps the answers of loops that reach their target through another reference', () => {
    assert.equal(compile({ $defs: { a: { $ref: '#/$defs/a' } }, $ref: '#/$defs/a' })(1), true);
    const ring = { $defs: { a: { $ref: '#/$defs/b' }, b: { $ref: '#/$defs/a' } }, $ref: '#/$defs/a' };
    assert.equal(compile(ring)(1), true);
    assert.equal(compile({ $ref: '#/$defs/a', $defs: { a: { $ref: '#' } } })(1), true);
  });

  it('keeps every reference that consumes the instance', () => {
    const tree = compile({ type: 'object', properties: { next: { $ref: '#' } } });
    assert.equal(tree({ next: { next: {} } }), true);
    assert.equal(tree({ next: { next: 1 } }), false);
    const chain = compile({ $defs: { a: { $ref: '#/$defs/b' }, b: { type: 'string' } }, $ref: '#/$defs/a' });
    assert.equal(chain('x'), true);
    assert.equal(chain(1), false);
    assert.equal(compile({ anyOf: [{ type: 'null' }, { $ref: '#' }] })(null), true);
  });
});
