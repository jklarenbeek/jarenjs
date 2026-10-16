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

// A registered document (addSchema, or a document compileAsync loads) that
// declares one identifier at two different places, or two registered
// documents that declare one nested identifier, answered by the place
// registered first. The compile that reads such an identifier is refused
// `JK0012`, naming both places; every other compile answers.
describe('JK0012: a registered identifier two places declare', () => {
  const R = () => ({ $id: 'https://d.test/r.json', $defs: {
    a: { $id: 'x.json', type: 'string' }, b: { $id: 'x.json', type: 'number' }, c: { $id: 'c.json', type: 'boolean' } } });
  const held = (...documents) => {
    const validator = new JarenValidator();
    for (const document of documents) validator.addSchema(document);
    return validator;
  };
  const within = (id, document, first, second) => `JK0012: '${id}' names two schemas (in '${document}', at '${first}' and at '${second}'), and this compile reads it, which would answer by the one registered first; give one of them another name`;
  const across = (id, one, two) => `JK0012: '${id}' names two schemas (one registered under '${one}', one under '${two}'), and this compile reads it, which would answer by the one registered first; give one of them another name`;
  const X = within('https://d.test/x.json#', 'https://d.test/r.json', '#/%24defs/a/%24id', '#/%24defs/b/%24id');

  it('a compile that reads it by its URI is refused (was the first place\'s answer: \'s\' true, 1 false)', () => {
    assert.equal(refusal(() => held(R()).compile({ $ref: 'https://d.test/x.json' })), X);
  });

  it('a chain of references that passes it is refused when it compiles', () => {
    const validator = held(R(), { $id: 'https://d.test/y.json', $ref: 'x.json' });
    assert.equal(refusal(() => validator.compile({ $ref: 'https://d.test/y.json' })), X);
  });

  it('an item reference to it is refused (the item fast path)', () => {
    assert.equal(refusal(() => held(R()).compile({ items: { $ref: 'https://d.test/x.json' } })), X);
  });

  it('a registered document\'s item reference to it is refused by the call that reaches it (was [1] false, by the first place)', () => {
    const validate = held(R(), { $id: 'https://d.test/it.json', items: { $ref: 'https://d.test/x.json' } }).compile({ $ref: 'https://d.test/it.json' });
    assert.deepEqual([['s'], [1]].map((instance) => refusal(() => validate(instance))), [X, X]);
  });

  it('a chain of references that passes an anchor two places declare is refused when it compiles', () => {
    const validator = held({ $id: 'https://d.test/an.json', $defs: { a: { $anchor: 'n', type: 'string' }, b: { $anchor: 'n', type: 'number' } } },
      { $id: 'https://d.test/z.json', $ref: 'an.json#n' });
    assert.equal(refusal(() => validator.compile({ $ref: 'https://d.test/z.json' })),
      within('https://d.test/an.json#n', 'https://d.test/an.json', '#/%24defs/a/%24anchor', '#/%24defs/b/%24anchor'));
  });

  it('a pointer read through it is refused', () => {
    assert.equal(refusal(() => held(R()).compile({ $ref: 'https://d.test/x.json#/type' })), X);
  });

  it('a registered document whose own $ref reads it is refused by the call that reaches it (was { p: 1 } false, by the first place)', () => {
    const validate = held({ $id: 'https://d.test/p.json', $defs: { a: { $id: 'x.json', type: 'string' }, b: { $id: 'x.json', type: 'number' } }, properties: { p: { $ref: 'x.json' } } })
      .compile({ $ref: 'https://d.test/p.json' });
    const message = within('https://d.test/x.json#', 'https://d.test/p.json', '#/%24defs/a/%24id', '#/%24defs/b/%24id');
    assert.deepEqual([{ p: 's' }, { p: 1 }].map((instance) => refusal(() => validate(instance))), [message, message]);
  });

  it('the second place\'s own reference read against it is refused by the call that reaches it (was false for { k: 1 }, true for { k: \'s\' })', () => {
    const validate = held({ $schema: D20, $id: 'https://d.test/r.json', $defs: {
      a: { $id: 'x.json', $defs: { n: { type: 'string' } } },
      b: { $id: 'x.json', $defs: { n: { type: 'number' } }, properties: { k: { $ref: '#/$defs/n' } } } } })
      .compile({ $ref: 'https://d.test/r.json#/$defs/b' });
    const message = within('https://d.test/x.json#', 'https://d.test/r.json', '#/%24defs/a/%24id', '#/%24defs/b/%24id');
    assert.deepEqual([{ k: 1 }, { k: 's' }].map((instance) => refusal(() => validate(instance))), [message, message]);
  });

  it('a $recursiveRef read against it is refused by the call that reaches it (was false for { k: {} })', () => {
    const validate = held({ $schema: 'https://json-schema.org/draft/2019-09/schema', $id: 'https://d.test/q.json', $defs: {
      a: { $id: 'x.json', $recursiveAnchor: true, type: 'string' },
      b: { $id: 'x.json', type: 'object', properties: { k: { $recursiveRef: '#' } } } } })
      .compile({ $ref: 'https://d.test/q.json#/$defs/b' });
    assert.equal(refusal(() => validate({ k: {} })),
      within('https://d.test/x.json#', 'https://d.test/q.json', '#/%24defs/a/%24id', '#/%24defs/b/%24id'));
  });

  it('a $recursiveRef read against it under a dynamic scope is refused by the call that reaches it (was the first place\'s $recursiveAnchor deciding)', () => {
    const validate = held({ $schema: 'https://json-schema.org/draft/2019-09/schema', $id: 'https://d.test/q.json', $defs: {
      a: { $id: 'x.json', $recursiveAnchor: true, type: 'string' },
      b: { $id: 'x.json', type: 'object', properties: { k: { $recursiveRef: '#' } } } } })
      .compile({ $schema: 'https://json-schema.org/draft/2019-09/schema', $recursiveAnchor: true, type: 'object', properties: { r: { $ref: 'https://d.test/q.json#/$defs/b' } } });
    assert.equal(refusal(() => validate({ r: { k: {} } })),
      within('https://d.test/x.json#', 'https://d.test/q.json', '#/%24defs/a/%24id', '#/%24defs/b/%24id'));
  });

  it('an anchor the document root and a nested place declare is refused (was the root\'s answer)', () => {
    const validator = held({ $id: 'https://d.test/ra.json', $anchor: 'n', type: 'string', $defs: { b: { $anchor: 'n', type: 'number' } } });
    assert.equal(refusal(() => validator.compile({ $ref: 'https://d.test/ra.json#n' })),
      within('https://d.test/ra.json#n', 'https://d.test/ra.json', '#/%24anchor', '#/%24defs/b/%24anchor'));
  });

  it('a $dynamicRef to a $dynamicAnchor two places declare is refused (was the first place\'s answer)', () => {
    const validator = held({ $schema: D20, $id: 'https://d.test/y.json', $defs: { a: { $dynamicAnchor: 'q', type: 'string' }, b: { $dynamicAnchor: 'q', type: 'number' } } });
    assert.equal(refusal(() => validator.compile({ $schema: D20, $dynamicRef: 'https://d.test/y.json#q' })),
      within('https://d.test/y.json#q', 'https://d.test/y.json', '#/%24defs/a/%24dynamicAnchor', '#/%24defs/b/%24dynamicAnchor'));
  });

  it('two registered documents that declare one nested $id: a compile that reads it is refused (was the first registered\'s answer)', () => {
    const validator = held({ $id: 'https://d.test/one.json', $defs: { a: { $id: 'x.json', type: 'string' } } },
      { $id: 'https://d.test/two.json', $defs: { a: { $id: 'x.json', type: 'number' } } });
    assert.equal(refusal(() => validator.compile({ $ref: 'https://d.test/x.json' })),
      across('https://d.test/x.json#', 'https://d.test/one.json', 'https://d.test/two.json'));
    // each document answers by its own place
    assert.deepEqual(answers(validator.compile({ $ref: 'https://d.test/one.json#/$defs/a' }), ['s', 1]), [true, false]);
    assert.deepEqual(answers(validator.compile({ $ref: 'https://d.test/two.json#/$defs/a' }), ['s', 1]), [false, true]);
  });

  it('a document registered again under its $id with a nested place changed: a compile that reads it is refused (was the stale place\'s answer)', () => {
    const validator = held({ $id: 'https://d.test/v.json', $defs: { a: { $id: 'x.json', type: 'string' } } },
      { $id: 'https://d.test/v.json', $defs: { a: { $id: 'x.json', type: 'number' } } });
    assert.equal(refusal(() => validator.compile({ $ref: 'https://d.test/x.json' })),
      across('https://d.test/x.json#', 'https://d.test/v.json', 'https://d.test/v.json'));
    assert.deepEqual(answers(validator.compile({ $ref: 'https://d.test/v.json#/$defs/a' }), ['s', 1]), [false, true]);
  });

  it('places that differ in a member named like an annotation are two schemas: refused', () => {
    const validator = held({ $id: 'https://d.test/m2.json', $defs: {
      a: { $id: 'x.json', properties: { title: { type: 'string' } } }, b: { $id: 'x.json', properties: { title: { type: 'number' } } } } });
    assert.equal(refusal(() => validator.compile({ $ref: 'https://d.test/x.json' })),
      within('https://d.test/x.json#', 'https://d.test/m2.json', '#/%24defs/a/%24id', '#/%24defs/b/%24id'));
  });

  it('places that differ in a default, a format or an annotation beside an assertion are two schemas: refused', () => {
    for (const [a, b] of [
      [{ type: 'string', default: 'a' }, { type: 'string', default: 'b' }],
      [{ type: 'string', format: 'email' }, { type: 'string', format: 'uri' }],
      [{ type: 'string', title: 't' }, { type: 'number', title: 't' }]]) {
      const validator = held({ $id: 'https://d.test/d2.json', $defs: { a: { $id: 'x.json', ...a }, b: { $id: 'x.json', ...b } } });
      assert.equal(refusal(() => validator.compile({ $ref: 'https://d.test/x.json' })),
        within('https://d.test/x.json#', 'https://d.test/d2.json', '#/%24defs/a/%24id', '#/%24defs/b/%24id'));
    }
  });

  it('equal places read under two drafts are two schemas: refused', () => {
    const one = (draft, name) => ({ $schema: draft, $id: `https://d.test/${name}.json`, $defs: { a: { $id: 'x.json', prefixItems: [{ type: 'string' }] } } });
    const validator = held(one('http://json-schema.org/draft-07/schema#', 'o7'), one(D20, 'o20'));
    assert.equal(refusal(() => validator.compile({ $ref: 'https://d.test/x.json' })),
      across('https://d.test/x.json#', 'https://d.test/o7.json', 'https://d.test/o20.json'));
  });

  it('a document compileAsync loads is refused when its compile reads it (was the first place\'s answer)', async () => {
    const asked = [];
    await assert.rejects(compileAsync(new JarenValidator(), { $ref: 'https://l.test/d.json' }, {
      loadSchema: async (uri) => {
        asked.push(uri);
        return { $schema: D20, $id: 'https://l.test/d.json', $defs: { a: { $id: 'y.json', type: 'string' }, b: { $id: 'y.json', type: 'number' } }, $ref: 'y.json' };
      },
    }), { code: 'JK0012', message: within('https://l.test/y.json#', 'https://l.test/d.json', '#/%24defs/a/%24id', '#/%24defs/b/%24id') });
    assert.deepEqual(asked, ['https://l.test/d.json']);
  });

  const throughIt = () => held({ $schema: D20, $id: 'https://d.test/r.json', $defs: {
    a: { $id: 'x.json', type: 'object', properties: { k: { type: 'string' } } }, b: { $id: 'x.json', type: 'number' } } },
  { $id: 'https://d.test/m.json', properties: { q: { $ref: 'https://d.test/x.json#/properties/k' } } });

  it('a registered document holding a reference through it is refused by the call that reaches it (was the first place\'s answer)', () => {
    const message = within('https://d.test/x.json#', 'https://d.test/r.json', '#/%24defs/a/%24id', '#/%24defs/b/%24id');
    const validate = throughIt().compile({ $ref: 'https://d.test/m.json' });
    assert.deepEqual([{ q: 's' }, { q: 1 }].map((instance) => refusal(() => validate(instance))), [message, message]);
  });

  describe('every other compile answers, as before', () => {
    it('an identifier the document declares once', () => {
      assert.deepEqual(answers(held(R()).compile({ $ref: 'https://d.test/c.json' }), [true, 1]), [true, false]);
    });
    it('each place, read by a pointer', () => {
      assert.deepEqual(answers(held(R()).compile({ $ref: 'https://d.test/r.json#/$defs/a' }), ['s', 1]), [true, false]);
      assert.deepEqual(answers(held(R()).compile({ $ref: 'https://d.test/r.json#/$defs/b' }), ['s', 1]), [false, true]);
    });
    it('both places, read by pointers in one compile, in either order', () => {
      for (const [p, q] of [['p', 'q'], ['q', 'p']]) {
        const validate = held(R()).compile({ properties: {
          [p]: { $ref: `https://d.test/r.json#/$defs/${p === 'p' ? 'a' : 'b'}` },
          [q]: { $ref: `https://d.test/r.json#/$defs/${q === 'p' ? 'a' : 'b'}` } } });
        assert.deepEqual(answers(validate, [{ p: 's', q: 1 }, { p: 's', q: 's' }, { p: 1, q: 1 }]), [true, false, false]);
      }
    });
    it('the place held under it reads it against itself, by $ref, $recursiveRef and $dynamicRef', () => {
      const document = () => ({ $schema: D20, $id: 'https://d.test/r.json', $defs: {
        a: { $id: 'x.json', $defs: { n: { type: 'string' } }, properties: { k: { $ref: '#/$defs/n' }, d: { $dynamicRef: '#/$defs/n' } } },
        b: { $id: 'x.json', type: 'number' } } });
      assert.deepEqual(answers(held(document()).compile({ $ref: 'https://d.test/r.json#/$defs/a' }), [{ k: 's', d: 's' }, { k: 1 }, { d: 1 }]), [true, false, false]);
      const recursive = { $schema: 'https://json-schema.org/draft/2019-09/schema', $id: 'https://d.test/q.json', $defs: {
        a: { $id: 'x.json', type: 'object', properties: { k: { $recursiveRef: '#' } } }, b: { $id: 'x.json', type: 'number' } } };
      assert.deepEqual(answers(held(recursive).compile({ $ref: 'https://d.test/q.json#/$defs/a' }), [{ k: {} }, { k: 1 }]), [true, false]);
    });
    it('the whole document', () => {
      assert.deepEqual(answers(held(R()).compile({ $ref: 'https://d.test/r.json' }), ['s', 1]), [true, true]);
    });
    it('a compile that reads no registered schema', () => {
      assert.deepEqual(answers(held(R()).compile({ type: 'string' }), ['s', 1]), [true, false]);
    });
    it('a compile that reads none while another registered document holds a reference through it', () => {
      assert.deepEqual(answers(throughIt().compile({ type: 'string' }), ['s', 1]), [true, false]);
    });
    it('one document object registered twice', () => {
      const document = { $id: 'https://d.test/f.json', $defs: { a: { $id: 'x.json', type: 'string' } } };
      assert.deepEqual(answers(held(document, document).compile({ $ref: 'https://d.test/x.json' }), ['s', 1]), [true, false]);
    });
    it('an equal copy registered again', () => {
      const document = () => ({ $id: 'https://d.test/f.json', $defs: { a: { $id: 'x.json', type: 'string' } } });
      assert.deepEqual(answers(held(document(), document()).compile({ $ref: 'https://d.test/x.json' }), ['s', 1]), [true, false]);
    });
    it('two places that differ only in annotations answer alike, so they answer (title, description, $comment, examples, deprecated, readOnly, writeOnly, nested too)', () => {
      const validator = held({ $id: 'https://d.test/an2.json', $defs: {
        a: { $id: 'x.json', type: 'object', title: 'one', description: 'one', properties: { title: { type: 'string', examples: ['a'] } } },
        b: { $id: 'x.json', type: 'object', $comment: 'two', deprecated: true, readOnly: true, writeOnly: false, properties: { title: { type: 'string', description: 'member' } } } } });
      assert.deepEqual(answers(validator.compile({ $ref: 'https://d.test/x.json' }), [{ title: 's' }, { title: 1 }]), [true, false]);
    });
    it('two equal places in one document', () => {
      const validator = held({ $id: 'https://d.test/e.json', $defs: { a: { $id: 'x.json', type: 'string' }, b: { $id: 'x.json', type: 'string' } } });
      assert.deepEqual(answers(validator.compile({ $ref: 'https://d.test/x.json' }), ['s', 1]), [true, false]);
    });
    it('a nested place that declares its document\'s identifier: the registered document answers', () => {
      const validator = held({ $id: 'https://d.test/self.json', type: 'object', $defs: { a: { $id: 'https://d.test/self.json', type: 'string' } } });
      assert.deepEqual(answers(validator.compile({ $ref: 'https://d.test/self.json' }), [{}, 's']), [true, false]);
    });
    it('a nested place in another document that declares a registered document\'s identifier: the registered document answers, in either order', () => {
      const one = { $id: 'https://d.test/one.json', type: 'string' };
      const two = { $id: 'https://d.test/two.json', $defs: { a: { $id: 'one.json', type: 'number' } } };
      assert.deepEqual(answers(held(one, two).compile({ $ref: 'https://d.test/one.json' }), ['s', 1]), [true, false]);
      assert.deepEqual(answers(held(two, one).compile({ $ref: 'https://d.test/one.json' }), ['s', 1]), [true, false]);
    });
    it('a registration refused (a loop of references) contests nothing', () => {
      const validator = held({ $id: 'https://d.test/one.json', $defs: { a: { $id: 'x.json', type: 'string' } } });
      assert.throws(() => validator.addSchema({ $id: 'https://d.test/two.json', $defs: { a: { $id: 'x.json', type: 'number' },
        r1: { $anchor: 'r1', $ref: '#r2' }, r2: { $anchor: 'r2', $ref: '#r1' } } }), { code: 'JK0001' });
      assert.deepEqual(answers(validator.compile({ $ref: 'https://d.test/x.json' }), ['s', 1]), [true, false]);
    });
    it('addSchema refuses nothing', () => {
      assert.doesNotThrow(() => held(R(), { $id: 'https://d.test/two.json', $defs: { a: { $id: 'x.json', type: 'null' } } }));
    });
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
