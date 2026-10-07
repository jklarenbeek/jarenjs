// The whole-text JSONX parser walks containers with an explicit stack of
// the open ones, so nesting depth is bounded by memory - as it is for
// JSON.parse - and not by the call stack. A document parses to the same
// value, reports the same events and fails with the same error, at the
// same line and column, at any depth as it does shallow.
//
// node:assert's deepStrictEqual and JSON.stringify both recurse, and
// overflow long before these depths, so deep values are compared here by
// iterative walks.

import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, ok } from 'node:assert';
import { isDeepStrictEqual } from 'node:util';

import {
  parseJsonx,
  stringifyJsonx,
  JsonxSyntaxError,
  LocalDate,
  LocalTime,
  LocalDateTime,
} from '@jarenjs/josl';

const MODES = [{ mode: 'json' }, { mode: 'jsonx' }, undefined];
const label = (options) => options?.mode ?? 'default';

//#region iterative helpers

/**
 * The first difference between two values, or null. Walks both with an
 * explicit stack, comparing prototypes, own keys in order (so array
 * lengths too) and scalars by Object.is; a non-plain object such as a
 * Date is a scalar compared by isDeepStrictEqual.
 * @param {*} actual @param {*} expected @returns {string|null}
 */
function firstDifference(actual, expected) {
  const stack = [[actual, expected, '']];
  while (stack.length > 0) {
    const [a, b, at] = stack.pop();
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
      if (!Object.is(a, b))
        return `${at || '/'}: ${String(a)} is not ${String(b)}`;
      continue;
    }
    const proto = Object.getPrototypeOf(a);
    if (proto !== Object.getPrototypeOf(b))
      return `${at || '/'}: different prototypes`;
    if (proto !== Object.prototype && proto !== Array.prototype) {
      if (!isDeepStrictEqual(a, b))
        return `${at || '/'}: ${String(a)} is not ${String(b)}`;
      continue;
    }
    const keys = Reflect.ownKeys(a);
    const other = Reflect.ownKeys(b);
    if (keys.length !== other.length || keys.some((k, i) => k !== other[i]))
      return `${at || '/'}: keys ${keys.map(String)} are not ${other.map(String)}`;
    for (const k of keys)
      if (k !== 'length')
        stack.push([a[k], b[k], `${at}/${String(k)}`]);
  }
  return null;
}

/**
 * Serialize a parsed value without recursion: containers here, every
 * scalar by stringifyJsonx.
 * @param {*} root @returns {string}
 */
function serialize(root) {
  const parts = [];
  const pending = [{ value: root }];
  while (pending.length > 0) {
    const task = pending.pop();
    if (task.text !== undefined) {
      parts.push(task.text);
      continue;
    }
    const v = task.value;
    if (Array.isArray(v)) {
      parts.push('[');
      pending.push({ text: ']' });
      for (let i = v.length - 1; i >= 0; --i) {
        pending.push({ value: v[i] });
        if (i > 0)
          pending.push({ text: ',' });
      }
    }
    else if (v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      parts.push('{');
      pending.push({ text: '}' });
      const keys = Object.keys(v);
      for (let i = keys.length - 1; i >= 0; --i) {
        pending.push({ value: v[keys[i]] });
        pending.push({ text: `${i > 0 ? ',' : ''}${JSON.stringify(keys[i])}:` });
      }
    }
    else
      parts.push(stringifyJsonx(v));
  }
  return parts.join('');
}

/**
 * Follow a chain of single-member containers down to its leaf.
 * @param {*} value @returns {{depth: number, leaf: *}}
 */
function chain(value) {
  let depth = 0;
  let v = value;
  for (;;) {
    if (Array.isArray(v) && v.length === 1)
      v = v[0];
    else if (v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype
      && Object.keys(v).length === 1)
      v = v[Object.keys(v)[0]];
    else
      return { depth, leaf: v };
    depth++;
  }
}

