//@ts-check
/**
 * @file The draft-04 `id` and a plain name's spelling, read alike by the
 * validator, `compileNormalizer` and `deriveStrictProfile`: `id` identifies a
 * schema object only where its document declares no draft this package knows
 * (none, or a `$schema` naming another dialect such as draft-04); under a
 * declared draft-06 or later it is no keyword. A plain name is matched as the
 * URI spells it, and one spelled as a JSON Pointer names nothing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { compileNormalizer, collectSameDocumentAnchors } from '@jarenjs/validate/normalize';
import { deriveStrictProfile } from '@jarenjs/validate/strict-profile';

const D04 = 'http://json-schema.org/draft-04/schema#';
const D06 = 'http://json-schema.org/draft-06/schema#';
const D07 = 'http://json-schema.org/draft-07/schema#';
const D19 = 'https://json-schema.org/draft/2019-09/schema';
const D20 = 'https://json-schema.org/draft/2020-12/schema';
const BASE = 'https://github.com/jklarenbeek/jarenjs';

/** @param {() => unknown} fn */
const code = (fn) => {
  try { fn(); return 'ok'; }
  catch (e) { return /** @type {any} */ (e).code; }
};
/** @param {any} schema @param {unknown[]} values */
const verdicts = (schema, values) => {
  const validate = new JarenValidator().compile(schema);
  return values.map((value) => validate(value));
};
/** @param {any} schema @param {unknown} value */
const normalized = (schema, value) => compileNormalizer(schema, { coerceTypes: true })(value);
/**
 * The strict profile's reading of `y`: the `$defs` member its reference
 * names, or the refusal's code.
 * @param {any} schema
 */
const strictTarget = (schema) => {
  try {
    const profile = /** @type {any} */ (deriveStrictProfile({ type: 'object', ...schema }).schema);
    return profile.properties.y.anyOf[0].$ref;
  }
  catch (e) { return /** @type {any} */ (e).code; }
};
/** @param {string|undefined} draft @param {any} schema */
const declaring = (draft, schema) => (draft === undefined ? schema : { $schema: draft, ...schema });

