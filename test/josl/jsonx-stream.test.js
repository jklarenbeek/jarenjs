import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, throws, ok } from 'node:assert';

import {
  parseJsonx,
  createJsonxStreamReader,
  parseJsonxStream,
  JsonxSyntaxError,
} from '@jarenjs/josl';

// Strict-JSON corpus (also valid JSONX).
const STRICT_DOCS = [
  'null', 'true', 'false', '0', '-0', '42', '-17', '3.1415', '5e+22',
  '1e-7', '"hello \\"world\\" \\u0041\\n"', '[]', '[1,[2,[3]]]', '{}',
  '{"a":1,"b":{"c":[true,null]}}', '  { "s" : "x" , "n" : -1.5e2 }  ',
  '{"dup":1,"dup":2}', '"\\ud83d\\ude00"',
  '{\n  "multi": [\n    1,\n    2\n  ]\n}',
];

// JSONX extension corpus.
const JSONX_DOCS = [
  '{"a": 123n, "b": -42n}',
  '9007199254740993',
  '{"re": /ab+c/gi, "cls": /[/]x/m}',
  '[2026-07-18T12:00:00Z, 2026-07-18, 12:30:00, 2026-07-18T12:00:00]',
  '[1979-05-27 07:32:00Z, 1979-05-27 07:32:00, 1979-05-27]',
  '[inf, -inf, nan, Infinity, -Infinity, NaN, 1_000_000, +5]',
  '{"__proto__": {"polluted": true}}',
  '{"nested": {"deep": [{"x": [[1, 2n], []]}]}, "tail": "s"}',
];

function readAll(doc, chunks, options = undefined) {
  const events = [];
  const reader = createJsonxStreamReader({
    ...(options ?? {}),
    onEvent: (e) => events.push(e),
  });
  for (const chunk of chunks)
    reader.feed(chunk);
  return { root: reader.end(), events };
}

function errOf(fn) {
  try {
    fn();
  }
  catch (e) {
    return e;
  }
  return null;
}

describe('jsonx-stream: equivalence with the full-text parser', () => {
  for (const doc of [...STRICT_DOCS, ...JSONX_DOCS])
    it(`end() equals parseJsonx for ${JSON.stringify(doc.slice(0, 30))}`, () => {
      deepStrictEqual(readAll(doc, [doc]).root, parseJsonx(doc));
    });
  for (const doc of STRICT_DOCS)
    it(`strict mode equals JSON.parse for ${JSON.stringify(doc.slice(0, 30))}`, () => {
      deepStrictEqual(readAll(doc, [doc], { mode: 'json' }).root, JSON.parse(doc));
    });
});

describe('jsonx-stream: split-point fuzz', () => {
  for (const doc of [...STRICT_DOCS, ...JSONX_DOCS])
    it(`splits of ${JSON.stringify(doc.slice(0, 30))} match single-feed`, () => {
      const base = readAll(doc, [doc]);
      // one char at a time
      deepStrictEqual(readAll(doc, doc.split('')), base, 'char-at-a-time');
      // every 2-chunk split
      for (let i = 1; i < doc.length; ++i)
        deepStrictEqual(
          readAll(doc, [doc.slice(0, i), doc.slice(i)]), base, `split at ${i}`);
    });
});

describe('jsonx-stream: event vocabulary', () => {
  it('emits start/pair/item/end in document order with absolute paths', () => {
    const { events } = readAll(
      '{"a": [1, {"b": 2n}], "c": "x"}',
      ['{"a": [1, {"b": 2n}], "c": "x"}']);
    deepStrictEqual(events, [
      { type: 'object-start', path: [], line: 1 },
      { type: 'array-start', path: ['a'], line: 1 },
      { type: 'item', path: ['a', 0], index: 0, value: 1, line: 1 },
      { type: 'object-start', path: ['a', 1], line: 1 },
      { type: 'pair', path: ['a', 1, 'b'], key: 'b', value: 2n, line: 1 },
      // an end event carries its completed container, so a consumer
      // never has to walk back into root() by path to find it
      { type: 'object-end', path: ['a', 1], value: { b: 2n }, line: 1 },
      { type: 'array-end', path: ['a'], value: [1, { b: 2n }], line: 1 },
      { type: 'pair', path: ['c'], key: 'c', value: 'x', line: 1 },
      { type: 'object-end', path: [], value: { a: [1, { b: 2n }], c: 'x' }, line: 1 },
    ]);
  });

  it('reports physical line numbers', () => {
    const { events } = readAll(
      '{\n  "a": [\n    1\n  ]\n}',
      ['{\n  "a": [\n    1\n  ]\n}']);
    deepStrictEqual(events.map((e) => [e.type, e.line]), [
      ['object-start', 1],
      ['array-start', 2],
      ['item', 3],
      ['array-end', 4],
      ['object-end', 5],
    ]);
  });

  it('a scalar root emits no events', () => {
    const { root, events } = readAll('42', ['42']);
    strictEqual(root, 42);
    deepStrictEqual(events, []);
  });

  it('fires scalars only on completion at their delimiter', () => {
    const seen = [];
    const reader = createJsonxStreamReader({ onEvent: (e) => seen.push(e.type) });
    reader.feed('{"n": 12');
    deepStrictEqual(seen, ['object-start']); // 12 may still grow
    reader.feed('3, "s": "x');
    deepStrictEqual(seen, ['object-start', 'pair']); // string still open
    reader.feed('y"}');
    deepStrictEqual(seen, ['object-start', 'pair', 'pair', 'object-end']);
    deepStrictEqual(reader.end(), { n: 123, s: 'xy' });
  });
});

