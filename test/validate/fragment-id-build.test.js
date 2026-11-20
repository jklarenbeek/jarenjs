//@ts-check
/**
 * @file An identifier that holds a fragment (`…/n.json#root`, a nested
 * `$id: '#foo'`) is held under that one spelling: no `#` is appended to it.
 * A document whose root `$id` is such an identifier, and that names its
 * document too, is built once, under the document's URI, where its places
 * are (`…/n.json#/properties/a`), and its name answers by that build. It
 * was built three times (`…#root`, `…#root#` and `…#`), a reference spelled
 * with the second `#` answered, and an error below the root was located at
 * the name followed by a pointer (`…#root/properties/a`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';

const ORIGIN = 'https://github.com/jklarenbeek/jarenjs';
const DRAFTS = [undefined, 'http://json-schema.org/draft-06/schema#', 'http://json-schema.org/draft-07/schema#',
  'https://json-schema.org/draft/2019-09/schema', 'https://json-schema.org/draft/2020-12/schema'];

/** A validator whose `counted` format records the place of every schema object built with it. */
function counting() {
  /** @type {string[]} */
  const built = [];
  const validator = new JarenValidator({ formatAssertion: true }).addFormat('counted', (/** @type {any} */ place) => { built.push(place.path); return () => true; });
  return { validator, built };
}
const named = (/** @type {string} */ $id, /** @type {string|undefined} */ $schema = undefined) =>
  ({ ...($schema ? { $schema } : {}), $id, properties: { a: { type: 'string', format: 'counted' } } });
/** @param {() => unknown} fn */
const refusal = (fn) => {
  try { fn(); return 'answers'; }
  catch (error) { return `${/** @type {any} */ (error).code} ${/** @type {any} */ (error).docPath ?? ''}`.trim(); }
};

describe('a document whose root $id holds a plain-name fragment', () => {
  it('is built once, under the URI of its document, in every draft (it was built three times)', () => {
    for (const $schema of DRAFTS) {
      for (const [$id, place] of [['https://x.test/n.json#root', 'https://x.test/n.json#/properties/a'], ['#root', `${ORIGIN}#/properties/a`], ['n.json#root', 'https://github.com/jklarenbeek/n.json#/properties/a']]) {
        const { validator, built } = counting();
        const validate = validator.compile(named($id, $schema));
        assert.deepEqual([validate({ a: 's' }), validate({ a: 1 })], [true, false], `${$schema} ${$id}`);
        assert.deepEqual(built, [place], `${$schema} ${$id}`);
      }
    }
  });

  it('is built once when it is held under that URI, whichever of its names a reference spells', () => {
    for (const ref of ['https://x.test/n.json#root', 'https://x.test/n.json', 'https://x.test/n.json#']) {
      const { validator, built } = counting();
      const validate = validator.addSchema(named('https://x.test/n.json#root'), 'https://x.test/n.json').compile({ $ref: ref });
      assert.deepEqual([validate({ a: 's' }), validate({ a: 1 })], [true, false], ref);
      assert.deepEqual(built, ['https://x.test/n.json#/properties/a'], ref);
    }
    // a fragment-only name under a key
    const { validator, built } = counting();
    validator.addSchema(named('#root'), 'https://x.test/k.json').compile({ properties: { one: { $ref: 'https://x.test/k.json#root' }, two: { $ref: 'https://x.test/k.json' } } });
    assert.deepEqual(built, ['https://x.test/k.json#/properties/a']);
  });

  it('locates an error below its root at a place of the document (it was the name followed by a pointer)', () => {
    const collecting = () => new JarenValidator({ collectErrors: true });
    const schema = { $id: 'https://x.test/n.json#root', type: 'object', properties: { a: { type: 'string' }, n: { $ref: '#root' }, m: { $ref: '#' } } };
    assert.deepEqual(collecting().compile(schema)({ a: 1, n: { a: 2 }, m: { a: 3 } }).errors.map((/** @type {any} */ e) => [e.instancePath, e.schemaPath]),
      [['/a', 'https://x.test/n.json#/properties/a'], ['/n/a', 'https://x.test/n.json#/properties/a'], ['/m/a', 'https://x.test/n.json#/properties/a']]);
    assert.deepEqual(collecting().compile({ $id: '#root', properties: { a: { type: 'string' } } })({ a: 1 }).errors.map((/** @type {any} */ e) => e.schemaPath), [`${ORIGIN}#/properties/a`]);
    assert.deepEqual(collecting().compile({ $id: 'https://x.test/n.json#root', type: 'object' })(1).errors.map((/** @type {any} */ e) => e.schemaPath), ['https://x.test/n.json#']);
    const held = collecting().addSchema({ $id: 'https://x.test/n.json#root', properties: { a: { type: 'string' } } }, 'https://x.test/n.json');
    assert.deepEqual(held.compile({ $ref: 'https://x.test/n.json#root' })({ a: 1 }).errors.map((/** @type {any} */ e) => e.schemaPath), ['https://x.test/n.json#/properties/a']);
  });

  it('keeps answering by its name, from inside and from another document, and keeps a self-reference refused', () => {
    const inside = new JarenValidator().compile({ $id: 'https://x.test/n.json#root', type: 'object', properties: { a: { type: 'string' }, n: { $ref: '#root' }, m: { $ref: 'https://x.test/n.json#root' } } });
    assert.deepEqual([inside({ n: { m: { a: 's' } } }), inside({ n: { m: { a: 1 } } }), inside({ n: 1 })], [true, false, false]);
    const outside = new JarenValidator().addSchema({ $id: 'https://x.test/n.json#root', type: 'object', properties: { a: { type: 'string' } } }, 'https://x.test/n.json')
      .compile({ items: { $ref: 'https://x.test/n.json#root' } });
    assert.deepEqual([outside([{ a: 's' }]), outside([{ a: 1 }]), outside([1])], [true, false, false]);
    for (const $ref of ['#root', '#', 'https://x.test/n.json#root', 'https://x.test/n.json'])
      assert.equal(refusal(() => new JarenValidator().compile({ $id: 'https://x.test/n.json#root', $ref })), 'JK0001 #/%24ref', $ref);
  });
});

