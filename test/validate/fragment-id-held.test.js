//@ts-check
/**
 * @file A held document whose root `$id` holds a plain-name fragment
 * (`#root`, `https://x.test/r.json#root`) and that is not held under the URI
 * before the fragment is the document of its own references: its pointers
 * (`#/definitions/s`), `#` and its plain names resolve inside it, whatever a
 * later compile holds under that URI. Its pointers named a place of
 * whichever document a compile put there: the compiling one's, another held
 * schema's, or none (`JK0009`). Its places are named below its name
 * (`…#root/definitions/s`), which no reference outside it reaches.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';

const ORIGIN = 'https://github.com/jklarenbeek/jarenjs';
const D7 = 'http://json-schema.org/draft-07/schema#';
const D19 = 'https://json-schema.org/draft/2019-09/schema';
const D20 = 'https://json-schema.org/draft/2020-12/schema';
/** The two spellings of such an `$id`, and the reference that names each held without a key. */
const NAMES = /** @type {const} */ ([['#root', `${ORIGIN}#root`], ['https://x.test/r.json#root', 'https://x.test/r.json#root']]);

/** @param {string} $id @param {object} [extra] */
const document = ($id, extra = {}) => ({ $id, definitions: { s: { type: 'string' } }, properties: { a: { $ref: '#/definitions/s' } }, ...extra });
/** @param {(value: unknown) => any} validate @param {unknown[]} values */
const answers = (validate, values) => values.map((value) => { const result = validate(value); return typeof result === 'boolean' ? result : result.valid; });
const A = [{ a: 'x' }, { a: 1 }];
/** @param {() => unknown} fn */
const refusal = (fn) => {
  try { fn(); return 'answers'; }
  catch (error) { return /** @type {any} */ (error).code; }
};