describe('jsonx-stream: partial root', () => {
  it('root() is undefined before any content', () => {
    strictEqual(createJsonxStreamReader().root(), undefined);
  });

  it('exposes the growing tree; incomplete scalars are absent', () => {
    const reader = createJsonxStreamReader();
    reader.feed('{"a": [1, 2');
    deepStrictEqual(reader.root(), { a: [1] });
    reader.feed(', 3], "b"');
    deepStrictEqual(reader.root(), { a: [1, 2, 3] });
    reader.feed(': 4}');
    deepStrictEqual(reader.end(), { a: [1, 2, 3], b: 4 });
  });
});

describe('jsonx-stream: strict-json mode rejections', () => {
  // every JSONX extension form, plus classic JSON errors
  const badDocs = [
    '+1', '1n', '1_000', 'inf', '-inf', 'nan', 'Infinity', 'NaN',
    '/re/g', '2026-07-18', '12:30:00', '[1, 2n]', '{"a": /x/}',
    '01', "'single'", '{a:1}', '[1,]', '{"a":1,}', '[1 2]', '"\t"',
  ];
  for (const doc of badDocs)
    it(`rejects ${JSON.stringify(doc)} with the full-text parser's error`, () => {
      const expected = errOf(() => parseJsonx(doc, { mode: 'json' }));
      ok(expected instanceof JsonxSyntaxError);
      const actual = errOf(() => readAll(doc, [doc], { mode: 'json' }));
      ok(actual instanceof JsonxSyntaxError, `stream accepted ${doc}`);
      strictEqual(actual.message, expected.message);
    });
});

describe('jsonx-stream: errors', () => {
  const incompleteDocs = [
    '', '{', '[', '{"a"', '{"a":', '{"a":1', '[1', '[1,', '"abc',
    '"ab\\', 'tru', '{"a": "b" "c"', '{"a" 1}', '[1:', '-',
  ];
  for (const doc of incompleteDocs)
    it(`fails on ${JSON.stringify(doc)} like the full-text parser`, () => {
      const expected = errOf(() => parseJsonx(doc));
      ok(expected instanceof JsonxSyntaxError);
      const actual = errOf(() => {
        const reader = createJsonxStreamReader();
        reader.feed(doc);
        reader.end();
      });
      ok(actual instanceof JsonxSyntaxError, `stream accepted ${JSON.stringify(doc)}`);
      strictEqual(actual.message, expected.message);
    });

  it('reports line and column across chunk boundaries', () => {
    const expected = errOf(() => parseJsonx('{\n  "a": what\n}'));
    const reader = createJsonxStreamReader();
    reader.feed('{\n  "a": wh');
    const actual = errOf(() => {
      reader.feed('at\n}');
      reader.end();
    });
    ok(actual instanceof JsonxSyntaxError);
    strictEqual(actual.line, 2);
    strictEqual(actual.column, 8);
    strictEqual(actual.message, expected.message);
  });

  it('errors eagerly on trailing content', () => {
    const reader = createJsonxStreamReader();
    throws(() => reader.feed('1 2'), /unexpected trailing characters/);
  });

  it('rejects feeding after end', () => {
    const reader = createJsonxStreamReader();
    reader.feed('1');
    reader.end();
    throws(() => reader.feed('x'), /cannot feed after end/);
  });

  it('end() is idempotent', () => {
    const reader = createJsonxStreamReader();
    reader.feed('{"a": 1}');
    deepStrictEqual(reader.end(), { a: 1 });
    deepStrictEqual(reader.end(), { a: 1 });
  });
});

describe('jsonx-stream: prototype safety', () => {
  it('guards against prototype pollution', () => {
    const { root } = readAll(
      '{"__proto__": {"polluted": true}}',
      ['{"__proto__', '": {"poll', 'uted": true}}']);
    strictEqual({}.polluted, undefined);
    strictEqual(Object.getPrototypeOf(root), Object.prototype);
    deepStrictEqual(root.__proto__, { polluted: true });
  });
});

