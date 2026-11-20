import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import * as assert from '../assert.node.js';

import { JarenValidator } from '@jarenjs/validate';

// The array keywords apply to exactly the values `type: 'array'` takes (what
// Array.isArray takes) and the object keywords to exactly the values
// `type: 'object'` takes (any other non-null object), in both modes: a
// keyword group that tests its instance another way fails here. `undefined`
// is not in this corpus.

class Sub extends Array {}
class Empty {}
function argumentsOf() { return arguments; }
// Makers of another realm's values: its Array and Object are not this one's.
const realm = runInNewContext('({ arrayOf: (items) => Array.from(items), objectOf: (members) => Object.assign({}, members) })');

const D07 = 'http://json-schema.org/draft-07/schema#';
const D2019 = 'https://json-schema.org/draft/2019-09/schema';
const D2020 = 'https://json-schema.org/draft/2020-12/schema';

const same = (value) => value;

/** [keyword, a schema, an array's elements that fail it, the instance holding the value] */
const ARRAY_KEYWORDS = [
  ['maxItems', { maxItems: 0 }, [1], same],
  ['minItems', { minItems: 2 }, [1], same],
  ['minItems and maxItems', { minItems: 2, maxItems: 3 }, [1], same],
  ['uniqueItems', { uniqueItems: true }, [1, 1], same],
  ['uniqueItems beside maxItems', { uniqueItems: true, maxItems: 5 }, [1, 1], same],
  ['items: false', { items: false }, [1], same],
  ['a type-only items', { items: { type: 'string' } }, [1], same],
  ['an items schema', { items: { type: 'string', minLength: 1 } }, [1], same],
  ['items beside maxItems', { items: { type: 'string' }, maxItems: 5 }, [1], same],
  ['maxItems beside a boolean contains and items', { maxItems: 0, contains: true, items: { type: 'number' } }, [1], same],
  ['a tuple of type-only positions', { $schema: D2020, prefixItems: [{ type: 'string' }] }, [1], same],
  ['a closed tuple', { $schema: D2020, prefixItems: [{ type: 'number' }], items: false }, [1, 2], same],
  ['a tuple position schema', { $schema: D2020, prefixItems: [{ minimum: 5 }] }, [1], same],
  ['additionalItems', { $schema: D07, items: [{}], additionalItems: false }, [1, 2], same],
  ['contains', { contains: { type: 'string' } }, [1], same],
  ['contains beside items', { items: { type: 'number' }, contains: { const: 5 } }, [1], same],
  ['minContains', { $schema: D2019, contains: { type: 'number' }, minContains: 2 }, [1], same],
  ['unevaluatedItems: false', { $schema: D2019, unevaluatedItems: false }, [1], same],
  ['an unevaluatedItems schema', { $schema: D2019, unevaluatedItems: { type: 'string' } }, [1], same],
  ['maxItems from a $data reference', { properties: { list: { maxItems: { $data: '1/max' } } } }, [1], (value) => ({ list: value, max: 0 })],
  ['uniqueItems from a $data reference', { properties: { list: { uniqueItems: { $data: '1/unique' } } } }, [1, 1], (value) => ({ list: value, unique: true })],
];

/** The values that are arrays: [label, a maker from the elements] */
const ARRAYS = [
  ['an array', (items) => [...items]],
  ['an Array subclass instance', (items) => Sub.from(items)],
  ['a Proxy of an array', (items) => new Proxy([...items], {})],
  ['an array of another realm', (items) => realm.arrayOf(items)],
  ['an array with an own constructor member', (items) => Object.assign([...items], { constructor: Object })],
];

/** The values that hold the same elements and a length, and are no arrays */
const ARRAY_LOOK_ALIKES = [
  ['{ constructor: Array }', (items) => ({ constructor: Array, ...items, length: items.length })],
  ['an object whose prototype is an array', (items) => Object.setPrototypeOf({ ...items, length: items.length }, [])],
  ['an object with the array prototype', (items) => Object.setPrototypeOf({ ...items, length: items.length }, Array.prototype)],
  ['a function whose constructor member is Array', (items) => Object.assign(function plain() {}, { constructor: Array, ...items })],
  ['an arguments object', (items) => argumentsOf(...items)],
  ['a typed array', (items) => Uint8Array.from(items)],
];

