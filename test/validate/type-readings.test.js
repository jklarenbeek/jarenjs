import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as assert from '../assert.node.js';

import { JarenValidator } from '@jarenjs/validate';

// `type` reads a value JSON cannot carry one way: whatever keyword sits
// beside it, wherever its schema is reached from, and in both modes. A type
// test that answers another way on some path fails here. `undefined` is not
// in this corpus: an absent value and an element holding `undefined` have
// their own readings (undefined-elements.test.js).

class Sub extends Array {}
class Point { constructor() { this.x = 1; } }
function argumentsOf() { return arguments; }
// Makers of another realm's values: its Array and Object are not this one's.
const realm = runInNewContext('({ array: () => [1], object: () => ({ a: 1 }) })');

const D2019 = 'https://json-schema.org/draft/2019-09/schema';
const D2020 = 'https://json-schema.org/draft/2020-12/schema';

// The type names whose answers are pinned below; `tuple` takes what `array`
// takes, and `set`, `map` and `regex` are the validator's own kinds, held to
// one answer per value only.
const PINNED = ['null', 'boolean', 'integer', 'bigint', 'number', 'string', 'object', 'array'];
const NAMES = [...PINNED, 'set', 'map', 'tuple', 'regex'];

/** [label, a maker of the value, the pinned type names that take it] */
const VALUES = [
  ['NaN', () => NaN, []],
  ['Infinity', () => Infinity, ['number']],
  ['-Infinity', () => -Infinity, ['number']],
  ['-0', () => -0, ['integer', 'number']],
  ['a bigint', () => 1n, ['bigint']],
  ['a symbol', () => Symbol('s'), []],
  ['a function', () => function plain() {}, []],
  ['a function whose constructor member is Array', () => Object.assign(function plain() {}, { constructor: Array }), []],
  ['an Array subclass instance', () => Sub.from([1]), ['array']],
  ['an array with an own constructor member', () => Object.assign([1], { constructor: Object }), ['array']],
  ['an array of another realm', () => realm.array(), ['array']],
  ['a Proxy of an array', () => new Proxy([1], {}), ['array']],
  ['{ constructor: Array }', () => ({ constructor: Array }), ['object']],
  ['an object whose prototype is an array', () => Object.create([]), ['object']],
  ['an object with the array prototype and a length', () => Object.setPrototypeOf({ 0: 1, length: 1 }, Array.prototype), ['object']],
  ['a null-prototype object', () => Object.create(null), ['object']],
  ['an object of another realm', () => realm.object(), ['object']],
  ['a class instance', () => new Point(), ['object']],
  ['a Proxy of an object', () => new Proxy({ a: 1 }, {}), ['object']],
  ['a Map', () => new Map([[1, 2]]), ['object']],
  ['a Set', () => new Set([1]), ['object']],
  ['a Date', () => new Date(0), ['object']],
  ['a RegExp', () => /a/, ['object']],
  ['a Number object', () => new Number(1), ['object']],
  ['a String object', () => new String('a'), ['object']],
  ['a Boolean object', () => new Boolean(false), ['object']],
  ['a Uint8Array', () => new Uint8Array(1), ['object']],
  ['an arguments object', () => argumentsOf(1), ['object']],
];

// Keywords of every family, each read beside `type`. A keyword answers for
// itself, so `type` beside it answers what `type` answers and the keyword
// answers alone.
const SIBLINGS = [
  { description: 'x' },
  { maximum: Number.MAX_VALUE },
  { exclusiveMinimum: -Number.MAX_VALUE },
  { maxLength: 1e9 },
  { pattern: '' },
  { maxItems: 1e9 },
  { items: { type: 'number' } },
  { uniqueItems: true },
  { maxProperties: 1e9 },
  { properties: { zzz: {} } },
  { required: ['zzz'] },
  { additionalProperties: {} },
  { maximum: Number.MAX_VALUE, maxLength: 1e9 },
  { maxItems: 1e9, maxProperties: 1e9, maxLength: 1e9 },
];
const ARRAY_KEYWORDS = ['maxItems', 'items', 'uniqueItems'];
const OBJECT_KEYWORDS = ['maxProperties', 'properties', 'required', 'additionalProperties'];
// A schema naming `set` compiles no array keyword and one naming `map` no
// object keyword: those two kinds have no keyword group.
const compiles = (type, sibling) => !(type === 'set' && ARRAY_KEYWORDS.some((key) => key in sibling))
  && !(type === 'map' && OBJECT_KEYWORDS.some((key) => key in sibling));

const same = (value) => value;
const inArray = (value) => [value];
const inMember = (value) => ({ m: value });

