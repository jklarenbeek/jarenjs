//@ts-check
// A strict structured-output profile: one closed, self-contained document a
// provider's strict mode accepts, derived from a schema, with the two maps
// between the original's instances and the profile's. The original stays the
// authority: for every instance it accepts, `toProfile` gives one the profile
// accepts; for every answer the profile accepts, `fromProfile` gives one the
// original accepts or refuses with its own errors. A schema a closed profile
// would read wrong is refused with a code naming the place.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JarenValidator, SchemaCompileError, SchemaRuntimeError, VALIDATE_CODES } from '@jarenjs/validate';
import { deriveStrictProfile, relaxSchema } from '@jarenjs/validate/strict-profile';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const D20 = 'https://json-schema.org/draft/2020-12/schema';
const relaxedNote = (keyword, value) => `(strict profile: ${keyword} ${JSON.stringify(value)} is relaxed here; the original schema enforces it)`;

/** The original's own validator, as a host compiles it. @param {any} schema @param {object[]} [references] */
const original = (schema, references = []) => {
  const validator = new JarenValidator();
  for (const reference of references) validator.addSchema(reference);
  return validator.compile(schema);
};
/** A validator over the profile, read as the 2020-12 document it is. @param {any} profile */
const profiled = (profile) => new JarenValidator().compile({ $schema: D20, ...profile });

/** The refusal a derivation throws, as `[code, docPath]`. @param {() => unknown} fn */
const refusal = (fn) => {
  try { fn(); }
  catch (error) {
    return [error instanceof SchemaCompileError ? error.code : `uncoded ${error}`, error.docPath];
  }
  return ['no throw', undefined];
};

const patchSchema = {
  type: 'object',
  required: ['ops'],
  properties: { ops: { type: 'array', items: { $ref: '#/$defs/op' } } },
  $defs: {
    op: {
      type: 'object',
      required: ['op', 'path'],
      properties: {
        op: { enum: ['add', 'replace', 'remove'] },
        path: { type: 'string', pattern: '^/' },
        value: { type: 'string' },
      },
    },
  },
};

describe('deriveStrictProfile: the profile', () => {
  it('closes every object, requires every member and widens the optional ones to admit null', () => {
    assert.deepEqual(deriveStrictProfile(patchSchema).schema, {
      type: 'object',
      required: ['ops'],
      properties: { ops: { type: 'array', items: { $ref: '#/$defs/op' } } },
      additionalProperties: false,
      $defs: {
        op: {
          type: 'object',
          required: ['op', 'path', 'value'],
          properties: {
            op: { enum: ['add', 'replace', 'remove'] },
            path: { type: 'string', description: relaxedNote('pattern', '^/') },
            value: { type: ['string', 'null'] },
          },
          additionalProperties: false,
        },
      },
    });
  });

  it('restates every keyword outside the strict subset in the description, after the one it has', () => {
    const { schema } = deriveStrictProfile({ type: 'object', properties: {
      n: { type: 'integer', description: 'a count', minimum: 1, multipleOf: 2 },
      tags: { type: 'array', items: { type: 'string', format: 'email' }, uniqueItems: true, maxItems: 3 },
      s: { type: 'string', not: { const: 'x' } },
    }, required: ['n', 'tags', 's'] });
    assert.deepEqual(schema.properties, {
      n: { type: 'integer', description: `a count ${relaxedNote('minimum', 1)} ${relaxedNote('multipleOf', 2)}` },
      tags: { type: 'array', items: { type: 'string', description: relaxedNote('format', 'email') },
        description: `${relaxedNote('uniqueItems', true)} ${relaxedNote('maxItems', 3)}` },
      s: { type: 'string', description: '(strict profile: the not keyword is relaxed here; the original schema enforces it)' },
    });
  });

  it('turns oneOf into anyOf and an allOf of one branch into that branch', () => {
    const { schema } = deriveStrictProfile({ type: 'object', required: ['a', 'b'], properties: {
      a: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      b: { allOf: [{ $ref: '#/$defs/n' }], description: 'b' },
    }, $defs: { n: { type: 'number' } } });
    assert.deepEqual(schema.properties, {
      a: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
      b: { anyOf: [{ $ref: '#/$defs/n' }], description: 'b' },
    });
    assert.deepEqual(schema.$defs, { n: { type: 'number' } });
  });

  it('wraps a root that is not an object as the one member value, and unwraps it', () => {
    const strict = deriveStrictProfile({ type: 'string', minLength: 2 });
    assert.deepEqual(strict.schema, {
      type: 'object', properties: { value: { type: 'string', description: relaxedNote('minLength', 2) } },
      required: ['value'], additionalProperties: false,
    });
    assert.deepEqual(strict.toProfile('ab'), { value: 'ab' });
    assert.equal(strict.fromProfile({ value: 'ab' }), 'ab');
    assert.deepEqual(strict.fromProfile('not wrapped'), 'not wrapped', 'an answer the profile does not accept is returned as it reads');
  });

  it('closes an open object over its declared members: toProfile drops what it never declared', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true };
    const strict = deriveStrictProfile(schema);
    assert.deepEqual(strict.schema, { type: 'object', properties: { a: { type: ['string', 'null'] } }, additionalProperties: false, required: ['a'] });
    assert.deepEqual(strict.toProfile({ a: 'x', extra: 1 }), { a: 'x' });
    assert.deepEqual(strict.fromProfile({ a: null }), {});
  });

  it('closes an object closed by unevaluatedProperties: false, and leaves out a member declared false', () => {
    const { schema } = deriveStrictProfile({ type: 'object', required: ['a'], properties: { a: { type: 'string' }, gone: false }, unevaluatedProperties: false });
    assert.deepEqual(schema, { type: 'object', required: ['a'], properties: { a: { type: 'string' } }, additionalProperties: false });
  });

  it('keeps an object already closed with no members', () => {
    assert.deepEqual(deriveStrictProfile({ type: 'object', additionalProperties: false }).schema,
      { type: 'object', additionalProperties: false, properties: {}, required: [] });
  });
});