/** [keyword, a schema, an object's members that fail it, the instance holding the value, validator options] */
const OBJECT_KEYWORDS = [
  ['maxProperties', { maxProperties: 0 }, { a: 1 }, same],
  ['minProperties', { minProperties: 2 }, { a: 1 }, same],
  ['minProperties and maxProperties', { minProperties: 2, maxProperties: 3 }, { a: 1 }, same],
  ['required', { required: ['b'] }, { a: 1 }, same],
  ['required beside an annotation', { required: ['b'], title: 't' }, { a: 1 }, same],
  ['required beside maxProperties', { required: ['b'], maxProperties: 5 }, { a: 1 }, same],
  ['required beside minProperties', { required: ['b'], minProperties: 1 }, { a: 1 }, same],
  ['required beside both counts', { required: ['b'], minProperties: 1, maxProperties: 5 }, { a: 1 }, same],
  ['properties', { properties: { a: false } }, { a: 1 }, same],
  ['properties beside required', { properties: { a: {} }, required: ['b'] }, { a: 1 }, same],
  ['a closed properties', { properties: { b: {} }, additionalProperties: false }, { a: 1 }, same],
  ['properties where annotations are kept', { $schema: D2019, properties: { a: false }, unevaluatedProperties: true }, { a: 1 }, same],
  ['patternProperties', { patternProperties: { '^a': false } }, { a: 1 }, same],
  ['additionalProperties: false', { additionalProperties: false }, { a: 1 }, same],
  ['an additionalProperties schema', { additionalProperties: { type: 'string' } }, { a: 1 }, same],
  ['propertyNames', { propertyNames: false }, { a: 1 }, same],
  ['dependentRequired', { $schema: D2019, dependentRequired: { a: ['b'] } }, { a: 1 }, same],
  ['a dependencies list', { dependencies: { a: ['b'] } }, { a: 1 }, same],
  ['a dependencies schema', { dependencies: { a: false } }, { a: 1 }, same],
  ['dependentSchemas', { $schema: D2019, dependentSchemas: { a: false } }, { a: 1 }, same],
  ['unevaluatedProperties: false', { $schema: D2019, unevaluatedProperties: false }, { a: 1 }, same],
  ['an unevaluatedProperties schema', { $schema: D2019, unevaluatedProperties: { type: 'string' } }, { a: 1 }, same],
  ['propertyDependencies', { $schema: D2020, propertyDependencies: { a: { x: false } } }, { a: 'x' }, same, { propertyDependencies: true }],
  ['maxProperties from a $data reference', { properties: { o: { maxProperties: { $data: '1/max' } } } }, { a: 1 }, (value) => ({ o: value, max: 0 })],
  ['required from a $data reference', { properties: { o: { required: { $data: '1/names' } } } }, { a: 1 }, (value) => ({ o: value, names: ['b'] })],
];

/** The values that are objects: [label, a maker from the members] */
const OBJECTS = [
  ['a plain object', (members) => ({ ...members })],
  ['an object whose own constructor member is Array', (members) => Object.defineProperty({ ...members }, 'constructor', { value: Array })],
  ['an object whose prototype is an array', (members) => Object.setPrototypeOf({ ...members }, [])],
  ['an object with the array prototype', (members) => Object.setPrototypeOf({ ...members }, Array.prototype)],
  ['a null-prototype object', (members) => Object.assign(Object.create(null), members)],
  ['a class instance', (members) => Object.assign(new Empty(), members)],
  ['a Proxy of an object', (members) => new Proxy({ ...members }, {})],
  ['a Map with own members', (members) => Object.assign(new Map(), members)],
  ['an object of another realm', (members) => realm.objectOf(members)],
];

/** The values that hold the same own members and are arrays */
const ARRAYS_WITH_MEMBERS = [
  ['an array with own members', (members) => Object.assign([], members)],
  ['an Array subclass instance', (members) => Object.assign(new Sub(), members)],
  ['a Proxy of an array', (members) => new Proxy(Object.assign([], members), {})],
  ['an array of another realm', (members) => Object.assign(realm.arrayOf([]), members)],
  ['an array with an own constructor member', (members) => Object.assign([], members, { constructor: Object })],
];

const MODES = [
  ['when validation stops at the first failure', {}, (result) => result],
  ['when errors are collected', { collectErrors: true }, (result) => result.valid],
];

