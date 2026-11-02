import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { JarenValidator } from '@jarenjs/validate';

// A compiled schema is a tree of closures every schema of a kind shares, so
// each closure between the entry and the check that answers is a call that
// sees every schema's children. The element walk of a lone `items` or
// `prefixItems`, a tuple position, and a reference resolved on first use run
// without a closure of their own around them; a leading `type` of `object` or
// `array` is tested by the member or element walk of that kind, and
// `properties` with `additionalProperties` is one walk; a tuple whose
// positions compile to constant answers or type-only tests, homogeneous
// items of one such test, and a member whose schema is type-only or asserts
// nothing are tested by code with no call per element or member. These tests
// count the frames between the entry and a format check, pin that each
// shortcut answers as the composition it replaces, and pin what each walk
// reads: the tuple tested by code no element past its positions, the items
// tested by code every element, and a leading type the instance class once.

/**
 * Frames between `entry` and the format check, in the first-failure mode, on
 * a second validation (the first resolves the references it meets).
 */
function framesToCheck(schema, data) {
  let frames = -1;
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 200;
  try {
    const validate = new JarenValidator({ formatAssertion: true })
      .addFormats({
        probe: () => function probe() {
          const lines = String(new Error().stack).split('\n').slice(2);
          frames = lines.findIndex((line) => line.includes('entry'));
          return true;
        },
      })
      .compile(schema);
    validate(data);
    (function entry() { validate(data); })();
  }
  finally {
    Error.stackTraceLimit = limit;
  }
  return frames;
}

describe('closures between the entry and the check', function () {
  it('a lone element walk tests the array class itself', function () {
    assert.strictEqual(framesToCheck({ items: { format: 'probe' } }, ['x']), 2);
  });

  it('a tuple position is called by the element walk', function () {
    assert.strictEqual(framesToCheck({ prefixItems: [{ format: 'probe' }] }, ['x']), 2);
  });

  it('a leading type of object or array is tested by the walk of that kind', function () {
    assert.strictEqual(framesToCheck({ type: 'object', properties: { a: { format: 'probe' } } }, { a: 'x' }), 2);
    assert.strictEqual(framesToCheck({ type: 'array', items: { format: 'probe' } }, ['x']), 2);
  });

  it('properties with additionalProperties are walked by one closure', function () {
    assert.strictEqual(framesToCheck({ properties: { a: { format: 'probe' } }, additionalProperties: false }, { a: 'x' }), 2);
    assert.strictEqual(framesToCheck({ type: 'object', properties: { a: { format: 'probe' } }, required: ['a'], additionalProperties: false }, { a: 'x' }), 2);
    assert.strictEqual(framesToCheck({ properties: { a: {} }, additionalProperties: { format: 'probe' } }, { b: 'x' }), 2);
  });

  it('a reference resolved on first use counts toward the bound itself', function () {
    const schema = {
      $ref: '#/$defs/node',
      $defs: { node: { properties: { next: { $ref: '#/$defs/node' }, name: { format: 'probe' } } } },
    };
    assert.strictEqual(framesToCheck(schema, { next: { name: 'x' } }), 5);
  });
});

// Values a JSON parse never makes are in the matrix on purpose: the
// shortcuts must read them as the compositions they replace do.
class ArraySubclass extends Array {}
const VALUES = [
  undefined, null, true, false, 0, -0, 1, 1.5, -2, 2 ** 53, Infinity, -Infinity, NaN, 10n,
  '', 'x', 'abc', [], [1], ['a', 'b'], {}, { a: 1 }, Object.create(null),
  JSON.parse('{"constructor":1}'), new ArraySubclass(), new Date(0), /x/, new Map(), new Set(),
];
const TYPES = ['null', 'boolean', 'integer', 'number', 'string', 'object', 'array'];
const show = (value) => {
  try { return typeof value === 'bigint' ? `${value}n` : JSON.stringify(value) ?? String(value); }
  catch { return Object.prototype.toString.call(value); }
};