describe('deriveStrictProfile: a placeholder null and a null the original admits', () => {
  const schema = {
    type: 'object',
    required: ['required'],
    properties: {
      plain: { type: 'string' },
      nullable: { type: ['string', 'null'] },
      viaRef: { $ref: '#/$defs/maybe' },
      viaUnion: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      viaEnum: { enum: ['x', null] },
      constant: { const: 'k' },
      refusesNull: { type: ['string', 'null'], not: { type: 'null' } },
      required: { type: ['string', 'null'] },
    },
    $defs: { maybe: { type: ['integer', 'null'] } },
  };
  const strict = deriveStrictProfile(schema);

  it('widens only the members whose schema the original validator refuses null for', () => {
    assert.deepEqual(strict.schema.properties, {
      plain: { type: ['string', 'null'] },
      nullable: { type: ['string', 'null'] },
      viaRef: { $ref: '#/$defs/maybe' },
      viaUnion: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      viaEnum: { enum: ['x', null] },
      constant: { anyOf: [{ const: 'k' }, { type: 'null' }] },
      refusesNull: { type: ['string', 'null'], description: '(strict profile: the not keyword is relaxed here; the original schema enforces it)' },
      required: { type: ['string', 'null'] },
    });
  });

  it('removes the null of a widened member and keeps every null the original admits', () => {
    const answer = { plain: null, nullable: null, viaRef: null, viaUnion: null, viaEnum: null, constant: null, refusesNull: null, required: null };
    assert.equal(profiled(strict.schema)(answer), true);
    const restored = strict.fromProfile(answer);
    assert.deepEqual(restored, { nullable: null, viaRef: null, viaUnion: null, viaEnum: null, required: null });
    assert.equal(original(schema)(restored), true);
  });

  it('keeps a value that is not null, and round-trips an instance through both maps', () => {
    const instance = { plain: 'p', constant: 'k', required: 'r' };
    const filled = strict.toProfile(instance);
    assert.deepEqual(filled, { plain: 'p', nullable: null, viaRef: null, viaUnion: null, viaEnum: null, constant: 'k', refusesNull: null, required: 'r' });
    assert.equal(profiled(strict.schema)(filled), true);
    const back = strict.fromProfile(filled);
    assert.deepEqual(back, { plain: 'p', nullable: null, viaRef: null, viaUnion: null, viaEnum: null, constant: 'k', required: 'r' });
    assert.equal(original(schema)(back), true);
  });

  it('reads a union by the branch the answer matches, and keeps a null two matching branches disagree about', () => {
    const union = { type: 'object', required: ['shape'], properties: { shape: { anyOf: [
      { type: 'object', required: ['r'], properties: { r: { type: 'number' }, label: { type: 'string' } } },
      { type: 'object', required: ['w'], properties: { w: { type: 'number' }, label: { type: 'string' } } },
      { type: 'object', required: ['w'], properties: { w: { type: 'number' }, label: { type: ['string', 'null'] } } },
    ] } } };
    const strict = deriveStrictProfile(union);
    assert.deepEqual(strict.fromProfile({ shape: { r: 1, label: null } }), { shape: { r: 1 } });
    assert.deepEqual(strict.fromProfile({ shape: { w: 1, label: null } }), { shape: { w: 1, label: null } });
    assert.deepEqual(strict.fromProfile({ shape: { w: 1, label: 'x' } }), { shape: { w: 1, label: 'x' } });
    assert.deepEqual(strict.toProfile({ shape: { r: 2 } }), { shape: { r: 2, label: null } });
  });
});