for (const [mode, modeOptions, read] of MODES) {
  const answer = (schema, instance, options = {}) => read(new JarenValidator({ ...modeOptions, ...options }).compile(schema)(instance));

  describe(`the array keywords apply to exactly the arrays, ${mode}`, () => {
    for (const [label, make] of ARRAYS) {
      it(`${label} is read by every array keyword`, () => {
        const strays = [];
        for (const [keyword, schema, items, instanceOf] of ARRAY_KEYWORDS) {
          if (answer(schema, instanceOf(make(items))) !== false) strays.push(keyword);
        }
        assert.deepEqual(strays, []);
      });
    }
    for (const [label, make] of ARRAY_LOOK_ALIKES) {
      it(`${label} is read by no array keyword`, () => {
        const strays = [];
        for (const [keyword, schema, items, instanceOf] of ARRAY_KEYWORDS) {
          if (answer(schema, instanceOf(make(items))) !== true) strays.push(keyword);
        }
        assert.deepEqual(strays, []);
      });
    }
  });

  describe(`the object keywords apply to exactly the objects, ${mode}`, () => {
    for (const [label, make] of OBJECTS) {
      it(`${label} is read by every object keyword`, () => {
        const strays = [];
        for (const [keyword, schema, members, instanceOf, options] of OBJECT_KEYWORDS) {
          if (answer(schema, instanceOf(make(members)), options) !== false) strays.push(keyword);
        }
        assert.deepEqual(strays, []);
      });
    }
    for (const [label, make] of ARRAYS_WITH_MEMBERS) {
      it(`${label} is read by no object keyword`, () => {
        const strays = [];
        for (const [keyword, schema, members, instanceOf, options] of OBJECT_KEYWORDS) {
          if (answer(schema, instanceOf(make(members)), options) !== true) strays.push(keyword);
        }
        assert.deepEqual(strays, []);
      });
    }
  });

  describe(`what a keyword evaluates reaches an outer unevaluated keyword, ${mode}`, () => {
    const EVALUATED_ITEMS = [
      { $schema: D2019, allOf: [{ unevaluatedItems: true }], unevaluatedItems: false },
      { $schema: D2019, items: true, unevaluatedItems: false },
      { $schema: D2019, allOf: [{ items: true }], unevaluatedItems: false },
      { $schema: D2019, allOf: [{ items: { type: 'number' } }], unevaluatedItems: false },
      { $schema: D2020, contains: { type: 'number' }, unevaluatedItems: false },
    ];
    const EVALUATED_MEMBERS = [
      { $schema: D2019, allOf: [{ unevaluatedProperties: true }], unevaluatedProperties: false },
      { $schema: D2019, properties: { a: {} }, unevaluatedProperties: false },
      { $schema: D2019, allOf: [{ additionalProperties: true }], unevaluatedProperties: false },
      { $schema: D2019, allOf: [{ patternProperties: { '^a': {} } }], unevaluatedProperties: false },
    ];

    for (const [label, make] of ARRAYS) {
      it(`the elements of ${label}`, () => {
        for (const schema of EVALUATED_ITEMS)
          assert.isTrue(answer(schema, make([1])), JSON.stringify(schema));
      });
    }
    for (const [label, make] of OBJECTS) {
      it(`the members of ${label}`, () => {
        for (const schema of EVALUATED_MEMBERS)
          assert.isTrue(answer(schema, make({ a: 1 })), JSON.stringify(schema));
      });
    }
  });

  describe(`properties reads an own non-enumerable member by its schema, ${mode}`, () => {
    const hidden = () => Object.defineProperty({ z: 1 }, 'a', { value: 1 });

    it('reads it where required is the only other object keyword of the schema', () => {
      const schemas = [
        { properties: { a: false } },
        { properties: { a: false }, required: ['z'] },
        { type: 'object', properties: { a: false } },
        { title: 't', properties: { a: false } },
        { properties: { a: { type: 'string' } } },
        { properties: { a: false, q: { const: { $data: '1/z' } } } },
        { $schema: D2019, properties: { a: false }, unevaluatedProperties: true },
        { allOf: [{ properties: { a: false } }] },
        { $ref: '#/definitions/p', definitions: { p: { properties: { a: false } } } },
      ];
      for (const schema of schemas)
        assert.isFalse(answer(schema, hidden()), JSON.stringify(schema));
      assert.isFalse(answer({ items: { properties: { a: false } } }, [hidden()]));
      assert.isFalse(answer({ properties: { m: { properties: { a: false } } } }, { m: hidden() }));
    });

    it('reads the members Object.keys lists beside a keyword that walks or counts them', () => {
      const schemas = [
        { properties: { a: false }, additionalProperties: true },
        { properties: { a: false }, additionalProperties: {} },
        { properties: { a: false }, additionalProperties: false, patternProperties: { '^z$': {} } },
        { properties: { a: false }, patternProperties: { '^q': {} } },
        { properties: { a: false }, propertyNames: {} },
        { properties: { a: false }, minProperties: 1 },
        { properties: { a: false }, maxProperties: 5 },
        { properties: { a: false }, dependencies: { q: ['z'] } },
        { $schema: D2019, properties: { a: false }, dependentRequired: { q: ['z'] } },
        { $schema: D2019, properties: { a: false }, dependentSchemas: { q: {} } },
      ];
      for (const schema of schemas)
        assert.isTrue(answer(schema, hidden()), JSON.stringify(schema));
    });

    it('reads no inherited member', () => {
      const inherited = () => Object.assign(Object.create({ a: 1 }), { z: 1 });
      for (const schema of [{ properties: { a: false } }, { properties: { a: false }, required: ['z'] }, { properties: { a: false }, additionalProperties: {} }])
        assert.isTrue(answer(schema, inherited()), JSON.stringify(schema));
    });
  });

  describe(`an object whose prototype is an array is no array, ${mode}`, () => {
    it('has its own length read by no array keyword', () => {
      let reads = 0;
      const make = () => Object.setPrototypeOf({ 0: 1, 1: 1, get length() { reads++; return 2; } }, []);
      for (const [keyword, schema, , instanceOf] of ARRAY_KEYWORDS)
        assert.isTrue(answer(schema, instanceOf(make())), keyword);
      assert.strictEqual(reads, 0);
    });
  });
}

