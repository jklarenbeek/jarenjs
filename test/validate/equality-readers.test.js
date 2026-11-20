/**
 * @file `const`, `enum`, their `$data` and `data` forms, `uniqueItems: true`
 * and the `$data` form of `uniqueItems` answer by one relation, core's
 * `equalsDeep`: a value is the constant, or a member of the list, exactly
 * when the relation takes the two as equal, and two items repeat exactly
 * when it does, in either order and in both modes. Their answers on
 * `undefined`, a member or an element holding it, and on the two zeros are
 * the ones they gave before the relation was made one.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { equalsDeep } from '@jarenjs/core/object';
import { JarenValidator } from '@jarenjs/validate';

const MODES = [
  ['at the first failure', () => new JarenValidator(), (/** @type {any} */ r) => r],
  ['collecting errors', () => new JarenValidator({ collectErrors: true }), (/** @type {any} */ r) => r.valid],
];

const hole = () => new Array(1);
/** A hole, then `after`. @param {unknown[]} after */
const sparse = (...after) => { const list = new Array(1); list.push(...after); return list; };
const dollarUnique = { properties: { list: { uniqueItems: { $data: '1/on' } } } };
const dollar = (/** @type {string} */ keyword) => ({ properties: { value: { [keyword]: { $data: '/limit' } } } });
const dollarItems = (/** @type {string} */ keyword) => ({ properties: { value: { items: { [keyword]: { $data: '/limit' } } } } });
const data = (/** @type {string} */ keyword) => ({ properties: { value: { data: { [keyword]: '/limit' } } } });