describe('jsonx-stream: async convenience', () => {
  it('parses async iterables of chunks', async () => {
    const doc = '{"a": [1, 2, {"b": "cd"}]}';
    async function* llmish() {
      for (let i = 0; i < doc.length; i += 3)
        yield doc.slice(i, i + 3);
    }
    deepStrictEqual(await parseJsonxStream(llmish()), parseJsonx(doc));
  });
});

//#region partial text

// Deltas for progressive display. Feeding one character at a time is the
// worst case a token stream can produce, so every escape, surrogate pair
// and chunk boundary gets exercised by construction.
function partialsOf(doc, size = 1) {
  const events = [];
  const reader = createJsonxStreamReader({
    partialText: true,
    onEvent: (e) => events.push(e),
  });
  for (let i = 0; i < doc.length; i += size)
    reader.feed(doc.slice(i, i + size));
  const root = reader.end();
  return { events, root };
}

function joinedText(events, path) {
  return events
    .filter((e) => e.type === 'text-partial' && e.path.join(' ') === path.join(' '))
    .map((e) => e.text)
    .join('');
}

describe('jsonx-stream: text-partial events', () => {
  it('is off unless asked for', () => {
    const events = [];
    const reader = createJsonxStreamReader({ onEvent: (e) => events.push(e) });
    for (const ch of '{"a": "hello"}')
      reader.feed(ch);
    reader.end();
    strictEqual(events.some((e) => e.type === 'text-partial'), false);
  });
  it('deltas concatenate to the completed string', () => {
    const { events, root } = partialsOf('{"msg": "hello world"}');
    strictEqual(joinedText(events, ['msg']), 'hello world');
    deepStrictEqual(root, { msg: 'hello world' });
  });
  it('carries the same path the pair event will use', () => {
    const { events } = partialsOf('{"a": {"b": "xy"}}');
    const partial = events.find((e) => e.type === 'text-partial');
    const pair = events.find((e) => e.type === 'pair');
    deepStrictEqual(partial.path, ['a', 'b']);
    deepStrictEqual(pair.path, ['a', 'b']);
  });
  it('indexes array elements', () => {
    const { events } = partialsOf('["ab", "cd"]');
    strictEqual(joinedText(events, [0]), 'ab');
    strictEqual(joinedText(events, [1]), 'cd');
  });
  it('unescapes deltas and never splits an escape', () => {
    const { events, root } = partialsOf('{"s": "a\\u0041b\\tc\\"d"}');
    strictEqual(joinedText(events, ['s']), 'aAb\tc"d');
    deepStrictEqual(root, { s: 'aAb\tc"d' });
    for (const e of events)
      if (e.type === 'text-partial')
        ok(!e.text.includes('\\'), `raw escape leaked into a delta: ${JSON.stringify(e.text)}`);
  });
  it('never splits a surrogate pair across two deltas', () => {
    const { events, root } = partialsOf('{"e": "x\\uD83D\\uDE00y"}');
    strictEqual(joinedText(events, ['e']), 'x\u{1F600}y');
    deepStrictEqual(root, { e: 'x\u{1F600}y' });
    for (const e of events) {
      if (e.type !== 'text-partial')
        continue;
      const last = e.text.charCodeAt(e.text.length - 1);
      ok(!(last >= 0xD800 && last <= 0xDBFF), 'a delta ended on a lone high surrogate');
      const first = e.text.charCodeAt(0);
      ok(!(first >= 0xDC00 && first <= 0xDFFF), 'a delta started on a lone low surrogate');
    }
  });
  it('emits nothing for object keys', () => {
    const { events } = partialsOf('{"a long key here": 1}');
    strictEqual(events.some((e) => e.type === 'text-partial'), false);
  });
  it('agrees with the completed value at every chunk size', () => {
    const doc = '{"a": "one \\u00e9 two", "b": ["three", "fo\\nur"], "c": 5}';
    for (const size of [1, 2, 3, 5, 8, 13]) {
      const { events, root } = partialsOf(doc, size);
      deepStrictEqual(root, parseJsonx(doc));
      strictEqual(joinedText(events, ['a']), root.a);
      strictEqual(joinedText(events, ['b', 0]), root.b[0]);
      strictEqual(joinedText(events, ['b', 1]), root.b[1]);
    }
  });
  it('handles a root-level string', () => {
    const { events, root } = partialsOf('"just a string"');
    strictEqual(root, 'just a string');
    strictEqual(joinedText(events, []), 'just a string');
  });
});


