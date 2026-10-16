// What `addSchema` registers when its document holds a place the walk
// refuses, and which loops it refuses. A malformed `$ref` or `$id`, or an
// identifier declared twice, stopped the registration there, so a later
// compile was refused JK0009 naming a URI the document declares; the walk now
// goes on past the place, and the compile that reads it refuses it (JK0010).
// A loop of references only the 2019-09 reading of a document that declares
// no draft makes was refused at `addSchema`, though a draft-07 compile has no
// loop; it is now refused by the compile that reads it so.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { JarenValidator, SchemaCompileError } from '@jarenjs/validate';
import { compileAsync } from '@jarenjs/validate/load';

const D07 = 'http://json-schema.org/draft-07/schema#';
const D19 = 'https://json-schema.org/draft/2019-09/schema';
const UNHELD = 'no schema the validator holds has that URI; register it with addSchema, load it with compileAsync, or fix the reference';
const REPAIR = 'is not a valid URI reference; correct it, percent-encoding any character a URI does not allow';

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

/** A validator holding `documents`, registered in order. */
const holding = (...documents) => {
  const validator = new JarenValidator();
  for (const document of documents) validator.addSchema(document);
  return validator;
};

describe('addSchema registers the rest of a document past a place its walk refuses', () => {
  const badRef = () => ({ $id: 'https://a.test/a.json', properties: { a: { $ref: 'http://[x' } }, $defs: { b: { $id: 'b.json', type: 'string' } } });
  const badId = () => ({ $id: 'https://a.test/a.json', properties: { a: { $id: 'http://[x', type: 'number', $defs: { c: { $id: 'https://a.test/c.json', type: 'number' } } } }, $defs: { b: { $id: 'b.json', type: 'string' } } });

  it('a malformed $ref: an identifier after it answers (was JK0009 naming it)', () => {
    assert.deepEqual(answers(holding(badRef()).compile({ $ref: 'https://a.test/b.json' }), ['s', 1]), [true, false]);
  });
  it('a malformed $ref: the compile that reads it refuses it, naming the $ref', () => {
    const validate = holding(badRef()).compile({ $ref: 'https://a.test/a.json' });
    assert.deepEqual(refusal(() => validate({})), ['JK0010', `JK0010: $ref 'http://[x' ${REPAIR} at https://a.test/a.json#/properties/a/%24ref`]);
  });
  it('a malformed $ref: a pointer past it answers, as before', () => {
    assert.deepEqual(answers(holding(badRef()).compile({ $ref: 'https://a.test/a.json#/$defs/b' }), ['s', 1]), [true, false]);
  });
  it('a malformed $ref: compiling the document itself is refused where it is read, as before', () => {
    assert.deepEqual(refusal(() => new JarenValidator().compile(badRef())), ['JK0010', `JK0010: $ref 'http://[x' ${REPAIR} at #/properties/a/%24ref`]);
  });

  it('a malformed $id: an identifier beside it answers (was JK0009 naming it)', () => {
    assert.deepEqual(answers(holding(badId()).compile({ $ref: 'https://a.test/b.json' }), ['s', 1]), [true, false]);
  });
  it('a malformed $id: the compile that reads it refuses it, naming the $id', () => {
    const validate = holding(badId()).compile({ $ref: 'https://a.test/a.json' });
    assert.deepEqual(refusal(() => validate({})), ['JK0010', `JK0010: $id 'http://[x' ${REPAIR}`]);
  });
  it('a malformed $id: nothing below it is registered, as before', () => {
    assert.deepEqual(refusal(() => holding(badId()).compile({ $ref: 'https://a.test/c.json' })),
      ['JK0009', `JK0009: Can not resolve schema for 'https://a.test/c.json#': ${UNHELD} at #/%24ref`]);
  });

  const twice = () => ({ $id: 'https://a.test/a.json', $defs: {
    x: { $id: 'x.json', type: 'string' },
    y: { $id: 'x.json', type: 'number', $defs: { z: { $id: 'z.json', type: 'number' } } },
    n: { $anchor: 'n', type: 'string' },
    m: { $anchor: 'n', type: 'number', $defs: { w: { $id: 'w.json', type: 'number' } } },
    d1: { $dynamicAnchor: 'q', type: 'string' },
    d2: { $dynamicAnchor: 'q', type: 'number', $defs: { v: { $id: 'v.json', type: 'number' } } },
    b: { $id: 'b.json', type: 'string' },
  } });
  it('an identifier declared twice: an identifier after it answers (was JK0009 naming it)', () => {
    assert.deepEqual(answers(holding(twice()).compile({ $ref: 'https://a.test/b.json' }), ['s', 1]), [true, false]);
  });
  it('an identifier declared twice: the compile that reads it is refused, naming both places (was the first place\'s answer)', () => {
    const both = (id, first, second) => ['JK0012', `JK0012: '${id}' names two schemas (in 'https://a.test/a.json', at '${first}' and at '${second}'), and this compile reads it, which would answer by the one registered first; give one of them another name`];
    assert.deepEqual(refusal(() => holding(twice()).compile({ $ref: 'https://a.test/x.json' })),
      both('https://a.test/x.json#', '#/%24defs/x/%24id', '#/%24defs/y/%24id'));
    assert.deepEqual(refusal(() => holding(twice()).compile({ $ref: 'https://a.test/a.json#n' })),
      both('https://a.test/a.json#n', '#/%24defs/n/%24anchor', '#/%24defs/m/%24anchor'));
    assert.deepEqual(refusal(() => holding(twice()).compile({ $ref: 'https://a.test/a.json#q' })),
      both('https://a.test/a.json#q', '#/%24defs/d1/%24dynamicAnchor', '#/%24defs/d2/%24dynamicAnchor'));
  });
  it('an identifier declared twice: nothing below its second place is registered, as before', () => {
    for (const uri of ['https://a.test/z.json#', 'https://a.test/w.json#', 'https://a.test/v.json#'])
      assert.deepEqual(refusal(() => holding(twice()).compile({ $ref: uri })),
        ['JK0009', `JK0009: Can not resolve schema for '${uri}': ${UNHELD} at #/%24ref`]);
  });

  it('a loop of references the rest of the document holds is refused by the compile that reaches it', () => {
    const ring = (a) => ({ $id: 'https://r.test/d.json', properties: { a }, $defs: { s: { type: 'string' }, r1: { $anchor: 'r1', $ref: '#r2' }, r2: { $anchor: 'r2', $ref: '#r1' } } });
    const validator = holding(ring({ $ref: 'http://[x' }));
    // what else the document holds answers, as before
    assert.deepEqual(answers(validator.compile({ $ref: 'https://r.test/d.json#/$defs/s' }), ['s', 1]), [true, false]);
    // was JK0009 naming the anchor the stopped registration left out
    assert.deepEqual(refusal(() => validator.compile({ $ref: 'https://r.test/d.json#r1' })),
      ['JK0001', 'JK0001: $ref cycle: https://r.test/d.json#r1 -> https://r.test/d.json#r2 -> https://r.test/d.json#r1 never reads the instance']);
    // without the refused place the document is refused where it is added, as before
    assert.deepEqual(refusal(() => holding(ring({ type: 'number' }))),
      ['JK0001', 'JK0001: $ref cycle: https://r.test/d.json#r2 -> https://r.test/d.json#r1 -> https://r.test/d.json#r2 never reads the instance']);
  });
});