describe('the shortcuts answer as the compositions they replace', function () {
  const verdict = (schema, value, options = {}) => {
    const result = new JarenValidator(options).compile(schema)(value);
    return typeof result === 'object' ? result.valid : result;
  };

  it('a type name with other keywords answers as the one-name type list', function () {
    for (const type of TYPES) {
      for (const extra of [{ $comment: 'x' }, { maxLength: 1e9 }, { maxLength: 1e9, maxItems: 1e9 }]) {
        for (const value of VALUES) {
          assert.strictEqual(verdict({ type, ...extra }, value), verdict({ type: [type], ...extra }, value),
            `${type} ${JSON.stringify(extra)} ${show(value)}`);
          assert.strictEqual(verdict({ properties: { m: { type, ...extra } } }, { m: value }),
            verdict({ properties: { m: { type: [type], ...extra } } }, { m: value }));
        }
      }
    }
  });

  it('a lone bound or multipleOf answers as when errors are collected', function () {
    const schemas = [{ minimum: 0 }, { maximum: 0 }, { exclusiveMinimum: 0 }, { exclusiveMaximum: 0 },
      { multipleOf: 0.5 }, { minimum: 1, exclusiveMinimum: true, $schema: 'http://json-schema.org/draft-04/schema#' }];
    for (const schema of schemas) {
      for (const value of VALUES) {
        assert.strictEqual(verdict(schema, value), verdict(schema, value, { skipErrors: false, collectErrors: true }),
          `${JSON.stringify(schema)} ${show(value)}`);
      }
    }
  });

  it('a lone element walk and a tuple answer as when errors are collected', function () {
    const schemas = [{ items: { type: ['string'] } }, { prefixItems: [{ type: ['string'] }], items: false },
      { prefixItems: [{ minimum: 1 }], items: { type: ['string'] } }, { items: [{ maxLength: 1 }], additionalItems: { type: ['null'] }, $schema: 'http://json-schema.org/draft-07/schema#' },
      { contains: { const: 1 } }];
    const arrays = [[], ['a'], [1], ['a', 'b'], [1, null], ['ab', null], [2, 'x', 'y'], ...VALUES];
    for (const schema of schemas) {
      for (const value of arrays) {
        assert.strictEqual(verdict(schema, value), verdict(schema, value, { skipErrors: false, collectErrors: true }),
          `${JSON.stringify(schema)} ${show(value)}`);
      }
    }
  });

  it('a tuple of boolean and single-type positions answers as when errors are collected', function () {
    const draft7 = 'http://json-schema.org/draft-07/schema#';
    const schemas = [{ prefixItems: [{ type: 'boolean' }, { type: 'boolean' }] },
      { prefixItems: [{ type: 'integer' }, { type: 'string' }], items: false }, { prefixItems: [true, false] },
      { prefixItems: [{}, { type: 'null' }], items: true }, { prefixItems: [{ type: 'number' }], uniqueItems: true },
      { items: [{ type: 'number' }, { type: 'object' }, { type: 'array' }], additionalItems: false, $schema: draft7 },
      { items: [], additionalItems: false, $schema: draft7 }, { items: [{ type: 'string' }], additionalItems: {}, $schema: draft7 },
      { prefixItems: [{ type: 'string' }], items: { type: 'integer' } }, { prefixItems: [{ type: 'string' }, { minimum: 1 }], items: false }];
    const arrays = [[], [true], [true, false], [false, true, 'x', 'x'], [1, 'a'], [1.5, 'a', null], [NaN], [null, null],
      [1.5, {}, []], [2, [], {}], [2, {}, [], 'past'], [{}, {}], ['a', 1], [true, true],
      { constructor: Array, length: 1, 0: 'x' }, ArraySubclass.from([1, 'x']), ...VALUES];
    for (const schema of schemas) {
      for (const value of arrays) {
        assert.strictEqual(verdict(schema, value), verdict(schema, value, { skipErrors: false, collectErrors: true }),
          `${JSON.stringify(schema)} ${show(value)}`);
      }
    }
  });
});

// Objects a JSON parse never makes, for the member walks: getters (one
// throwing, read before or after an undeclared member), a proxy, inherited
// and non-enumerable members, a null prototype, a class instance, and the
// array-likes and arrays the object test admits or refuses.
class Point { constructor() { this.a = 'x'; } get b() { return 1; } get c() { throw new Error('getter'); } }
const throwingAt = (keys) => {
  const object = {};
  for (const key of keys) {
    if (key === 'a') Object.defineProperty(object, 'a', { get() { throw new Error('getter'); }, enumerable: true });
    else object[key] = 1;
  }
  return object;
};
const OBJECTS = [
  {}, { a: 'x' }, { a: 1 }, { a: 'x', b: 1 }, { b: 1, a: 'x' }, { a: 'x', b: 1, c: true }, { a: 'x', x: 1 },
  { x: 1, a: 'x' }, { a: undefined }, { a: NaN, b: NaN }, JSON.parse('{"__proto__":"x","a":"x"}'),
  Object.defineProperty({ a: 'x' }, 'b', { get() { return 1; }, enumerable: true }), throwingAt(['x', 'a']),
  throwingAt(['a', 'x']), throwingAt(['b', 'a']), new Proxy({ a: 'x', b: 1 }, {}), Object.create({ a: 'x', b: 1 }),
  Object.defineProperty({ b: 1 }, 'a', { value: 'x', enumerable: false }), Object.assign(Object.create(null), { a: 'x', b: 1 }),
  new Point(), ArraySubclass.from(['x']), { constructor: Array }, { constructor: Array, length: 1, 0: 'x' },
  Object.assign(['x'], { constructor: Object }), ...VALUES,
];
const outcome = (validate, value) => {
  try {
    const result = validate(value);
    return typeof result === 'object' ? result.valid : result;
  }
  catch (error) {
    return `throws ${error.message}`;
  }
};

