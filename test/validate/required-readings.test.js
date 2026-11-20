import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as assert from '../assert.node.js';

import { JarenValidator } from '@jarenjs/validate';

// `required`, the names `dependentRequired` and a `dependencies` list
// require, and the member that triggers a dependency keyword read an own
// non-enumerable member as present, as they read an enumerable one, and an
// inherited member as absent; whatever keyword sits beside them and in both
// modes. They apply to the values `type: 'object'` takes. Each schema below
// is answered by another closure, so a closure that reads a member its own
// way fails here. `undefined` is not in this corpus: a member holding it has
// its own reading.

class Sub extends Array {}
class Reading {
  constructor() { this.z = 1; }
  get a() { return 1; }
}
// A maker of another realm's array: its Array is not this one's.
const realm = runInNewContext('({ array: () => [1] })');

const D2019 = 'https://json-schema.org/draft/2019-09/schema';

const same = (value) => value;
// what a schema answers for an object by whether the member is there, and
// for a value that is no object
const applies = (isObject, present) => !isObject || present;
const typed = (isObject, present) => isObject && present;

/** [what selects the closure, the schema, the instance holding the value, the expected answer] */
const READERS = [
  ['alone', { required: ['a'] }, same, applies],
  ['beside an annotation', { required: ['a'], title: 't' }, same, applies],
  ['beside minProperties', { required: ['a'], minProperties: 1 }, same, applies],
  ['beside maxProperties', { required: ['a'], maxProperties: 9 }, same, applies],
  ['beside minProperties and maxProperties', { required: ['a'], minProperties: 1, maxProperties: 9 }, same, applies],
  ['beside properties', { properties: { a: {} }, required: ['a'] }, same, applies],
  ['beside properties and additionalProperties', { properties: { a: {} }, required: ['a'], additionalProperties: true }, same, applies],
  ['beside properties and an additionalProperties schema', { properties: { a: {} }, required: ['a'], additionalProperties: {} }, same, applies],
  ['beside properties where annotations are kept', { $schema: D2019, properties: { a: {} }, required: ['a'], unevaluatedProperties: true }, same, applies],
  ['beside properties with a location reader below', { properties: { a: {}, q: { const: { $data: '1/z' } } }, required: ['a'] }, same, applies],
  ['beside patternProperties', { patternProperties: { '^q': {} }, required: ['a'] }, same, applies],
  ['beside propertyNames', { propertyNames: {}, required: ['a'] }, same, applies],
  ['beside type', { type: 'object', required: ['a'] }, same, typed],
  ['beside type and properties', { type: 'object', properties: { a: {} }, required: ['a'] }, same, typed],
  ['as an item schema', { items: { required: ['a'] } }, (value) => [value], applies],
  ['as an item schema beside an annotation', { items: { required: ['a'], title: 't' } }, (value) => [value], applies],
  ['as a member schema', { properties: { m: { required: ['a'] } } }, (value) => ({ m: value }), applies],
  ['from a $data reference', { properties: { o: { required: { $data: '1/names' } } } }, (value) => ({ o: value, names: ['a'] }), applies],
  ['behind $ref', { $ref: '#/definitions/r', definitions: { r: { required: ['a'] } } }, same, applies],
  ['inside allOf', { allOf: [{ required: ['a'] }] }, same, applies],
  ['inside anyOf', { anyOf: [{ required: ['a'] }] }, same, applies],
  ['inside dependentSchemas', { $schema: D2019, dependentSchemas: { z: { required: ['a'] } } }, same, applies],
  ['inside a schema dependency', { dependencies: { z: { required: ['a'] } } }, same, applies],
  ['as a dependentRequired name', { $schema: D2019, dependentRequired: { z: ['a'] } }, same, applies],
  ['as a dependentRequired name beside properties', { $schema: D2019, properties: { z: {} }, dependentRequired: { z: ['a'] } }, same, applies],
  ['as a dependencies name', { dependencies: { z: ['a'] } }, same, applies],
  ['as a name of one of two dependencies', { dependencies: { z: ['a'], y: ['a'] } }, same, applies],
  ['as a dependencies name beside a schema dependency', { dependencies: { z: ['a'], y: {} } }, same, applies],
];

