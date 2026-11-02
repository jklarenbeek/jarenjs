import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { JarenValidator } from '@jarenjs/validate';

// A compiled schema is a tree of closures every schema of a kind shares, so
// each closure between the entry and the check that answers is a call that
// sees every schema's children. The element walk of a lone `items` or
// `prefixItems`, a tuple position, and a reference resolved on first use run
// without a closure of their own around them, and a tuple whose positions
// compile to constant answers or type-only tests is tested by code with no
// call per element; these tests count the frames between the entry and a
// format check, pin that each shortcut answers as the composition it
// replaces, and that the tuple tested by code reads no element past its
// positions.

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