describe('deriveStrictProfile: references are bundled into one document', () => {
  const item = {
    $id: 'https://x.test/item.json',
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' }, parts: { type: 'array', items: { $ref: '#' } }, size: { $ref: '#size' } },
    $defs: { size: { $anchor: 'size', enum: ['S', 'L'] } },
  };
  const schema = { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { $ref: 'https://x.test/item.json' } }, next: { $ref: '#' } } };

  it('rewrites each reference to the profile\'s $defs, keeping recursion', () => {
    const strict = deriveStrictProfile(schema, { references: [item] });
    assert.deepEqual(strict.schema, {
      type: 'object',
      required: ['items', 'next'],
      properties: { items: { type: 'array', items: { $ref: '#/$defs/item' } }, next: { anyOf: [{ $ref: '#' }, { type: 'null' }] } },
      additionalProperties: false,
      $defs: {
        item: {
          type: 'object',
          required: ['id', 'parts', 'size'],
          properties: {
            id: { type: 'string' },
            parts: { type: ['array', 'null'], items: { $ref: '#/$defs/item' } },
            size: { anyOf: [{ $ref: '#/$defs/size' }, { type: 'null' }] },
          },
          additionalProperties: false,
        },
        size: { enum: ['S', 'L'] },
      },
    });
    const instance = { items: [{ id: 'a', parts: [{ id: 'b', size: 'S' }] }], next: { items: [] } };
    assert.equal(original(schema, [item])(instance), true);
    const filled = strict.toProfile(instance);
    assert.equal(profiled(strict.schema)(filled), true);
    assert.deepEqual(strict.fromProfile(filled), instance);
  });

  it('refuses a reference to a document it was not given, naming the place', () => {
    assert.deepEqual(refusal(() => deriveStrictProfile(schema)), ['JK0104', '#/properties/items/items']);
  });

  it('resolves a reference inside an embedded $id against that resource, and asks its validator about null there', () => {
    const embedded = { type: 'object', required: ['e'], properties: { e: { $ref: 'https://e.test/x.json' } }, $defs: {
      x: { $id: 'https://e.test/x.json', type: 'object', properties: { a: { $ref: '#/$defs/n' }, b: { type: 'string' } }, $defs: { n: { type: ['integer', 'null'] } } },
    } };
    const strict = deriveStrictProfile(embedded);
    assert.deepEqual(strict.schema.$defs, {
      x: { type: 'object', properties: { a: { $ref: '#/$defs/n' }, b: { type: ['string', 'null'] } }, required: ['a', 'b'], additionalProperties: false },
      n: { type: ['integer', 'null'] },
    });
    assert.deepEqual(strict.fromProfile({ e: { a: null, b: null } }), { e: { a: null } });
  });

  it('names a place inside a reference by its $id', () => {
    const open = { $id: 'https://x.test/open.json', type: 'object', properties: { bag: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: { type: 'string' } } } };
    assert.deepEqual(refusal(() => deriveStrictProfile({ $ref: 'https://x.test/open.json' }, { references: [open] })),
      ['JK0102', 'https://x.test/open.json#/properties/bag']);
  });
});

const textNote = (/** @type {string} */ what) => `(strict profile: write this ${what} as JSON text, a string such as "{\\"a\\": 1}"; the original schema enforces it)`;
const entriesNote = '(strict profile: this object is written as an array of { key, value } entries, one per member, each key once; the original schema enforces it)';

