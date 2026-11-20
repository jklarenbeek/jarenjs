//@ts-check
/**
 * @file A URI's query is part of the name a schema is held and looked up
 * by: `a.json?v=1` and `a.json?v=2` are two documents, and neither is
 * `a.json`. A reference reaches a document only when both spell the same
 * query, as `@jarenjs/validate/normalize`, `@jarenjs/emit` and
 * `deriveStrictProfile` read one, and as a held dialect is looked up by its
 * `$schema`. The validator dropped the query from every key, so a `$ref`
 * with any query, or none, reached a document whose `$id` holds another.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { compileAsync } from '@jarenjs/validate/load';
import { compileNormalizer } from '@jarenjs/validate/normalize';
import { deriveStrictProfile } from '@jarenjs/validate/strict-profile';
import { emitTypeScript } from '@jarenjs/emit';

const D20 = 'https://json-schema.org/draft/2020-12/schema';
const A = 'http://x.test/a.json';

/** What a reference to `ref` answers for an integer and a string, or its refusal. @param {JarenValidator} validator @param {string} ref */
const reach = (validator, ref) => {
  try {
    const validate = validator.compile({ $ref: ref });
    return [validate(1), validate('x')];
  }
  catch (error) { return `${/** @type {any} */ (error).code} ${/** @type {any} */ (error).docPath}`; }
};
const holding = (/** @type {string} */ $id, /** @type {string} */ type = 'integer') => new JarenValidator().addSchema({ $id, type });

