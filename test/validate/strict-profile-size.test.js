//@ts-check
// A strict profile measured in the numbers providers cap a structured-output
// schema by: the characters of its text, its properties (the optional ones and
// the union-typed ones among them), definitions, schemas on a loop of
// references, the levels of object nesting through references, enum values,
// and the characters of names and listed values. The measure builds in no cap.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SchemaCompileError } from '@jarenjs/validate';
import { deriveStrictProfile, relaxSchema, strictProfileSize } from '@jarenjs/validate/strict-profile';

const ROOT = new URL('../../', import.meta.url);
const text = { type: 'string' };
/** An object schema of the given members. @param {Record<string, unknown>} properties */
const object = (properties) => ({ type: 'object', properties });
const ref = (/** @type {string} */ name) => ({ $ref: `#/$defs/${name}` });

describe('strictProfileSize: the counts', () => {
  const schema = {
    type: 'object',
    properties: {
      id: text,
      kind: { enum: ['a', 'bb', 3, null] },
      tags: { type: ['array', 'null'], items: ref('tag') },
      owner: { anyOf: [ref('person'), { type: 'null' }] },
      note: ref('maybe'),
      fixed: { const: 'v1' },
    },
    required: ['id', 'kind'],
    additionalProperties: false,
    $defs: {
      tag: { type: 'object', properties: { name: text }, required: ['name'], additionalProperties: false },
      person: { type: 'object', properties: { name: text, boss: { anyOf: [ref('person'), { type: 'null' }] } }, required: ['name', 'boss'], additionalProperties: false },
      maybe: { type: ['string', 'null'] },
    },
  };

  it('counts properties, the optional and the union-typed among them, definitions, loops, levels, enum values and name characters', () => {
    assert.deepEqual(strictProfileSize(schema), {
      characters: JSON.stringify(schema).length,
      // root 6, tag 1, person 2
      properties: 9,
      // tags, owner, note and fixed are not required
      optionalProperties: 4,
      // a list of types, an anyOf, a reference to a list of types, and the person's boss
      unionProperties: 4,
      definitions: 3,
      // a person names a person
      recursiveSchemas: 1,
      // the root, then a tag or a person
      depth: 2,
      enumValues: 4,
      largestEnum: 4,
      // a, bb, and 3 and null as their JSON text
      largestEnumCharacters: 8,
      // 36 of property names, 14 of definition names, 8 of enum values, 2 of the const
      nameCharacters: 60,
    });
  });

  it('counts a character outside the basic plane once', () => {
    const astral = { type: 'object', properties: { '\u{1F600}': { enum: ['\u{1F600}\u{1F600}', 'x'] } } };
    const size = strictProfileSize(astral);
    assert.equal(JSON.stringify(astral).length - size.characters, 3, 'three surrogate pairs in the text');
    assert.deepEqual([size.nameCharacters, size.largestEnumCharacters], [4, 3]);
  });

  it('keeps the largest enum and the longest enum apart', () => {
    const size = strictProfileSize(object({ many: { enum: [1, 2, 3, 4] }, long: { enum: ['a longer value', 'another one'] }, flag: { const: true } }));
    assert.deepEqual([size.enumValues, size.largestEnum, size.largestEnumCharacters], [6, 4, 25]);
    // many, long, flag; 1 2 3 4; the two long values; true
    assert.equal(size.nameCharacters, 12 + 4 + 25 + 4);
  });

  it('reads a member named like a keyword as a member, and listed data as data', () => {
    const size = strictProfileSize(object({ properties: text, enum: text, $defs: text, const: { const: { properties: { a: 1 }, enum: [1, 2] } } }));
    assert.deepEqual([size.properties, size.definitions, size.enumValues, size.depth], [4, 0, 0, 1]);
  });

  it('measures what deriveStrictProfile returns as it measures its schema', () => {
    const strict = deriveStrictProfile(schema);
    const size = strictProfileSize(strict);
    assert.deepEqual(size, strictProfileSize(strict.schema));
    // every member is required in a profile
    assert.deepEqual([size.properties, size.optionalProperties], [9, 0]);
    assert.equal(size.unionProperties, 5, 'the four the original wrote as unions, and fixed, which the profile widens to admit null');
  });

  it('refuses what is neither a profile nor a schema, with a code', () => {
    for (const value of [undefined, null, 'x', 1, [], () => {}]) {
      assert.throws(() => strictProfileSize(/** @type {any} */ (value)), (error) => error instanceof SchemaCompileError && error.code === 'JK0107');
    }
    assert.deepEqual(strictProfileSize(true), { characters: 4, properties: 0, optionalProperties: 0, unionProperties: 0, definitions: 0,
      recursiveSchemas: 0, depth: 0, enumValues: 0, largestEnum: 0, largestEnumCharacters: 0, nameCharacters: 0 });
  });
});