/** @param {() => unknown} fn @returns {object} The thrown error's observable fields */
function errorOf(fn) {
  try {
    fn();
  }
  catch (e) {
    return { jsonx: e instanceof JsonxSyntaxError, name: e.name, message: e.message, line: e.line, column: e.column, hint: e.hint };
  }
  throw new Error('expected a JsonxSyntaxError');
}

//#endregion

//#region documents

const arrays = (n, leaf = '1') => '['.repeat(n) + leaf + ']'.repeat(n);
const objects = (n, leaf = '1') => '{"k":'.repeat(n) + leaf + '}'.repeat(n);
const mixed = (n, leaf = '1') => '[{"k":'.repeat(n / 2) + leaf + '}]'.repeat(n / 2);

/**
 * `n` levels of an array holding a number, an object and a negated
 * number, the object holding the next level before a string member.
 * @param {number} n @returns {string} A document 2n + 1 deep
 */
function comb(n) {
  let open = '';
  let close = '';
  for (let i = 0; i < n; ++i) {
    open += `[${i},{"k":`;
    close = `,"z":"${i}"},${-i}]${close}`;
  }
  return `${open}[]${close}`;
}

//#endregion

describe('jsonx: nesting depth is bounded by memory, not the call stack', () => {
  for (const n of [3000, 20000])
    it(`parses documents ${n} deep like JSON.parse, in every mode`, () => {
      for (const [name, text] of [['arrays', arrays(n)], ['objects', objects(n)], ['mixed', mixed(n)], ['comb', comb(n / 2)]]) {
        const expected = JSON.parse(text);
        for (const options of MODES)
          strictEqual(firstDifference(parseJsonx(text, options), expected), null, `${name}, ${label(options)}`);
      }
    });

  it('parses documents 200000 deep, in every mode', () => {
    const n = 200000;
    for (const [name, text] of [['arrays', arrays(n)], ['objects', objects(n)], ['mixed', mixed(n)]])
      for (const options of MODES) {
        const value = parseJsonx(text, options);
        deepStrictEqual(chain(value), { depth: n, leaf: 1 }, `${name}, ${label(options)}`);
        const out = serialize(value);
        strictEqual(out.length, text.length, `${name}, ${label(options)}`);
        ok(out === text, `${name}, ${label(options)}: re-serializes to the input`);
      }
    const spaced = '[ \n'.repeat(n) + '\t1\r\n' + '] '.repeat(n);
    for (const options of MODES)
      deepStrictEqual(chain(parseJsonx(spaced, options)), { depth: n, leaf: 1 }, `whitespace, ${label(options)}`);
  });

  it('parses extension scalars 200000 deep', () => {
    const n = 200000;
    for (const [leaf, expected] of [['2026-07-18', new LocalDate(2026, 7, 18)], ['123n', 123n], ['/a]b/g', /a]b/g], ['-inf', -Infinity]]) {
      const text = mixed(n, leaf);
      const value = parseJsonx(text);
      const reached = chain(value);
      strictEqual(reached.depth, n, leaf);
      deepStrictEqual(reached.leaf, expected, leaf);
      ok(serialize(value) === text, `${leaf}: re-serializes to the input`);
    }
  });

  it('reports every event, with its absolute path, 3000 deep', () => {
    const n = 3000;
    for (const [text, kind, step] of [[arrays(n), 'array', 0], [objects(n, 'true'), 'object', 'k']])
      for (const options of MODES) {
        const events = [];
        const value = parseJsonx(text, { ...options, onEvent: (e) => events.push(e) });
        // an open and a close for each of the n containers, and the leaf's value
        strictEqual(events.length, 2 * n + 1);
        deepStrictEqual(
          events.map((e) => `${e.type}:${e.path.length}`),
          [
            ...Array.from({ length: n }, (_, i) => `open:${i}`),
            `value:${n}`,
            ...Array.from({ length: n }, (_, i) => `close:${n - 1 - i}`),
          ]);
        ok(events.slice(0, n).every((e) => e.kind === kind), `${kind}, ${label(options)}: open kinds`);
        const leaf = events[n];
        strictEqual(leaf.path.length, n);
        ok(leaf.path.every((p) => p === step), `${kind}, ${label(options)}: the leaf's path`);
        strictEqual(leaf.value, kind === 'array' ? 1 : true);
        strictEqual(events[n + 1].path.length, n - 1);
        strictEqual(events[2 * n].value, value);
      }
  });

  it('keeps "__proto__" an own member at any depth', () => {
    for (const n of [3000, 20000]) {
      const text = '{"__proto__":'.repeat(n) + '{"polluted":true}' + '}'.repeat(n);
      for (const options of MODES) {
        let v = parseJsonx(text, options);
        let depth = 0;
        while (depth < n && Object.getPrototypeOf(v) === Object.prototype && Object.hasOwn(v, '__proto__')) {
          v = Object.getOwnPropertyDescriptor(v, '__proto__').value;
          depth++;
        }
        strictEqual(depth, n, label(options));
        strictEqual(Object.getPrototypeOf(v), Object.prototype);
        deepStrictEqual(Object.entries(v), [['polluted', true]]);
        strictEqual({}.polluted, undefined);
      }
      const inner = parseJsonx(arrays(n, '{"__proto__":{"x":1},"a":2}'));
      const { depth, leaf } = chain(inner);
      strictEqual(depth, n);
      deepStrictEqual(Object.keys(leaf), ['__proto__', 'a']);
      strictEqual(Object.getPrototypeOf(leaf), Object.prototype);
      deepStrictEqual(Object.getOwnPropertyDescriptor(leaf, '__proto__').value, { x: 1 });
      strictEqual({}.x, undefined);
    }
  });
});