describe('a member is read once', () => {
  it('by properties, when errors are collected', () => {
    const collecting = new JarenValidator({ collectErrors: true }).compile({ properties: { a: false, b: false, c: false } });
    const paths = (data) => collecting(data).errors.map((error) => error.instancePath);
    assert.deepEqual(paths({ b: 1, a: 1 }), ['/b', '/a']);
    assert.deepEqual(paths(Object.defineProperty({ b: 1 }, 'a', { value: 1 })), ['/b', '/a']);
    assert.deepEqual(paths(Object.defineProperty(Object.defineProperty({}, 'c', { value: 1 }), 'a', { value: 1 })), ['/a', '/c']);
  });

  it('by a dependency keyword it triggers, in both modes', () => {
    const schema = { $schema: D2019, dependentSchemas: { t: { properties: { g: { type: 'number' } } } } };
    for (const options of [{}, { collectErrors: true }]) {
      const validate = new JarenValidator(options).compile(schema);
      let reads = 0;
      validate({ t: 1, get g() { reads++; return 1; } });
      assert.strictEqual(reads, 1);
      reads = 0;
      validate(Object.defineProperty({ get g() { reads++; return 1; } }, 't', { value: 1 }));
      assert.strictEqual(reads, 1);
    }
  });
});

describe('properties naming many members', () => {
  // 40 members, none of which may be there
  const names = Array.from({ length: 40 }, (_, i) => `p${i}`);
  const schema = { properties: Object.fromEntries(names.map((name) => [name, false])) };
  const hidden = (target, ...keys) => keys.reduce((object, key) => Object.defineProperty(object, key, { value: 1 }), target);

  it('reads each own member it names once, listed or not, in both modes', () => {
    const first = new JarenValidator().compile(schema);
    const collecting = new JarenValidator({ collectErrors: true }).compile(schema);
    const faults = (data) => collecting(data).errors.length;
    assert.isTrue(first({ z: 1 }));
    assert.strictEqual(faults({ z: 1 }), 0);
    assert.isTrue(first(Object.assign(Object.create({ p3: 1, p35: 1 }), { z: 1 })));
    assert.strictEqual(faults(Object.assign(Object.create({ p3: 1, p35: 1 }), { z: 1 })), 0);
    for (const keys of [['p3'], ['p35'], ['p3', 'p35'], ['p0', 'p30', 'p31', 'p39']]) {
      assert.isFalse(first(hidden({ z: 1 }, ...keys)), keys.join());
      assert.strictEqual(faults(hidden({ z: 1 }, ...keys)), keys.length, keys.join());
    }
    assert.strictEqual(faults(Object.fromEntries(names.map((name) => [name, 1]))), 40);
    // listed and unlisted members together: each once, the listed ones first
    const mixed = collecting(hidden({ p33: 1, p2: 1 }, 'p36', 'p4'));
    assert.deepEqual(mixed.errors.map((error) => error.instancePath), ['/p33', '/p2', '/p4', '/p36']);
  });
});