describe('the object and array walks answer as the compositions they replace', function () {
  const compile = (schema) => new JarenValidator().compile(schema);

  it('a leading type with a member or element walk answers as the one-name type list', function () {
    const extras = [{ properties: { a: { type: 'string' }, b: {} } },
      { properties: { a: { type: 'string' }, b: { type: 'integer' } }, required: ['a'] },
      { properties: { a: { type: 'string', maxLength: 3 } }, required: ['a', 'b'] },
      { properties: { a: { type: 'string' } }, additionalProperties: false },
      { properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: { type: 'integer' } },
      { properties: {}, required: ['a'] }, { minProperties: 1 }, { required: ['a'], maxProperties: 2 },
      { items: { type: 'string' } }, { items: { type: 'string', maxLength: 1 } }, { items: {} }];
    const values = [...OBJECTS, ['x', 'y'], ['x', 1], [null], ArraySubclass.from([1])];
    for (const type of ['object', 'array']) {
      for (const extra of extras) {
        const one = compile({ type, ...extra });
        const list = compile({ type: [type], ...extra });
        for (const value of values) {
          assert.strictEqual(outcome(one, value), outcome(list, value), `${type} ${JSON.stringify(extra)} ${show(value)}`);
        }
      }
    }
  });

  it('properties with additionalProperties answer as the general member walk', function () {
    const schemas = [{ properties: { a: { type: 'string' } }, additionalProperties: false },
      { properties: { a: { type: 'string' }, b: { type: 'integer' } }, required: ['a'], additionalProperties: false },
      { properties: { a: {}, b: { type: 'integer', minimum: 1 } }, required: ['b', 'a'], additionalProperties: true },
      { properties: { b: { type: 'integer' }, a: { type: 'string' } }, additionalProperties: {} },
      { properties: { a: { type: 'string' } }, additionalProperties: { type: 'integer' } },
      { properties: { a: { type: 'string' } }, additionalProperties: { not: {} } },
      { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false }];
    for (const schema of schemas) {
      const walk = compile(schema);
      // minProperties: 0 asserts nothing and keeps the schema off the fast path
      const general = compile({ ...schema, minProperties: 0 });
      for (const value of OBJECTS) {
        assert.strictEqual(outcome(walk, value), outcome(general, value), `${JSON.stringify(schema)} ${show(value)}`);
      }
    }
  });

  it('properties with additionalProperties evaluate the members an unevaluatedProperties beside them reads', function () {
    const pair = { a: 1, b: 2 };
    for (const additionalProperties of [true, {}, { type: 'integer' }]) {
      const schema = { allOf: [{ properties: { a: {} }, additionalProperties }], unevaluatedProperties: false };
      assert.strictEqual(compile(schema)(pair), true, JSON.stringify(schema));
    }
    const branch = { anyOf: [{ properties: { a: { type: 'integer' } }, additionalProperties: false }, { properties: { b: {} } }], unevaluatedProperties: false };
    assert.strictEqual(compile(branch)({ a: 1 }), true);
    assert.strictEqual(compile(branch)({ a: 1, c: 1 }), false);
  });

  it('a declared member is tested only when it is an own member', function () {
    const validate = compile({ properties: { a: { type: 'string' }, b: { type: 'integer' } }, required: ['a'] });
    assert.strictEqual(validate(Object.assign(Object.create({ b: 'y' }), { a: 'x' })), true);
    assert.strictEqual(validate(Object.assign(Object.create({ a: 'x' }), { b: 1 })), false);
    assert.strictEqual(validate({ a: 'x', b: 'y' }), false);
  });

  it('items of one type-only test answer as items of a composition of it', function () {
    const arrays = [[], ['x'], ['x', 'y'], [1], [1, 2.5], [1.5, NaN], [null], [true, false], [[]], [{}], [{}, []],
      ['x', 1, null], [2 ** 53, -0], ArraySubclass.from(['x']), { constructor: Array, length: 1, 0: 'x' }];
    for (const type of TYPES) {
      const pure = compile({ items: { type } });
      const composed = compile({ items: { anyOf: [{ type }] } });
      for (const value of [...arrays, ...VALUES])
        assert.strictEqual(pure(value), composed(value), `${type} ${show(value)}`);
    }
  });

  it('a type-only member answers as the type-only schema', function () {
    for (const type of TYPES) {
      const member = compile({ type });
      const walks = [compile({ properties: { m: { type } } }), compile({ properties: { m: { type }, n: {} }, required: ['m'] }),
        compile({ properties: { m: { type } }, additionalProperties: false })];
      const additional = compile({ properties: { n: {} }, additionalProperties: { type } });
      for (const value of VALUES) {
        for (const walk of walks)
          assert.strictEqual(walk({ m: value }), member(value), `${type} ${show(value)}`);
        assert.strictEqual(additional({ m: value }), member(value), `${type} ${show(value)}`);
      }
    }
  });
});