describe('deriveStrictProfile: a value of any shape is carried as JSON text', () => {
  const schema = { type: 'object', required: ['id'], properties: {
    id: { type: 'string' },
    metadata: { type: 'object', description: 'free-form' },
    anything: {},
    list: { type: 'array' },
    pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] },
  } };
  const strict = deriveStrictProfile(schema);

  it('writes a free-form object, an untyped member, the items of an untyped array and a tuple as strings', () => {
    assert.deepEqual(strict.schema.properties, {
      id: { type: 'string' },
      metadata: { type: ['string', 'null'], description: `free-form ${textNote('object')}` },
      anything: { type: ['string', 'null'], description: textNote('value') },
      list: { type: ['array', 'null'], items: { type: 'string', description: textNote('value') } },
      pair: { type: ['string', 'null'], description: `${textNote('array')} (strict profile: the prefixItems keyword is relaxed here; the original schema enforces it)` },
    });
  });

  it('round-trips through the text', () => {
    const instance = { id: 'a', metadata: { k: [1] }, anything: 5, list: [1, 'x'], pair: ['a', 1] };
    const filled = strict.toProfile(instance);
    assert.deepEqual(filled, { id: 'a', metadata: '{"k":[1]}', anything: '5', list: ['1', '"x"'], pair: '["a",1]' });
    assert.equal(profiled(strict.schema)(filled), true);
    assert.deepEqual(strict.fromProfile(filled), instance);
  });

  it('refuses text that is not JSON with a code and the place, and leaves a decoded value to the original', () => {
    const answer = { id: 'a', metadata: '{oops', anything: null, list: null, pair: null };
    assert.equal(profiled(strict.schema)(answer), true, 'a string is what the profile asks for');
    assert.throws(() => strict.fromProfile(answer), (error) => error instanceof SchemaRuntimeError && error.code === 'JK2002' && error.dataPath === '/metadata');
    const decoded = strict.fromProfile({ ...answer, metadata: '[1]' });
    assert.deepEqual(decoded, { id: 'a', metadata: [1], anything: null });
    assert.equal(original(schema)(decoded), false, 'the original refuses an array where it declared an object');
  });

  it('boxes a carrier as { json } beside a union branch that also takes a string', () => {
    const union = { type: 'object', required: ['q'], properties: { q: { anyOf: [{ type: 'string' }, { type: 'object' }] } } };
    const strict = deriveStrictProfile(union);
    assert.deepEqual(strict.schema.properties.q, { anyOf: [{ type: 'string' },
      { type: 'object', properties: { json: { type: 'string', description: textNote('object') } }, required: ['json'], additionalProperties: false }] });
    assert.deepEqual(strict.toProfile({ q: { $sum: '$.b' } }), { q: { json: '{"$sum":"$.b"}' } });
    assert.deepEqual(strict.fromProfile({ q: { json: '{"$sum":"$.b"}' } }), { q: { $sum: '$.b' } });
    assert.deepEqual(strict.fromProfile({ q: '{"$sum":"$.b"}' }), { q: '{"$sum":"$.b"}' }, 'a string is the string branch');
  });

  it('still compiles the original, so a reference only a carrier holds is refused when the profile is derived', () => {
    assert.deepEqual(refusal(() => deriveStrictProfile({ type: 'object', required: ['a'], properties: { a: { items: { $ref: 'https://nowhere.test/x.json' } } } })),
      ['JK0009', undefined]);
  });

  it('carries the schema true as the wrapped value', () => {
    const strict = deriveStrictProfile(true);
    assert.deepEqual(strict.schema, { type: 'object', properties: { value: { type: 'string', description: textNote('value') } }, required: ['value'], additionalProperties: false });
    assert.deepEqual(strict.fromProfile(strict.toProfile({ a: 1 })), { a: 1 });
  });

  it('widens a carrier whose original admits null, keeping the null', () => {
    const schema = { type: 'object', required: ['n'], properties: { n: { type: 'integer' }, extra: { anyOf: [{ $ref: '#/$defs/any' }, { type: 'number' }] } }, $defs: { any: {} } };
    const strict = deriveStrictProfile(schema);
    assert.equal(profiled(strict.schema)(strict.toProfile({ n: 1 })), true);
    assert.deepEqual(strict.fromProfile(strict.toProfile({ n: 1 })), { n: 1, extra: null });
  });
});

describe('deriveStrictProfile: a map is carried as { key, value } entries', () => {
  const schema = { type: 'object', required: ['tags'], properties: {
    tags: { type: 'object', patternProperties: { '^x-': { type: 'string' } }, additionalProperties: false },
    counts: { type: 'object', additionalProperties: { type: 'integer' } },
  } };
  const strict = deriveStrictProfile(schema);

  it('derives an entries array whose value is the map\'s value schema', () => {
    const entry = (/** @type {string} */ keyNote, /** @type {object} */ value) => ({ type: 'object', properties: { key: { type: 'string', description: keyNote }, value },
      required: ['key', 'value'], additionalProperties: false });
    assert.deepEqual(strict.schema.properties, {
      tags: { type: 'array', items: entry('(strict profile: a member name; a name matching "^x-" takes that pattern\'s value schema, and every name matches one; the original schema enforces it)', { type: 'string' }), description: entriesNote },
      counts: { type: ['array', 'null'], items: entry('(strict profile: a member name)', { type: 'integer' }), description: entriesNote },
    });
  });

  it('round-trips an object through its entries', () => {
    const instance = { tags: { 'x-a': 'A' }, counts: { a: 1, b: 2 } };
    const filled = strict.toProfile(instance);
    assert.deepEqual(filled, { tags: [{ key: 'x-a', value: 'A' }], counts: [{ key: 'a', value: 1 }, { key: 'b', value: 2 }] });
    assert.equal(profiled(strict.schema)(filled), true);
    assert.deepEqual(strict.fromProfile(filled), instance);
  });

  it('refuses entries that name one key twice, with a code and the place', () => {
    assert.throws(() => strict.fromProfile({ tags: [{ key: 'x-a', value: 'A' }, { key: 'x-a', value: 'B' }], counts: null }),
      (error) => error instanceof SchemaRuntimeError && error.code === 'JK2003' && error.dataPath === '/tags/1');
  });

  it('leaves a name the pattern refuses to the original', () => {
    const decoded = strict.fromProfile({ tags: [{ key: 'other', value: 'A' }], counts: null });
    assert.deepEqual(decoded, { tags: { other: 'A' } });
    assert.equal(original(schema)(decoded), false);
  });
});

