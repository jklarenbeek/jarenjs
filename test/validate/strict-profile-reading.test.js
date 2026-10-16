//@ts-check
// A strict profile reads the schema as the original's validator reads it:
// the keywords beside a `$ref` per the declared draft, a reference to a
// boolean schema as that schema, an `$id` refused as the validator refuses
// it; and it never offers a value the original refuses for every answer —
// an enum or const of containers, a member a closed base never admits —
// nor tells the model an annotation is enforced.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { JarenValidator, SchemaCompileError } from '@jarenjs/validate';
import { deriveStrictProfile } from '@jarenjs/validate/strict-profile';

const D07 = 'http://json-schema.org/draft-07/schema#';
const D19 = 'https://json-schema.org/draft/2019-09/schema';
const D20 = 'https://json-schema.org/draft/2020-12/schema';
const textNote = (/** @type {string} */ what) => `(strict profile: write this ${what} as JSON text, a string such as "{\\"a\\": 1}"; the original schema enforces it)`;

/** @param {any} schema */
const original = (schema) => new JarenValidator().compile(schema);
/** @param {any} profile */
const profiled = (profile) => new JarenValidator().compile({ $schema: D20, ...profile });
/** The refusal a call throws, as `[code, docPath, message]`. @param {() => unknown} fn */
const refusal = (fn) => {
  try { fn(); }
  catch (error) {
    return [error instanceof SchemaCompileError ? error.code : `uncoded ${error}`, error.docPath, error.message];
  }
  return ['no throw', undefined, undefined];
};

describe('the keywords beside a $ref are read per the declared draft', () => {
  /** @param {string|undefined} draft */
  const schema = (draft) => ({ ...(draft === undefined ? {} : { $schema: draft }), type: 'object', required: ['a'],
    properties: { a: { $ref: '#/definitions/n', type: 'string' } }, definitions: { n: { type: 'integer' } } });

  for (const [label, draft] of [['a document that declares no draft', undefined], ['draft-07', D07]]) {
    it(`${label}: the $ref alone, as the original reads it`, () => {
      const strict = deriveStrictProfile(schema(draft));
      assert.deepEqual(strict.schema, { type: 'object', properties: { a: { $ref: '#/$defs/n' } }, required: ['a'], additionalProperties: false,
        $defs: { n: { type: 'integer' } } });
      const check = original(schema(draft));
      assert.deepEqual([check({ a: 5 }), check({ a: 'x' })], [true, false]);
      assert.equal(check(strict.fromProfile({ a: 5 })), true);
    });
  }

  it('2019-09 and 2020-12: the siblings apply, as before (the $ref restated)', () => {
    for (const draft of [D19, D20]) {
      assert.deepEqual(deriveStrictProfile(schema(draft)).schema.properties.a,
        { type: 'string', description: '(strict profile: $ref "#/definitions/n" is relaxed here; the original schema enforces it)' });
    }
  });

  it('a description beside a $ref read alone still documents the node', () => {
    const strict = deriveStrictProfile({ $schema: D07, type: 'object', required: ['a'], definitions: { n: { type: 'integer' } },
      properties: { a: { $ref: '#/definitions/n', description: 'the count', minimum: 3, default: 1 } } });
    assert.deepEqual(strict.schema.properties.a, { $ref: '#/$defs/n', description: 'the count' });
  });

  it('draft-07: an object type beside a $ref is not refused, since the original reads the $ref alone', () => {
    const strict = deriveStrictProfile({ $schema: D07, type: 'object', required: ['a'], definitions: { n: { type: 'integer' } },
      properties: { a: { type: 'object', $ref: '#/definitions/n' } } });
    assert.deepEqual(strict.schema.properties.a, { $ref: '#/$defs/n' });
  });

  it('a member a branch narrows keeps the draft of the place it comes from', () => {
    /** @param {string|undefined} draft */
    const member = (draft) => deriveStrictProfile({ ...(draft === undefined ? {} : { $schema: draft }), type: 'object', required: ['a'],
      properties: { a: { $ref: '#/$defs/s', maxLength: 5 } }, allOf: [{ properties: { a: { minLength: 2 } } }], $defs: { s: { type: 'string' } } })
      .schema.properties.a;
    assert.deepEqual(member(D20), { $ref: '#/$defs/s', description: '(strict profile: minLength 2 is relaxed here; the original schema enforces it) '
      + '(strict profile: maxLength 5 is relaxed here; the original schema enforces it)' });
    assert.deepEqual(member(undefined), { $ref: '#/$defs/s', description: '(strict profile: minLength 2 is relaxed here; the original schema enforces it)' });
  });

  it('draft-07: an $id beside a $ref sets no base, so the $ref resolves in the document', () => {
    const s = { $schema: D07, type: 'object', required: ['a'], properties: { a: { $id: 'http://x.test/y', $ref: '#/definitions/n' } },
      definitions: { n: { type: 'integer' } } };
    assert.deepEqual([original(s)({ a: 1 }), original(s)({ a: 'x' })], [true, false]);
    assert.deepEqual(deriveStrictProfile(s).schema.properties.a, { $ref: '#/$defs/n' });
  });

  it('draft-07: an $id that names only a fragment starts no resource of its own', () => {
    const s = { $schema: D07, type: 'object', required: ['x'], properties: { x: { $ref: '#/definitions/b' } },
      definitions: { a: { $id: '#foo', type: 'string' }, b: { type: 'integer' } } };
    assert.deepEqual(deriveStrictProfile(s).schema.properties.x, { $ref: '#/$defs/b' });
  });
});

