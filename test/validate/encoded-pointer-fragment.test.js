import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { compileAsync } from '@jarenjs/validate/load';
import { resolveSameDocumentRef } from '@jarenjs/validate/normalize';

// A URI fragment percent-encodes a JSON Pointer: a fragment that decodes to
// one starting with `/` is a pointer, its `%2F`s separate tokens as `/`s
// do, and every other escape decodes once, with the token holding it.

const D07 = 'http://json-schema.org/draft-07/schema#';
const D20 = 'https://json-schema.org/draft/2020-12/schema';

const answers = (validate, instances) => instances.map((instance) => {
  try { return validate(instance); }
  catch (e) { return /** @type {any} */ (e).code; }
});
const $defs = {
  x: { type: 'string' },
  'a%25b': { type: 'number' },
  'a%b': { type: 'boolean' },
  'a/b': { type: 'null' },
  a: { b: { type: 'array' } },
};
const INSTANCES = ['s', 1, true, null, []];
/** Which of INSTANCES a target accepts, by the target's name. */
const ACCEPTS = {
  x: [true, false, false, false, false],
  'a%25b': [false, true, false, false, false],
  'a%b': [false, false, true, false, false],
  'a/b': [false, false, false, true, false],
  'a.b': [false, false, false, false, true],
};
const read = (ref) => {
  const validate = new JarenValidator().compile({ $defs, properties: { p: { $ref: ref } } });
  return answers((value) => validate({ p: value }), INSTANCES);
};

describe('a percent-encoded pointer fragment is a pointer', () => {
  it('the entry input', () => {
    const validate = new JarenValidator().compile({ $defs: { x: { type: 'string' } }, properties: { p: { $ref: '#%2F$defs%2Fx' } } });
    assert.deepEqual(answers(validate, [{ p: 1 }, { p: 's' }]), [false, true]);
  });

  for (const [ref, target] of [
    ['#%2F$defs%2Fx', 'x'],
    ['#%2f$defs%2fx', 'x'],
    ['#%2F%24defs%2Fx', 'x'],
    ['#%2F$defs/x', 'x'],
    ['#/$defs/x', 'x'],
    ['#/%24defs/x', 'x'],
    ['#%2F$defs%2Fa%2525b', 'a%25b'],
    ['#/$defs/a%2525b', 'a%25b'],
    ['#/$defs/a%25b', 'a%b'],
    ['#%2F$defs%2Fa~1b', 'a/b'],
    ['#/$defs/a~1b', 'a/b'],
    ['#%2F$defs%2Fa%2Fb', 'a.b'],
    ['#/$defs/a%2Fb', 'a.b'],
  ]) {
    it(`${ref} names ${target}`, () => {
      assert.deepEqual(read(ref), ACCEPTS[target]);
    });
  }

  it('reads as @jarenjs/validate/normalize reads it', () => {
    const schema = { $defs };
    for (const [ref, path] of [['#%2F$defs%2Fx', ['x']], ['#%2F$defs%2Fa%2525b', ['a%25b']], ['#/$defs/a%2Fb', ['a', 'b']], ['#%2F$defs%2Fa~1b', ['a/b']]])
      assert.equal(resolveSameDocumentRef(ref, schema), path.reduce((node, key) => node[key], schema.$defs), ref);
  });

  it('a pointer that misses is refused JK0009, naming the pointer', () => {
    assert.throws(() => new JarenValidator().compile({ $defs, properties: { p: { $ref: '#%2F$defs%2Fnope' } } }), {
      code: 'JK0009',
      message: "JK0009: Can not resolve schema for 'https://github.com/jklarenbeek/jarenjs#/$defs/nope': '/$defs/nope' is not a schema in 'https://github.com/jklarenbeek/jarenjs#'; fix the pointer at #/properties/p/%24ref",
    });
  });

  it('draft-07, a held document, a $dynamicRef and compileAsync', async () => {
    const d07 = new JarenValidator().compile({ $schema: D07, definitions: { x: { type: 'string' } }, properties: { p: { $ref: '#%2Fdefinitions%2Fx' } } });
    assert.deepEqual(answers(d07, [{ p: 's' }, { p: 1 }]), [true, false]);
    const validator = new JarenValidator();
    validator.addSchema({ $id: 'https://h.test/d.json', $defs: { x: { type: 'string' } } });
    assert.deepEqual(answers(validator.compile({ $ref: 'https://h.test/d.json#%2F$defs%2Fx' }), ['s', 1]), [true, false]);
    const dynamic = new JarenValidator().compile({ $schema: D20, $defs: { x: { type: 'string' } }, properties: { p: { $dynamicRef: '#%2F$defs%2Fx' } } });
    assert.deepEqual(answers(dynamic, [{ p: 's' }, { p: 1 }]), [true, false]);
    const loaded = await compileAsync(new JarenValidator(), { $ref: 'https://l.test/d.json#%2F$defs%2Fx' },
      { loadSchema: async () => ({ $defs: { x: { type: 'string' } } }) });
    assert.deepEqual(answers(loaded, ['s', 1]), [true, false]);
  });

  it('an anchor spelled with a leading %2F names nothing: the reference stays a pointer', () => {
    // the pointer names a schema: it is that schema, not the anchor's
    const shadowed = new JarenValidator().compile({ $schema: D20, a: { type: 'boolean' }, $defs: { y: { $anchor: '%2Fa', type: 'string' } }, properties: { p: { $ref: '#%2Fa' } } });
    assert.deepEqual(answers(shadowed, [{ p: true }, { p: 's' }]), [true, false]);
    // the pointer names nothing: refused, naming the anchor and the repair
    assert.throws(() => new JarenValidator().compile({ $schema: D20, $defs: { y: { $anchor: '%2Fa', type: 'string' } }, properties: { p: { $ref: '#%2Fa' } } }), {
      code: 'JK0009',
      docPath: '#/properties/p/%24ref',
      reason: "Can not resolve schema for 'https://github.com/jklarenbeek/jarenjs#/a': '#%2Fa' is a JSON Pointer, and the $anchor '%2Fa' at '#/%24defs/y/%24anchor' spelled like it names nothing; give the anchor a plain name (a letter or '_', then letters, digits, '-', '.', '_')",
    });
  });

  it('a plain name is still a plain name', () => {
    const validate = new JarenValidator().compile({ $schema: D20, $defs: { y: { $anchor: 'a%2Fb', type: 'string' } }, properties: { p: { $ref: '#a%2Fb' } } });
    assert.deepEqual(answers(validate, [{ p: 's' }, { p: 1 }]), [true, false]);
    // a dynamic anchor so named keeps its dynamic scope: the outermost one applies
    const bookend = new JarenValidator().compile({
      $schema: D20, $id: 'https://t.test/root', $ref: 'list',
      $defs: {
        foo: { $dynamicAnchor: 'a%2Fb', type: 'string' },
        list: { $id: 'list', type: 'array', items: { $dynamicRef: '#a%2Fb' }, $defs: { items: { $dynamicAnchor: 'a%2Fb' } } },
      },
    });
    assert.deepEqual(answers(bookend, [['a'], [1]]), [true, false]);
  });

  it('a %2F inside a plain name is not decoded: the name is matched as spelled', () => {
    assert.throws(() => new JarenValidator().compile({ $schema: D20, $defs: { y: { $anchor: 'a/b', type: 'string' } }, properties: { p: { $ref: '#a%2Fb' } } }), {
      code: 'JK0009',
    });
  });
});
