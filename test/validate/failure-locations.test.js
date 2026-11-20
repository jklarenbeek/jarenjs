import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import { JarenValidator } from '@jarenjs/validate';
import { basicOutput, listOutput, hierarchicalOutput } from '@jarenjs/validate/output';
import { VALIDATION_KEYWORDS, TRAVERSE_SCHEMA_OBJECTS, TRAVERSE_SCHEMA_MAPS, TRAVERSE_SCHEMA_MAP_MAPS } from '../../packages/validate/src/schema-keywords.js';

// One rule locates a failure: at the instance its failing subschema or
// assertion is applied to. A subschema applied to a member or an element
// (`additionalProperties`, `unevaluatedProperties`, `properties`,
// `patternProperties`, `items`, `prefixItems`, `additionalItems`,
// `unevaluatedItems`, each also as `false`) fails at that member or element;
// an assertion about the object or array itself (`required`, the counts,
// `dependentRequired`, a `dependencies` list, `propertyNames`, `uniqueItems`,
// `contains` and its bounds) fails at the object or array, its params naming
// the members involved. One row per keyword: a keyword added later that
// locates another way fails here.

const D2020 = 'https://json-schema.org/draft/2020-12/schema';
const D07 = 'http://json-schema.org/draft-07/schema#';

/**
 * [keyword, its dialect, the schema of the instance, the instance, the errors
 * collected: [keyword, where (the tokens below the instance; [] is the
 * instance itself), params], the validator's options]. Member names hold `/`
 * and `~`: a location spells them escaped.
 * @type {[string, string, object, unknown, [string, string[], object][], object?][]}
 */
