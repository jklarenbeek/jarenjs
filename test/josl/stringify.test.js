import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, throws, ok } from 'node:assert';

import {
  parseJosl,
  parseToml,
  stringifyJosl,
  stringifyToml,
  JoslStringifyError,
  LocalDate,
  LocalTime,
  LocalDateTime,
} from '@jarenjs/josl';

function roundtrip(value, options = undefined) {
  deepStrictEqual(parseJosl(stringifyJosl(value, options)), value);
}

describe('josl: stringify', () => {
  it('round-trips tables, subtables and arrays of tables', () => {
    roundtrip({
      title: 'example',
      owner: { name: 'Tom', dob: { year: 1979 } },
      products: [{ name: 'Hammer' }, { name: 'Nail', spec: { weight: 0.5 } }],
    });
  });
  it('round-trips every scalar type', () => {
    roundtrip({
      s: 'esc "q" \\ \n \t \u0001 tail',
      i: 42,
      f: 3.1415,
      neg: -0.01,
      exp: 5e22,
      inf: Infinity,
      ninf: -Infinity,
      t: true,
      big: 123n,
      huge: 9007199254740993n,
      re: /ab+c/gi,
      nul: null,
      when: new Date('1979-05-27T07:32:00Z'),
      ld: new LocalDate(1979, 5, 27),
      lt: new LocalTime(7, 32, 0, '.999'),
      ldt: new LocalDateTime(new LocalDate(1979, 5, 27), new LocalTime(7, 32, 0)),
    });
    const r = parseJosl(stringifyJosl({ n: NaN }));
    ok(Number.isNaN(r.n));
  });
  it('round-trips heterogeneous and nested arrays inline', () => {
    roundtrip({
      mixed: [1, 'two', true, null, [3, 4], { a: 1 }],
      empty: [],
    });
  });
  it('round-trips root arrays via [[]]', () => {
    const value = [{ name: 'one', meta: { x: 1 } }, { name: 'two' }];
    const text = stringifyJosl(value);
    ok(text.startsWith('[[]]'));
    deepStrictEqual(parseJosl(text), value);
  });
  it('quotes non-bare keys', () => {
    roundtrip({ 'key with space': 1, 'dotted.key': { 'a"b': 2 } });
  });
  it('preserves __proto__ keys safely', () => {
    const value = parseJosl('[__proto__]\nx = 1');
    const again = parseJosl(stringifyJosl(value));
    deepStrictEqual(again.__proto__, { x: 1 });
    strictEqual(Object.getPrototypeOf(again), Object.prototype);
  });
  it('rejects scalar roots and circular references', () => {
    throws(() => stringifyJosl(42), JoslStringifyError);
    const cyc = { a: {} };
    cyc.a.back = cyc;
    throws(() => stringifyJosl(cyc), JoslStringifyError);
  });
});

describe('josl: stringify toml downlevel', () => {
  it('emits strict toml that parseToml accepts', () => {
    const value = {
      title: 'example',
      when: new Date('1979-05-27T07:32:00Z'),
      items: [{ id: 1 }, { id: 2 }],
    };
    deepStrictEqual(parseToml(stringifyToml(value)), value);
  });
  it('errors on null by default, omits with onNull', () => {
    throws(() => stringifyToml({ a: null }), JoslStringifyError);
    strictEqual(stringifyToml({ a: null, b: 1 }, { onNull: 'omit' }), 'b = 1\n');
  });
  it('downlevels regexps to strings on request', () => {
    throws(() => stringifyToml({ re: /a/g }), JoslStringifyError);
    deepStrictEqual(
      parseToml(stringifyToml({ re: /a/g }, { onRegExp: 'string' })),
      { re: '/a/g' });
  });
  it('emits in-range bigints plain, errors beyond 64 bits', () => {
    strictEqual(stringifyToml({ a: 123n }), 'a = 123\n');
    throws(() => stringifyToml({ a: 2n ** 64n }), JoslStringifyError);
  });
  it('rejects root arrays in toml mode', () => {
    throws(() => stringifyToml([{ a: 1 }]), JoslStringifyError);
  });
});