describe('an enum or const that lists an object or an array is carried as JSON text', () => {
  for (const [label, member, value, values] of /** @type {[string, any, unknown, string][]} */ ([
    ['an object const', { type: 'object', const: { k: 1 } }, { k: 1 }, 'const {"k":1}'],
    ['an object enum', { type: 'object', enum: [{ k: 1 }, { k: 2 }] }, { k: 2 }, 'enum [{"k":1},{"k":2}]'],
    ['an array enum', { type: 'array', enum: [[1, 2]] }, [1, 2], 'enum [[1,2]]'],
  ])) {
    it(`${label}: the values restated, the value kept both ways`, () => {
      const s = { $schema: D20, type: 'object', required: ['o'], properties: { o: member } };
      const strict = deriveStrictProfile(s);
      const what = member.type;
      assert.deepEqual(strict.schema.properties.o, { type: 'string',
        description: `${textNote(what)} (strict profile: ${values} is relaxed here; the original schema enforces it)` });
      const filled = strict.toProfile({ o: value });
      assert.deepEqual(filled, { o: JSON.stringify(value) });
      assert.equal(profiled(strict.schema)(filled), true);
      assert.deepEqual(strict.fromProfile(filled), { o: value });
      assert.equal(original(s)(strict.fromProfile(filled)), true);
    });
  }
});

describe('an $id that is no URI reference is refused JK0010, as the validator refuses it', () => {
  const message = '$id \'http://[x\' is not a valid URI reference; correct it, percent-encoding any character a URI does not allow';
  for (const [label, schema, at] of /** @type {[string, any, string][]} */ ([
    ['at the root', { $id: 'http://[x', type: 'object', properties: { a: { type: 'string' } } }, '#/%24id'],
    ['on a member', { type: 'object', properties: { a: { $id: 'http://[x', type: 'string' } } }, '#/properties/a/%24id'],
    ['draft-07, beside a $ref', { $schema: D07, type: 'object', properties: { a: { $id: 'http://[x', $ref: '#/definitions/n' } }, definitions: { n: {} } }, '#/properties/a/%24id'],
  ])) {
    it(label, () => {
      const expected = ['JK0010', at, `JK0010: ${message} at ${at}`];
      assert.deepEqual(refusal(() => deriveStrictProfile(schema)), expected);
      assert.deepEqual(refusal(() => original(schema)), expected, 'the validator\'s own answer');
    });
  }
});