const ROWS = [
  ['additionalProperties: false', D2020, { properties: { a: {} }, additionalProperties: false }, { a: 1, 'x/y': 2, 'z~': 3 },
    [['additionalProperties', ['x/y'], { additionalProperty: 'x/y' }], ['additionalProperties', ['z~'], { additionalProperty: 'z~' }]]],
  ['an additionalProperties schema', D2020, { additionalProperties: { type: 'string' } }, { 'x/y': 1 },
    [['type', ['x/y'], { type: 'string' }]]],
  ['unevaluatedProperties: false', D2020, { properties: { a: {} }, unevaluatedProperties: false }, { a: 1, 'x/y': 2, 'z~': 3 },
    [['unevaluatedProperties', ['x/y'], { unevaluatedProperty: 'x/y' }], ['unevaluatedProperties', ['z~'], { unevaluatedProperty: 'z~' }]]],
  ['an unevaluatedProperties schema', D2020, { unevaluatedProperties: { type: 'string' } }, { 'x/y': 1 },
    [['type', ['x/y'], { type: 'string' }], ['unevaluatedProperties', ['x/y'], { unevaluatedProperty: 'x/y' }]]],
  ['properties: false', D2020, { properties: { 'x/y': false } }, { 'x/y': 1 },
    [['false schema', ['x/y'], {}]]],
  ['a properties schema', D2020, { properties: { 'x/y': { type: 'string' } } }, { 'x/y': 1 },
    [['type', ['x/y'], { type: 'string' }]]],
  ['patternProperties: false', D2020, { patternProperties: { '^x': false } }, { 'x/y': 1 },
    [['false schema', ['x/y'], {}]]],
  ['required', D2020, { required: ['b', 'c'] }, { a: 1 },
    [['required', [], { missingProperty: 'b' }], ['required', [], { missingProperty: 'c' }]]],
  ['minProperties', D2020, { minProperties: 2 }, { a: 1 },
    [['minProperties', [], { limit: 2 }]]],
  ['maxProperties', D2020, { maxProperties: 0 }, { a: 1 },
    [['maxProperties', [], { limit: 0 }]]],
  ['dependentRequired', D2020, { dependentRequired: { 'a/b': ['c', 'd'] } }, { 'a/b': 1, d: 2 },
    [['dependentRequired', [], { property: 'a/b', missingProperty: 'c' }]]],
  ['a dependencies list', D07, { dependencies: { 'a/b': ['c'] } }, { 'a/b': 1 },
    [['dependencies', [], { property: 'a/b', missingProperty: 'c' }]]],
  ['a dependencies list beside a schema', D07, { dependencies: { 'a/b': ['c'], e: { required: ['f'] } } }, { 'a/b': 1, e: 2 },
    [['dependencies', [], { property: 'a/b', missingProperty: 'c' }], ['required', [], { missingProperty: 'f' }]]],
  ['dependentSchemas', D2020, { dependentSchemas: { a: { required: ['b'] } } }, { a: 1 },
    [['required', [], { missingProperty: 'b' }]]],
  ['a dependencies schema', D07, { dependencies: { a: { required: ['b'] } } }, { a: 1 },
    [['required', [], { missingProperty: 'b' }]]],
  ['propertyDependencies', D2020, { propertyDependencies: { a: { x: { required: ['b'] } } } }, { a: 'x' },
    [['required', [], { missingProperty: 'b' }]], { propertyDependencies: true }],
  ['propertyNames', D2020, { propertyNames: { maxLength: 1 } }, { 'a/b': 1, c: 2, de: 3 },
    [['maxLength', [], { limit: 1, propertyName: 'a/b' }], ['maxLength', [], { limit: 1, propertyName: 'de' }]]],
  ['propertyNames: false', D2020, { propertyNames: false }, { a: 1 },
    [['false schema', [], { propertyName: 'a' }]]],
  ['items: false', D2020, { items: false }, [1, 2],
    [['items', ['0'], {}]]],
  ['items: false past prefixItems', D2020, { prefixItems: [{}], items: false }, [1, 2, 3],
    [['items', ['1'], {}]]],
  ['an items schema', D2020, { items: { type: 'string' } }, ['a', 1],
    [['type', ['1'], { type: 'string' }], ['items', [], {}]]],
  ['prefixItems: [false]', D2020, { prefixItems: [false] }, [1],
    [['items', ['0'], {}]]],
  ['a prefixItems schema', D2020, { prefixItems: [{ type: 'string' }] }, [1],
    [['type', ['0'], { type: 'string' }], ['items', [], {}]]],
  ['an items array position false', D07, { items: [{}, false] }, [1, 2],
    [['items', ['1'], {}]]],
  ['additionalItems: false', D07, { items: [{}], additionalItems: false }, [1, 2, 3],
    [['items', ['1'], {}]]],
  ['an additionalItems schema', D07, { items: [{}], additionalItems: { type: 'string' } }, [1, 2],
    [['type', ['1'], { type: 'string' }], ['items', [], {}]]],
  ['unevaluatedItems: false', D2020, { prefixItems: [{}], unevaluatedItems: false }, [1, 2, 3],
    [['unevaluatedItems', ['1'], { unevaluatedItem: 1 }]]],
  ['an unevaluatedItems schema', D2020, { prefixItems: [{}], unevaluatedItems: { type: 'string' } }, [1, 2],
    [['type', ['1'], { type: 'string' }], ['unevaluatedItems', ['1'], { unevaluatedItem: 1 }]]],
  // Beside contains the element walk reports as it does alone (it used to
  // refuse with no error at all).
  ['prefixItems: [false] beside contains', D2020, { prefixItems: [false], contains: {} }, [1],
    [['items', ['0'], {}]]],
  ['an items schema beside contains', D2020, { items: { type: 'string' }, contains: { const: 'a' } }, ['a', 1],
    [['type', ['1'], { type: 'string' }], ['items', [], {}]]],
  ['minItems', D2020, { minItems: 2 }, [1],
    [['minItems', [], { limit: 2 }]]],
  ['maxItems', D2020, { maxItems: 0 }, [1],
    [['maxItems', [], { limit: 0 }]]],
  ['uniqueItems', D2020, { uniqueItems: true }, [1, 1],
    [['uniqueItems', [], {}]]],
  ['contains', D2020, { contains: { type: 'string' } }, [1],
    [['contains', [], {}]]],
  ['contains: false', D2020, { contains: false }, [1],
    [['contains', [], {}]]],
  ['minContains', D2020, { contains: { type: 'string' }, minContains: 2 }, ['a', 1],
    [['minContains', [], { limit: 2 }]]],
  ['maxContains', D2020, { contains: { type: 'string' }, maxContains: 1 }, ['a', 'b'],
    [['maxContains', [], { limit: 1 }]]],
];

