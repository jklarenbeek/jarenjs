import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, throws, ok } from 'node:assert';

import { mulberry32 } from '@jarenjs/core/random';
import {
  parseJosl,
  parseToml,
  parseJoslCst,
  parseJoslStream,
  createStreamReader,
  createStreamWriter,
  iterateJoslStream,
  stringifyJosl,
  stringifyJoslChunks,
  stringifyJoslStream,
  toGbnf,
  JoslSyntaxError,
  JoslStringifyError,
} from '@jarenjs/josl';

async function drain(iterable) {
  const out = [];
  for await (const item of iterable)
    out.push(item);
  return out;
}

function reads(text) {
  const value = parseJosl(text);
  ok(Array.isArray(value), `${JSON.stringify(text)} reads as an array`);
  return value;
}

function refused(text, pattern, options = undefined) {
  throws(() => parseJosl(text, options), (e) => e instanceof JoslSyntaxError && pattern.test(e.message), JSON.stringify(text));
}

describe('josl: the empty root array', () => {
  it('is spelled [] and nothing else changes spelling', () => {
    strictEqual(stringifyJosl([]), '[]\n');
    strictEqual(stringifyJosl({}), '');
    strictEqual(stringifyJosl([{}]), '[[]]\n');
    strictEqual(stringifyJosl([{}, {}]), '[[]]\n\n[[]]\n');
    strictEqual(stringifyJosl({ a: [], b: {}, c: [{}] }), 'a = []\n\n[b]\n\n[[c]]\n');
    strictEqual(stringifyJosl([{ a: [], b: {} }]), '[[]]\na = []\n\n[b]\n');
  });

  it('reads back as an array, where the empty table reads as an object', () => {
    deepStrictEqual(reads('[]\n'), []);
    deepStrictEqual(parseJosl(stringifyJosl([])), []);
    deepStrictEqual(parseJosl(''), {});
    deepStrictEqual(parseJosl(stringifyJosl({})), {});
  });

  it('reads the forms a reader may meet', () => {
    deepStrictEqual(reads('[]'), []);
    deepStrictEqual(reads('[ ]'), []);
    deepStrictEqual(reads('# none\n\n[] # empty\n\n# end\n'), []);
    deepStrictEqual(reads('[]\r\n'), []);
    deepStrictEqual(reads('[]\n[[]]\na = 1\n'), [{ a: 1 }]);
  });

  it('is a JOSL extension that strict TOML refuses', () => {
    throws(() => parseToml('[]\n'), (e) => e instanceof JoslSyntaxError && /root arrays/.test(e.message));
    throws(() => stringifyJosl([], { mode: 'toml' }), JoslStringifyError);
  });

  it('refuses a second declaration, a table root, and a section before any item', () => {
    refused('[]\n[]\n', /already/);
    refused('[[]]\n[]\n', /already/);
    refused('a = 1\n[]\n', /mix a root table and a root array/);
    refused('[x]\n[]\n', /mix a root table and a root array/);
    refused('[]\na = 1\n', /expected \[\[\]\] before/);
    refused('[]\n[x]\n', /expected \[\[\]\] before/);
    refused('[]\n[[x]]\n', /expected \[\[\]\] before/);
  });

  it('is read the same from any chunking and announced as one event', () => {
    for (const parts of [['[]\n'], ['[', ']\n'], ['[]', '\n'], ['[', ']', '\n']]) {
      const events = [];
      const reader = createStreamReader({ onEvent: (e) => events.push(e) });
      for (const part of parts)
        reader.feed(part);
      const root = reader.end();
      ok(Array.isArray(root), JSON.stringify(parts));
      deepStrictEqual(root, []);
      deepStrictEqual(events, [{ type: 'root-array', path: [], line: 1 }]);
    }
    const events = [];
    parseJosl('# c\n[]\n[[]]\n', { onEvent: (e) => events.push(e) });
    deepStrictEqual(events, [
      { type: 'root-array', path: [], line: 2 },
      { type: 'root-item', path: [0], index: 0, line: 3 },
    ]);
  });

  it('reads through the stream readers and the CST', async () => {
    deepStrictEqual(await parseJoslStream(['[', ']\n']), []);
    deepStrictEqual(await drain(iterateJoslStream(['[]\n'])), []);
    deepStrictEqual(await drain(iterateJoslStream(['[]\n[[]]\na = 1\n[[]]\na = 2\n'])), [{ a: 1 }, { a: 2 }]);
    const doc = parseJoslCst('[]\n');
    strictEqual(doc.toString(), '[]\n');
    deepStrictEqual(doc.toJSON(), []);
  });

  it('is written the same by every writer', async () => {
    strictEqual([...stringifyJoslChunks([])].join(''), '[]\n');
    strictEqual((await drain(stringifyJoslStream([]))).join(''), '[]\n');
    strictEqual((await drain(stringifyJoslStream((async function* () { })()))).join(''), '[]\n');
    const w = createStreamWriter();
    strictEqual(w.rootArray().end(), '[]\n');
    const chunks = [];
    createStreamWriter({ onChunk: (c) => chunks.push(c), buffer: false }).rootArray();
    deepStrictEqual(chunks, ['[]\n']);
    const filled = createStreamWriter().comment('c').rootArray().rootItem({ a: 1 });
    deepStrictEqual(parseJosl(filled.end()), [{ a: 1 }]);
    for (const nonEmpty of [[{ a: 1 }], [{ a: 1 }, { b: 2 }]]) {
      strictEqual([...stringifyJoslChunks(nonEmpty)].join(''), stringifyJosl(nonEmpty));
      strictEqual((await drain(stringifyJoslStream(nonEmpty))).join(''), stringifyJosl(nonEmpty));
    }
  });

  it('is refused by the stream writer where the reader would refuse it', () => {
    throws(() => createStreamWriter({ mode: 'toml' }).rootArray(), JoslStringifyError);
    throws(() => createStreamWriter().pair('a', 1).rootArray(), (e) => /mix a root table and a root array/.test(e.message));
    throws(() => createStreamWriter().table('t').rootArray(), (e) => /mix a root table and a root array/.test(e.message));
    throws(() => createStreamWriter().rootArray().rootArray(), (e) => /already/.test(e.message));
    throws(() => createStreamWriter().rootItem().rootArray(), (e) => /already/.test(e.message));
    throws(() => createStreamWriter().rootArray().pair('a', 1), JoslStringifyError);
    throws(() => createStreamWriter().rootArray().table('t'), JoslStringifyError);
  });

  it('is part of the grammar JOSL text is constrained to, and not of the TOML one', () => {
    ok(toGbnf().includes('root-array-table ::= "[" ws "]"'));
    ok(!toGbnf({ mode: 'toml' }).includes('root-array-table'));
  });
});