describe('strictProfileSize: the levels of object nesting', () => {
  const depthOf = (/** @type {any} */ schema) => strictProfileSize(schema).depth;
  const recursiveOf = (/** @type {any} */ schema) => strictProfileSize(schema).recursiveSchemas;

  it('counts objects, not arrays, unions or references', () => {
    assert.equal(depthOf(text), 0);
    assert.equal(depthOf(object({})), 1);
    assert.equal(depthOf({ type: 'array', items: { anyOf: [text, { type: 'array', items: text }] } }), 0);
    assert.equal(depthOf(object({ a: { type: 'array', items: { anyOf: [object({ b: object({}) }), text] } } })), 3);
    assert.equal(depthOf({ type: ['object', 'null'], properties: { a: text } }), 1);
  });

  it('follows a reference into its definition, and takes the deepest of two routes whichever is written first', () => {
    const node = object({ leaf: object({}) });
    const shallow = ref('node');
    const deep = object({ c: ref('node') });
    for (const properties of [{ a: shallow, b: deep }, { b: deep, a: shallow }])
      assert.equal(depthOf({ ...object(properties), $defs: { node } }), 4, 'the root, b, the node, its leaf');
    // a chain of definitions adds each one's levels
    assert.equal(depthOf({ ...object({ a: ref('one') }), $defs: { one: object({ b: ref('two') }), two: object({ c: ref('three') }), three: object({}) } }), 4);
    // a definition nothing references adds none
    assert.equal(depthOf({ ...object({}), $defs: { unused: object({ a: object({ b: object({}) }) }) } }), 1);
  });

  it('walks a loop of references once, from wherever it is entered', () => {
    // a tree: the root names itself
    const tree = { type: 'object', properties: { name: text, children: { type: 'array', items: { $ref: '#' } } } };
    assert.deepEqual([depthOf(tree), recursiveOf(tree)], [1, 1]);
    // a definition that names itself, reached at two levels
    const linked = object({ next: ref('node'), leaf: object({}) });
    for (const properties of [{ a: ref('node'), b: object({ c: ref('node') }) }, { b: object({ c: ref('node') }), a: ref('node') }]) {
      const schema = { ...object(properties), $defs: { node: linked } };
      assert.deepEqual([depthOf(schema), recursiveOf(schema)], [4, 1], 'the root, b, the node, its leaf');
    }
    // two definitions that name each other: the path from A is A alone, the path from B goes on into A
    const $defs = { A: object({ b: ref('B'), x: object({ y: object({}) }) }), B: object({ a: ref('A') }) };
    assert.deepEqual([depthOf({ ...object({ p: ref('A') }), $defs }), recursiveOf({ ...object({ p: ref('A') }), $defs })], [4, 2]);
    assert.deepEqual([depthOf({ ...object({ p: ref('B') }), $defs }), recursiveOf({ ...object({ p: ref('B') }), $defs })], [5, 2]);
    // entered at both, the deeper path counts, in either order
    assert.equal(depthOf({ ...object({ p: ref('A'), q: ref('B') }), $defs }), 5);
    assert.equal(depthOf({ ...object({ q: ref('B'), p: ref('A') }), $defs }), 5);
  });

  it('reads a reference as the document spells its places', () => {
    const node = object({ leaf: object({}) });
    assert.equal(depthOf({ ...object({ a: { $ref: '#/%24defs/node' } }), $defs: { node } }), 3, 'a percent-encoded fragment');
    assert.equal(depthOf({ ...object({ a: { $ref: '#/definitions/node' } }), definitions: { node } }), 3, 'draft-07 definitions');
    assert.equal(depthOf({ ...object({ a: { $ref: '#/$defs/a~1b' } }), $defs: { 'a/b': node } }), 3, 'an escaped name');
    assert.equal(depthOf({ ...object({ a: { $ref: '#/$defs/in/$defs/node' } }), $defs: { in: { $defs: { node } } } }), 3, 'a definition inside a definition');
    // a reference that names no definition of the document adds no level
    for (const $ref of ['#/$defs/missing', 'https://example.test/other.json', '#/%'])
      assert.equal(depthOf({ ...object({ a: { $ref } }), $defs: { node } }), 1, $ref);
  });

  /** Definitions that each name every other: a loop with a path through every order of them. @param {number} count */
  const tangled = (count) => {
    const names = Array.from({ length: count }, (_, i) => `d${i}`);
    return { ...object({ start: ref('d0') }), $defs: Object.fromEntries(names.map((name) => [name,
      object({ deep: object({ deeper: object({}) }), ...Object.fromEntries(names.filter((other) => other !== name).map((other) => [`to_${other}`, ref(other)])) })])) };
  };
  /** Definitions that each name the next, the last the first. @param {number} count */
  const ring = (count) => ({ ...object({ start: ref('d0') }), $defs: Object.fromEntries(Array.from({ length: count }, (_, i) => [`d${i}`,
    object({ next: ref(`d${(i + 1) % count}`), pad: object({}) })])) });

  it('walks a tangled loop path by path while its paths are few, and end to end beyond', () => {
    // the root, one level in each of five definitions on the way, and the three levels of the last
    assert.deepEqual([depthOf(tangled(5)), recursiveOf(tangled(5))], [1 + 4 + 3, 5]);
    // nine have more paths than the walk follows: every definition once, end to end, which no path exceeds
    assert.deepEqual([depthOf(tangled(9)), recursiveOf(tangled(9))], [1 + 9 * 3, 9]);
    assert.ok(1 + 8 + 3 <= depthOf(tangled(9)));
  });

  it('walks a long ring path by path, and a ring of more definitions than it recurses through end to end', () => {
    // the root, a level in each of 299 definitions on the way, and the two of the last
    assert.deepEqual([depthOf(ring(300)), recursiveOf(ring(300))], [1 + 299 + 2, 300]);
    assert.deepEqual([depthOf(ring(600)), recursiveOf(ring(600))], [1 + 600 * 2, 600]);
  });

  it('goes on from a loop into what the loop leaves for, walked or end to end', () => {
    const tail = object({ x: object({}) });
    /** @param {number} count */
    const leaving = (count) => {
      const schema = /** @type {any} */ (ring(count));
      schema.$defs[`d${count - 1}`].properties.out = ref('tail');
      schema.$defs.tail = tail;
      return schema;
    };
    // the root, a level in each of the three on the way, and the tail's two
    assert.equal(depthOf(leaving(3)), 1 + 3 + 2);
    assert.equal(depthOf(leaving(600)), 1 + 600 * 2 + 2);
    assert.equal(recursiveOf(leaving(600)), 600, 'the tail is on no loop');
  });

  it('follows a long chain of definitions that is no loop without recursing through it', () => {
    const count = 20000;
    const chain = { ...object({ start: ref('d0') }), $defs: Object.fromEntries(Array.from({ length: count }, (_, i) => [`d${i}`,
      i + 1 < count ? object({ next: ref(`d${i + 1}`) }) : object({})])) };
    assert.deepEqual([depthOf(chain), recursiveOf(chain), strictProfileSize(chain).definitions], [1 + count, 0, count]);
  });
});

