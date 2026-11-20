//@ts-check
/**
 * @file A pointer through a member whose name a JSON Pointer or a URI
 * fragment escapes (`a/b` as `a~1b`, `a~b` as `a~0b`, `a%b` as `a%25b`, a
 * member named `""`) keeps the base of the embedded resource it passes: a
 * reference below that member resolves against the resource's `$id`, as it
 * does when the pointer passes a member spelled plainly, when the resource
 * is referenced itself, and when the document is compiled directly. It
 * resolved against the document's base: the walk that finds the nearest
 * identifier above a pointer's place split the pointer without decoding
 * its tokens, and lost its way at that member.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';

const D07 = 'http://json-schema.org/draft-07/schema#';
const D20 = 'https://json-schema.org/draft/2020-12/schema';

/** A document whose member `name` is an embedded resource in another directory, referencing `leaf.json`. */
const rootDocument = (/** @type {string} */ name, /** @type {string} */ $schema = D20, /** @type {string} */ $id = 'http://q.test/sub/res.json') => ({
  $schema, $id: 'http://q.test/root.json',
  properties: { [name]: { $id, properties: { c: { $ref: 'leaf.json' } } } },
});
/** A validator holding the leaf the resource names (a string) and the one the document's base would name (a number). */
const holdingLeaves = (/** @type {object} */ options = undefined) => new JarenValidator(options)
  .addSchema({ $id: 'http://q.test/sub/leaf.json', type: 'string' })
  .addSchema({ $id: 'http://q.test/leaf.json', type: 'number' });

/** Each member name with the token a reference spells it by. */
const MEMBERS = /** @type {[string, string][]} */ ([
  ['ab', 'ab'],
  ['a/b', 'a~1b'],
  ['a~b', 'a~0b'],
  ['a/b', 'a%7E1b'],
  ['a~b', 'a%7E0b'],
  ['a%b', 'a%25b'],
  ['a b', 'a%20b'],
  ['é', '%C3%A9'],
  ['', ''],
]);

describe('a pointer through a member whose name is escaped', () => {
  for (const $schema of [D20, D07]) {
    it(`keeps the base of the embedded resource above its place (it read the document's base): ${$schema}`, () => {
      for (const [name, token] of MEMBERS) {
        const validate = holdingLeaves().addSchema(rootDocument(name, $schema)).compile({ $ref: `http://q.test/root.json#/properties/${token}/properties/c` });
        assert.deepEqual([validate('x'), validate(1)], [true, false], `${JSON.stringify(name)} by ${token}`);
      }
    });
  }

  it('answers as the resource referenced itself, and as the document compiled directly', () => {
    for (const [name, token] of MEMBERS) {
      const validator = holdingLeaves().addSchema(rootDocument(name));
      const place = validator.compile({ $ref: `http://q.test/root.json#/properties/${token}/properties/c` });
      const resource = validator.compile({ $ref: 'http://q.test/sub/res.json' });
      const direct = holdingLeaves().compile(rootDocument(name));
      for (const value of ['x', 1, null]) {
        assert.equal(place(value), resource({ c: value }), `${JSON.stringify(name)} ${JSON.stringify(value)}`);
        assert.equal(place(value), direct({ [name]: { c: value } }), `${JSON.stringify(name)} ${JSON.stringify(value)}`);
      }
    }
  });

  it('reads a relative $id of that resource against the document, and two escaped members on the way', () => {
    const relative = holdingLeaves().addSchema(rootDocument('a/b', D20, 'sub/res.json')).compile({ $ref: 'http://q.test/root.json#/properties/a~1b/properties/c' });
    assert.deepEqual([relative('x'), relative(1)], [true, false]);
    const nested = holdingLeaves().addSchema({ $schema: D20, $id: 'http://q.test/root.json',
      properties: { 'a/b': { properties: { 'c~d': { $id: 'http://q.test/sub/res.json', properties: { c: { $ref: 'leaf.json' } } } } } } })
      .compile({ $ref: 'http://q.test/root.json#/properties/a~1b/properties/c~0d/properties/c' });
    assert.deepEqual([nested('x'), nested(1)], [true, false]);
  });

  it('holds for a pointer of the compiled document itself', () => {
    const validate = holdingLeaves().compile({ ...rootDocument('a/b'), $defs: { z: { $ref: '#/properties/a~1b/properties/c' } }, additionalProperties: { $ref: '#/$defs/z' } });
    assert.deepEqual([validate({ k: 'x' }), validate({ k: 1 })], [true, false]);
  });

  it('locates the failure in the leaf the resource names', () => {
    const result = holdingLeaves({ collectErrors: true }).addSchema(rootDocument('a/b')).compile({ $ref: 'http://q.test/root.json#/properties/a~1b/properties/c' })(1);
    assert.deepEqual(result.errors.map((/** @type {any} */ e) => [e.keyword, e.schemaPath]), [['type', 'http://q.test/sub/leaf.json#']]);
  });

  it('leaves what read right as it was: a plain member, a member the pointer misses, and %2F separating two tokens', () => {
    const plain = holdingLeaves().addSchema(rootDocument('ab')).compile({ $ref: 'http://q.test/root.json#/properties/ab/properties/c' });
    assert.deepEqual([plain('x'), plain(1)], [true, false]);
    assert.throws(() => holdingLeaves().addSchema(rootDocument('a/b')).compile({ $ref: 'http://q.test/root.json#/properties/a~1x/properties/c' }), { code: 'JK0009' });
    // `%2F` is a `/` of the pointer, never one of a member name: `#/properties/a%2Fb` names the member `b` of `a`
    const tokens = holdingLeaves().addSchema({ $schema: D20, $id: 'http://q.test/root.json',
      properties: { a: { b: { $id: 'http://q.test/sub/res.json', properties: { c: { $ref: 'leaf.json' } } } }, 'a/b': { properties: { c: { type: 'boolean' } } } } })
      .compile({ $ref: 'http://q.test/root.json#/properties/a%2Fb/properties/c' });
    assert.deepEqual([tokens('x'), tokens(1), tokens(true)], [true, false, false]);
  });
});

