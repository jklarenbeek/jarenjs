import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import { JarenValidator } from '@jarenjs/validate';

// The first-failure walks of a schema whose object keywords are `properties`
// with a `required` list and `additionalProperties` read a member by the
// name the schema declares, or by the instance's own enumerable names
// beside `additionalProperties`. Each answer below is what the keywords
// state (an inherited member is absent, an own non-enumerable one is present
// to `required`, the walk beside `additionalProperties` reads the listed
// members only), whichever way a walk reaches it. A member holding
// `undefined` is not in this corpus: it has its own reading.

const D2019 = 'https://json-schema.org/draft/2019-09/schema';

class Inherits {
  constructor() { this.a = 'xy'; }
  get b() { return 'no integer'; }
}
class Throws {
  constructor() { this.a = 'xy'; }
  get b() { throw new Error('read an inherited member'); }
}
const nonEnumerable = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: false });

const MEMBERS = { a: { type: 'string' }, b: { type: 'integer' }, c: { type: 'boolean' } };

/** [label, schema] */
const SCHEMAS = [
  ['properties', { properties: MEMBERS }],
  ['properties and required', { properties: MEMBERS, required: ['a'] }],
  ['properties, required and additionalProperties: false', { properties: MEMBERS, required: ['a'], additionalProperties: false }],
  ['properties, required and an additionalProperties schema', { properties: MEMBERS, required: ['a'], additionalProperties: { type: 'integer' } }],
  ['properties and required where annotations are kept', { $schema: D2019, properties: MEMBERS, required: ['a'], unevaluatedProperties: true }],
];

/** [label, maker, answers in SCHEMAS order] */
const INSTANCES = [
  ['every member', () => ({ a: 'xy', b: 1, c: true }), [true, true, true, true, true]],
  ['the required member alone', () => ({ a: 'xy' }), [true, true, true, true, true]],
  ['no member', () => ({}), [true, false, false, false, false]],
  ['a member of the wrong type', () => ({ a: 'xy', b: 'q' }), [false, false, false, false, false]],
  ['the required member of the wrong type', () => ({ a: 1 }), [false, false, false, false, false]],
  ['an undeclared member', () => ({ a: 'xy', z: 'q' }), [true, true, false, false, true]],
  ['an undeclared integer member', () => ({ a: 'xy', z: 1 }), [true, true, false, true, true]],
  ['an inherited member of the wrong type', () => Object.assign(Object.create({ b: 'q' }), { a: 'xy' }), [true, true, true, true, true]],
  ['the required member inherited', () => Object.create({ a: 'xy' }), [true, false, false, false, false]],
  ['an inherited enumerable undeclared member', () => Object.assign(Object.create({ z: 'q' }), { a: 'xy' }), [true, true, true, true, true]],
  ['an own non-enumerable undeclared member', () => nonEnumerable({ a: 'xy' }, 'z', 'q'), [true, true, true, true, true]],
  ['the required member own and non-enumerable', () => nonEnumerable({}, 'a', 'xy'), [true, true, true, true, true]],
  ['the required member own, non-enumerable and of the wrong type', () => nonEnumerable({}, 'a', 1), [false, false, true, true, false]],
  ['an own non-enumerable member shadowing an inherited enumerable one', () => nonEnumerable(Object.assign(Object.create({ z: 'q' }), { a: 'xy' }), 'z', 'q'), [true, true, true, true, true]],
  ['a symbol-keyed member', () => ({ a: 'xy', [Symbol('z')]: 'q' }), [true, true, true, true, true]],
  ['an integer-keyed member', () => ({ a: 'xy', 0: 'q' }), [true, true, false, false, true]],
  ['a member deleted before', () => { const o = { a: 'xy', z: 'q', b: 1 }; delete o.z; return o; }, [true, true, true, true, true]],
  ['a null-prototype object', () => Object.assign(Object.create(null), { a: 'xy', b: 1 }), [true, true, true, true, true]],
  ['a null-prototype object with an undeclared member', () => Object.assign(Object.create(null), { a: 'xy', z: 'q' }), [true, true, false, false, true]],
  ['a null-prototype object of the wrong type', () => Object.assign(Object.create(null), { b: 'q' }), [false, false, false, false, false]],
  ['a class instance whose accessor is inherited', () => new Inherits(), [true, true, true, true, true]],
  ['a class instance whose inherited accessor throws', () => new Throws(), [true, true, true, true, true]],
  ['a Proxy of an object', () => new Proxy({ a: 'xy', b: 1 }, {}), [true, true, true, true, true]],
  ['a Proxy of an object of the wrong type', () => new Proxy({ a: 'xy', b: 'q' }, {}), [false, false, false, false, false]],
  ['a Map', () => new Map([['a', 1]]), [true, false, false, false, false]],
  ['a typed array', () => new Uint8Array(2), [true, false, false, false, false]],
  ['a String wrapper', () => new String('ab'), [true, false, false, false, false]],
  ['an array', () => ['xy'], [true, true, true, true, true]],
  ['an own __proto__ member', () => JSON.parse('{ "__proto__": "q", "a": "xy" }'), [true, true, false, false, true]],
  ['an own hasOwnProperty member', () => ({ hasOwnProperty: 'q', a: 'xy' }), [true, true, false, false, true]],
];