describe('a draft-04 id under a declared draft-06 or later names nothing', () => {
  const named = (/** @type {string} */ draft) => declaring(draft, { definitions: { a: { id: '#foo', type: 'integer' } }, properties: { y: { $ref: '#foo' } } });

  it('the entry input: a $ref that only the id reaches is refused, naming the id and the repair', () => {
    for (const [draft, repair] of [[D06, "$id: '#foo'"], [D07, "$id: '#foo'"], [D19, "$anchor: 'foo'"], [D20, "$anchor: 'foo'"]]) {
      assert.throws(() => new JarenValidator().compile(named(draft)), {
        code: 'JK0009',
        docPath: '#/properties/y/%24ref',
        reason: `Can not resolve schema for '${BASE}#foo': it is named only by id at '#/definitions/a/id', which from draft-06 on is no keyword and names nothing; spell it ${repair}`,
      }, draft);
      // the normalizer and the strict profile do not reach it either
      assert.deepEqual(normalized(named(draft), { y: '1' }), { y: '1' }, draft);
      assert.equal(strictTarget(named(draft)), 'JK0104', draft);
      assert.equal(collectSameDocumentAnchors(named(draft)).size, 0, draft);
    }
  });

  it('an id with a path sets no base: a relative $ref below it resolves against the document', () => {
    for (const draft of [D06, D07, D19, D20]) {
      const schema = { $schema: draft, $id: 'http://example.com/root.json', definitions: { x: { type: 'integer' } }, properties: { y: { id: 'thing', properties: { z: { $ref: '#/definitions/x' } } } } };
      assert.deepEqual(verdicts(schema, [{ y: { z: 1 } }, { y: { z: '1' } }]), [true, false], draft);
      assert.deepEqual(normalized(schema, { y: { z: '1' } }), { y: { z: 1 } }, draft);
    }
  });

  it('an absolute id names no document', () => {
    const schema = { $schema: D07, definitions: { a: { id: 'http://example.com/other.json', type: 'integer' } }, properties: { y: { $ref: 'http://example.com/other.json' } } };
    assert.throws(() => new JarenValidator().compile(schema), {
      code: 'JK0009',
      reason: "Can not resolve schema for 'http://example.com/other.json#': it is named only by id at '#/definitions/a/id', which from draft-06 on is no keyword and names nothing; spell it $id: 'http://example.com/other.json'",
    });
    assert.equal(strictTarget(schema), 'JK0104');
  });

  it('a registered document under a declared draft is read the same', () => {
    const validator = new JarenValidator();
    validator.addSchema({ $schema: D07, $id: 'https://h.test/d.json', definitions: { a: { id: '#foo', type: 'integer' } } });
    assert.throws(() => validator.compile({ $ref: 'https://h.test/d.json#foo' }), {
      code: 'JK0009',
      reason: "Can not resolve schema for 'https://h.test/d.json#foo': it is named only by id at '#/definitions/a/id', which from draft-06 on is no keyword and names nothing; spell it $id: '#foo'",
    });
  });

  it('a pointer passing an id sets no base: a loop through it is still refused when the schema compiles', () => {
    const schema = { $schema: D07, allOf: [{ $ref: '#/definitions/a/allOf/0' }], definitions: { a: { id: 'http://example.com/a.json', allOf: [{ $ref: '#' }] } } };
    assert.equal(code(() => new JarenValidator().compile(schema)), 'JK0001');
  });

    it('$id spells it: the same schemas with $id answer under every draft', () => {
    for (const draft of [D06, D07, D19, D20]) {
      const schema = { $schema: draft, definitions: { a: { $id: '#foo', type: 'integer' } }, properties: { y: { $ref: '#foo' } } };
      assert.deepEqual(verdicts(schema, [{ y: 1 }, { y: '1' }]), [true, false], draft);
      assert.deepEqual(normalized(schema, { y: '1' }), { y: 1 }, draft);
    }
  });
});