describe('deriveStrictProfile: an object beside allOf or anyOf is distributed into its branches', () => {
  it('folds allOf branches that only narrow into the object', () => {
    const schema = { type: 'object', required: ['from'], properties: { from: { type: 'string' }, event: { type: ['string', 'null'] }, after: { type: 'number' } },
      additionalProperties: false, allOf: [{ not: { required: ['event', 'after'] } }] };
    const strict = deriveStrictProfile(schema);
    assert.deepEqual(strict.schema, { type: 'object', additionalProperties: false, description: '(strict profile: the not keyword is relaxed here; the original schema enforces it)',
      properties: { from: { type: 'string' }, event: { type: ['string', 'null'] }, after: { type: ['number', 'null'] } }, required: ['from', 'event', 'after'] });
    // event admits null, so its null is kept, unless the original then
    // refuses the answer and accepts the member absent
    assert.deepEqual(strict.fromProfile({ from: 'a', event: null, after: 1 }), { from: 'a', after: 1 });
    assert.deepEqual(strict.fromProfile({ from: 'a', event: null, after: null }), { from: 'a', event: null });
  });

  it('distributes the object into each anyOf branch of required alternatives', () => {
    const schema = { type: 'object', properties: { path: { type: 'string' }, schema: { type: 'object', properties: { t: { type: 'string' } } } },
      anyOf: [{ required: ['path'] }, { required: ['schema'] }], additionalProperties: false };
    const strict = deriveStrictProfile(schema);
    const branches = strict.schema.properties.value.anyOf;
    assert.deepEqual(branches.map((/** @type {any} */ branch) => [branch.required, branch.properties.path.type, branch.properties.schema.type]),
      [[['path', 'schema'], 'string', ['object', 'null']], [['path', 'schema'], ['string', 'null'], 'object']]);
    assert.deepEqual(strict.fromProfile({ value: { path: '$', schema: null } }), { path: '$' });
    assert.deepEqual(strict.fromProfile({ value: { path: null, schema: { t: 'x' } } }), { schema: { t: 'x' } });
  });

  it('narrows a member an enum or const branch discriminates to the values the object\'s schema accepts', () => {
    const schema = { type: 'object', required: ['kind'], properties: { kind: { type: 'string' } },
      oneOf: [{ properties: { kind: { const: 'circle' }, r: { type: 'number' } }, required: ['r'] }, { properties: { kind: { enum: ['square', 2] }, side: { type: 'number' } }, required: ['side'] }] };
    assert.deepEqual(deriveStrictProfile(schema).schema.properties.value.anyOf, [
      { type: 'object', properties: { kind: { enum: ['circle'] }, r: { type: 'number' } }, required: ['kind', 'r'], additionalProperties: false },
      { type: 'object', properties: { kind: { enum: ['square'] }, side: { type: 'number' } }, required: ['kind', 'side'], additionalProperties: false },
    ]);
  });

  it('leaves out of a closed branch the object\'s members it does not declare, and drops a branch that would need one', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } },
      anyOf: [{ properties: { a: { type: 'string' } }, additionalProperties: false }, { required: ['b'] }, { required: ['b'], properties: { a: true }, additionalProperties: false }] };
    assert.deepEqual(deriveStrictProfile(schema).schema.properties.value.anyOf, [
      { type: 'object', properties: { a: { type: ['string', 'null'] } }, required: ['a'], additionalProperties: false },
      { type: 'object', properties: { a: { type: ['string', 'null'] }, b: { type: 'string' } }, required: ['a', 'b'], additionalProperties: false },
    ]);
  });

  it('keeps a closed branch to its own members', () => {
    const schema = { type: 'object', anyOf: [{ required: ['member'], properties: { member: { type: 'string' } }, additionalProperties: false },
      { required: ['value'], properties: { value: { type: 'number' } }, additionalProperties: false }] };
    assert.deepEqual(deriveStrictProfile(schema).schema.properties.value.anyOf, [
      { type: 'object', properties: { member: { type: 'string' } }, required: ['member'], additionalProperties: false },
      { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false },
    ]);
  });
});