/** [label, a maker (every value holds an enumerable own `z`), whether it is an object, whether `a` is there] */
const INSTANCES = [
  ['a plain object without the member', () => ({ z: 1 }), true, false],
  ['a plain object with the member', () => ({ a: 1, z: 1 }), true, true],
  ['an own non-enumerable member', () => Object.defineProperty({ z: 1 }, 'a', { value: 1 }), true, true],
  ['an own non-enumerable accessor', () => Object.defineProperty({ z: 1 }, 'a', { get() { return 1; } }), true, true],
  ['an inherited member', () => Object.assign(Object.create({ a: 1 }), { z: 1 }), true, false],
  ['a member the class holds as an accessor', () => new Reading(), true, false],
  ['a null-prototype object with the member', () => Object.assign(Object.create(null), { a: 1, z: 1 }), true, true],
  ['a null-prototype object without the member', () => Object.assign(Object.create(null), { z: 1 }), true, false],
  ['{ constructor: Array } without the member', () => ({ constructor: Array, z: 1 }), true, false],
  ['{ constructor: Array } with the member', () => ({ constructor: Array, a: 1, z: 1 }), true, true],
  ['an object whose prototype is an array, without the member', () => Object.setPrototypeOf({ z: 1 }, []), true, false],
  ['an object whose prototype is an array, with the member', () => Object.setPrototypeOf({ a: 1, z: 1 }, []), true, true],
  ['a Proxy of an object without the member', () => new Proxy({ z: 1 }, {}), true, false],
  ['a Proxy of an object with a non-enumerable member', () => new Proxy(Object.defineProperty({ z: 1 }, 'a', { value: 1 }), {}), true, true],
  ['a Map without the member', () => Object.assign(new Map(), { z: 1 }), true, false],
  ['an Array subclass instance without the member', () => Object.assign(new Sub(), { z: 1 }), false, false],
  ['an Array subclass instance with a member of that name', () => Object.assign(new Sub(), { a: 1, z: 1 }), false, true],
  ['an array of another realm', () => Object.assign(realm.array(), { z: 1 }), false, false],
  ['an array with an own constructor member', () => Object.assign([1], { constructor: Object, z: 1 }), false, false],
];

/** [the keyword a member `t` triggers, a schema an object holding `t` fails] */
const TRIGGERED = [
  ['dependentRequired', { $schema: D2019, dependentRequired: { t: ['missing'] } }],
  ['dependentRequired beside properties', { $schema: D2019, properties: { z: {} }, dependentRequired: { t: ['missing'] } }],
  ['dependentSchemas', { $schema: D2019, dependentSchemas: { t: false } }],
  ['dependentSchemas beside required', { $schema: D2019, required: ['z'], dependentSchemas: { t: false } }],
  ['a dependencies list', { dependencies: { t: ['missing'] } }],
  ['a dependencies schema', { dependencies: { t: false } }],
  ['one of two dependencies lists', { dependencies: { t: ['missing'], u: ['z'] } }],
  ['a dependencies list beside a schema dependency', { dependencies: { t: ['missing'], u: {} } }],
  ['a schema dependency beside a list', { dependencies: { t: false, u: ['z'] } }],
  ['a dependencies list beside minProperties', { dependencies: { t: ['missing'] }, minProperties: 1 }],
  ['a dependencies list beside patternProperties', { dependencies: { t: ['missing'] }, patternProperties: { '^q': {} } }],
];

/** [label, a maker, whether the member `t` triggers] */
const TRIGGERS = [
  ['an own enumerable member', () => ({ t: 1, z: 1 }), true],
  ['an own non-enumerable member', () => Object.defineProperty({ z: 1 }, 't', { value: 1 }), true],
  ['an own non-enumerable accessor', () => Object.defineProperty({ z: 1 }, 't', { get() { return 1; } }), true],
  ['a member of { constructor: Array }', () => ({ constructor: Array, t: 1, z: 1 }), true],
  ['a non-enumerable member of a null-prototype object', () => Object.defineProperty(Object.assign(Object.create(null), { z: 1 }), 't', { value: 1 }), true],
  ['an inherited member', () => Object.assign(Object.create({ t: 1 }), { z: 1 }), false],
  ['no such member', () => ({ z: 1 }), false],
  ['a member of an Array subclass instance', () => Object.assign(new Sub(), { t: 1, z: 1 }), false],
];

const MODES = [
  ['when validation stops at the first failure', new JarenValidator(), (result) => result],
  ['when errors are collected', new JarenValidator({ collectErrors: true }), (result) => result.valid],
];