describe('strictProfileSize: the profiles of real schemas', () => {
  /** Count through `relaxSchema`, which calls back for a keyword wherever it is one. @param {any} schema @param {string} keyword @param {(value: any) => number} count */
  const through = (schema, keyword, count) => {
    let total = 0;
    relaxSchema(schema, { keywords: [keyword], note: (_, value) => { total += count(value); return ''; } });
    return total;
  };

  it('agrees with an independent count over the profiles of the vendored suite groups', () => {
    const groups = JSON.parse(fs.readFileSync(new URL('./fixtures/strict-profile/draft2020-12-accepted.json', import.meta.url), 'utf8'));
    const totals = { profiles: 0, properties: 0, unionProperties: 0, definitions: 0, recursiveSchemas: 0, enumValues: 0, nameCharacters: 0, deepest: 0 };
    for (const group of groups) {
      const { schema } = deriveStrictProfile(group.schema);
      const size = strictProfileSize(schema);
      const where = `${group.file} / ${group.description}`;
      assert.equal(size.characters, [...JSON.stringify(schema)].length, where);
      assert.equal(size.enumValues, through(schema, 'enum', (values) => values.length), where);
      assert.equal(size.definitions, Object.keys(schema.$defs ?? {}).length, where);
      // a profile requires every member it declares
      assert.equal(size.optionalProperties, 0, where);
      assert.equal(size.properties, through(schema, 'required', (names) => names.length), where);
      assert.ok(size.unionProperties <= size.properties && size.largestEnum <= size.enumValues && size.recursiveSchemas <= size.definitions + 1, where);
      totals.profiles++;
      for (const key of /** @type {const} */ (['properties', 'unionProperties', 'definitions', 'recursiveSchemas', 'enumValues', 'nameCharacters'])) totals[key] += size[key];
      totals.deepest = Math.max(totals.deepest, size.depth);
    }
    assert.deepEqual(totals, { profiles: 224, properties: 253, unionProperties: 36, definitions: 18, recursiveSchemas: 3, enumValues: 25, nameCharacters: 1557, deepest: 2 });
  });

  it('measures every grammar and authoring profile of the suite, each number the count of what it names', (t) => {
    const files = Object.entries({ json: ['jaren-query', 'jaren-jslt', 'jaren-jtlt', 'geojson'], db: ['jaren-model'], app: ['jaren-app'],
      flow: ['jaren-fsm', 'jaren-dag', 'jaren-statechart', 'jaren-workflow'] })
      .flatMap(([pkg, names]) => names.flatMap((name) => ['', '.authoring', '.draft-07'].map((suffix) => `packages/${pkg}/schemas/${name}${suffix}.schema.json`)))
      .filter((file) => fs.existsSync(new URL(file, ROOT)));
    const documents = files.map((file) => JSON.parse(fs.readFileSync(new URL(file, ROOT), 'utf8')));
    const byId = new Map(documents.map((document) => [document.$id, document]));
    /** The documents a schema's references name, and theirs. @param {any} schema */
    const referenced = (schema) => {
      const found = new Map();
      const queue = [schema];
      while (queue.length > 0) {
        const document = queue.pop();
        for (const match of JSON.stringify(document).matchAll(/"\$ref":"([^"#]+)(?:#[^"]*)?"/g)) {
          const target = URL.canParse(match[1], document.$id) ? byId.get(new URL(match[1], document.$id).href) : undefined;
          if (target !== undefined && target !== schema && !found.has(target.$id)) { found.set(target.$id, target); queue.push(target); }
        }
      }
      return [...found.values()];
    };
    /** @type {Record<string, [number, string]>} */
    const largest = {};
    for (const [i, document] of documents.entries()) {
      const { schema } = deriveStrictProfile(document, { references: referenced(document) });
      const size = strictProfileSize(schema);
      assert.equal(size.characters, [...JSON.stringify(schema)].length, files[i]);
      assert.equal(size.enumValues, through(schema, 'enum', (values) => values.length), files[i]);
      assert.equal(size.definitions, Object.keys(schema.$defs ?? {}).length, files[i]);
      assert.equal(size.optionalProperties, 0, files[i]);
      assert.equal(size.properties, through(schema, 'required', (names) => names.length), files[i]);
      assert.ok(size.depth >= 1 && size.unionProperties <= size.properties, files[i]);
      for (const [key, value] of Object.entries(size)) if (value > (largest[key]?.[0] ?? -1)) largest[key] = [value, /** @type {string} */ (files[i].split('/').at(-1))];
    }
    assert.ok(files.length >= 28, 'the grammars, their authoring profiles and their draft-07 twins');
    t.diagnostic(`largest of ${files.length} profiles: ${JSON.stringify(largest)}`);
  });
});

describe('the README example of strictProfileSize', () => {
  it('prints the numbers the README shows', () => {
    const readme = fs.readFileSync(new URL('packages/validate/README.md', ROOT), 'utf8');
    const section = readme.slice(readme.indexOf('## Strict structured-output profiles'), readme.indexOf('## Error messages & i18n'));
    const fence = /** @type {string} */ ([...section.matchAll(/```js\n([\s\S]*?)\n```/g)].map((match) => match[1]).find((code) => code.includes('strictProfileSize(')));
    const shown = fence.split('\n').filter((line) => line.startsWith('// ')).map((line) => line.slice(3));
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', fence], { cwd: fileURLToPath(ROOT), encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } });
    assert.equal(out, `${shown.at(-1)}\n`);
    assert.match(out, /^\{"characters":\d+,"properties":\d+,/);
  });
});