describe('a pointer whose % starts no escape', () => {
  /** @param {() => unknown} fn */
  const refusal = (fn) => {
    try { fn(); return 'answers'; }
    catch (error) { return `${/** @type {any} */ (error).name} ${/** @type {any} */ (error).code} ${/** @type {any} */ (error).docPath ?? ''}`.trim(); }
  };
  const holder = (/** @type {string} */ ref) => ({ $id: 'https://p.test/h.json', properties: { 'a%b': { type: 'string' }, q: { $ref: ref } } });

  it('is refused JK0010 at its $ref when the document compiles (it threw an uncoded URIError)', () => {
    for (const ref of ['#/properties/a%b', '#/properties/%zz', '#/properties/a%2'])
      assert.equal(refusal(() => new JarenValidator().compile({ properties: { 'a%b': { type: 'string' }, q: { $ref: ref } } })), 'SchemaCompileError JK0010 #/properties/q/%24ref', ref);
    assert.throws(() => new JarenValidator().compile({ properties: { q: { $ref: '#/properties/a%b' } } }),
      { message: /^JK0010: \$ref '#\/properties\/a%b' is not a valid URI reference; correct it, percent-encoding any character a URI does not allow/ });
  });

  it('in a held document is refused by the first call that builds it, as any $ref that is no URI reference, and refuses no other compile (every compile threw the URIError)', () => {
    const validator = new JarenValidator().addSchema(holder('#/properties/a%b'));
    const unrelated = validator.compile({ type: 'string' });
    assert.deepEqual([unrelated('x'), unrelated(1)], [true, false]);
    const reaching = validator.compile({ $ref: 'https://p.test/h.json' });
    assert.equal(refusal(() => reaching({ q: 'x' })), 'SchemaCompileError JK0010 https://p.test/h.json#/properties/q/%24ref');
    // a dynamic reference is read the same way
    const dynamic = new JarenValidator().addSchema({ $schema: D20, $id: 'https://p.test/d.json', properties: { q: { $dynamicRef: '#/a%b' } } });
    assert.equal(dynamic.compile({ type: 'string' })('x'), true);
    const through = dynamic.compile({ $ref: 'https://p.test/d.json' });
    assert.equal(refusal(() => through({ q: 1 })), 'SchemaCompileError JK0010 https://p.test/d.json#/properties/q/%24dynamicRef');
  });

  it('leaves the escaped spelling, a plain name and a held key as they were', () => {
    // `%25` is the `%` of a member name
    const escaped = new JarenValidator().addSchema(holder('#/properties/a%25b')).compile({ $ref: 'https://p.test/h.json' });
    assert.deepEqual([escaped({ q: 'x' }), escaped({ q: 1 })], [true, false]);
    // a plain name is keyed as the URI spells it, and never decoded
    const named = new JarenValidator().compile({ $schema: D20, $ref: '#a%b', $defs: { t: { $anchor: 'a%b', type: 'string' } } });
    assert.deepEqual([named('x'), named(1)], [true, false]);
    // a key handed to addSchema is held as written: it names nothing a reference can spell, and refuses no compile
    const keyed = new JarenValidator().addSchema({ type: 'number' }, 'https://p.test/k.json#/a%b');
    assert.deepEqual([keyed.compile({ type: 'string' })('x'), keyed.compile({ type: 'string' })(1)], [true, false]);
    assert.equal(refusal(() => keyed.compile({ $ref: 'https://p.test/k.json#/a%b' })), 'SchemaCompileError JK0010 #/%24ref');
  });
});