describe('a held document named by a plain-name fragment alone', () => {
  it('resolves its own pointers inside itself, whatever the compile holds under the URI before the name (it answered by the compile\'s, or was refused JK0009)', () => {
    for (const [$id, ref] of NAMES) {
      const held = () => new JarenValidator().addSchema(document($id));
      assert.deepEqual(answers(held().compile({ $ref: ref }), A), [true, false], $id);
      assert.deepEqual(answers(held().compile({ definitions: { s: { type: 'number' } }, $ref: ref }), A), [true, false], $id);
      assert.deepEqual(answers(held().compile({ $id: 'https://x.test/own.json', definitions: { s: { type: 'number' } }, $ref: ref }), A), [true, false], $id);
    }
  });

  it('answers as the document compiled directly, which is unchanged, in draft-07, 2019-09 and 2020-12', () => {
    for (const [$id, ref] of NAMES) {
      assert.deepEqual(answers(new JarenValidator().compile(document($id)), A), [true, false], $id);
      for (const $schema of [D7, D19, D20]) {
        const held = new JarenValidator().addSchema({ $schema, ...document($id) });
        assert.deepEqual(answers(held.compile({ $ref: ref }), A), [true, false], `${$id} ${$schema}`);
        assert.deepEqual(answers(held.compile({ $schema, definitions: { s: { type: 'number' } }, $ref: ref }), A), [true, false], `${$id} ${$schema}`);
      }
    }
  });

  it('reads `#` inside it as itself, not as the compiling document', () => {
    for (const [$id, ref] of NAMES) {
      const held = new JarenValidator().addSchema({ $id, type: 'object', properties: { a: { type: 'string' }, n: { $ref: '#' } } });
      assert.deepEqual(answers(held.compile({ type: ['object', 'number'], properties: { z: { $ref: ref } } }), [{ z: { n: { a: 's' } } }, { z: { n: { a: 1 } } }, { z: { n: 1 } }]), [true, false, false], $id);
    }
  });

  it('resolves its plain names, its `$dynamicRef` pointers and a pointer below a keyword no draft defines inside itself', () => {
    for (const [$id, ref] of NAMES) {
      const anchored = { $schema: D20, $id, $defs: { s: { $anchor: 's', type: 'string' } }, properties: { a: { $ref: '#s' } } };
      assert.deepEqual(answers(new JarenValidator().addSchema(anchored).compile({ $ref: ref }), A), [true, false], $id);
      const dynamic = { $schema: D20, $id, type: 'object', properties: { a: { type: 'string' }, n: { $dynamicRef: '#/properties/a' } } };
      assert.deepEqual(answers(new JarenValidator().addSchema(dynamic).compile({ $schema: D20, properties: { a: { type: 'number' }, z: { $ref: ref } } }), [{ z: { n: 's' } }, { z: { n: 1 } }]), [true, false], $id);
      const unwalked = { $schema: D20, $id, components: { schemas: { p: { type: 'string' } } }, properties: { a: { $ref: '#/components/schemas/p' } } };
      assert.deepEqual(answers(new JarenValidator().addSchema(unwalked).compile({ components: { schemas: { p: { type: 'number' } } }, $ref: ref }), A), [true, false], $id);
    }
    // an embedded resource below it keeps its own `#`
    const embedded = { $id: '#root', $defs: { s: { type: 'number' } }, properties: { e: { $id: 'https://x.test/e.json', $defs: { s: { type: 'string' } }, properties: { a: { $ref: '#/$defs/s' } } } } };
    assert.deepEqual(answers(new JarenValidator().addSchema(embedded).compile({ $ref: `${ORIGIN}#root` }), [{ e: { a: 'x' } }, { e: { a: 1 } }]), [true, false]);
  });

  it('keeps two such documents apart, and apart from a schema held under the URI before the name', () => {
    for (const [$id, ref] of NAMES) {
      const two = new JarenValidator().addSchema(document($id)).addSchema(document($id.replace('root', 'other'), { definitions: { s: { type: 'number' } } }));
      assert.deepEqual([answers(two.compile({ $ref: ref }), A), answers(two.compile({ $ref: ref.replace('root', 'other') }), A)], [[true, false], [false, true]], $id);
    }
    const uri = 'https://x.test/r.json';
    const beside = { $id: uri, type: 'number', definitions: { s: { type: 'number' } } };
    for (const validator of [new JarenValidator().addSchema(document(`${uri}#root`)).addSchema(beside), new JarenValidator().addSchema(beside).addSchema(document(`${uri}#root`))])
      assert.deepEqual([answers(validator.compile({ $ref: uri }), ['x', 1]), answers(validator.compile({ $ref: `${uri}#root` }), A)], [[false, true], [true, false]]);
  });

  it('reads its pointers inside itself under a key too', () => {
    assert.deepEqual(answers(new JarenValidator().addSchema(document('#root'), 'https://x.test/k.json').compile({ $ref: 'https://x.test/k.json#root' }), A), [true, false]);
    // an absolute name of another URI is read as written, the key holding the document
    assert.deepEqual(answers(new JarenValidator().addSchema(document('https://x.test/r.json#root'), 'https://x.test/k.json').compile({ $ref: 'https://x.test/k.json' }), A), [true, false]);
  });

  it('answers the document registered last under the name', () => {
    for (const [$id, ref] of NAMES) {
      const validator = new JarenValidator().addSchema(document($id)).addSchema(document($id, { definitions: { s: { type: 'number' } } }));
      assert.deepEqual(answers(validator.compile({ $ref: ref }), A), [false, true], $id);
    }
  });

  it('hands `getSchema` the caller\'s own object, and makes no later compile without `$id` refused', () => {
    for (const [$id, ref] of NAMES) {
      const held = document($id);
      const validator = new JarenValidator().addSchema(held);
      assert.equal(validator.getSchema(ref), held, $id);
      assert.equal(validator.getSchema($id), held, $id);
      assert.equal(validator.getSchema(ref.slice(0, ref.indexOf('#'))), null, $id);
      // a compile without `$id` is its own document at the origin: not refused JK0012, and its pointers are its own
      assert.deepEqual(answers(validator.compile({ type: 'string' }), ['x', 1]), [true, false], $id);
      assert.deepEqual(answers(validator.compile({ definitions: { s: { type: 'number' } }, properties: { a: { $ref: '#/definitions/s' } } }), A), [false, true], $id);
    }
  });

  it('still refuses a reference to its URI that no schema holds', () => {
    assert.equal(refusal(() => new JarenValidator().addSchema(document('https://x.test/r.json#root')).compile({ $ref: 'https://x.test/r.json#/definitions/s' })), 'JK0009');
    assert.equal(refusal(() => new JarenValidator().addSchema(document('https://x.test/r.json#root')).compile({ $ref: 'https://x.test/r.json' })), 'JK0009');
  });
});