describe('a draft-04 id where no known draft is declared identifies its schema', () => {
  it('a plain name: every tool reaches it', () => {
    for (const draft of [undefined, D04, 'https://example.com/unknown-dialect']) {
      const schema = declaring(draft, { definitions: { a: { id: '#foo', type: 'integer' } }, properties: { y: { $ref: '#foo' } } });
      assert.deepEqual(verdicts(schema, [{ y: 1 }, { y: '1' }]), [true, false], String(draft));
      assert.deepEqual(normalized(schema, { y: '1' }), { y: 1 }, String(draft));
      assert.equal(strictTarget(schema), '#/$defs/a', String(draft));
    }
  });

  it('an absolute id names a document the validator and the strict profile reach, with no note for it', () => {
    for (const draft of [undefined, D04]) {
      const schema = declaring(draft, { definitions: { a: { id: 'http://example.com/other.json', type: 'integer' } }, properties: { y: { $ref: 'http://example.com/other.json' } } });
      assert.deepEqual(verdicts(schema, [{ y: 1 }, { y: '1' }]), [true, false], String(draft));
      assert.deepEqual(/** @type {any} */ (deriveStrictProfile({ type: 'object', ...schema }).schema).$defs, { other: { type: 'integer' } }, String(draft));
    }
  });

  it('an id with a path is the base below it, as $id is, also where a pointer passes through it', () => {
    /** @param {string} keyword @param {string|undefined} draft */
    const nested = (keyword, draft) => declaring(draft, {
      definitions: { c: { type: 'string' }, a: { [keyword]: 'http://example.com/a.json', definitions: { b: { properties: { z: { $ref: '#/definitions/c' } } }, c: { type: 'integer' } } } },
      properties: { y: { $ref: '#/definitions/a/definitions/b' } },
    });
    for (const draft of [undefined, D04])
      for (const keyword of ['$id', 'id']) {
        assert.deepEqual(verdicts(nested(keyword, draft), [{ y: { z: 1 } }, { y: { z: 's' } }]), [true, false], `${keyword} ${draft}`);
        const validator = new JarenValidator();
        validator.addSchema(nested(keyword, draft), 'https://h.test/n.json');
        const validate = validator.compile({ $ref: 'https://h.test/n.json#/definitions/a/definitions/b' });
        assert.deepEqual([validate({ z: 1 }), validate({ z: 's' })], [true, false], `registered ${keyword} ${draft}`);
      }
  });

  it('an id with a path is the base below it where an applicator enters it, and for the loop check', () => {
    for (const draft of [undefined, D04])
      for (const keyword of ['$id', 'id']) {
        const entered = declaring(draft, {
          definitions: { c: { type: 'string' } },
          properties: { y: { [keyword]: 'http://example.com/a.json', definitions: { c: { type: 'integer' } }, properties: { z: { $ref: '#/definitions/c' } } } },
        });
        assert.deepEqual(verdicts(entered, [{ y: { z: 1 } }, { y: { z: 's' } }]), [true, false], `${keyword} ${draft}`);
        // the root's `x` leads back to the root, the embedded one's does not: no loop
        const looping = declaring(draft, {
          allOf: [{ [keyword]: 'http://example.com/a.json', allOf: [{ $ref: '#/definitions/x' }], definitions: { x: { type: 'integer' } } }],
          definitions: { x: { allOf: [{ $ref: '#' }] } },
        });
        assert.deepEqual(verdicts(looping, [1, 's']), [true, false], `loop ${keyword} ${draft}`);
        // and where a pointer passes through it
        const passing = declaring(draft, {
          allOf: [{ $ref: '#/definitions/a/allOf/0' }],
          definitions: {
            x: { allOf: [{ $ref: '#' }] },
            a: { [keyword]: 'http://example.com/a.json', allOf: [{ $ref: '#/definitions/x' }], definitions: { x: { type: 'integer' } } },
          },
        });
        assert.deepEqual(verdicts(passing, [1, 's']), [true, false], `pointer ${keyword} ${draft}`);
        // a refusal below it is located in the resource it names
        assert.throws(() => new JarenValidator().compile(declaring(draft, { properties: { y: { [keyword]: 'http://example.com/a.json', minLength: -1 } } })),
          { code: 'JK0013', docPath: 'http://example.com/a.json#/minLength' }, `located ${keyword} ${draft}`);
      }
  });

    it('a draft-04 document a validator holds keeps every compile answering', () => {
    // the JSON-Schema-Test-Suite's remote, registered with every draft's run
    const validator = new JarenValidator();
    validator.addSchema({ definitions: { refToInteger: { $ref: '#foo' }, A: { id: '#foo', type: 'integer' } } }, 'http://localhost:1234/locationIndependentIdentifierDraft4.json');
    assert.equal(validator.compile({ type: 'string' })(1), false);
    const validate = validator.compile({ $schema: D20, $ref: 'http://localhost:1234/locationIndependentIdentifierDraft4.json#/definitions/refToInteger' });
    assert.deepEqual([validate(1), validate('1')], [true, false]);
  });

  it('an id inside an enum or a const is instance data', () => {
    const schema = { $schema: D04, definitions: { e: { enum: [{ id: '#foo' }] }, c: { const: { id: '#bar' } } }, properties: { y: { $ref: '#foo' } } };
    assert.equal(code(() => new JarenValidator().compile(schema)), 'JK0009');
    assert.equal(collectSameDocumentAnchors(schema).size, 0);
  });
});

