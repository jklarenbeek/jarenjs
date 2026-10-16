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
import { JarenValidator, SchemaCompileError, VALIDATE_CODES } from '@jarenjs/validate';
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
    const open = { $id: 'https://x.test/open.json', type: 'object', properties: { bag: { type: 'object' } } };
    assert.deepEqual(refusal(() => deriveStrictProfile({ $ref: 'https://x.test/open.json' }, { references: [open] })),
      ['JK0102', 'https://x.test/open.json#/properties/bag']);
  });
});

describe('deriveStrictProfile: a schema a closed profile would read wrong is refused with a code', () => {
  for (const [label, schema, expected] of [
    ['a member that accepts any value', { type: 'object', properties: { a: {} } }, ['JK0101', '#/properties/a']],
    ['a member true', { type: 'object', properties: { a: true } }, ['JK0101', '#/properties/a']],
    ['the schema true', true, ['JK0101', '#']],
    ['an array with no items schema', { type: 'object', properties: { a: { type: 'array' } } }, ['JK0101', '#/properties/a']],
    ['patternProperties', { type: 'object', properties: { a: { type: 'string' } }, patternProperties: { '^x': { type: 'string' } } }, ['JK0102', '#/patternProperties']],
    ['a map-valued additionalProperties', { type: 'object', properties: { m: { type: 'object', additionalProperties: { type: 'string' } } } }, ['JK0102', '#/properties/m/additionalProperties']],
    ['an object with no declared members', { type: 'object', properties: { m: { type: 'object' } } }, ['JK0102', '#/properties/m']],
    ['an allOf beside an object type', { type: 'object', properties: { a: { type: 'string' } }, allOf: [{ properties: { b: { type: 'string' } } }] }, ['JK0103', '#/allOf']],
    ['an untyped allOf of two branches', { allOf: [{ type: 'string' }, { minLength: 1 }] }, ['JK0103', '#/allOf']],
    ['a $ref beside properties', { type: 'object', properties: { a: { $ref: '#/$defs/n', properties: {} } }, $defs: { n: { type: 'number' } } }, ['JK0103', '#/properties/a/properties']],
    ['prefixItems', { type: 'object', properties: { t: { type: 'array', prefixItems: [{ type: 'string' }], items: { type: 'number' } } } }, ['JK0103', '#/properties/t/prefixItems']],
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
    for (const code of ['JK0101', 'JK0102', 'JK0103', 'JK0104', 'JK0105', 'JK0106', 'JK0107', 'JK0108'])
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
    assert.deepEqual(counts, { groups: 64, forward: 87, accepted: 103, restoredValid: 97, restoredRefused: 6, roundTrip: 86 });
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
    assert.deepEqual(codes, { JK0101: 151, JK0102: 6, JK0103: 109, JK0104: 31, JK0108: 3 });
  });
});

describe('the json package grammars', () => {
  const dir = new URL('../../packages/json/schemas/', import.meta.url);
  const grammars = fs.readdirSync(dir).filter((name) => name.endsWith('.schema.json')).sort()
    .map((name) => [name, JSON.parse(fs.readFileSync(new URL(name, dir), 'utf8'))]);
  const references = grammars.map(([, schema]) => schema);

  it('are each refused where an open map or a composed object makes them unclosable', () => {
    const answers = Object.fromEntries(grammars.map(([name, schema]) =>
      [name, refusal(() => deriveStrictProfile(schema, { references: references.filter((other) => other !== schema) }))]));
    assert.deepEqual(answers, {
      'geojson.draft-07.schema.json': ['JK0102', 'https://jarenjs.dev/schemas/geojson/draft-07#/definitions/feature/properties/properties'],
      'geojson.jaren.schema.json': ['JK0102', 'https://jarenjs.dev/schemas/geojson-jaren#/%24defs/feature/properties/properties'],
      'geojson.schema.json': ['JK0102', 'https://jarenjs.dev/schemas/geojson#/%24defs/feature/properties/properties'],
      'jaren-jslt.authoring.schema.json': ['JK0103', 'https://jarenjs.dev/schemas/jaren-jslt/0.1/authoring#/%24defs/matchSpec/anyOf/1/anyOf'],
      'jaren-jslt.draft-07.schema.json': ['JK0103', 'https://jarenjs.dev/schemas/jaren-jslt/0.1/draft-07#/definitions/matchSpec/oneOf/1/anyOf'],
      'jaren-jslt.llm-profile.schema.json': ['JK0103', 'https://jarenjs.dev/schemas/jaren-jslt/0.1/llm-profile#/%24defs/matchSpec/anyOf/1/anyOf'],
      'jaren-jslt.schema.json': ['JK0103', 'https://jarenjs.dev/schemas/jaren-jslt/0.1#/%24defs/matchSpec/oneOf/1/anyOf'],
      'jaren-jtlt.draft-07.schema.json': ['JK0103', 'https://jarenjs.dev/schemas/jaren-jtlt/0.1/draft-07#/definitions/matchSpec/oneOf/1/anyOf'],
      'jaren-jtlt.schema.json': ['JK0103', 'https://jarenjs.dev/schemas/jaren-jtlt/0.1#/%24defs/matchSpec/oneOf/1/anyOf'],
      'jaren-query.authoring.schema.json': ['JK0102', 'https://jarenjs.dev/schemas/jaren-query/0.1/authoring#/%24defs/objectExpression'],
      'jaren-query.draft-07.schema.json': ['JK0102', 'https://jarenjs.dev/schemas/jaren-query/0.1/draft-07#/definitions/mapConstructor/patternProperties'],
      'jaren-query.llm-profile.schema.json': ['JK0102', 'https://jarenjs.dev/schemas/jaren-query/0.1/llm-profile#/%24defs/mapConstructor/additionalProperties'],
      'jaren-query.schema.json': ['JK0102', 'https://jarenjs.dev/schemas/jaren-query/0.1#/%24defs/mapConstructor/patternProperties'],
    });
  });
});

describe('the README example', () => {
  it('runs as written: build, a stand-in provider, fromProfile, validate', () => {
    const readme = fs.readFileSync(new URL('../../packages/validate/README.md', import.meta.url), 'utf8');
    const section = readme.slice(readme.indexOf('## Strict structured-output profiles'));
    const fence = section.slice(section.indexOf('```js\n') + 6, section.indexOf('\n```', section.indexOf('```js\n')));
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', fence], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(out, '{"ops":[{"op":"remove","path":"/draft"},{"op":"add","path":"/title","value":"Q3"}]} true\n');
  });
});
