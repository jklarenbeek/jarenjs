import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { JarenValidator, SchemaCompileError, TraverseOptions, VALIDATE_CODES } from '@jarenjs/validate';
import { compileAsync } from '@jarenjs/validate/load';

// An identifier ($id, $anchor, $dynamicAnchor) names one schema: a second
// place declaring it is refused `JK0012`, naming both places, where it was an
// uncoded `Error` ("… already exists").

const D20 = 'https://json-schema.org/draft/2020-12/schema';
const ORIGIN = 'https://github.com/jklarenbeek/jarenjs';

const answers = (validate, instances) => instances.map((instance) => {
  try { return validate(instance); }
  catch (e) { return /** @type {any} */ (e).code; }
});
const refusal = (fn) => {
  try { fn(); }
  catch (e) {
    assert.ok(e instanceof SchemaCompileError, String(e));
    return /** @type {any} */ (e).message;
  }
  return 'no refusal';
};

describe('JK0012: an identifier declared twice', () => {
  it('is a registered code', () => {
    assert.equal(VALIDATE_CODES.JK0012, 'an identifier names two schemas');
  });

  it('the entry input', () => {
    assert.equal(refusal(() => new JarenValidator().compile({ $defs: { a: { $id: 'x.json' }, b: { $id: 'x.json' } } })),
      "JK0012: 'https://github.com/jklarenbeek/x.json#' is declared twice (first at '#/%24defs/a/%24id'); give one of them another name at #/%24defs/b/%24id");
  });

  for (const [label, $defs, first, second] of [
    ['two $anchors', { a: { $anchor: 'n' }, b: { $anchor: 'n' } }, '#/%24defs/a/%24anchor', '#/%24defs/b/%24anchor'],
    ['two $dynamicAnchors', { a: { $dynamicAnchor: 'n' }, b: { $dynamicAnchor: 'n' } }, '#/%24defs/a/%24dynamicAnchor', '#/%24defs/b/%24dynamicAnchor'],
    ['an $anchor and a $dynamicAnchor', { a: { $anchor: 'n' }, b: { $dynamicAnchor: 'n' } }, '#/%24defs/a/%24anchor', '#/%24defs/b/%24dynamicAnchor'],
  ]) {
    it(label, () => {
      assert.equal(refusal(() => new JarenValidator().compile({ $schema: D20, $defs })),
        `JK0012: '${ORIGIN}#n' is declared twice (first at '${first}'); give one of them another name at ${second}`);
    });
  }

  it('an $id equal to the document\'s, and an $id equal to an anchor\'s URI', () => {
    assert.equal(refusal(() => new JarenValidator().compile({ $id: 'https://r.test/a.json', $defs: { a: { $id: 'https://r.test/a.json' } } })),
      "JK0012: 'https://r.test/a.json#' is declared twice (first at '#/%24id'); give one of them another name at #/%24defs/a/%24id");
    assert.equal(refusal(() => new JarenValidator().compile({ $schema: D20, $id: 'https://r.test/a.json', $defs: { a: { $anchor: 'n' }, b: { $id: 'https://r.test/a.json#n' } } })),
      "JK0012: 'https://r.test/a.json#n' is declared twice (first at '#/%24defs/a/%24anchor'); give one of them another name at #/%24defs/b/%24id");
  });

  it('names the first place that declared it, when one object declares it twice', () => {
    assert.equal(refusal(() => new JarenValidator().compile({ $schema: D20, $defs: { a: { $anchor: 'n', $dynamicAnchor: 'n' }, b: { $anchor: 'n' } } })),
      `JK0012: '${ORIGIN}#n' is declared twice (first at '#/%24defs/a/%24anchor'); give one of them another name at #/%24defs/b/%24anchor`);
  });

  it('an identifier a held schema already has', () => {
    const validator = new JarenValidator();
    validator.addSchema({ $id: 'https://a.test/x.json', type: 'number' });
    assert.equal(refusal(() => validator.compile({ $defs: { a: { $id: 'https://a.test/x.json', type: 'string' } } })),
      "JK0012: $id declares 'https://a.test/x.json#', which names another schema the validator holds; give one of them another name at #/%24defs/a/%24id");
    assert.equal(refusal(() => validator.compile({ $id: 'https://a.test/x.json', type: 'string' })),
      "JK0012: $id declares 'https://a.test/x.json#', which names another schema the validator holds; give one of them another name at #/%24id");
  });

  it('the schemas a compile is given', () => {
    assert.equal(refusal(() => new JarenValidator().compile({ $ref: 'https://a.test/x.json' }, [{ $id: 'https://a.test/x.json' }, { $id: 'https://a.test/x.json' }])),
      "JK0012: $id declares 'https://a.test/x.json#', which names another schema the validator holds; give one of them another name at #/%24id");
    assert.equal(refusal(() => new JarenValidator().compile({ type: 'string' }, [{ type: 'number' }, { type: 'boolean' }])),
      `JK0012: the document has no $id, and the URI it is read under, '${ORIGIN}#', names another schema the validator holds; give it an $id of its own`);
  });

  it('compileAsync refuses a schema that declares one twice', async () => {
    await assert.rejects(compileAsync(new JarenValidator(), { $defs: { a: { $id: 'x.json' }, b: { $id: 'x.json' } } },
      { loadSchema: async () => true }), {
      code: 'JK0012',
      message: "JK0012: 'https://github.com/jklarenbeek/x.json#' is declared twice (first at '#/%24defs/a/%24id'); give one of them another name at #/%24defs/b/%24id",
    });
  });
});