describe('addSchema refuses only a loop every reading of the document makes', () => {
  const root = () => ({ $id: 'https://held.test/root.json', $defs: { a: { $id: 'sub/a.json', $ref: 'name.json' } } });
  const sub = () => ({ $id: 'https://held.test/sub/name.json', $ref: 'https://held.test/root.json#/$defs/a' });
  const name = () => ({ $id: 'https://held.test/name.json', type: 'string' });
  const P = { properties: { p: { $ref: 'https://held.test/root.json#/$defs/a' } } };
  const LOOP = ['JK0001', 'JK0001: $ref cycle: https://held.test/sub/a.json# -> https://held.test/sub/name.json# -> https://held.test/sub/a.json# never reads the instance'];

  for (const [order, documents] of [
    ['root, sub, name (was JK0001 at addSchema)', [root, sub, name]],
    ['sub, root, name', [sub, root, name]],
    ['name, root, sub (was JK0001 at addSchema)', [name, root, sub]],
  ]) {
    it(`registered ${order}: a draft-07 compile answers, a 2019-09 compile is refused`, () => {
      const validator = holding(...documents.map((d) => d()));
      const instances = [{ p: 'x' }, { p: 5 }, {}];
      assert.deepEqual(answers(validator.compile(P), instances), [true, false, true]);
      assert.deepEqual(answers(validator.compile({ $schema: D07, ...P }), instances), [true, false, true]);
      assert.deepEqual(refusal(() => validator.compile({ $schema: D19, ...P })), LOOP);
      assert.deepEqual(answers(validator.compile({ type: 'string' }), ['s', 1]), [true, false]);
    });
  }

  it('compileAsync: a draft-07 compile loads what it reads and answers; a 2019-09 compile is refused', async () => {
    const served = { 'https://held.test/root.json': root(), 'https://held.test/sub/name.json': sub(), 'https://held.test/name.json': name() };
    const asked = [];
    const loadSchema = async (uri) => {
      asked.push(uri);
      return served[uri];
    };
    const validate = await compileAsync(new JarenValidator(), P, { loadSchema });
    assert.deepEqual(asked, ['https://held.test/root.json', 'https://held.test/name.json']);
    assert.deepEqual(answers(validate, [{ p: 'x' }, { p: 5 }]), [true, false]);
    await assert.rejects(async () => compileAsync(new JarenValidator(), { $schema: D19, ...P }, { loadSchema }), { code: 'JK0001', message: LOOP[1] });
  });

  it('a loop only the draft-07 reading makes is refused by a draft-07 compile, as before', () => {
    const validator = holding(
      { $id: 'https://m.test/root.json', $defs: { a: { $id: 'sub/a.json', $ref: 'b.json' } } },
      { $id: 'https://m.test/b.json', $ref: 'https://m.test/root.json#/$defs/a' },
      { $id: 'https://m.test/sub/b.json', type: 'string' });
    const S = { $ref: 'https://m.test/root.json#/$defs/a' };
    assert.deepEqual(refusal(() => validator.compile(S)),
      ['JK0001', 'JK0001: $ref cycle: https://m.test/sub/a.json# -> https://m.test/b.json# -> https://m.test/sub/a.json# never reads the instance']);
    assert.deepEqual(answers(validator.compile({ $schema: D19, ...S }), ['x', 5]), [true, false]);
  });

  it('a loop that does not depend on the reading is refused at addSchema, as before', () => {
    const validator = new JarenValidator().addSchema({ $id: 'https://l.test/root.json', $defs: { k: { type: 'string' } } });
    assert.deepEqual(refusal(() => validator.addSchema({ $id: 'https://l.test/d.json', $defs: { a: { $anchor: 'a', $ref: '#b' }, b: { $anchor: 'b', $ref: '#a' } } })),
      ['JK0001', 'JK0001: $ref cycle: https://l.test/d.json#b -> https://l.test/d.json#a -> https://l.test/d.json#b never reads the instance']);
    // the refused document is not held; what was held still answers
    assert.deepEqual(answers(validator.compile({ $ref: 'https://l.test/root.json#/$defs/k' }), ['s', 1]), [true, false]);
    assert.deepEqual(refusal(() => validator.compile({ $ref: 'https://l.test/d.json' })),
      ['JK0009', `JK0009: Can not resolve schema for 'https://l.test/d.json#': ${UNHELD} at #/%24ref`]);
  });
});