describe('an identifier that holds a fragment', () => {
  const root = () => ({ $id: 'https://x.test/n.json#root', properties: { a: { type: 'string' } } });
  const nested = () => ({ $id: 'https://x.test/doc.json', definitions: { f: { $id: '#foo', type: 'integer' } } });

  it('has no second spelling: a # after it names nothing (it answered)', () => {
    assert.equal(refusal(() => new JarenValidator().addSchema(root()).compile({ $ref: 'https://x.test/n.json#root#' })), 'JK0009 #/%24ref');
    assert.equal(refusal(() => new JarenValidator().addSchema(root(), 'https://x.test/n.json').compile({ $ref: 'https://x.test/n.json#root#' })), 'JK0009 #/%24ref');
    assert.equal(refusal(() => new JarenValidator().addSchema(nested()).compile({ $ref: 'https://x.test/doc.json#foo#' })), 'JK0009 #/%24ref');
    assert.equal(refusal(() => new JarenValidator().compile({ ...nested(), items: { $ref: '#foo#' } })), 'JK0009 #/items/%24ref');
    const document = root();
    const validator = new JarenValidator().addSchema(document);
    assert.deepEqual(['https://x.test/n.json#root', 'https://x.test/n.json#root#'].map((key) => validator.getSchema(key) === document), [true, false]);
    // an identifier written with a second # is held as written, and answers by that spelling alone
    const doubled = new JarenValidator().addSchema({ $id: 'https://x.test/n.json#root#', type: 'string' });
    assert.equal(refusal(() => doubled.compile({ $ref: 'https://x.test/n.json#root#' })), 'answers');
    assert.equal(refusal(() => doubled.compile({ $ref: 'https://x.test/n.json#root' })), 'JK0009 #/%24ref');
  });

  it('answers by its own spelling as before, and every other doubled # stays refused', () => {
    const byName = new JarenValidator().addSchema(root()).compile({ $ref: 'https://x.test/n.json#root' });
    assert.deepEqual([byName({ a: 's' }), byName({ a: 1 })], [true, false]);
    const byNested = new JarenValidator().addSchema(nested()).compile({ $ref: 'https://x.test/doc.json#foo' });
    assert.deepEqual([byNested(1), byNested('x')], [true, false]);
    for (const ref of ['https://x.test/n.json#root##', 'https://x.test/n.json##', 'https://x.test/n.json#root#/properties/a', 'https://x.test/doc.json#foo##'])
      assert.equal(refusal(() => new JarenValidator().addSchema(root()).addSchema(nested()).compile({ $ref: ref })), 'JK0009 #/%24ref', ref);
    // a document's URI keeps its two spellings, with and without the empty fragment
    for (const ref of ['https://x.test/doc.json', 'https://x.test/doc.json#']) {
      const validate = new JarenValidator().addSchema({ $id: 'https://x.test/doc.json', type: 'integer' }).compile({ $ref: ref });
      assert.deepEqual([validate(1), validate('x')], [true, false], ref);
    }
  });
});