describe('a plain name is matched as the URI spells it, by every tool', () => {
  /** @param {string} anchor @param {string} ref */
  const named = (anchor, ref) => ({ $schema: D20, $defs: { a: { $anchor: anchor, type: 'integer' } }, properties: { y: { $ref: ref } } });

  it('the entry input: an $anchor spelled with a percent-encoding', () => {
    for (const [anchor, ref] of [['a%20b', '#a%20b'], ['a b', '#a%20b'], ['a%20b', '#a b'], ['é', '#%C3%A9']]) {
      assert.deepEqual(verdicts(named(anchor, ref), [{ y: 1 }, { y: '1' }]), [true, false], `${anchor} ${ref}`);
      assert.deepEqual(normalized(named(anchor, ref), { y: '1' }), { y: 1 }, `${anchor} ${ref}`);
      assert.equal(strictTarget(named(anchor, ref)), '#/$defs/a', `${anchor} ${ref}`);
    }
  });

  it('a percent-encoding of a letter is not the letter', () => {
    for (const [anchor, ref] of [['A', '#%41'], ['%41', '#A']]) {
      assert.equal(code(() => new JarenValidator().compile(named(anchor, ref))), 'JK0009', `${anchor} ${ref}`);
      assert.deepEqual(normalized(named(anchor, ref), { y: '1' }), { y: '1' }, `${anchor} ${ref}`);
      assert.equal(strictTarget(named(anchor, ref)), 'JK0104', `${anchor} ${ref}`);
    }
  });

  it('a fragment-only $id is spelled the same way', () => {
    const schema = { $schema: D07, definitions: { a: { $id: '#a%20b', type: 'integer' } }, properties: { y: { $ref: '#a b' } } };
    assert.deepEqual(verdicts(schema, [{ y: 1 }, { y: '1' }]), [true, false]);
    assert.deepEqual(normalized(schema, { y: '1' }), { y: 1 });
  });
});

describe('an anchor spelled as a JSON Pointer names nothing', () => {
  it('a reference to the place the pointer names reaches that place', () => {
    const schema = { $schema: D20, $defs: { a: { $anchor: '/$defs/b', type: 'integer' }, b: { type: 'boolean' } }, properties: { y: { $ref: '#/$defs/b' } } };
    assert.deepEqual(verdicts(schema, [{ y: true }, { y: 1 }]), [true, false]);
    assert.deepEqual(normalized(schema, { y: 'true' }), { y: true });
    assert.equal(strictTarget(schema), '#/$defs/b');
    assert.equal(collectSameDocumentAnchors(schema).size, 0);
  });

  it('a pointer that names no place is refused, naming the anchor and the repair', () => {
    for (const keyword of ['$anchor', '$dynamicAnchor']) {
      const schema = { $schema: D20, $defs: { a: { [keyword]: '/foo', type: 'integer' } }, properties: { y: { $ref: '#/foo' } } };
      assert.throws(() => new JarenValidator().compile(schema), {
        code: 'JK0009',
        reason: `Can not resolve schema for '${BASE}#/foo': '#/foo' is a JSON Pointer, and the ${keyword} '/foo' at '#/%24defs/a/${encodeURIComponent(keyword)}' spelled like it names nothing; give the anchor a plain name (a letter or '_', then letters, digits, '-', '.', '_')`,
      }, keyword);
      assert.deepEqual(normalized(schema, { y: '1' }), { y: '1' }, keyword);
      assert.equal(strictTarget(schema), 'JK0104', keyword);
    }
  });
});

describe('a $dynamicAnchor is a plain name a $ref reaches, in every tool', () => {
  it('the normalizer and the strict profile read it as the validator does', () => {
    const schema = { $schema: D20, $defs: { a: { $dynamicAnchor: 'x', type: 'integer' } }, properties: { y: { $ref: '#x' } } };
    assert.deepEqual(verdicts(schema, [{ y: 1 }, { y: '1' }]), [true, false]);
    assert.deepEqual(normalized(schema, { y: '1' }), { y: 1 });
    assert.equal(strictTarget(schema), '#/$defs/a');
  });
});