describe('deriveStrictProfile: a schema a closed profile would read wrong is refused with a code', () => {
  for (const [label, schema, expected] of [
    ['patternProperties beside declared properties', { type: 'object', properties: { a: { type: 'string' } }, patternProperties: { '^x': { type: 'string' } } }, ['JK0102', '#']],
    ['a map that may also be an array', { type: 'object', properties: { m: { type: ['object', 'array'], additionalProperties: { type: 'string' }, items: { type: 'string' } } } }, ['JK0102', '#/properties/m']],
    ['a schema-valued unevaluatedProperties', { type: 'object', properties: { a: { type: 'string' } }, unevaluatedProperties: { type: 'string' } }, ['JK0102', '#/unevaluatedProperties']],
    ['an allOf branch that gives a member a schema of its own', { type: 'object', properties: { a: { type: 'string' } }, allOf: [{ properties: { a: { type: 'integer' } } }] }, ['JK0103', '#/allOf/0/properties/a']],
    ['a branch beside an object type that is not members', { type: 'object', properties: { a: { type: 'string' } }, anyOf: [{ $ref: '#/$defs/x' }], $defs: { x: { type: 'object', properties: {} } } }, ['JK0103', '#/anyOf/0/%24ref']],
    ['an if beside an object type', { type: 'object', properties: { a: { type: 'string' } }, if: { required: ['a'] } }, ['JK0103', '#/if']],
    ['an untyped allOf of two branches', { allOf: [{ type: 'string' }, { minLength: 1 }] }, ['JK0103', '#/allOf']],
    ['a $ref beside properties', { type: 'object', properties: { a: { $ref: '#/$defs/n', properties: {} } }, $defs: { n: { type: 'number' } } }, ['JK0103', '#/properties/a/properties']],
    ['a $dynamicRef', { type: 'object', properties: { a: { $dynamicRef: '#node' } } }, ['JK0104', '#/properties/a/%24dynamicRef']],
    ['a pointer that misses', { type: 'object', properties: { a: { $ref: '#/$defs/none' } } }, ['JK0104', '#/properties/a']],
    ['oneOf beside anyOf', { type: 'object', properties: { a: { oneOf: [{ type: 'string' }], anyOf: [{ type: 'integer' }] } } }, ['JK0105', '#/properties/a']],
    ['a required member it does not declare', { type: 'object', required: ['id'], properties: { name: { type: 'string' } } }, ['JK0106', '#/required']],
    ['a draft-07 dependencies schema beside an object type', { type: 'object', properties: { a: { type: 'string' } }, dependencies: { a: { properties: { b: { type: 'string' } }, required: ['b'] } } }, ['JK0103', '#/dependencies']],
    ['dependentRequired naming a member it does not declare', { type: 'object', properties: { a: { type: 'string' } }, dependentRequired: { a: ['b'] } }, ['JK0106', '#/dependentRequired']],
    ['a draft-07 dependencies list naming a member it does not declare', { type: 'object', properties: { a: { type: 'string' } }, dependencies: { a: ['b'] } }, ['JK0106', '#/dependencies']],
    ['the schema false', false, ['JK0108', '#']],
    ['items false', { type: 'object', properties: { t: { type: 'array', items: false } } }, ['JK0108', '#/properties/t/items']],
    ['an anyOf branch false', { type: 'object', properties: { a: { anyOf: [false, { type: 'string' }] } } }, ['JK0108', '#/properties/a/anyOf/0']],
  ]) {
    it(`${label} → ${expected[0]}`, () => {
      assert.deepEqual(refusal(() => deriveStrictProfile(/** @type {any} */ (schema))), expected);
    });
  }

  it('refuses an argument it does not take', () => {
    assert.deepEqual(refusal(() => deriveStrictProfile(/** @type {any} */ ('x'))), ['JK0107', undefined]);
    assert.deepEqual(refusal(() => deriveStrictProfile({ type: 'string' }, /** @type {any} */ ({ references: {} }))), ['JK0107', undefined]);
    assert.deepEqual(refusal(() => deriveStrictProfile({ type: 'string' }, { references: [{ type: 'string' }] })), ['JK0107', undefined]);
  });

  it('every code is in the code table', () => {
    for (const code of ['JK0101', 'JK0102', 'JK0103', 'JK0104', 'JK0105', 'JK0106', 'JK0107', 'JK0108', 'JK2002', 'JK2003'])
      assert.equal(typeof VALIDATE_CODES[code], 'string', code);
  });

  it('relaxes a dependency between declared members, and one whose trigger a closed object never holds', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } },
      dependentRequired: { a: ['b'] }, dependencies: { gone: ['missing'] } };
    const strict = deriveStrictProfile(schema);
    assert.deepEqual(strict.schema, { type: 'object', properties: { a: { type: ['string', 'null'] }, b: { type: ['string', 'null'] } },
      additionalProperties: false, required: ['a', 'b'],
      description: '(strict profile: the dependentRequired keyword is relaxed here; the original schema enforces it) (strict profile: the dependencies keyword is relaxed here; the original schema enforces it)' });
    assert.deepEqual(strict.fromProfile({ a: 'x', b: null }), { a: 'x' }, 'the original then refuses it with its own error');
    assert.equal(original(schema)(strict.fromProfile({ a: 'x', b: 'y' })), true);
  });

  it('relaxes, rather than refuses, what applies only beside a shape that is not an object', () => {
    const { schema } = deriveStrictProfile({ type: 'object', required: ['s'], properties: {
      s: { type: 'string', allOf: [{ minLength: 1 }], anyOf: [{ format: 'email' }, { format: 'uri' }] },
    } });
    assert.deepEqual(schema.properties.s, { type: 'string',
      description: '(strict profile: the allOf keyword is relaxed here; the original schema enforces it) (strict profile: the anyOf keyword is relaxed here; the original schema enforces it)' });
  });
});