describe('a place below the name of a held document named by a plain-name fragment alone', () => {
  /** @param {() => unknown} fn */
  const refused = (fn) => {
    try { fn(); return 'answers'; }
    catch (error) { return `${/** @type {any} */ (error).code} ${/** @type {any} */ (error).docPath ?? ''}`; }
  };
  it('is reached by none of the references outside the document: `<name>/definitions/s` is no name and no pointer (it answered)', () => {
    for (const [$id, ref] of NAMES) {
      const held = () => new JarenValidator().addSchema(document($id));
      const inner = `${ref}/definitions/s`;
      assert.equal(refused(() => held().compile({ $ref: inner })), 'JK0009 #/%24ref', $id);
      assert.equal(refused(() => held().compile({ properties: { q: { $ref: inner } } })), 'JK0009 #/properties/q/%24ref', $id);
      assert.equal(refused(() => held().compile({ $schema: D20, $dynamicRef: inner })), 'JK0009 #/%24dynamicRef', $id);
      // another held document's, through a chain of references, is refused at its own reference, by the first call
      assert.equal(refused(() => held().addSchema({ $id: 'https://o.test/o.json', $ref: inner }).compile({ $ref: 'https://o.test/o.json' })('x')), 'JK0009 https://o.test/o.json#/%24ref', $id);
      assert.equal(held().getSchema(inner), null, $id);
      // the document's own references, and its name, still answer
      assert.deepEqual(answers(held().compile({ $ref: ref }), A), [true, false], $id);
      assert.deepEqual(answers(held().compile({ properties: { q: { $ref: ref } } }), [{ q: { a: 'x' } }, { q: { a: 1 } }]), [true, false], $id);
    }
  });

  it('reads a `$recursiveRef: "#"` inside the document as the document, not as the compiling one (it read the compile\'s root)', () => {
    const recursive = (/** @type {string} */ $id, /** @type {boolean} */ anchored) => ({ $schema: D19, $id, ...(anchored ? { $recursiveAnchor: true } : {}),
      type: 'object', properties: { a: { type: 'string' }, n: { $recursiveRef: '#' } } });
    const values = [{ z: { n: { a: 's' } } }, { z: { n: { a: 1 } } }, { z: { n: 1 } }];
    // each answers as the same document named by a URI without a fragment does
    for (const [$id, ref] of [...NAMES, ['https://x.test/p.json', 'https://x.test/p.json']]) {
      for (const [anchored, outer, expected] of /** @type {[boolean, boolean, boolean[]][]} */ ([[false, false, [true, false, false]], [false, true, [true, false, false]],
        [true, false, [true, false, false]], [true, true, [true, true, true]]])) {
        const validate = new JarenValidator().addSchema(recursive($id, anchored))
          .compile({ $schema: D19, ...(outer ? { $recursiveAnchor: true } : {}), type: ['object', 'number'], properties: { z: { $ref: ref } } });
        assert.deepEqual(answers(validate, values), expected, `${$id} ${anchored} ${outer}`);
      }
      assert.deepEqual(answers(new JarenValidator().compile(recursive($id, false)), [{ n: { a: 's' } }, { n: { a: 1 } }, { n: 1 }]), [true, false, false], $id);
    }
  });
});

describe('an anchor on the root of an embedded resource whose `$id` is relative', () => {
  const held = () => new JarenValidator().addSchema({ $schema: D20, $id: 'https://a.test/dir/root.json',
    $defs: { e: { $id: 'sub/e.json', $anchor: 'top', properties: { p: { $ref: 'leaf.json' } } }, l: { $id: 'sub/leaf.json', type: 'string' } } });
  it('reads the resource\'s references against its own base, reached by the anchor (they were read against the origin)', () => {
    for (const ref of ['https://a.test/dir/sub/e.json#top', 'https://a.test/dir/sub/e.json'])
      assert.deepEqual(answers(held().compile({ $ref: ref }), [{ p: 'x' }, { p: 1 }]), [true, false], ref);
    const beside = held().addSchema({ $id: 'https://github.com/jklarenbeek/sub/leaf.json', type: 'number' });
    assert.deepEqual(answers(beside.compile({ $ref: 'https://a.test/dir/sub/e.json#top' }), [{ p: 'x' }, { p: 1 }]), [true, false]);
  });
});
