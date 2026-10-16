// A plain-name fragment is keyed as the URI spells it, whatever characters
// the name holds: an `$anchor`, a `$dynamicAnchor` or a draft-07 `$id: '#…'`
// that was no HTML identifier of at most 31 characters (`a b`, `_a`, a longer
// name) was read as the document, so it threw an uncoded "already exists"
// where it was declared, and a reference to it named the whole document.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { JarenValidator, SchemaCompileError, TraverseOptions } from '@jarenjs/validate';

const ORIGIN = 'https://github.com/jklarenbeek/jarenjs';
const D19 = 'https://json-schema.org/draft/2019-09/schema';
const D20 = 'https://json-schema.org/draft/2020-12/schema';
const UNHELD = 'no schema the validator holds has that URI; register it with addSchema, load it with compileAsync, or fix the reference';
const LONG = 'a'.repeat(40);

/** Each instance's answer, or the code its call is refused with. */
const answers = (validate, instances) => instances.map((instance) => {
  try {
    return validate(instance);
  }
  catch (error) {
    return error instanceof SchemaCompileError ? error.code : 'uncoded';
  }
});

/** The refusal a call throws, as `[code, message]`. */
const refusal = (fn) => {
  try { fn(); }
  catch (error) {
    return [error instanceof SchemaCompileError ? error.code : 'uncoded', error.message];
  }
  return ['no throw', ''];
};

describe('an anchor resolves exactly, whatever its name', () => {
  it('the reported schema answers (threw an uncoded "already exists")', () => {
    const validate = new JarenValidator().compile({ $defs: { x: { $anchor: 'a b', type: 'string' } }, $ref: '#a b' });
    assert.deepEqual(answers(validate, ['s', 1]), [true, false]);
  });

  // the first ten names threw an uncoded Error; the last four answered and
  // still do
  for (const name of ['a b', '_a', '1a', 'é', LONG, 'a%20b', 'a/b', '#a', '-a', 'a~b', 'a', 'a:b', 'a.b', 'a-b']) {
    for (const [draft, $schema] of [['2020-12', D20], ['2019-09', D19], ['no draft', undefined]]) {
      it(`$anchor ${JSON.stringify(name.length > 12 ? 'a × 40' : name)}, ${draft}`, () => {
        const schema = { $defs: { x: { $anchor: name, type: 'string' } }, properties: { p: { $ref: `#${name}` } } };
        if ($schema) schema.$schema = $schema;
        assert.deepEqual(answers(new JarenValidator().compile(schema), [{ p: 's' }, { p: 1 }, {}]), [true, false, true]);
      });
    }
  }

  it('a reference may spell the name percent-encoded', () => {
    const validate = new JarenValidator().compile({ $schema: D20, $defs: { x: { $anchor: 'a b', type: 'string' } }, $ref: '#a%20b' });
    assert.deepEqual(answers(validate, ['s', 1]), [true, false]);
  });

  for (const name of ['a b', '_a', LONG]) {
    it(`a draft-07 $id '#${name.length > 12 ? 'a × 40' : name}'`, () => {
      const validate = new JarenValidator().compile({ definitions: { x: { $id: `#${name}`, type: 'string' } }, properties: { p: { $ref: `#${name}` } } });
      assert.deepEqual(answers(validate, [{ p: 's' }, { p: 1 }]), [true, false]);
    });
  }

  it('an anchor of a held document (answered true for a number: the reference named the document)', () => {
    const validate = new JarenValidator()
      .addSchema({ $schema: D20, $id: 'https://h.test/d', $defs: { x: { $anchor: '_a', type: 'string' } } })
      .compile({ $schema: D20, $ref: 'https://h.test/d#_a' });
    assert.deepEqual(answers(validate, ['s', 1]), [true, false]);
  });

  it('with anchors global to the validator', () => {
    const validate = new JarenValidator({ traverse: new TraverseOptions(undefined, true, true) })
      .compile({ $defs: { x: { $anchor: 'a b', type: 'string' } }, properties: { p: { $ref: '#a b' } } });
    assert.deepEqual(answers(validate, [{ p: 's' }, { p: 1 }]), [true, false]);
  });
});

describe('a $dynamicAnchor resolves exactly, whatever its name', () => {
  // the outermost dynamic scope's anchor (strings) wins over the list's own (anything)
  const bookend = (name, spelled = name) => ({ $schema: D20, $id: 'https://t.test/root', $ref: 'list', $defs: {
    override: { $dynamicAnchor: name, type: 'string' },
    list: { $id: 'list', type: 'array', items: { $dynamicRef: `#${spelled}` }, $defs: { dflt: { $dynamicAnchor: name } } },
  } });
  for (const [name, spelled] of [['ab'], ['_a'], [LONG], ['a b'], ['é'], ['a%zz'], ['a%20b'], ['a%41'], ['a b', 'a%20b'], ['a%20b', 'a b'], ['é', '%C3%A9']]) {
    it(`${JSON.stringify(name.length > 12 ? 'a × 40' : name)}${spelled === undefined ? '' : `, named ${JSON.stringify(spelled)}`}`, () => {
      assert.deepEqual(answers(new JarenValidator().compile(bookend(name, spelled)), [[1], ['s']]), [false, true]);
    });
  }
});

describe('a reference to a plain name no anchor declares is refused (it named the document)', () => {
  for (const [name, spelled] of [['_a', '_a'], ['a b', 'a%20b'], [LONG, LONG]]) {
    it(JSON.stringify(name.length > 12 ? 'a × 40' : name), () => {
      assert.deepEqual(refusal(() => new JarenValidator().compile({ $schema: D20, properties: { p: { $ref: `#${name}` } } })),
        ['JK0009', `JK0009: Can not resolve schema for '${ORIGIN}#${spelled}': ${UNHELD} at #/properties/p/%24ref`]);
    });
  }
});

describe('what answered right answers as before', () => {
  for (const [label, schema, instances, expected] of [
    ['an anchor no reference names, at the document root', { $schema: D20, $anchor: 'a b', type: 'string' }, ['s', 1], [true, false]],
    ['a longer anchor at the document root', { $schema: D20, $anchor: LONG, type: 'string' }, ['s', 1], [true, false]],
    ['an anchor beside an $id, in a subschema nothing applies', { $schema: D20, $defs: { x: { $id: 'https://x.test/y', $anchor: 'a b', type: 'string' } } }, ['s', 1], [true, true]],
    ['a pointer fragment', { $schema: D20, $defs: { x: { type: 'string' } }, properties: { p: { $ref: '#/$defs/x' } } }, [{ p: 's' }, { p: 1 }], [true, false]],
    ['an empty fragment', { $schema: D20, $id: 'https://t.test/e.json#', type: 'object', properties: { p: { $ref: 'https://t.test/e.json#' } } }, [{ p: {} }, { p: 1 }], [true, false]],
  ]) {
    it(label, () => {
      assert.deepEqual(answers(new JarenValidator().compile(schema), instances), expected);
    });
  }
});
