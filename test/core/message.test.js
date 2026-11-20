//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatTemplateParam,
  formatMessageValue,
  compileMessageTemplate,
  compileMessageCatalog,
} from '@jarenjs/core/message';

describe('formatTemplateParam', function () {
  it('stringifies primitives and JSON-encodes containers', function () {
    assert.equal(formatTemplateParam('x'), 'x');
    assert.equal(formatTemplateParam(3), '3');
    assert.equal(formatTemplateParam(true), 'true');
    assert.equal(formatTemplateParam(null), 'null');
    assert.equal(formatTemplateParam(undefined), 'undefined');
    assert.equal(formatTemplateParam([1, 'a']), '["1","a"]'.replace(/"1"/, '1'));
    assert.equal(formatTemplateParam({ a: 1 }), '{"a":1}');
  });
});

describe('formatMessageValue', function () {
  it('keeps a string quoted so empty and padded values stay visible', function () {
    assert.equal(formatMessageValue('x'), '"x"');
    assert.equal(formatMessageValue(''), '""');
    assert.equal(formatMessageValue(' '), '" "');
  });

  it('JSON-encodes everything else', function () {
    assert.equal(formatMessageValue(3), '3');
    assert.equal(formatMessageValue(null), 'null');
    assert.equal(formatMessageValue([1, 2]), '[1,2]');
    assert.equal(formatMessageValue({ a: 1 }), '{"a":1}');
  });

  it('writes a BigInt, which JSON cannot spell, as its digits (a JSON string inside a container)', function () {
    assert.equal(formatMessageValue(10n), '10');
    assert.equal(formatMessageValue([10n, 'a']), '["10","a"]');
    assert.equal(formatMessageValue({ a: { b: -2n } }), '{"a":{"b":"-2"}}');
    assert.equal(formatMessageValue(undefined), 'undefined');
  });
});

describe('a BigInt in a rendered parameter', function () {
  it('renders as its digits at any depth', function () {
    assert.equal(formatTemplateParam(10n), '10');
    assert.equal(formatTemplateParam([10n]), '["10"]');
    assert.equal(formatTemplateParam({ a: [1n, 2] }), '{"a":["1",2]}');
    const render = compileMessageTemplate('must be one of {allowedValues}');
    assert.equal(render({ allowedValues: [[10n], 'x'] }), 'must be one of [["10"],"x"]');
  });
});

describe('every value a message can quote renders', function () {
  const both = [['formatMessageValue', formatMessageValue], ['formatTemplateParam', formatTemplateParam]];

  it('writes a BigInt object as the digits of the bigint it holds, at the root and inside a value', function () {
    for (const [name, render] of both) {
      assert.equal(render(Object(10n)), '10', name);
      assert.equal(render([Object(2n), 2n]), '["2","2"]', name);
      assert.equal(render({ a: { b: Object(-3n) } }), '{"a":{"b":"-3"}}', name);
    }
  });

  it('writes a value JSON cannot write — a circular reference, a value nested past the host stack — as its tag', function () {
    const cyclic = /** @type {any} */ ({ a: 1 });
    cyclic.self = cyclic;
    cyclic.list = [cyclic, { up: cyclic }];
    const cyclicArray = /** @type {any[]} */ ([1]);
    cyclicArray.push(cyclicArray);
    const bare = Object.create(null);
    bare.self = bare;
    let array = /** @type {any} */ (1);
    for (let i = 0; i < 100_000; ++i)
      array = [array];
    let object = /** @type {any} */ (1);
    for (let i = 0; i < 100_000; ++i)
      object = { a: object };
    for (const [name, render] of both) {
      assert.equal(render(cyclic), '[object Object]', name);
      assert.equal(render(cyclicArray), '[object Array]', name);
      assert.equal(render(bare), '[object Object]', name);
      assert.equal(render(array), '[object Array]', name);
      assert.equal(render(object), '[object Object]', name);
    }
    const shared = { s: 1 };
    // a value met twice side by side is no cycle
    assert.equal(formatMessageValue([shared, shared, Object(1n)]), '[{"s":1},{"s":1},"1"]');
  });

  it('writes a value that hands out a new object at every read as its tag', function () {
    let reads = 0;
    const endless = {
      toJSON() {
        // a run that never stops stops here instead of filling the heap
        if (++reads > 1_000_000)
          throw new RangeError('read past the bound');
        return { a: this };
      },
    };
    assert.equal(formatMessageValue(endless), '[object Object]');
    assert.ok(reads < 1_000_000, String(reads));
  });

  it('writes what JSON.stringify writes for every value it writes, beside one it refuses', function () {
    const values = [null, true, false, 0, -0, 1.5, NaN, Infinity, 'a"b\n \ud800', '', 1n, [1n, { a: 2n }],
      undefined, Symbol('s'), () => 1, [], {}, [undefined, () => 1, Symbol('e')],
      { a: undefined, b: () => 1, c: Symbol('c'), [Symbol('k')]: 1, d: 1 }, new Date(0), new Date(NaN), /x/g,
      new Map([[1, 2]]), new Set([1]), new Number(3), new String('s'), new Boolean(false), Object(Symbol('w')),
      new Error('e'), { toJSON(/** @type {string} */ key) { return `k=${key}`; } },
      [{ toJSON(/** @type {string} */ key) { return `k=${key}`; } }], { a: { toJSON() { return undefined; } } },
      new Uint8Array([1, 2]), new BigInt64Array([1n]), Object.create(null),
      Object.assign(Object.create({ inherited: 1 }), { own: 2 }), Array(2).fill(1, 1), Object.assign([1], { x: 2 }),
      { 1: 'a', b: 'c', 0: 'd' }, new Proxy({ a: 1 }, {}), new Proxy([1, 2], {}), { nested: [[[{ deep: [1, 'x', null] }]]] },
      Object.assign(new Number(1), { x: 1 }), { length: 2, 0: 'a' },
      { [Symbol.toStringTag]: 'Number', a: 1 }, { [Symbol.toStringTag]: 'BigInt', b: 2 }, Object.create(Boolean.prototype)];
    const digits = (/** @type {string} */ _key, /** @type {unknown} */ value) =>
      (typeof value === 'bigint' ? value.toString() : value);
    for (const value of values) {
      // the BigInt object beside it makes JSON.stringify refuse the pair
      assert.equal(formatMessageValue([value, Object(1n)]), `[${JSON.stringify([value], digits).slice(1, -1)},"1"]`);
    }
  });

  it('writes an object that inherits from BigInt.prototype without holding a bigint as its tag', function () {
    const fake = Object.create(BigInt.prototype);
    for (const [name, render] of both) {
      assert.equal(render(fake), '[object BigInt]', name);
      assert.equal(render([fake]), '[object Array]', name);
    }
  });

  it('writes a value whose own code throws when it is read as its tag', function () {
    assert.equal(formatMessageValue({ toJSON() { throw new RangeError('own'); } }), '[object Object]');
    assert.equal(formatTemplateParam([Object(1n), { get a() { throw new SyntaxError('getter'); } }]), '[object Array]');
  });
});