// [what is asked, the schema, the instance, the answer]: the answers these
// keywords gave on `undefined`, NaN and the two zeros before the relation
// was made one, each of which stands
const HELD = [
  ['const 1 on undefined', { const: 1 }, undefined, false],
  ['const null on undefined', { const: null }, undefined, false],
  ['const {} on undefined', { const: {} }, undefined, false],
  ['enum [1] on undefined', { enum: [1] }, undefined, true],
  ['enum [{}] on undefined', { enum: [{}] }, undefined, true],
  ['enum [] on undefined', { enum: [] }, undefined, true],
  ['a member const 1 on { a: undefined }', { properties: { a: { const: 1 } } }, { a: undefined }, false],
  ['a member const {} on { a: undefined }', { properties: { a: { const: {} } } }, { a: undefined }, false],
  ['a member enum [1] on { a: undefined }', { properties: { a: { enum: [1] } } }, { a: undefined }, true],
  ['a member enum [{}] on { a: undefined }', { properties: { a: { enum: [{}] } } }, { a: undefined }, true],
  ['items const 1 on [undefined]', { items: { const: 1 } }, [undefined], false],
  ['items const {} on [undefined]', { items: { const: {} } }, [undefined], false],
  ['items enum [1] on [undefined]', { items: { enum: [1] } }, [undefined], false],
  ['items enum [{}] on [undefined]', { items: { enum: [{}] } }, [undefined], false],
  ['items enum [1] on a hole', { items: { enum: [1] } }, hole(), false],
  ['items enum [undefined] on [undefined]', { items: { enum: [undefined] } }, [undefined], true],
  ['items enum [a hole, 1] on [undefined]', { items: { enum: sparse(1) } }, [undefined], true],
  ['items enum [a hole, {}] on [undefined]', { items: { enum: sparse({}) } }, [undefined], true],
  ['items enum [undefined, {}] on [undefined]', { items: { enum: [undefined, {}] } }, [undefined], true],
  ['items enum [a hole, NaN] on [undefined]', { items: { enum: sparse(NaN) } }, [undefined], true],
  ['items enum [a hole, NaN, {}] on [undefined]', { items: { enum: sparse(NaN, {}) } }, [undefined], true],
  ['const { a: undefined } on {}', { const: { a: undefined } }, {}, false],
  ['const { a: undefined } on { a: undefined }', { const: { a: undefined } }, { a: undefined }, true],
  ['const {} on { a: undefined }', { const: {} }, { a: undefined }, false],
  ['enum [{ a: undefined }] on {}', { enum: [{ a: undefined }] }, {}, false],
  ['enum [{ a: undefined }] on { a: undefined }', { enum: [{ a: undefined }] }, { a: undefined }, true],
  ['const [undefined] on [null]', { const: [undefined] }, [null], false],
  ['const [undefined] on [undefined]', { const: [undefined] }, [undefined], true],
  ['const [undefined] on a hole', { const: [undefined] }, hole(), true],
  ['uniqueItems on [undefined, undefined]', { uniqueItems: true }, [undefined, undefined], false],
  ['uniqueItems on [undefined, null]', { uniqueItems: true }, [undefined, null], true],
  ['uniqueItems on [a hole, undefined]', { uniqueItems: true }, sparse(undefined), false],
  ['uniqueItems on two holes', { uniqueItems: true }, new Array(2), false],
  ['uniqueItems on [{ a: undefined }, {}]', { uniqueItems: true }, [{ a: undefined }, {}], true],
  ['uniqueItems on [{ a: undefined }, { a: undefined }]', { uniqueItems: true }, [{ a: undefined }, { a: undefined }], false],
  ['uniqueItems on [[undefined], a hole]', { uniqueItems: true }, [[undefined], hole()], false],
  ['$data uniqueItems on [undefined, undefined]', dollarUnique, { on: true, list: [undefined, undefined] }, false],
  ['$data uniqueItems on [undefined, null]', dollarUnique, { on: true, list: [undefined, null] }, true],
  ['$data uniqueItems on [a hole, undefined]', dollarUnique, { on: true, list: sparse(undefined) }, false],
  ['$data uniqueItems on [{ a: undefined }, {}]', dollarUnique, { on: true, list: [{ a: undefined }, {}] }, true],
  ['$data uniqueItems on [{ a: undefined }, { a: undefined }]', dollarUnique, { on: true, list: [{ a: undefined }, { a: undefined }] }, false],
  ['$data const of a member holding undefined, on 1', dollar('const'), { value: 1, limit: undefined }, false],
  ['$data const of a member holding undefined, on undefined', dollar('const'), { value: undefined, limit: undefined }, true],
  ['$data const 1 on undefined', dollar('const'), { value: undefined, limit: 1 }, true],
  ['$data const of an absent member', dollar('const'), { value: 1 }, true],
  ['$data const { a: undefined } on {}', dollar('const'), { value: {}, limit: { a: undefined } }, false],
  ['$data enum [undefined] on 1', dollar('enum'), { value: 1, limit: [undefined] }, false],
  ['$data enum [undefined] on undefined', dollar('enum'), { value: undefined, limit: [undefined] }, true],
  ['items $data enum [a hole] on [undefined]', dollarItems('enum'), { value: [undefined], limit: hole() }, true],
  ['items $data enum [undefined] on [undefined]', dollarItems('enum'), { value: [undefined], limit: [undefined] }, true],
  ['items $data const [undefined] on [[undefined]]', dollarItems('const'), { value: [[undefined]], limit: [undefined] }, true],
  ['data enum [undefined] on undefined', data('enum'), { value: undefined, limit: [undefined] }, true],
  ['data const 1 on undefined', data('const'), { value: undefined, limit: 1 }, true],
  ['const NaN on NaN', { const: NaN }, NaN, false],
  ['const 0 on -0', { const: 0 }, -0, true],
  ['const -0 on 0', { const: -0 }, 0, true],
  ['const { a: NaN } on { a: NaN }', { const: { a: NaN } }, { a: NaN }, false],
  ['const [0] on [-0]', { const: [0] }, [-0], true],
  ['enum [0] on -0', { enum: [0] }, -0, true],
  ['enum [{}, 0] on -0', { enum: [{}, 0] }, -0, true],
  ['enum [[NaN]] on [NaN]', { enum: [[NaN]] }, [NaN], false],
  ['uniqueItems on [NaN, NaN]', { uniqueItems: true }, [NaN, NaN], true],
  ['uniqueItems on [0, -0]', { uniqueItems: true }, [0, -0], false],
  ['uniqueItems on [[NaN], [NaN]]', { uniqueItems: true }, [[NaN], [NaN]], true],
  ['uniqueItems on [[0], [-0]]', { uniqueItems: true }, [[0], [-0]], false],
  ['$data uniqueItems on [NaN, NaN]', dollarUnique, { on: true, list: [NaN, NaN] }, true],
  ['$data uniqueItems on [0, -0]', dollarUnique, { on: true, list: [0, -0] }, false],
  ['$data uniqueItems on [[NaN], [NaN]]', dollarUnique, { on: true, list: [[NaN], [NaN]] }, true],
  ['$data const NaN on NaN', dollar('const'), { value: NaN, limit: NaN }, false],
  ['$data const 0 on -0', dollar('const'), { value: -0, limit: 0 }, true],
  ['$data enum [0] on -0', dollar('enum'), { value: -0, limit: [0] }, true],
  ['data const NaN on NaN', data('const'), { value: NaN, limit: NaN }, false],
];