describe('jsonx: errors are the same at any depth', () => {
  // [document, options, message, hint, offset of the error in the
  // document - or 'end' for the end of the text - and whether the
  // wrapping containers may be closed after it]
  const MALFORMED = [
    ['[1 2]', { mode: 'json' }, "expected ',' or ']' in array", undefined, 3, true],
    ['{"a":1 "b":2}', undefined, "expected ',' or '}' in object", undefined, 7, true],
    ['{"a" 1}', undefined, "expected ':' after key", undefined, 5, true],
    ['{1:2}', { mode: 'json' }, 'expected a string key', undefined, 1, true],
    ['{"a":1,}', undefined, 'expected a string key', undefined, 7, true],
    ['[1,]', { mode: 'json' }, 'invalid value', undefined, 3, true],
    ['[1,,2]', undefined, 'invalid value', undefined, 3, true],
    ['{"a"::1}', undefined, 'invalid value', undefined, 5, true],
    ['[1}', undefined, "expected ',' or ']' in array", undefined, 2, true],
    ['{"a":1]', undefined, "expected ',' or '}' in object", undefined, 6, true],
    ['[1x]', undefined, 'unexpected character after value', undefined, 2, true],
    ['["a"x]', undefined, "expected ',' or ']' in array", undefined, 4, true],
    ['[tru]', undefined, "invalid value 'tru'", undefined, 1, true],
    ['[inf]', { mode: 'json' }, "'inf' is a JSONX extension", 'JSON cannot represent non-finite numbers', 1, true],
    ['[/a/]', { mode: 'json' }, 'a regexp literal is a JSONX extension', 'quote the pattern as a string', 1, true],
    ['[+1]', { mode: 'json' }, "a leading '+' sign is a JSONX extension", 'remove the + sign', 1, true],
    ['[01]', { mode: 'json' }, 'unexpected character after value', undefined, 2, true],
    ['[2026-02-30]', undefined, "invalid date '2026-02-30'", undefined, 1, true],
    ['[1.5n]', undefined, 'bigint literals cannot have a fraction or exponent', undefined, 1, true],
    ['["\\x"]', undefined, "invalid escape '\\x'", undefined, 2, true],
    ['["abc', undefined, 'unterminated string', 'close the string with \'"\'', 'end', true],
    ['[1', undefined, 'unterminated array', "close the array with ']'", 'end', false],
    ['{"a":1', undefined, 'unterminated object', "close the object with '}'", 'end', false],
    ['[', undefined, 'unexpected end of input', undefined, 'end', false],
    ['{"a":', { mode: 'json' }, 'unexpected end of input', undefined, 'end', false],
    ['{"a"', undefined, "expected ':' after key", undefined, 'end', false],
    ['{', undefined, 'expected a string key', undefined, 'end', false],
  ];

  /**
   * The document wrapped `depth - 1` containers deep, alternately an array
   * and an object member, with a line break after each opening when
   * `lines` is set.
   */
  function wrap(doc, depth, lines, close) {
    let open = '';
    let after = '';
    for (let i = 0; i < depth - 1; ++i) {
      open += (i % 2 === 0 ? '[' : '{"k":') + (lines ? '\n' : '');
      after = (i % 2 === 0 ? ']' : '}') + after;
    }
    return { text: open + doc + (close ? after : ''), offset: open.length };
  }

  /** The 1-based line and column of an offset, counted afresh. */
  function lineColumn(text, pos) {
    const before = text.slice(0, pos);
    const line = before.split('\n').length;
    return { line, column: pos - before.lastIndexOf('\n') };
  }

  for (const depth of [1, 2, 5, 500, 3000])
    for (const lines of [false, true])
      it(`reports each error ${depth} deep${lines ? ', a line per level' : ''}`, () => {
        for (const [doc, options, message, hint, at, close] of MALFORMED) {
          const { text, offset } = wrap(doc, depth, lines, close);
          const pos = at === 'end' ? text.length : offset + at;
          const { line, column } = lineColumn(text, pos);
          deepStrictEqual(errorOf(() => parseJsonx(text, options)), {
            jsonx: true,
            name: 'JsonxSyntaxError',
            message: `${message} at line ${line}, column ${column}${hint ? ` (${hint})` : ''}`,
            line,
            column,
            hint,
          }, `${doc} ${depth} deep`);
          // the same text, and the same place in the innermost document, as shallow
          const shallow = errorOf(() => parseJsonx(doc, options));
          strictEqual(shallow.column, (at === 'end' ? doc.length : at) + 1, doc);
        }
      });

  it('reports a deep error at the line and column it is at', () => {
    const n = 3000;
    const cases = [
      ['['.repeat(n), 'unexpected end of input', 1, n + 1, undefined],
      ['['.repeat(n) + '1', 'unterminated array', 1, n + 2, "close the array with ']'"],
      ['{"k":'.repeat(n) + '1', 'unterminated object', 1, 5 * n + 2, "close the object with '}'"],
      ['[\n'.repeat(n) + '1', 'unterminated array', n + 1, 2, "close the array with ']'"],
      ['['.repeat(n) + '1' + ']'.repeat(n - 1) + 'x', "expected ',' or ']' in array", 1, 2 * n + 1, undefined],
      [arrays(n) + ' x', 'unexpected trailing characters', 1, 2 * n + 3, undefined],
      ['['.repeat(n - 1) + '[1 2]' + ']'.repeat(n - 1), "expected ',' or ']' in array", 1, n + 3, undefined],
    ];
    for (const [text, message, line, column, hint] of cases)
      for (const options of MODES)
        deepStrictEqual(errorOf(() => parseJsonx(text, options)), {
          jsonx: true,
          name: 'JsonxSyntaxError',
          message: `${message} at line ${line}, column ${column}${hint ? ` (${hint})` : ''}`,
          line,
          column,
          hint,
        }, `${message}, ${label(options)}`);
  });
});