describe('compileMessageTemplate', function () {
  it('substitutes named params', function () {
    assert.equal(compileMessageTemplate('must be {limit}')({ limit: 3 }), 'must be 3');
    assert.equal(compileMessageTemplate('{a} and {b}')({ a: 1, b: 2 }), '1 and 2');
  });

  it('leaves an unknown name as a literal placeholder', function () {
    assert.equal(compileMessageTemplate('a {nope} b')({}), 'a {nope} b');
    assert.equal(compileMessageTemplate('a {nope} b')(null), 'a {nope} b');
  });

  it('renders a present member even when its value is undefined or null', function () {
    assert.equal(compileMessageTemplate('{x}')({ x: undefined }), 'undefined');
    assert.equal(compileMessageTemplate('{x}')({ x: null }), 'null');
  });

  it('escapes a literal brace with {{', function () {
    assert.equal(compileMessageTemplate('{{limit}')({ limit: 3 }), '{limit}');
  });

  it('keeps an unterminated placeholder verbatim', function () {
    assert.equal(compileMessageTemplate('a {b')({ b: 1 }), 'a {b');
  });

  it('short-circuits a template with no placeholders', function () {
    const render = compileMessageTemplate('plain text');
    assert.equal(render({}), 'plain text');
    assert.equal(render(null), 'plain text');
  });
});

describe('compileMessageCatalog', function () {
  it('preserves prototype-named ids as frozen own entries', function () {
    const closure = (p) => `closure ${p.n}`;
    for (const entry of ['value {n}', closure]) {
      const input = { ['__proto__']: entry, constructor: 'ctor {n}', toString: 'text {n}' };
      const catalog = compileMessageCatalog(input);
      assert.deepEqual(Object.keys(catalog), Object.keys(input));
      assert.equal(Object.getPrototypeOf(catalog), Object.prototype);
      assert.equal(catalog.__proto__({ n: 2 }), typeof entry === 'string' ? 'value 2' : 'closure 2');
      assert.equal(catalog.constructor({ n: 2 }), 'ctor 2');
      assert.equal(catalog.toString({ n: 2 }), 'text 2');
      assert.equal(Object.isFrozen(catalog), true);
      assert.equal(Object.isFrozen(input), false);
    }
  });

  it('compiles template strings and passes closures through', function () {
    const closure = (p) => `closure ${p.n}`;
    const catalog = compileMessageCatalog({ a: 'tpl {n}', b: closure });
    assert.equal(catalog.a({ n: 1 }), 'tpl 1');
    assert.equal(catalog.b, closure);
    assert.equal(catalog.b({ n: 2 }), 'closure 2');
  });

  it('freezes the result', function () {
    const catalog = compileMessageCatalog({ a: 'x' });
    assert.equal(Object.isFrozen(catalog), true);
  });
});