describe('an object whose prototype is an array and whose length is 2 ** 53', () => {
  it('answers at once under every array keyword', () => {
    // A subprocess timeout turns a walk to that length into a test failure.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { JarenValidator } from '@jarenjs/validate';
      const D2019 = 'https://json-schema.org/draft/2019-09/schema';
      const schemas = [{ items: { type: 'number' } }, { items: { minimum: 1 } }, { contains: { type: 'number' } },
        { uniqueItems: true }, { maxItems: 3 }, { $schema: D2019, unevaluatedItems: { type: 'number' } },
        { type: 'object', items: { type: 'number' } }];
      const answers = [];
      for (const options of [{}, { collectErrors: true }]) {
        for (const schema of schemas) {
          const result = new JarenValidator(options).compile(schema)(Object.setPrototypeOf({ length: 2 ** 53 }, []));
          answers.push(typeof result === 'boolean' ? result : result.valid);
        }
      }
      console.log(answers.every((answer) => answer === true) && answers.length === 14);
    `], { encoding: 'utf8', timeout: 20000, env: { ...process.env, FORCE_COLOR: '0' } });
    assert.strictEqual(result.status, 0, result.error?.message ?? result.stderr);
    assert.strictEqual(result.stdout, 'true\n');
  });
});

// A type that also names the validator's own `set` or `map` kind: the array
// keywords still apply to an array and the object keywords to an object; a
// Set or a Map that type takes is read by none of them.
describe('a type naming set or map beside array or object', () => {
  const TYPED = [
    [{ type: ['array', 'set'], maxItems: 0 }, [[1], false], [[], true], [new Set([1]), true]],
    [{ type: ['array', 'set'], items: { type: 'string' } }, [[1], false], [['a'], true], [new Set([1]), true]],
    [{ type: ['set', 'array'], uniqueItems: true, minItems: 3 }, [[1, 1], false], [[1, 2, 3], true], [new Set([1]), true]],
    [{ type: ['object', 'map'], required: ['a'], maxProperties: 0 }, [{ b: 1 }, false], [{}, false], [new Map([['b', 1]]), true], [new Map(), true]],
    [{ type: ['object', 'map'], properties: { a: { type: 'string' } } }, [{ a: 1 }, false], [{ a: 's' }, true], [new Map([['a', 1]]), true]],
    [{ type: ['map', 'object'], additionalProperties: false }, [{ a: 1 }, false], [{}, true], [new Map([['a', 1]]), true]],
    [{ type: 'map', minProperties: 1 }, [new Map([['a', 1]]), true], [new Map(), true], [{}, false]],
    [{ type: 'set', maxItems: 0 }, [new Set([1]), true], [[1], false]],
  ];
  for (const [mode, modeOptions, read] of MODES) {
    it(`answers as the array or object type alone does for an array or object, ${mode}`, () => {
      for (const [schema, ...cells] of TYPED) {
        const validate = new JarenValidator(modeOptions).compile(schema);
        for (const [instance, expected] of cells)
          assert.strictEqual(read(validate(instance)), expected, `${JSON.stringify(schema)} on ${instance?.constructor?.name} ${JSON.stringify(instance instanceof Map || instance instanceof Set ? [...instance] : instance)}`);
      }
    });
  }

  it('reports the array and object keywords beside the type in collected errors', () => {
    const keywords = (schema, instance) => new JarenValidator({ collectErrors: true }).compile(schema)(instance).errors
      .map((e) => `${e.keyword}@${e.instancePath}`);
    assert.deepEqual(keywords({ type: ['array', 'set'], maxItems: 0 }, [1]), ['maxItems@']);
    assert.deepEqual(keywords({ type: ['object', 'map'], required: ['a'], maxProperties: 0 }, { b: 1 }), ['maxProperties@', 'required@']);
    assert.deepEqual(keywords({ type: 'set', maxItems: 0 }, [1]), ['type@', 'maxItems@']);
    assert.deepEqual(keywords({ type: 'map', required: ['a'] }, new Map([['b', 1]])), []);
  });
});