describe('jsonx: tricky documents', () => {
  it('parses whitespace, empty containers and duplicate keys', () => {
    for (const options of MODES) {
      deepStrictEqual(parseJsonx('\t[\r\n1 ,\n{ "a" : [ ] } , [[]] ]\n', options), [1, { a: [] }, [[]]]);
      deepStrictEqual(parseJsonx('[[],{},[{}],{"":[]}]', options), [[], {}, [{}], { '': [] }]);
      deepStrictEqual(Object.entries(parseJsonx('{"a":1,"b":2,"a":3}', options)), [['a', 3], ['b', 2]]);
      const proto = parseJsonx('{"__proto__":{"x":1},"a":{"__proto__":[]}}', options);
      deepStrictEqual(Object.keys(proto), ['__proto__', 'a']);
      deepStrictEqual(Object.getOwnPropertyDescriptor(proto, '__proto__').value, { x: 1 });
      deepStrictEqual(Object.getOwnPropertyDescriptor(proto.a, '__proto__').value, []);
      strictEqual(Object.getPrototypeOf(proto.a), Object.prototype);
    }
  });

  it('parses nested extension scalars', () => {
    const value = parseJsonx('{"n":[123n,-42n,9007199254740993,+5,1_000,-0],'
      + '"t":[2026-07-18,12:30:00,2026-07-18T12:00:00,2026-07-18T12:00:00Z],'
      + '"re":[/a]b\\//g],"x":[[inf,-inf],{"nan":nan}]}');
    deepStrictEqual(value, {
      n: [123n, -42n, 9007199254740993n, 5, 1000, -0],
      t: [
        new LocalDate(2026, 7, 18),
        new LocalTime(12, 30, 0),
        new LocalDateTime(new LocalDate(2026, 7, 18), new LocalTime(12, 0, 0)),
        new Date('2026-07-18T12:00:00Z'),
      ],
      re: [/a]b\//g],
      x: [[Infinity, -Infinity], { nan: NaN }],
    });
  });

  it('reports events with array indexes after nested containers', () => {
    const events = [];
    parseJsonx('[[1],[2,[3]],4]', { onEvent: (e) => events.push([e.type, e.path, e.kind ?? e.value]) });
    deepStrictEqual(events, [
      ['open', [], 'array'],
      ['open', [0], 'array'],
      ['value', [0, 0], 1],
      ['close', [0], [1]],
      ['open', [1], 'array'],
      ['value', [1, 0], 2],
      ['open', [1, 1], 'array'],
      ['value', [1, 1, 0], 3],
      ['close', [1, 1], [3]],
      ['close', [1], [2, [3]]],
      ['value', [2], 4],
      ['close', [], [[1], [2, [3]], 4]],
    ]);
  });

  it('reports events with object keys, and empty containers', () => {
    const events = [];
    parseJsonx('{"a":{"b":[{}]},"c":[]}', { mode: 'json', onEvent: (e) => events.push([e.type, e.path, e.kind ?? e.value]) });
    deepStrictEqual(events, [
      ['open', [], 'object'],
      ['open', ['a'], 'object'],
      ['open', ['a', 'b'], 'array'],
      ['open', ['a', 'b', 0], 'object'],
      ['close', ['a', 'b', 0], {}],
      ['close', ['a', 'b'], [{}]],
      ['close', ['a'], { b: [{}] }],
      ['open', ['c'], 'array'],
      ['close', ['c'], []],
      ['close', [], { a: { b: [{}] }, c: [] }],
    ]);
  });

  it('reports the events before an error, then the error', () => {
    const events = [];
    const error = errorOf(() => parseJsonx('[1,{"a":[2,3}', { onEvent: (e) => events.push([e.type, e.path, e.kind ?? e.value]) }));
    deepStrictEqual(events, [
      ['open', [], 'array'],
      ['value', [0], 1],
      ['open', [1], 'object'],
      ['open', [1, 'a'], 'array'],
      ['value', [1, 'a', 0], 2],
      ['value', [1, 'a', 1], 3],
    ]);
    deepStrictEqual(error, {
      jsonx: true,
      name: 'JsonxSyntaxError',
      message: "expected ',' or ']' in array at line 1, column 13",
      line: 1,
      column: 13,
      hint: undefined,
    });
  });
});