describe('relaxSchema', () => {
  const note = (keyword) => `(no ${keyword})`;

  it('rewrites schema positions only: a member named like a keyword and data stay as written', () => {
    const schema = { type: 'object', properties: { format: { type: 'string', format: 'date' }, oneOf: { type: 'integer' } }, enum: [{ format: 'kept' }], default: { oneOf: 1 } };
    assert.deepEqual(relaxSchema(schema, { keywords: ['format'], note }), {
      type: 'object', properties: { format: { type: 'string', description: '(no format)' }, oneOf: { type: 'integer' } },
      enum: [{ format: 'kept' }], default: { oneOf: 1 },
    });
  });

  it('turns oneOf into anyOf in place, and refuses a node with both', () => {
    assert.deepEqual(relaxSchema({ oneOf: [{ type: 'string', format: 'x' }], title: 't' }, { keywords: ['format'], note }),
      { anyOf: [{ type: 'string', description: '(no format)' }], title: 't' });
    assert.deepEqual(refusal(() => relaxSchema({ items: { oneOf: [], anyOf: [] } }, { keywords: [], note })), ['JK0105', '#/items']);
  });

  it('refuses an argument it does not take', () => {
    assert.deepEqual(refusal(() => relaxSchema({}, /** @type {any} */ ({ keywords: 'format', note }))), ['JK0107', undefined]);
    assert.deepEqual(refusal(() => relaxSchema({}, /** @type {any} */ ({ keywords: [] }))), ['JK0107', undefined]);
  });
});

describe('the correctness contract over the JSON-Schema-Test-Suite (draft 2020-12)', () => {
  const groups = JSON.parse(fs.readFileSync(new URL('fixtures/strict-profile/draft2020-12-accepted.json', import.meta.url), 'utf8'));

  it('holds for every group the transform accepts', () => {
    const counts = { groups: 0, forward: 0, accepted: 0, restoredValid: 0, restoredRefused: 0, roundTrip: 0 };
    for (const group of groups) {
      const strict = deriveStrictProfile(group.schema);
      const check = original(group.schema);
      const profile = profiled(strict.schema);
      counts.groups++;
      for (const test of group.tests) {
        const where = `${group.file} / ${group.description} / ${test.description}`;
        const filled = strict.toProfile(test.data);
        if (check(test.data) === true) {
          counts.forward++;
          assert.equal(profile(filled), true, `the profile accepts toProfile(an instance the original accepts): ${where}`);
          const back = strict.fromProfile(filled);
          assert.equal(check(back), true, `round trip: ${where}`);
          if (JSON.stringify(back) === JSON.stringify(test.data)) counts.roundTrip++;
        }
        for (const answer of [filled, test.data]) {
          if (profile(answer) !== true) continue;
          counts.accepted++;
          const verdict = check(strict.fromProfile(answer));
          assert.equal(typeof verdict, 'boolean', `the original answers fromProfile(a profile answer): ${where}`);
          counts[verdict ? 'restoredValid' : 'restoredRefused']++;
        }
      }
    }
    assert.deepEqual(counts, { groups: 222, forward: 538, accepted: 749, restoredValid: 556, restoredRefused: 193, roundTrip: 535 });
  });

  const suite = new URL('../../benchmark/suite/tests/draft2020-12/', import.meta.url);
  const present = fs.existsSync(suite);
  it('accepts exactly the vendored groups and refuses every other one with a code', { skip: present ? false : 'the benchmark/suite submodule is not checked out' }, () => {
    const accepted = [];
    /** @type {Record<string, number>} */
    const codes = {};
    for (const file of fs.readdirSync(suite).filter((name) => name.endsWith('.json')).sort()) {
      for (const group of JSON.parse(fs.readFileSync(new URL(file, suite), 'utf8'))) {
        try {
          deriveStrictProfile(group.schema);
          accepted.push(`${file} / ${group.description}`);
        }
        catch (error) {
          assert.ok(error instanceof SchemaCompileError, `${file} / ${group.description}: ${error}`);
          codes[error.code] = (codes[error.code] ?? 0) + 1;
        }
      }
    }
    assert.deepEqual(accepted, groups.map((group) => `${group.file} / ${group.description}`));
    assert.deepEqual(codes, { JK0009: 2, JK0102: 1, JK0103: 102, JK0104: 31, JK0108: 6 });
  });
});

const D20_ROOT = new URL('../../', import.meta.url);
/** Every committed grammar and authoring profile of the suite, by file. */
const grammarFiles = Object.entries({ json: ['jaren-query', 'jaren-jslt', 'jaren-jtlt', 'geojson'], db: ['jaren-model'], app: ['jaren-app'],
  flow: ['jaren-fsm', 'jaren-dag', 'jaren-statechart', 'jaren-workflow'] })
  .flatMap(([pkg, names]) => names.flatMap((name) => ['', '.authoring'].map((suffix) => `packages/${pkg}/schemas/${name}${suffix}.schema.json`)))
  .filter((file) => fs.existsSync(new URL(file, D20_ROOT)));