class Point { /** @param {number} x */ constructor(x) { this.x = x; } }
const symbol = Symbol('a');
const f = function f() { return 1; };
const twin = function f() { return 1; };
const other = function f() { return 2; };
/** @param {number[]} bytes */
const buffer = (...bytes) => Uint8Array.from(bytes).buffer;
/** @param {any} value @param {string} key @param {unknown} member */
const hidden = (value, key, member) => Object.defineProperty(value, key, { value: member, enumerable: false });

// JSON values and the values no JSON text holds, two of a kind where two
// built alike are equal and where they are not; `undefined` is left out
// (the answers on it are the table above)
const VALUES = () => [
  null, true, false, 0, -0, 1, 1.5, NaN, Infinity, 'a', '', '1', 1n, 2n,
  [], [1], [1, 2], [[1]], [NaN], {}, { a: 1 }, { a: 1, b: 2 }, { b: 2, a: 1 }, { a: [1] }, { a: NaN }, { a: { b: null } },
  symbol, Symbol('a'), f, twin, other, Object.create(Function.prototype),
  new Number(1), new Number(1), new Number(2), new String('a'), new String('a'), new Boolean(true), new Boolean(false),
  Object(symbol),
  new Date(1), new Date(1), new Date(2), /a/, /a/, /a/g,
  new Map([[1, 2]]), new Map([[1, 2]]), new Map([[1, 3]]), new Set([1]), new Set([1]), new Set([2]),
  new Uint8Array([1]), new Uint8Array([1]), new Uint8Array([2]), buffer(1), buffer(1), buffer(2),
  new DataView(buffer(1)), new DataView(buffer(2)),
  new Error('a'), new Error('a'), new Error('b'), new Point(1), new Point(1), new Point(2),
  Object.create(null), hidden({ b: 2 }, 'a', 1), { [symbol]: 1 },
];