describe('a member the base\'s additionalProperties false refuses is never offered', () => {
  const base = { $schema: D20, type: 'object', required: ['a'], properties: { a: { type: 'string' } }, additionalProperties: false };

  it('an allOf branch\'s optional member leaves the object', () => {
    const s = { ...base, allOf: [{ properties: { b: { type: 'string' } } }] };
    const strict = deriveStrictProfile(s);
    assert.deepEqual(strict.schema, { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } }, required: ['a'] });
    assert.deepEqual([original(s)({ a: 'x' }), original(s)({ a: 'x', b: 'y' })], [true, false]);
    assert.equal(profiled(strict.schema)({ a: 'x', b: 'y' }), false);
  });

  it('an allOf branch that requires one leaves the object no value: JK0108', () => {
    const s = { ...base, allOf: [{ properties: { b: { type: 'string' } }, required: ['b'] }] };
    assert.equal(original(s)({ a: 'x', b: 'y' }), false);
    assert.deepEqual(refusal(() => deriveStrictProfile(s)).slice(0, 2), ['JK0108', '#/additionalProperties']);
  });

  it('an anyOf branch that requires one accepts no value and is dropped', () => {
    const s = { ...base, anyOf: [{ properties: { b: { type: 'string' } }, required: ['b'] }, { properties: { a: { minLength: 2 } } }] };
    // a root that is a union is carried as the one member value
    assert.deepEqual(deriveStrictProfile(s).schema.properties.value, { anyOf: [{ type: 'object', additionalProperties: false, properties: { a: { type: 'string',
      description: '(strict profile: minLength 2 is relaxed here; the original schema enforces it)' } }, required: ['a'] }] });
  });

  it('unevaluatedProperties false sees the branch members, which stay', () => {
    const s = { $schema: D20, type: 'object', required: ['a'], properties: { a: { type: 'string' } }, unevaluatedProperties: false,
      allOf: [{ properties: { b: { type: 'string' } } }] };
    assert.equal(original(s)({ a: 'x', b: 'y' }), true);
    assert.deepEqual(Object.keys(deriveStrictProfile(s).schema.properties), ['a', 'b']);
  });
});

describe('a $ref to a boolean schema reads as that schema', () => {
  it('true: a value of any shape, carried as JSON text', () => {
    const s = { $schema: D20, type: 'object', required: ['a'], properties: { a: { $ref: '#/$defs/any' } }, $defs: { any: true } };
    const strict = deriveStrictProfile(s);
    assert.deepEqual(strict.schema, { type: 'object', properties: { a: { type: 'string', description: textNote('value') } }, required: ['a'], additionalProperties: false });
    assert.deepEqual(strict.fromProfile(strict.toProfile({ a: { x: [1] } })), { a: { x: [1] } });
  });

  it('false, as a member: one the closed object leaves out, as a member declared false', () => {
    const s = { $schema: D20, type: 'object', required: ['b'], properties: { a: { $ref: '#/$defs/no' }, b: { type: 'string' } }, $defs: { no: false } };
    assert.deepEqual([original(s)({ b: 'x' }), original(s)({ a: 1, b: 'x' })], [true, false]);
    assert.deepEqual(deriveStrictProfile(s).schema, { type: 'object', properties: { b: { type: 'string' } }, required: ['b'], additionalProperties: false });
  });

  it('false, anywhere else: JK0108 at the place, as the schema false there', () => {
    const s = { $schema: D20, type: 'object', properties: { a: { anyOf: [{ $ref: '#/$defs/no' }, { type: 'string' }] } }, $defs: { no: false } };
    assert.deepEqual(refusal(() => deriveStrictProfile(s)).slice(0, 2), ['JK0108', '#/properties/a/anyOf/0']);
  });
});