describe('the query of a URI is part of the name a schema is held under', () => {
  it('a reference reaches a document only by its own query, as one with another path does not (any query reached it)', () => {
    assert.deepEqual(reach(holding(`${A}?v=a`), `${A}?v=a`), [true, false]);
    // the oracle: a reference that differs in its path
    assert.equal(reach(holding(A), 'http://x.test/b.json'), 'JK0009 #/%24ref');
    assert.equal(reach(holding(`${A}?v=a`), `${A}?v=zzz`), 'JK0009 #/%24ref');
    assert.equal(reach(holding(`${A}?v=a`), A), 'JK0009 #/%24ref');
    assert.equal(reach(holding(A), `${A}?v=a`), 'JK0009 #/%24ref');
    // the query as written: its case, an escape in it and an empty one are part of the spelling
    assert.equal(reach(holding(`${A}?V=A`), `${A}?v=a`), 'JK0009 #/%24ref');
    assert.equal(reach(holding(`${A}?v=a`), `${A}?v=%61`), 'JK0009 #/%24ref');
    assert.equal(reach(holding(`${A}?`), A), 'JK0009 #/%24ref');
    assert.throws(() => holding(`${A}?v=a`).compile({ $ref: `${A}?v=zzz` }),
      { message: /^JK0009: Can not resolve schema for 'http:\/\/x\.test\/a\.json\?v=zzz#': no schema the validator holds has that URI/ });
    // an embedded resource is named the same way
    const embedded = (/** @type {string} */ ref) => {
      try { return ['x', 1].map(new JarenValidator().compile({ $ref: ref, $defs: { x: { $id: `${A}?v=a`, type: 'string' } } })); }
      catch (error) { return /** @type {any} */ (error).code; }
    };
    assert.deepEqual([embedded(`${A}?v=a`), embedded(`${A}?v=zzz`), embedded(A)], [[true, false], 'JK0009', 'JK0009']);
  });

  it('two documents that differ in their query are two documents (both answered as the first registered)', () => {
    const validator = holding(`${A}?v=1`).addSchema({ $id: `${A}?v=2`, type: 'string' }).addSchema({ $id: A, type: 'boolean' });
    assert.deepEqual([reach(validator, `${A}?v=1`), reach(validator, `${A}?v=2`), reach(validator, A)], [[true, false], [false, true], [false, false]]);
    // a reference that is only a query replaces the base's
    const relative = holding(`${A}?v=2`, 'string').compile({ $id: `${A}?v=1`, properties: { p: { $ref: '?v=2' } } });
    assert.deepEqual([relative({ p: 'x' }), relative({ p: 1 })], [true, false]);
  });

  it('a pointer, a plain name and an error location inside such a document keep the query', () => {
    const document = () => ({ $schema: D20, $id: `${A}?v=1`, $defs: { t: { $anchor: 't', type: 'integer' } },
      properties: { p: { $ref: '#/$defs/t' }, q: { $ref: 'a.json?v=1#t' }, r: { $ref: `${A}?v=1#/$defs/t` } } });
    const validate = new JarenValidator().compile(document());
    assert.deepEqual([validate({ p: 1, q: 2, r: 3 }), validate({ p: 'x' }), validate({ q: 'x' }), validate({ r: 'x' })], [true, false, false, false]);
    assert.throws(() => new JarenValidator().compile({ ...document(), properties: { q: { $ref: 'a.json?v=2#t' } } }), { code: 'JK0009', docPath: '#/properties/q/%24ref' });
    const result = new JarenValidator({ collectErrors: true }).addSchema(document()).compile({ $ref: `${A}?v=1` })({ p: 'x' });
    assert.deepEqual(result.errors.map((/** @type {any} */ e) => e.schemaPath), [`${A}?v=1#/$defs/t`]);
  });

  it('addSchema and getSchema key the query too (getSchema answered without it)', () => {
    const document = { $id: `${A}?v=1`, type: 'integer' };
    const validator = new JarenValidator().addSchema(document);
    assert.deepEqual([`${A}?v=1`, `${A}?v=1#`, A, `${A}?v=2`].map((key) => validator.getSchema(key) === document), [true, true, false, false]);
    const keyed = new JarenValidator().addSchema({ type: 'integer' }, `${A}?v=1`);
    assert.deepEqual([reach(keyed, `${A}?v=1`), reach(keyed, `${A}?v=2`), reach(keyed, A)], [[true, false], 'JK0009 #/%24ref', 'JK0009 #/%24ref']);
  });

  it('a held dialect is found by a $schema that spells its query, and by no other (it was found without the query only)', () => {
    /** A dialect without the validation vocabulary: under it `type` asserts nothing. */
    const dialect = { $schema: D20, $id: 'https://v.test/d?v=1', $dynamicAnchor: 'meta',
      $vocabulary: { 'https://json-schema.org/draft/2020-12/vocab/core': true, 'https://json-schema.org/draft/2020-12/vocab/applicator': true } };
    const validator = new JarenValidator().addMetaSchema(dialect);
    const under = (/** @type {string} */ $schema) => { const validate = validator.compile({ $schema, type: 'string' }); return [validate(1), validate('a')]; };
    assert.deepEqual(under('https://v.test/d?v=1'), [true, true]);
    assert.deepEqual(under('https://v.test/d?v=2'), [false, true]);
    assert.deepEqual(under('https://v.test/d'), [false, true]);
    assert.deepEqual(['https://v.test/d?v=1', 'https://v.test/d?v=2', 'https://v.test/d'].map(($schema) => validator.validateSchema({ $schema, type: 'string' })), [true, false, false]);
  });

  it('compileAsync asks the loader for the URI with its query, once per query (it asked without it)', async () => {
    /** @type {string[]} */
    const asked = [];
    const documents = /** @type {Record<string, object>} */ ({ [`${A}?v=1`]: { type: 'integer' }, [`${A}?v=2`]: { type: 'string' }, [A]: { type: 'boolean' } });
    const validate = await compileAsync(new JarenValidator(), { properties: { a: { $ref: `${A}?v=1` }, b: { $ref: `${A}?v=2` } } },
      { loadSchema: async (uri) => { asked.push(uri); return structuredClone(documents[uri]); } });
    assert.deepEqual(asked.sort(), [`${A}?v=1`, `${A}?v=2`]);
    assert.deepEqual([validate({ a: 1, b: 'x' }), validate({ a: 'x' }), validate({ b: 1 })], [true, false, false]);
    // a loaded document is named by the URI it was loaded from, whatever $id it declares
    const named = await compileAsync(new JarenValidator(), { $ref: `${A}?v=2` }, { loadSchema: async () => ({ $id: A, type: 'integer' }) });
    assert.deepEqual([named(1), named('x')], [true, false]);
  });

  it('reads as the normalizer, the emitter and the strict profile read the same two references', () => {
    const schema = (/** @type {string} */ ref) => ({ $schema: D20, type: 'object', properties: { a: { $ref: ref } }, $defs: { x: { $id: `${A}?v=a`, type: 'integer' } } });
    /** Whether each tool reaches the integer through the reference. @param {string} ref */
    const reached = (ref) => {
      /** @type {boolean[]} */
      const tools = [];
      try { tools.push(new JarenValidator().compile(schema(ref))({ a: 'x' }) === false); } catch { tools.push(false); }
      tools.push(/** @type {any} */ (compileNormalizer(schema(ref), { coerceTypes: true })({ a: '5' })).a === 5);
      tools.push(/a\?: (\w+)/.exec(emitTypeScript(schema(ref), { name: 'T' }))?.[1] !== 'unknown');
      try { tools.push(JSON.stringify(deriveStrictProfile(schema(ref)).schema).includes('"integer"')); } catch { tools.push(false); }
      return tools;
    };
    assert.deepEqual(reached(`${A}?v=a`), [true, true, true, true]);
    assert.deepEqual(reached(`${A}?v=zzz`), [false, false, false, false]);
    assert.deepEqual(reached(A), [false, false, false, false]);
  });

  it('leaves what read right as it was', () => {
    // the scheme and the host in any case, the empty fragment
    assert.deepEqual(reach(holding(`HTTP://X.TEST/a.json?v=a`), `${A}?v=a`), [true, false]);
    assert.deepEqual(reach(holding(`${A}?v=a`), `${A}?v=a#`), [true, false]);
    assert.deepEqual(reach(new JarenValidator().addSchema({ type: 'integer' }, 'http://x.test/k?x=1#'), 'http://x.test/k?x=1'), [true, false]);
    // a `?` in a fragment is no query: a pointer token and a plain name hold one
    const token = new JarenValidator().compile({ $defs: { 'a?b': { type: 'integer' } }, $ref: '#/$defs/a?b' });
    assert.deepEqual([token(1), token('x')], [true, false]);
    const name = new JarenValidator().compile({ $schema: D20, $defs: { t: { $anchor: 'a?b', type: 'integer' } }, $ref: '#a?b' });
    assert.deepEqual([name(1), name('x')], [true, false]);
    // a URN with an r-component: its own pointers resolve inside it
    const urn = new JarenValidator().compile({ $id: 'urn:example:foo-bar-baz-qux?+CCResolve:cc=uk', properties: { foo: { $ref: '#/$defs/bar' } }, $defs: { bar: { type: 'string' } } });
    assert.deepEqual([urn({ foo: 'bar' }), urn({ foo: 12 })], [true, false]);
  });
});