describe('jsonx-stream: detached records', () => {
  const FC = JSON.stringify({
    type: 'FeatureCollection',
    name: 'regions',
    features: [
      { type: 'Feature', properties: { name: 'a' }, geometry: { type: 'Point', coordinates: [1, 2] } },
      { type: 'Feature', properties: { name: 'b' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
      { type: 'Feature', properties: { name: 'c' }, geometry: null },
    ],
  });

  /** Feed a document one character at a time, collecting detached records. */
  function stream(doc, detach) {
    const records = [];
    const reader = createJsonxStreamReader({
      mode: 'json',
      detach,
      onEvent: (e) => {
        if ((e.type === 'object-end' || e.type === 'array-end')
          && e.path.length === detach.length)
          records.push(e.value);
      },
    });
    for (const ch of doc)
      reader.feed(ch);
    return { root: reader.end(), records };
  }

  it('hands every record to the consumer and keeps none in the root', () => {
    const { root, records } = stream(FC, ['features', '*']);
    strictEqual(records.length, 3);
    // the frame survives, the records do not
    deepStrictEqual(root, { type: 'FeatureCollection', name: 'regions', features: [] });
    strictEqual(root.features.length, 0, 'not even an empty slot per record');
  });

  it('detached records are byte-for-byte what a full parse would produce', () => {
    const { records } = stream(FC, ['features', '*']);
    deepStrictEqual(records, JSON.parse(FC).features);
  });

  it('a record keeps its own nesting: the pattern is a path, not a prefix', () => {
    const { records } = stream(FC, ['features', '*']);
    // the Polygon's rings are inside their feature, not detached from it
    deepStrictEqual(records[1].geometry.coordinates, [[[0, 0], [1, 0], [1, 1], [0, 0]]]);
  });

  it('detaches array elements at the root', () => {
    const doc = '[{"i":0},{"i":1},{"i":2}]';
    const { root, records } = stream(doc, ['*']);
    deepStrictEqual(records, [{ i: 0 }, { i: 1 }, { i: 2 }]);
    deepStrictEqual(root, []);
  });

  it('keeps indices right when only some siblings detach', () => {
    // a literal index detaches exactly one element; the others stay put
    // at the positions they had, so no path ever shifts
    const events = [];
    const reader = createJsonxStreamReader({
      mode: 'json',
      detach: ['xs', 1],
      onEvent: (e) => events.push(e),
    });
    reader.feed('{"xs":[10,20,30]}');
    const root = reader.end();
    deepStrictEqual(events.filter((e) => e.type === 'item').map((e) => e.path),
      [['xs', 0], ['xs', 1], ['xs', 2]]);
    strictEqual(root.xs[0], 10);
    strictEqual(root.xs[2], 30);
    ok(!(1 in root.xs), 'the detached element left no slot behind');
  });

  it('detaches scalars too, which the item event already carried', () => {
    const seen = [];
    const reader = createJsonxStreamReader({
      mode: 'json',
      detach: ['log', '*'],
      onEvent: (e) => {
        if (e.type === 'item') seen.push(e.value);
      },
    });
    reader.feed('{"log":["a","b","c"],"n":3}');
    const root = reader.end();
    deepStrictEqual(seen, ['a', 'b', 'c']);
    deepStrictEqual(root, { log: [], n: 3 });
  });

  it('detaches an object member by key', () => {
    const reader = createJsonxStreamReader({ mode: 'json', detach: ['big'] });
    reader.feed('{"keep":1,"big":{"a":[1,2,3]}}');
    deepStrictEqual(reader.end(), { keep: 1 });
  });

  it('changes nothing when the pattern matches nothing', () => {
    const { root } = stream(FC, ['nowhere', '*']);
    deepStrictEqual(root, JSON.parse(FC));
  });

  it('reads identically with and without detach, whatever the chunking', () => {
    // the parse is unaffected: same events, same paths, same values
    const plain = [];
    const detached = [];
    const strip = (e) => (e.type === 'object-end' || e.type === 'array-end'
      ? { type: e.type, path: e.path, line: e.line }
      : e);
    for (const [sink, detach] of [[plain, undefined], [detached, ['features', '*']]]) {
      const reader = createJsonxStreamReader({
        mode: 'json', detach, onEvent: (e) => sink.push(strip(e)),
      });
      for (let i = 0; i < FC.length; i += 7)
        reader.feed(FC.slice(i, i + 7));
      reader.end();
    }
    deepStrictEqual(detached, plain);
  });

  it('rejects a malformed pattern at construction', () => {
    for (const bad of [[], 'features', 42, null, [{}], [-1], [1.5], [Symbol.iterator]])
      throws(() => createJsonxStreamReader({ detach: bad }), TypeError);
  });
});

//#endregion