describe('what answered before still answers', () => {
  it('addSchema keeps the first place and answers by it', () => {
    const validator = new JarenValidator();
    validator.addSchema({ $id: 'https://d.test/r.json', $defs: { a: { $id: 'x.json', type: 'string' }, b: { $id: 'x.json', type: 'number' }, c: { $id: 'c.json', type: 'boolean' } } });
    assert.deepEqual(answers(validator.compile({ $ref: 'https://d.test/x.json' }), ['s', 1]), [true, false]);
    assert.deepEqual(answers(validator.compile({ $ref: 'https://d.test/c.json' }), [true, 1]), [true, false]);
  });

  it('a document compileAsync loads keeps the first place, as addSchema does', async () => {
    const asked = [];
    const validate = await compileAsync(new JarenValidator(), { $ref: 'https://l.test/d.json' }, {
      loadSchema: async (uri) => {
        asked.push(uri);
        return { $schema: D20, $id: 'https://l.test/d.json', $defs: { a: { $id: 'y.json', type: 'string' }, b: { $id: 'y.json', type: 'number' } }, $ref: 'y.json' };
      },
    });
    assert.deepEqual(asked, ['https://l.test/d.json']);
    assert.deepEqual(answers(validate, ['s', 1]), [true, false]);
  });

  it('a URI only a held document\'s reference names is no collision', () => {
    const validator = new JarenValidator();
    validator.addSchema({ $id: 'https://z.test/a', $ref: ORIGIN });
    assert.deepEqual(answers(validator.compile({ type: 'string' }), [1, 's']), [false, true]);
  });

  it('one object reached at two places is one identifier', () => {
    const shared = { $id: 'x.json', type: 'string' };
    assert.deepEqual(answers(new JarenValidator().compile({ $defs: { a: shared, b: shared }, $ref: 'x.json' }), ['s', 1]), [true, false]);
  });

  it('two documents may use one anchor name', () => {
    const validator = new JarenValidator();
    validator.addSchema({ $schema: D20, $id: 'https://a.test/one.json', $defs: { a: { $anchor: 'n', type: 'string' } } });
    validator.addSchema({ $schema: D20, $id: 'https://a.test/two.json', $defs: { a: { $anchor: 'n', type: 'number' } } });
    assert.deepEqual(answers(validator.compile({ $ref: 'https://a.test/one.json#n' }), ['s', 1]), [true, false]);
    assert.deepEqual(answers(validator.compile({ $ref: 'https://a.test/two.json#n' }), ['s', 1]), [false, true]);
  });

  it('an anchor and a $dynamicAnchor of one name on one schema object', () => {
    const validate = new JarenValidator().compile({ $schema: D20, $defs: { a: { $anchor: 'n', $dynamicAnchor: 'n', type: 'string' } }, $ref: '#n' });
    assert.deepEqual(answers(validate, ['s', 1]), [true, false]);
  });
});

describe('where anchors are not allowed, an anchor declares nothing', () => {
  const traverse = new TraverseOptions(undefined, true, false, false);
  const compile = (schema) => new JarenValidator({ traverse }).compile(schema);

  it('an $anchor or a $dynamicAnchor below the root', () => {
    assert.deepEqual(answers(compile({ $schema: D20, $defs: { a: { $anchor: 'n', type: 'string' } } }), [1]), [true]);
    assert.deepEqual(answers(compile({ $schema: D20, $defs: { a: { $dynamicAnchor: 'n', type: 'string' } } }), [1]), [true]);
    assert.deepEqual(answers(compile({ $schema: D20, $defs: { a: { $anchor: 'n', type: 'string' } }, $ref: '#/$defs/a' }), [1, 's']), [false, true]);
  });

  it('an $anchor at the root', () => {
    assert.deepEqual(answers(compile({ $schema: D20, $anchor: 'n', type: 'string' }), [1, 's']), [false, true]);
  });
});