const grammars = new Map(grammarFiles.map((file) => [file, JSON.parse(fs.readFileSync(new URL(file, D20_ROOT), 'utf8'))]));
const othersOf = (/** @type {any} */ schema) => [...grammars.values()].filter((other) => other.$id !== schema.$id);

describe('the suite\'s grammars and authoring profiles', () => {
  it('derive, except the JTLT grammar, whose segment puts a multi-branch allOf beside no type', () => {
    const answers = Object.fromEntries([...grammars].map(([file, schema]) => [file, refusal(() => deriveStrictProfile(schema, { references: othersOf(schema) }))[0]]));
    assert.deepEqual(answers, Object.fromEntries(grammarFiles.map((file) => [file, file.includes('jaren-jtlt.schema') ? 'JK0103' : 'no throw'])));
  });

  // documents each original accepts, read through its profile both ways
  for (const [file, documents] of Object.entries({
    'packages/json/schemas/jaren-query.schema.json': [{ $sum: '$.prices[*]' }, { $for: { b: '$.books[*]' }, $where: { $gt: ['$b.price', 10] }, $return: '$b.title' }, '$.a', { $concat: ['a', '$.b', 'c'] }],
    'packages/json/schemas/jaren-query.authoring.schema.json': [{ $sum: '$.prices[*]' }, { $for: { r: '$.records[*]' }, $return: '$r.id' }, '$.a', 3],
    'packages/json/schemas/jaren-jslt.schema.json': [[{ match: '$..title', body: { $upper: '$' } }]],
    'packages/json/schemas/jaren-jslt.authoring.schema.json': [[{ match: '$', body: { total: { $sum: '$.prices[*]' } } }],
      { $jslt: '0.1', rules: [{ match: { schema: { type: 'object' } }, body: '$', mode: 'ids' }] }],
    'packages/json/schemas/geojson.schema.json': [{ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { name: 'a', n: [1] } }],
    'packages/app/schemas/jaren-app.authoring.schema.json': [{ state: { count: 0 }, view: [{ match: '$', body: { tag: 'div', children: ['hello'] } }], actions: { inc: { state: { count: { $add: ['$.count', 1] } } } } }],
    'packages/flow/schemas/jaren-fsm.authoring.schema.json': [{ initial: 'idle', states: ['idle', 'done'], transitions: [{ from: 'idle', to: 'done', event: 'GO' }] }],
    'packages/flow/schemas/jaren-dag.authoring.schema.json': [{ $dag: '0.1', nodes: { input: { kind: 'input' }, output: { kind: 'output' } }, edges: [{ from: 'input', to: 'output' }] }],
    'packages/flow/schemas/jaren-statechart.authoring.schema.json': [{ $fsm: '0.2', initial: 'idle', states: ['idle', { id: 'done', final: true }], transitions: [{ from: 'idle', to: 'done', after: 10 }] }],
    'packages/flow/schemas/jaren-workflow.authoring.schema.json': [{ $workflow: '0.2', revision: '1', initial: 'done', states: { done: { final: true } } }],
    'packages/db/schemas/jaren-model.authoring.schema.json': [{ $model: '0.1', collections: { notes: { schema: { type: 'object' }, key: '/id' } } }],
  })) {
    it(`${file.split('/').at(-1)}: the profile accepts toProfile(a document), and fromProfile gives one the original accepts`, () => {
      const schema = grammars.get(file);
      const strict = deriveStrictProfile(schema, { references: othersOf(schema) });
      const check = original(schema, othersOf(schema));
      const profile = profiled(strict.schema);
      for (const document of documents) {
        assert.equal(check(document), true, 'the original accepts the document');
        const filled = strict.toProfile(document);
        assert.equal(profile(filled), true, `the profile accepts ${JSON.stringify(filled).slice(0, 80)}`);
        assert.equal(check(strict.fromProfile(filled)), true, `the original accepts ${JSON.stringify(strict.fromProfile(filled)).slice(0, 80)}`);
      }
    });
  }
});

describe('the README example', () => {
  it('runs as written: build, a stand-in provider, fromProfile, validate', () => {
    const readme = fs.readFileSync(new URL('../../packages/validate/README.md', import.meta.url), 'utf8');
    const section = readme.slice(readme.indexOf('## Strict structured-output profiles'));
    const fence = section.slice(section.indexOf('```js\n') + 6, section.indexOf('\n```', section.indexOf('```js\n')));
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', fence], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } });
    assert.equal(out, '{"ops":[{"op":"remove","path":"/draft"},{"op":"add","path":"/title","value":"Q3"}]} true\n');
  });
});