/** Where the schema naming the type stands: [label, schema, instance, negated] */
const PLACES = [
  ['alone', (inner) => inner, same, false],
  ['as items', (inner) => ({ items: inner }), inArray, false],
  ['as a tuple position', (inner) => ({ $schema: D2020, prefixItems: [inner] }), inArray, false],
  ['as contains', (inner) => ({ contains: inner }), inArray, false],
  ['as unevaluatedItems', (inner) => ({ $schema: D2019, unevaluatedItems: inner }), inArray, false],
  ['as a member', (inner) => ({ properties: { m: inner } }), inMember, false],
  ['as a member of a closed object', (inner) => ({ properties: { m: inner }, additionalProperties: false }), inMember, false],
  ['as additionalProperties', (inner) => ({ additionalProperties: inner }), inMember, false],
  ['as unevaluatedProperties', (inner) => ({ $schema: D2019, unevaluatedProperties: inner }), inMember, false],
  ['behind $ref', (inner) => ({ $ref: '#/definitions/t', definitions: { t: inner } }), same, false],
  ['inside anyOf', (inner) => ({ anyOf: [inner] }), same, false],
  ['inside allOf', (inner) => ({ allOf: [inner] }), same, false],
  ['inside oneOf', (inner) => ({ oneOf: [inner] }), same, false],
  ['under not', (inner) => ({ not: inner }), same, true],
  ['as an if', (inner) => ({ if: inner, then: true, else: false }), same, false],
];

const MODES = [
  ['first failure', new JarenValidator(), (result) => result],
  ['collecting', new JarenValidator({ collectErrors: true }), (result) => result.valid],
];

const compiled = new Map();
function answer(mode, schema, instance) {
  const [label, jaren, read] = MODES[mode];
  const key = `${label} ${JSON.stringify(schema)}`;
  let validate = compiled.get(key);
  if (validate === undefined) compiled.set(key, validate = jaren.compile(schema));
  return read(validate(instance));
}

/** What `type: name` answers for a value: the pinned answer, else the lone first-failure one. */
function reading(name, make, taken) {
  if (name === 'tuple') return taken.includes('array');
  return PINNED.includes(name) ? taken.includes(name) : answer(0, { type: name }, make());
}

/**
 * Every cell that answers another way than `type` alone does (and its
 * sibling keyword alone), for one value.
 */
function strays(make, taken) {
  const found = [];
  const other = (name) => name === 'null' ? 'boolean' : 'null';
  for (const name of NAMES) {
    const base = reading(name, make, taken);
    for (let mode = 0; mode < MODES.length; ++mode) {
      // [what stands beside the type, the schema, the expected answer]
      const shapes = [
        ['lone', { type: name }, base],
        ['a list of one', { type: [name] }, base],
        ['a list of two', { type: [name, other(name)] }, base || reading(other(name), make, taken)],
        ['nullable', { type: name, nullable: true }, base],
      ];
      for (const sibling of SIBLINGS) {
        if (compiles(name, sibling))
          shapes.push([`beside ${JSON.stringify(sibling)}`, { type: name, ...sibling }, base && answer(mode, sibling, make())]);
      }
      for (const [beside, inner, expected] of shapes) {
        for (const [place, schemaOf, instanceOf, negated] of PLACES) {
          const got = answer(mode, schemaOf(inner), instanceOf(make()));
          if (got !== (negated ? !expected : expected))
            found.push(`${name}, ${beside}, ${place}, ${MODES[mode][0]}: ${got}`);
        }
      }
    }
  }
  return found;
}

describe('type reads a value JSON cannot carry one way', () => {
  for (const [label, make, taken] of VALUES) {
    it(`${label}: ${taken.length === 0 ? 'no pinned type' : taken.join(', ')}, beside every keyword, in every place and in both modes`, () => {
      assert.deepEqual(strays(make, taken), []);
    });
  }

  it('the pinned answers are the lone first-failure answers', () => {
    for (const [label, make, taken] of VALUES) {
      for (const name of PINNED)
        assert.strictEqual(answer(0, { type: name }, make()), taken.includes(name), `${label} as ${name}`);
    }
  });

  it('NaN is no number and no integer; the infinities and -0 are numbers', () => {
    const [, jaren] = MODES[0];
    assert.isFalse(jaren.compile({ type: 'number' })(NaN));
    assert.isFalse(jaren.compile({ type: 'number', maxLength: 5 })(NaN));
    assert.isFalse(jaren.compile({ type: ['number', 'string'] })(NaN));
    assert.isFalse(jaren.compile({ type: 'number', nullable: true })(NaN));
    assert.isFalse(jaren.compile({ type: 'number', description: 'a number' })(NaN));
    assert.isFalse(jaren.compile({ type: 'integer', description: 'an integer' })(NaN));
    assert.isTrue(jaren.compile({ type: 'number', description: 'a number' })(Infinity));
    assert.isTrue(jaren.compile({ type: 'number', description: 'a number' })(-Infinity));
    assert.isTrue(jaren.compile({ type: 'integer', description: 'an integer' })(-0));
    assert.isFalse(jaren.compile({ type: 'integer', description: 'an integer' })(Infinity));
  });

  it('an array is what Array.isArray takes, and an object is any other non-null object', () => {
    const [, jaren] = MODES[0];
    const array = jaren.compile({ type: 'array', maxItems: 5 });
    const object = jaren.compile({ type: 'object', maxProperties: 5 });
    for (const value of [Sub.from([1]), new Proxy([1], {}), realm.array(), Object.assign([1], { constructor: Object })]) {
      assert.isTrue(array(value));
      assert.isFalse(object(value));
    }
    for (const value of [{ constructor: Array }, Object.create([]), Object.create(Array.prototype), new Map(), Object.create(null)]) {
      assert.isFalse(array(value));
      assert.isTrue(object(value));
    }
  });
});