describe('the member walks of properties, required and additionalProperties', function () {
  for (const [label, schema] of SCHEMAS) {
    const validate = new JarenValidator().compile(schema);
    const collect = new JarenValidator({ collectErrors: true }).compile(schema);
    for (const [name, make, answers] of INSTANCES.map(([n, m, a]) => [n, m, a[SCHEMAS.findIndex(([l]) => l === label)]])) {
      it(`${label}: ${name} answers ${answers}`, function () {
        assert.strictEqual(validate(make()), answers);
        assert.strictEqual(collect(make()).valid, answers);
      });
    }
  }
});

// A name the schema declares under properties that the prototype holds:
// what the prototype holds is absent, an own member is read.
describe('declared names the prototype holds', function () {
  const schema = { properties: { toString: { type: 'string' }, constructor: { type: 'string' }, ['__proto__']: { type: 'string' } } };
  /** [label, maker, answer alone, with required: ['toString'], closed] */
  const CASES = [
    ['a plain object', () => ({}), true, false, true],
    ['own members of the declared types', () => JSON.parse('{ "toString": "a", "constructor": "b", "__proto__": "c" }'), true, true, true],
    ['an own toString of the wrong type', () => ({ toString: 1 }), false, false, false],
    ['an own __proto__ of the wrong type', () => JSON.parse('{ "__proto__": 1 }'), false, false, false],
  ];
  const alone = new JarenValidator().compile(schema);
  const required = new JarenValidator().compile({ ...schema, required: ['toString'] });
  const closed = new JarenValidator().compile({ ...schema, additionalProperties: false });
  for (const [label, make, answer, requiredAnswer, closedAnswer] of CASES) {
    it(`${label}`, function () {
      assert.deepStrictEqual([alone(make()), required(make()), closed(make())], [answer, requiredAnswer, closedAnswer]);
    });
  }
});

// A `required` name `properties` does not declare is read by `required`
// alone, beside each walk.
describe('a required name properties does not declare', function () {
  const required = ['a', 'z'];
  /** [label, schema] */
  const WALKS = [
    ['properties', { properties: MEMBERS, required }],
    ['an additionalProperties schema', { properties: MEMBERS, required, additionalProperties: { type: 'integer' } }],
    ['annotations kept', { $schema: D2019, properties: MEMBERS, required, unevaluatedProperties: true }],
  ];
  /** [label, maker, answer] */
  const CASES = [
    ['both names', () => ({ a: 'xy', z: 1 }), true],
    ['the undeclared name missing', () => ({ a: 'xy' }), false],
    ['the undeclared name own and non-enumerable', () => nonEnumerable({ a: 'xy' }, 'z', 'q'), true],
    ['the undeclared name inherited', () => Object.assign(Object.create({ z: 1 }), { a: 'xy' }), false],
  ];
  for (const [label, schema] of WALKS) {
    const validate = new JarenValidator().compile(schema);
    for (const [name, make, answer] of CASES) {
      it(`${label}: ${name} answers ${answer}`, function () {
        assert.strictEqual(validate(make()), answer);
      });
    }
  }
});
