import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, throws, ok } from 'node:assert';

import {
  parseJsonx,
  stringifyJsonx,
  JsonxSyntaxError,
  LocalDate,
  LocalTime,
  LocalDateTime,
} from '@jarenjs/josl';

describe('jsonx: strict json compatibility', () => {
  const docs = [
    'null', 'true', 'false', '0', '-0', '42', '-17', '3.1415', '5e+22',
    '1e-7', '"hello \\"world\\" \\u0041\\n"', '[]', '[1,[2,[3]]]', '{}',
    '{"a":1,"b":{"c":[true,null]}}', '  { "s" : "x" , "n" : -1.5e2 }  ',
    '{"dup":1,"dup":2}', '"\\ud83d\\ude00"',
  ];
  for (const doc of docs)
    it(`parses ${doc.slice(0, 30)} like JSON.parse`, () => {
      deepStrictEqual(parseJsonx(doc, { mode: 'json' }), JSON.parse(doc));
      deepStrictEqual(parseJsonx(doc), JSON.parse(doc)); // jsonx is a superset
    });
  const badDocs = ['+1', '01', '1n', 'inf', 'NaN', "'single'", '{a:1}',
    '[1,]', '{"a":1,}', '/re/', '2026-07-18', '1_000', '[1 2]', '"\t"'];
  for (const doc of badDocs)
    it(`rejects ${JSON.stringify(doc)} in json mode`, () => {
      throws(() => parseJsonx(doc, { mode: 'json' }), JsonxSyntaxError);
      throws(() => JSON.parse(doc), SyntaxError); // sanity: JSON agrees
    });
});

describe('jsonx: extensions', () => {
  it('parses bigints and promotes unsafe integers', () => {
    deepStrictEqual(parseJsonx('{"a": 123n, "b": -42n}'), { a: 123n, b: -42n });
    strictEqual(parseJsonx('9007199254740993'), 9007199254740993n);
    strictEqual(parseJsonx('9007199254740993', { mode: 'json' }), 9007199254740992);
  });
  it('parses regexp literals', () => {
    deepStrictEqual(parseJsonx('{"re": /ab+c/gi}'), { re: /ab+c/gi });
  });
  it('parses bare datetimes', () => {
    deepStrictEqual(
      parseJsonx('[2026-07-18T12:00:00Z, 2026-07-18, 12:30:00, 2026-07-18T12:00:00]'),
      [
        new Date('2026-07-18T12:00:00Z'),
        new LocalDate(2026, 7, 18),
        new LocalTime(12, 30, 0),
        new LocalDateTime(new LocalDate(2026, 7, 18), new LocalTime(12, 0, 0)),
      ]);
  });
  it('parses non-finite numbers and separators', () => {
    const r = parseJsonx('[inf, -inf, nan, Infinity, -Infinity, NaN, 1_000_000, +5]');
    deepStrictEqual(r.slice(0, 2), [Infinity, -Infinity]);
    ok(Number.isNaN(r[2]));
    strictEqual(r[6], 1000000);
    strictEqual(r[7], 5);
  });
  it('guards against prototype pollution', () => {
    const r = parseJsonx('{"__proto__": {"polluted": true}}');
    strictEqual({}.polluted, undefined);
    strictEqual(Object.getPrototypeOf(r), Object.prototype);
  });
  it('reports line, column and hint', () => {
    try {
      parseJsonx('{\n  "a": what\n}');
      ok(false, 'should have thrown');
    }
    catch (e) {
      ok(e instanceof JsonxSyntaxError);
      strictEqual(e.line, 2);
      strictEqual(e.column, 8);
    }
  });
});

describe('jsonx: document-order events', () => {
  it('emits open/value/close in document order with absolute paths', () => {
    const events = [];
    parseJsonx('{"a": [1, {"b": 2}], "c": 3}', {
      onEvent: (e) => events.push([e.type, e.path.join('.'), e.kind ?? e.value]),
    });
    deepStrictEqual(events, [
      ['open', '', 'object'],
      ['open', 'a', 'array'],
      ['value', 'a.0', 1],
      ['open', 'a.1', 'object'],
      ['value', 'a.1.b', 2],
      ['close', 'a.1', { b: 2 }],
      ['close', 'a', [1, { b: 2 }]],
      ['value', 'c', 3],
      ['close', '', { a: [1, { b: 2 }], c: 3 }],
    ]);
  });
});

describe('jsonx: stringify', () => {
  it('round-trips the extended types', () => {
    const value = {
      s: 'hi "there"',
      n: 1.5,
      big: 123n,
      re: /^a\/b$/im,
      when: new Date('2026-07-18T12:00:00.000Z'),
      ld: new LocalDate(2026, 7, 18),
      lt: new LocalTime(12, 30, 0, '.250'),
      ldt: new LocalDateTime(new LocalDate(2026, 7, 18), new LocalTime(1, 2, 3)),
      inf: Infinity,
      nul: null,
      arr: [1, 'two', [true]],
    };
    deepStrictEqual(parseJsonx(stringifyJsonx(value)), value);
    deepStrictEqual(parseJsonx(stringifyJsonx(value, { indent: 2 })), value);
  });
  it('json mode matches JSON.stringify exactly', () => {
    const value = { a: [1, null, 'x'], d: new Date(0), u: undefined, f: () => 1, nan: NaN };
    strictEqual(stringifyJsonx(value, { mode: 'json' }), JSON.stringify(value));
    strictEqual(
      stringifyJsonx(value, { mode: 'json', indent: 2 }),
      JSON.stringify(value, null, 2));
  });
  it('handles undefined like JSON.stringify', () => {
    strictEqual(stringifyJsonx(undefined), undefined);
    strictEqual(stringifyJsonx({ u: undefined }), '{}');
    strictEqual(stringifyJsonx([undefined]), '[null]');
  });
  it('throws on circular structures', () => {
    const cyc = {};
    cyc.self = cyc;
    throws(() => stringifyJsonx(cyc), TypeError);
  });
});