describe('the member and element walks read as the compositions they replace', function () {
  // An object whose `constructor` reads are counted.
  const countedConstructor = (target, type) => {
    const reads = { count: 0 };
    Object.defineProperty(target, 'constructor', { get() { reads.count++; return type; } });
    return { data: target, reads };
  };

  it('a leading type of object or array reads the instance class once', function () {
    for (const schema of [{ type: 'object', properties: { a: { type: 'string' } } },
      { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
      { type: 'object', properties: { a: { type: 'string' } }, minProperties: 1 }]) {
      const { data, reads } = countedConstructor({ a: 'x' }, Object);
      assert.strictEqual(new JarenValidator().compile(schema)(data), true);
      assert.strictEqual(reads.count, 1, JSON.stringify(schema));
    }
    for (const schema of [{ type: 'array', items: { type: 'string' } }, { type: 'array', items: { type: 'string', maxLength: 3 } }]) {
      const { data, reads } = countedConstructor(['x'], Array);
      assert.strictEqual(new JarenValidator().compile(schema)(data), true);
      assert.strictEqual(reads.count, 1, JSON.stringify(schema));
    }
  });

  // The own members a proxy is asked for, in order.
  const probed = (target) => {
    const seen = [];
    const data = new Proxy(target, {
      getOwnPropertyDescriptor(object, key) { seen.push(key); return Reflect.getOwnPropertyDescriptor(object, key); },
    });
    return { data, seen };
  };

  it('properties with additionalProperties list the members, then probe the required ones, then read in instance order', function () {
    const validate = new JarenValidator().compile({ properties: { a: { type: 'string' }, b: { type: 'integer' } }, required: ['a'], additionalProperties: false });
    const { data, seen } = probed({ a: 'x', b: 1 });
    assert.strictEqual(validate(data), true);
    assert.deepStrictEqual(seen, ['a', 'b', 'a']);
    const closed = new JarenValidator().compile({ properties: { a: { type: 'string' } }, additionalProperties: false });
    assert.strictEqual(outcome(closed, throwingAt(['x', 'a'])), false);
    assert.strictEqual(outcome(closed, throwingAt(['a', 'x'])), 'throws getter');
  });

  it('items of one type-only test read every element, past a failing one too', function () {
    const reads = { count: 0 };
    const data = [];
    [1, 'x', 'y'].forEach((value, i) => Object.defineProperty(data, i, { get() { reads.count++; return value; }, enumerable: true }));
    assert.strictEqual(new JarenValidator().compile({ items: { type: 'string' } })(data), false);
    assert.strictEqual(reads.count, 3);
  });
});

describe('a tuple of boolean and single-type positions', function () {
  // An array whose element reads are counted.
  const counted = (values) => {
    const reads = { count: 0 };
    const data = [];
    values.forEach((value, i) => Object.defineProperty(data, i, {
      get() { reads.count++; return value; },
      enumerable: true,
    }));
    return { data, reads };
  };

  it('reads its positions only, and no element when it is closed and the array is longer', function () {
    const open = new JarenValidator().compile({ prefixItems: [{ type: 'boolean' }, { type: 'boolean' }] });
    const closed = new JarenValidator().compile({ prefixItems: [{ type: 'boolean' }, true], items: false });
    const longer = counted([true, false, 'x', 'y', 'z']);
    assert.strictEqual(open(longer.data), true);
    assert.strictEqual(longer.reads.count, 2);
    const shorter = counted([true]);
    assert.strictEqual(open(shorter.data), true);
    assert.strictEqual(shorter.reads.count, 1);
    const past = counted([true, false, 'x']);
    assert.strictEqual(closed(past.data), false);
    assert.strictEqual(past.reads.count, 0);
  });
});