for (const [mode, jaren, read] of MODES) {
  describe(`required reads a member one way, ${mode}`, () => {
    for (const [label, make, isObject, present] of INSTANCES) {
      it(`${label}: ${isObject ? (present ? 'present' : 'absent') : 'no object'} to every reader`, () => {
        const strays = [];
        for (const [reader, schema, instanceOf, expected] of READERS) {
          const got = read(jaren.compile(schema)(instanceOf(make())));
          if (got !== expected(isObject, present)) strays.push(`${reader}: ${got}`);
        }
        assert.deepEqual(strays, []);
      });
    }
  });

  describe(`a dependency keyword is triggered by a non-enumerable member as by an enumerable one, ${mode}`, () => {
    for (const [label, make, triggers] of TRIGGERS) {
      it(`${label} ${triggers ? 'triggers' : 'does not trigger'} every keyword`, () => {
        const strays = [];
        for (const [keyword, schema] of TRIGGERED) {
          const got = read(jaren.compile(schema)(make()));
          if (got !== !triggers) strays.push(`${keyword}: ${got}`);
        }
        assert.deepEqual(strays, []);
      });
    }
  });
}

describe('a dependency keyword naming many triggers', () => {
  // 40 triggers, each requiring a member no instance holds
  const names = Array.from({ length: 40 }, (_, i) => `k${i}`);
  const schemas = [
    ['dependencies', { dependencies: Object.fromEntries(names.map((name) => [name, ['missing']])) }],
    ['dependentRequired', { $schema: D2019, dependentRequired: Object.fromEntries(names.map((name) => [name, ['missing']])) }],
    ['dependentSchemas', { $schema: D2019, dependentSchemas: Object.fromEntries(names.map((name) => [name, { required: ['missing'] }])) }],
  ];
  const hidden = (target, ...keys) => keys.reduce((object, key) => Object.defineProperty(object, key, { value: 1 }), target);
  const listed = () => Object.fromEntries(names.map((name) => [name, 1]));

  for (const [keyword, schema] of schemas) {
    it(`${keyword} is triggered once by each of its members, enumerable or not`, () => {
      const first = new JarenValidator().compile(schema);
      const collecting = new JarenValidator({ collectErrors: true }).compile(schema);
      const faults = (data) => collecting(data).errors.length;
      assert.isTrue(first({ z: 1 }));
      assert.strictEqual(faults({ z: 1 }), 0);
      assert.isTrue(first(Object.assign(Object.create({ k3: 1, k35: 1 }), { z: 1 })));
      for (const keys of [['k3'], ['k35'], ['k3', 'k35'], ['k0', 'k30', 'k31', 'k39']]) {
        assert.isFalse(first(hidden({ z: 1 }, ...keys)), keys.join());
        assert.strictEqual(faults(hidden({ z: 1 }, ...keys)), keys.length, keys.join());
      }
      assert.isFalse(first(listed()));
      assert.strictEqual(faults(listed()), 40);
      // listed and unlisted triggers together: each once
      assert.strictEqual(faults(hidden({ k2: 1, k33: 1 }, 'k4', 'k36')), 4);
    });
  }
});

describe('required beside a count keyword', () => {
  it('counts the members Object.keys lists and reads a non-enumerable member as present', () => {
    const jaren = new JarenValidator();
    const hidden = () => Object.defineProperty({ z: 1 }, 'a', { value: 1 });
    assert.isTrue(jaren.compile({ required: ['a'], maxProperties: 1 })(hidden()));
    assert.isFalse(jaren.compile({ required: ['a'], minProperties: 2 })(hidden()));
    assert.isTrue(jaren.compile({ required: ['a'], minProperties: 1, maxProperties: 1 })(hidden()));
    assert.isFalse(jaren.compile({ required: ['a'], minProperties: 2, maxProperties: 5 })(hidden()));
  });

  it('reports each absent name once when errors are collected', () => {
    const jaren = new JarenValidator({ collectErrors: true });
    const names = (schema, data) => jaren.compile(schema)(data).errors.map((error) => error.keyword);
    const inherited = () => Object.assign(Object.create({ a: 1 }), { z: 1 });
    assert.deepEqual(names({ required: ['a', 'b'], maxProperties: 9 }, inherited()), ['required', 'required']);
    assert.deepEqual(names({ required: ['a', 'b'], minProperties: 1 }, inherited()), ['required', 'required']);
    assert.deepEqual(names({ required: ['a', 'b'], minProperties: 1, maxProperties: 9 }, inherited()), ['required', 'required']);
  });
});