const escape = (/** @type {string} */ token) => token.replace(/~/g, '~0').replace(/\//g, '~1');
const at = (/** @type {string} */ place, /** @type {string[]} */ tokens) => place + tokens.map((token) => '/' + escape(token)).join('');

// The instance under test at the root, and as a member whose name needs escaping.
const PLACES = [
  ['at the root', '', (/** @type {object} */ schema) => schema, (/** @type {unknown} */ value) => value],
  ['as a member', '/o~1p', (/** @type {object} */ schema) => ({ properties: { 'o/p': schema } }), (/** @type {unknown} */ value) => ({ 'o/p': value })],
];

/** @param {string} message */
const parts = (message) => message.split('; ');

describe('a failure is located at the instance its subschema or assertion applies to', () => {
  for (const [placeLabel, place, wrap, hold] of PLACES) {
    for (const declared of [true, false]) {
      describe(`${placeLabel}, ${declared ? 'with' : 'without'} $schema`, () => {
        for (const [keyword, dialect, schema, instance, expected, options = {}] of ROWS) {
          const document = { ...(declared ? { $schema: dialect } : {}), ...wrap(schema) };
          const data = hold(instance);

          it(`${keyword}: collected errors, and the first failure agrees`, () => {
            const result = /** @type {any} */ (new JarenValidator({ ...options, collectErrors: true }).compile(document)(data));
            assert.strictEqual(result.valid, false);
            assert.strictEqual(new JarenValidator(options).compile(document)(data), false);
            assert.deepEqual(result.errors.map((/** @type {any} */ e) => [e.keyword, e.instancePath, e.params]),
              expected.map(([name, tokens, params]) => [name, at(place, tokens), params]));
          });

          it(`${keyword}: basic and list place each message where collected errors do`, () => {
            const collected = /** @type {any} */ (new JarenValidator({ ...options, collectErrors: true }).compile(document)(data)).errors;
            const located = (/** @type {string} */ message, /** @type {string} */ where) =>
              collected.some((/** @type {any} */ e) => e.message === message && e.instancePath === where);
            const basic = /** @type {any} */ (new JarenValidator({ ...options, outputFormat: basicOutput }).compile(document)(data));
            const leaves = basic.errors.filter((/** @type {any} */ u) => collected.some((/** @type {any} */ e) => e.message === u.error));
            assert.ok(leaves.length > 0, "basic reports a message collected errors hold");
            for (const unit of leaves) assert.ok(located(unit.error, unit.instanceLocation), `basic ${unit.keywordLocation} at '${unit.instanceLocation}'`);
            const list = /** @type {any} */ (new JarenValidator({ ...options, outputFormat: listOutput }).compile(document)(data));
            const hierarchical = /** @type {any} */ (new JarenValidator({ ...options, outputFormat: hierarchicalOutput }).compile(document)(data));
            /** @type {any[]} */
            const nested = [];
            const visit = (/** @type {any} */ unit) => { nested.push(unit); for (const kid of unit.details ?? []) visit(kid); };
            visit(hierarchical);
            // A probe's failure (a `contains` candidate) is no collected error: only the units of those are compared.
            const units = (/** @type {any[]} */ details) => details.filter((u) => u.errors !== undefined)
              .flatMap((u) => Object.entries(u.errors).map(([name, message]) => [u.evaluationPath, u.instanceLocation, name, message]))
              .filter(([, , , message]) => parts(message).some((text) => collected.some((/** @type {any} */ e) => e.message === text)));
            assert.deepEqual(units(nested), units(list.details));
            for (const [path, where, , message] of units(list.details))
              for (const text of parts(message)) assert.ok(located(text, where), `list ${path} at '${where}'`);
          });
        }
      });
    }
  }
});

// The keywords that apply to no object or array, or apply in place: every
// other keyword the validator reads must have a row above.
const NOT_OBJECT_OR_ARRAY = new Set(['type', 'enum', 'const', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum',
  'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'not', 'if', 'then', 'else', 'allOf', 'anyOf', 'oneOf',
  'definitions', '$defs', 'components']);

describe('every object and array keyword has a row', () => {
  it('names each keyword the validator reads in some row', () => {
    const named = new Set(ROWS.flatMap(([, , schema]) => Object.keys(schema)));
    const known = new Set([...VALIDATION_KEYWORDS, ...TRAVERSE_SCHEMA_OBJECTS, ...TRAVERSE_SCHEMA_MAPS, ...TRAVERSE_SCHEMA_MAP_MAPS]);
    assert.deepEqual([...known].filter((keyword) => !NOT_OBJECT_OR_ARRAY.has(keyword) && !named.has(keyword)), []);
  });
});

describe('the unit of a false subschema applied to a member or an element', () => {
  /**
   * The list units carrying errors as [evaluationPath, schemaLocation fragment, instanceLocation, error keys].
   * @param {object} schema @param {unknown} data
   */
  const listed = (schema, data) => /** @type {any} */ (new JarenValidator({ outputFormat: listOutput }).compile({ $schema: D2020, ...schema })(data))
    .details.filter((/** @type {any} */ u) => u.errors !== undefined)
    .map((/** @type {any} */ u) => [u.evaluationPath, u.schemaLocation.slice(u.schemaLocation.indexOf('#')), u.instanceLocation, Object.keys(u.errors)]);

  it('sits at the member under the keyword, as a false under properties does', () => {
    assert.deepEqual(listed({ properties: { x: false } }, { x: 1 }), [['/properties/x', '#/properties/x', '/x', ['']]]);
    assert.deepEqual(listed({ additionalProperties: false }, { x: 1 }), [['/additionalProperties', '#/additionalProperties', '/x', ['']]]);
    assert.deepEqual(listed({ unevaluatedProperties: false }, { x: 1 }), [['/unevaluatedProperties', '#/unevaluatedProperties', '/x', ['']]]);
  });

  it('sits at the element under the subschema that refused it', () => {
    assert.deepEqual(listed({ items: false }, [1]), [['/items', '#/items', '/0', ['']]]);
    assert.deepEqual(listed({ prefixItems: [{}, false] }, [1, 2]), [['/prefixItems/1', '#/prefixItems/1', '/1', ['']]]);
    assert.deepEqual(listed({ prefixItems: [{}], items: false }, [1, 2]), [['/items', '#/items', '/1', ['']]]);
    assert.deepEqual(listed({ $schema: D07, items: [{}], additionalItems: false }, [1, 2]), [['/additionalItems', '#/additionalItems', '/1', ['']]]);
    assert.deepEqual(listed({ unevaluatedItems: false }, [1]), [['/unevaluatedItems', '#/unevaluatedItems', '/0', ['']]]);
  });

  it('keeps an assertion about the object at the object', () => {
    assert.deepEqual(listed({ dependentRequired: { a: ['b'] } }, { a: 1 }), [['', '#', '', ['dependentRequired']]]);
    assert.deepEqual(listed({ required: ['b'] }, {}), [['', '#', '', ['required']]]);
  });
});