// Random documents with empty arrays and empty tables at every depth.
const KEYS = ['a', 'b', 'c', 'key', 'x y', 'd.e', 'z'];

function scalar(random) {
  const pick = Math.floor(random() * 5);
  if (pick === 0) return Math.floor(random() * 1000) - 500;
  if (pick === 1) return random() < 0.5;
  if (pick === 2) return null;
  if (pick === 3) return `s${Math.floor(random() * 50)}`;
  return Math.floor(random() * 100) / 4;
}

function table(random, depth) {
  const out = {};
  const width = Math.floor(random() * 4);
  for (let i = 0; i < width; ++i)
    out[KEYS[Math.floor(random() * KEYS.length)]] = value(random, depth + 1);
  return out;
}

function array(random, depth) {
  const length = Math.floor(random() * 4);
  const kind = Math.floor(random() * 3);
  const out = [];
  for (let i = 0; i < length; ++i) {
    if (kind === 0) out.push(table(random, depth + 1));
    else if (kind === 1) out.push(scalar(random));
    else out.push(random() < 0.5 ? array(random, depth + 1) : value(random, depth + 1));
  }
  return out;
}

function value(random, depth) {
  const r = random();
  if (depth > 4 || r < 0.35) return scalar(random);
  if (r < 0.5) return {};
  if (r < 0.65) return [];
  return r < 0.82 ? table(random, depth) : array(random, depth);
}

describe('josl: round trip over random documents', () => {
  it('reads back what stringifyJosl wrote, empty arrays and tables at every depth', () => {
    const random = mulberry32(20261014);
    let emptyRoots = 0;
    let emptyNested = 0;
    for (let round = 0; round < 600; ++round) {
      const doc = random() < 0.5 ? table(random, 0) : (() => {
        const length = Math.floor(random() * 4);
        return Array.from({ length }, () => table(random, 1));
      })();
      const text = stringifyJosl(doc);
      const back = parseJosl(text);
      deepStrictEqual(back, doc, text);
      strictEqual(Array.isArray(back), Array.isArray(doc), text);
      strictEqual(stringifyJosl(back), text);
      strictEqual([...stringifyJoslChunks(doc)].join(''), text);
      if (Array.isArray(doc) && doc.length === 0) emptyRoots++;
      emptyNested += (text.match(/= \[\]|\[\[\]\]|^\[[a-z]+\]$/gm) ?? []).length;
    }
    ok(emptyRoots > 5, `${emptyRoots} empty root arrays drawn`);
    ok(emptyNested > 50, `${emptyNested} empty nested arrays and tables drawn`);
  });

  it('keeps an empty table root and an empty root array apart', () => {
    for (const doc of [{}, [], [{}], { a: {} }, { a: [] }, [{ a: [] }], [{ a: {} }], { a: [{}] }, { a: [[]] }, { a: [{}, []] }]) {
      const back = parseJosl(stringifyJosl(doc));
      deepStrictEqual(back, doc);
      strictEqual(Array.isArray(back), Array.isArray(doc));
    }
  });
});