for (const [mode, make, read] of MODES) {
  /** @param {object} schema */
  const compile = (schema) => { const validate = make().compile(schema); return (/** @type {unknown} */ value) => read(validate(value)); };

  describe(`const, enum and uniqueItems keep their answers on undefined, NaN and the two zeros, ${mode}`, () => {
    it(`answers ${HELD.length} cases as before`, () => {
      for (const [asked, schema, instance, valid] of HELD)
        assert.equal(compile(schema)(instance), valid, asked);
    });
  });

  describe(`const, enum and uniqueItems answer by one relation, ${mode}`, () => {
    const dynamic = {
      '$data const': [compile(dollar('const')), (/** @type {unknown} */ a) => a],
      'data const': [compile(data('const')), (/** @type {unknown} */ a) => a],
      '$data enum': [compile(dollar('enum')), (/** @type {unknown} */ a) => [a]],
      'data enum': [compile(data('enum')), (/** @type {unknown} */ a) => [a]],
      '$data enum beside an object': [compile(dollar('enum')), (/** @type {unknown} */ a) => [{ filler: true }, a]],
    };
    const unique = compile({ uniqueItems: true });
    const uniqueBeside = compile({ uniqueItems: true, maxItems: 99 });
    const uniqueDollar = compile(dollarUnique);

    it('takes a value as the constant, or as listed, exactly when equalsDeep takes the two as equal', () => {
      const left = VALUES();
      const right = VALUES();
      let equal = 0;
      let asked = 0;
      left.forEach((a, i) => {
        const fixed = {
          const: compile({ const: a }),
          enum: compile({ enum: [a] }),
          'enum before a string': compile({ enum: [a, 'filler'] }),
          'enum after an object': compile({ enum: [{ filler: true }, a] }),
        };
        right.forEach((b, j) => {
          const want = equalsDeep(a, b);
          assert.equal(equalsDeep(b, a), want, `the relation in both orders, values ${i} and ${j}`);
          if (want) equal++;
          for (const [keyword, validate] of Object.entries(fixed)) {
            asked++;
            assert.equal(validate(b), want, `${keyword}, values ${i} and ${j}`);
          }
          for (const [keyword, [validate, limit]] of Object.entries(dynamic)) {
            asked++;
            assert.equal(validate({ value: b, limit: limit(a) }), want, `${keyword}, values ${i} and ${j}`);
          }
        });
      });
      assert.equal(asked, left.length * right.length * 9);
      assert.ok(equal > left.length, `${equal} equal pairs`);
    });

    it('takes two items as repeated exactly when equalsDeep takes them as equal, in both uniqueItems forms', () => {
      const left = VALUES();
      const right = VALUES();
      const pad = ['pad 1', 'pad 2', 'pad 3', 'pad 4', 'pad 5', 'pad 6', 'pad 7'];
      left.forEach((a, i) => right.forEach((b, j) => {
        const want = !equalsDeep(a, b);
        for (const list of [[a, b], [b, a], [a, ...pad, b]]) {
          assert.equal(unique(list), want, `uniqueItems, values ${i} and ${j}`);
          assert.equal(uniqueBeside(list), want, `uniqueItems beside maxItems, values ${i} and ${j}`);
          assert.equal(uniqueDollar({ on: true, list }), want, `$data uniqueItems, values ${i} and ${j}`);
        }
      }));
    });

    it('reads a wrapper beside its primitive, and two symbols, as unique in both forms', () => {
      for (const list of [[new String('a'), 'a'], ['a', new String('a')], [Symbol('a'), Symbol('b')], [new Number(1), 1]]) {
        assert.equal(unique(list), true);
        assert.equal(uniqueDollar({ on: true, list }), true);
      }
      for (const list of [[new Number(1), new Number(1)], [symbol, symbol], [f, twin]]) {
        assert.equal(unique(list), false);
        assert.equal(uniqueDollar({ on: true, list }), false);
      }
    });

    it('refuses a second symbol, a second wrapper state and NaN by const and enum alike', () => {
      const pairs = [[Symbol('a'), Symbol('a')], [new Number(1), new Number(2)], [new Boolean(true), new Boolean(false)],
        [new String('ab'), 'ab'], ['ab', new String('ab')], [Object.create(Function.prototype), f], [f, Object.create(Function.prototype)],
        [NaN, NaN]];
      for (const [a, b] of pairs) {
        assert.equal(compile({ const: a })(b), false);
        assert.equal(compile({ enum: [a] })(b), false);
        assert.equal(compile({ enum: [a, {}] })(b), false);
        assert.equal(dynamic['$data const'][0]({ value: b, limit: a }), false);
        assert.equal(dynamic['$data enum'][0]({ value: b, limit: [a] }), false);
        assert.equal(dynamic['data enum'][0]({ value: b, limit: [a] }), false);
      }
    });

    it('takes a function of the listed text by const and enum alike', () => {
      assert.equal(compile({ const: f })(twin), true);
      assert.equal(compile({ enum: [f] })(twin), true);
      assert.equal(compile({ enum: [1, f] })(twin), true);
      assert.equal(compile({ enum: [{}, f] })(twin), true);
      assert.equal(dynamic['$data const'][0]({ value: twin, limit: f }), true);
      assert.equal(dynamic['$data enum'][0]({ value: twin, limit: [f] }), true);
      assert.equal(compile({ enum: [f] })(other), false);
      assert.equal(dynamic['$data const'][0]({ value: other, limit: f }), false);
    });

    it('keeps the list an enum error reports as the schema gave it', { skip: mode !== 'collecting errors' }, () => {
      const list = [1, NaN];
      const result = make().compile({ enum: list })(NaN);
      assert.equal(result.valid, false);
      assert.equal(result.errors[0].keyword, 'enum');
      assert.equal(result.errors[0].params.allowedValues.length, 2);
    });
  });
}