describe('a profile note restates only what the original enforces', () => {
  it('annotations, errorMessage and x- keywords are dropped without a note; a constraint keeps its note', () => {
    const s = { $schema: D20, type: 'object', required: ['lang', 'n'], properties: {
      lang: { type: 'string', default: 'en', examples: ['nl'], 'x-ui': 'select', deprecated: true, readOnly: true, writeOnly: false,
        errorMessage: 'pick a language' },
      n: { type: 'integer', minimum: 1, default: 2 } } };
    assert.equal(original(s)({ lang: 'de', n: 1 }), true, 'the original enforces neither the default nor the examples');
    assert.deepEqual(deriveStrictProfile(s).schema.properties, {
      lang: { type: 'string' },
      n: { type: 'integer', description: '(strict profile: minimum 1 is relaxed here; the original schema enforces it)' },
    });
  });

  it('the same in a JSON-text carrier', () => {
    const strict = deriveStrictProfile({ $schema: D20, type: 'object', required: ['v'], properties: { v: { default: 1, examples: [2], 'x-a': 1, minimum: 0 } } });
    assert.deepEqual(strict.schema.properties.v, { type: 'string', description: `${textNote('value')} (strict profile: minimum 0 is relaxed here; the original schema enforces it)` });
  });
});

describe('bundled $defs names stay distinct when their provider-safe spellings meet', () => {
  it('"a b", "a_b", "a_b_2" and letters outside ASCII each keep a name of their own', () => {
    const keys = ['a b', 'a_b', 'a_b_2', 'ä', 'ö', '_'];
    const s = { $schema: D20, type: 'object', required: keys.map((_, i) => `x${i}`),
      properties: Object.fromEntries(keys.map((key, i) => [`x${i}`, { $ref: `#/$defs/${encodeURIComponent(key)}` }])),
      $defs: Object.fromEntries(keys.map((key) => [key, { type: 'object', required: [key], properties: { [key]: { type: 'string' } } }])) };
    const strict = deriveStrictProfile(s);
    assert.deepEqual(Object.keys(strict.schema.$defs), ['a_b', 'a_b_2', 'a_b_2_2', '_', '__2', '__3']);
    // each member still names its own target
    keys.forEach((key, i) => assert.deepEqual(Object.keys(strict.schema.$defs[strict.schema.properties[`x${i}`].$ref.slice('#/$defs/'.length)].properties), [key]));
  });
});

describe('a root $ref beside definitions derives, as the validator compiles it', () => {
  const d = { type: 'object', properties: { a: { type: 'string' } } };
  const EXPECTED = {
    type: 'object', properties: { value: { $ref: '#/$defs/d' } }, required: ['value'], additionalProperties: false,
    $defs: { d: { type: 'object', properties: { a: { type: ['string', 'null'] } }, required: ['a'], additionalProperties: false } },
  };

  it('derives the root $ref of an undeclared or draft-07 document, with $defs or definitions, and under a root $id', () => {
    for (const schema of [
      { $ref: '#/$defs/d', $defs: { d } }, { $ref: '#/definitions/d', definitions: { d } },
      { $schema: D07, $ref: '#/definitions/d', definitions: { d } },
      { $id: 'https://x.test/s.json', $ref: '#/$defs/d', $defs: { d } }, { $id: 's.json', $ref: '#/$defs/d', $defs: { d } },
      { $schema: D20, $ref: '#/$defs/d', $defs: { d } },
    ]) {
      const derived = deriveStrictProfile(schema);
      assert.deepEqual(derived.schema, EXPECTED, JSON.stringify(schema));
      const validate = original(schema), strict = profiled(derived.schema);
      assert.deepEqual([{ a: 'x' }, { a: 1 }].map((value) => [validate(value), strict(derived.toProfile(value))]), [[true, true], [false, false]]);
      assert.deepEqual(derived.fromProfile(derived.toProfile({ a: 'x' })), { a: 'x' });
    }
  });

  it('resolves a nested relative $id and an anchor under an absolute root $id', () => {
    const derived = deriveStrictProfile({ $id: 'https://x.test/a/s.json', type: 'object', properties: { a: { $ref: 'sub/n.json' }, b: { $ref: '#str' } },
      $defs: { n: { $id: 'sub/n.json', type: 'string' }, t: { $anchor: 'str', type: 'string' } } });
    assert.deepEqual(derived.schema, {
      type: 'object', properties: { a: { anyOf: [{ $ref: '#/$defs/n' }, { type: 'null' }] }, b: { anyOf: [{ $ref: '#/$defs/t' }, { type: 'null' }] } },
      required: ['a', 'b'], additionalProperties: false, $defs: { n: { type: 'string' }, t: { type: 'string' } },
    });
  });
});
