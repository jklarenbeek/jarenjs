import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, rejects, throws } from 'node:assert';

import {
  parseJosl,
  stringifyJosl,
  stringifyJoslChunks,
  stringifyJoslStream,
  createStreamWriter,
  createStreamReader,
  iterateJoslStream,
  stringifyCsv,
  stringifyCsvChunks,
  stringifyCsvStream,
  createCsvStreamWriter,
  iterateCsvStream,
  JoslSyntaxError,
  JoslStringifyError,
} from '@jarenjs/josl';

/**
 * A pull source over the given items that counts pulls and closes, and
 * can be told to throw at an index.
 * @param {any[]} items
 * @param {{ throwAt?: number }} [shape]
 */
function pullSource(items, shape = {}) {
  const counts = { pulled: 0, closed: 0 };
  const source = {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (shape.throwAt === i)
            throw new Error('the source broke');
          if (i >= items.length)
            return { done: true, value: undefined };
          counts.pulled++;
          return { done: false, value: items[i++] };
        },
        async return(value) {
          counts.closed++;
          return { done: true, value };
        },
      };
    },
  };
  return { counts, source };
}

/** @param {AsyncIterable<string>} chunks */
async function join(chunks) {
  let out = '';
  for await (const chunk of chunks)
    out += chunk;
  return out;
}

/** @param {number} ms */
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const ROWS = [
  { id: 1, name: 'a,b', note: 'he said "hi"' },
  { id: 2, name: 'multi\nline', note: '' },
  { id: 3, name: ' padded ', note: null },
];
const RECORDS = [
  { id: 1, tags: ['x', 'y'], when: 'now' },
  { id: 2, nested: { deep: { v: 1 } } },
  { id: 3, big: 123n, re: /^a$/i },
];

describe('pull: stringifyCsvStream', () => {
  it('is byte-identical to stringifyCsvChunks and stringifyCsv for empty, one, many, quoted and array rows, with and without explicit fields', async () => {
    const cases = [
      [[], {}],
      [ROWS.slice(0, 1), {}],
      [ROWS, {}],
      [ROWS, { header: false }],
      [ROWS, { fields: ['note', 'id'] }],
      [[], { fields: ['a', 'b'] }],
      [[['1', '2'], ['x,y', 'z']], {}],
      [ROWS, { delimiter: ';', quote: "'", newline: '\n' }],
    ];
    for (const [rows, options] of cases) {
      const sync = [...stringifyCsvChunks(rows, options)];
      const streamed = [];
      for await (const chunk of stringifyCsvStream(pullSource(rows).source, options))
        streamed.push(chunk);
      deepStrictEqual(streamed, sync, JSON.stringify(options));
      strictEqual(streamed.join(''), stringifyCsv(rows, options));
    }
  });

  it('pulls one row ahead of the consumer and closes the source once on an early return or an abort', async () => {
    const { counts, source } = pullSource(ROWS);
    const chunks = stringifyCsvStream(source)[Symbol.asyncIterator]();
    strictEqual(counts.pulled, 0, 'nothing pulled before the first chunk is asked for');
    await chunks.next(); // the header
    strictEqual(counts.pulled, 1);
    await chunks.next(); // row 1
    strictEqual(counts.pulled, 1, 'the header and the first row came from one pull');
    await chunks.next(); // row 2
    strictEqual(counts.pulled, 2);
    await chunks.return();
    strictEqual(counts.closed, 1, 'the consumer stopped early: closed once');
    await chunks.return();
    strictEqual(counts.closed, 1);

    const controller = new AbortController();
    const aborted = pullSource(ROWS);
    const stream = stringifyCsvStream(aborted.source, { signal: controller.signal })[Symbol.asyncIterator]();
    await stream.next(); // the header and the first row are one pull
    await stream.next();
    controller.abort(new Error('stop'));
    await rejects(stream.next(), /stop/, 'the abort is met at the next pull');
    strictEqual(aborted.counts.closed, 1, 'the abort closed the source once');
    strictEqual(aborted.counts.pulled, 1, 'and pulled nothing more');

    const broken = pullSource(ROWS, { throwAt: 1 });
    await rejects(join(stringifyCsvStream(broken.source)), /the source broke/);
    strictEqual(broken.counts.closed, 1, 'a throw closes the source once');
    const whole = pullSource(ROWS);
    await join(stringifyCsvStream(whole.source));
    strictEqual(whole.counts.closed, 0, 'a source read to its end is not closed again');
  });

  it('the stream writer produces the same text and answers its fields', () => {
    const writer = createCsvStreamWriter();
    strictEqual(writer.fields, null);
    for (const row of ROWS)
      writer.write(row);
    deepStrictEqual(writer.fields, ['id', 'name', 'note']);
    strictEqual(writer.end(), stringifyCsv(ROWS));
    const owed = createCsvStreamWriter({ fields: ['a', 'b'] });
    strictEqual(owed.end(), 'a,b\r\n', 'an explicit field list is owed its header even with no rows');
    const chunks = [];
    const sink = createCsvStreamWriter({ onChunk: (c) => chunks.push(c) });
    sink.write(ROWS[0]).write(ROWS[1]);
    deepStrictEqual(chunks, [...stringifyCsvChunks(ROWS.slice(0, 2))]);
    strictEqual(sink.end(), '', 'a sink writer retains nothing');
  });
});

describe('pull: stringifyJoslStream', () => {
  it('is byte-identical to stringifyJoslChunks and stringifyJosl for empty, one and many records, nested sections included', async () => {
    for (const records of [[], RECORDS.slice(0, 1), RECORDS, [{ a: { b: 1 } }, { c: [1, 2] }]]) {
      const sync = [...stringifyJoslChunks(records)];
      const streamed = [];
      for await (const chunk of stringifyJoslStream(pullSource(records).source))
        streamed.push(chunk);
      deepStrictEqual(streamed, sync);
      if (records.length !== 0) {
        strictEqual(streamed.join(''), stringifyJosl(records));
        deepStrictEqual(parseJosl(streamed.join('')), records);
      }
    }
  });

  it('pulls one record per chunk, refuses a non-table record and a TOML root, and closes the source once on early return, abort or throw', async () => {
    const { counts, source } = pullSource(RECORDS);
    const chunks = stringifyJoslStream(source)[Symbol.asyncIterator]();
    strictEqual(counts.pulled, 0);
    await chunks.next();
    strictEqual(counts.pulled, 1);
    await chunks.next();
    strictEqual(counts.pulled, 2);
    await chunks.return();
    strictEqual(counts.closed, 1);

    await rejects(join(stringifyJoslStream(pullSource([{ ok: 1 }, 5]).source)),
      (e) => e instanceof JoslStringifyError && /root array elements must be tables/.test(e.message));
    await rejects(stringifyJoslStream([], { mode: 'toml' }).next(), JoslStringifyError);

    const controller = new AbortController();
    controller.abort();
    const aborted = pullSource(RECORDS);
    await rejects(stringifyJoslStream(aborted.source, { signal: controller.signal }).next(), (e) => e.name === 'AbortError');
    strictEqual(aborted.counts.closed, 1);
    strictEqual(aborted.counts.pulled, 0);

    const broken = pullSource(RECORDS, { throwAt: 2 });
    await rejects(join(stringifyJoslStream(broken.source)), /the source broke/);
    strictEqual(broken.counts.closed, 1);
  });
});

describe('pull: the JOSL event writer without a buffer', () => {
  it('buffer: false delivers every chunk to the sink and retains none; text() and end() answer empty', () => {
    const chunks = [];
    const w = createStreamWriter({ onChunk: (c) => chunks.push(c), buffer: false });
    w.comment('generated').pair('title', 'x').table('server').pair('host', 'h');
    strictEqual(w.text(), '');
    strictEqual(w.end(), '');
    deepStrictEqual(w.chunks, []);
    const buffered = createStreamWriter();
    buffered.comment('generated').pair('title', 'x').table('server').pair('host', 'h');
    strictEqual(chunks.join(''), buffered.end(), 'the sink saw exactly the buffered document, blank lines included');
    throws(() => createStreamWriter({ buffer: false }), JoslStringifyError, 'no sink to deliver to');
  });
});

describe('pull: iterateJoslStream', () => {
  const DOC = [
    '[[]]', 'id = 1', 'tags = ["x"]', '',
    '[[]]', 'id = 2', '', '[nested]', 'v = 1', '',
    '[[]]', 'id = 3',
  ].join('\n');

  it('yields each root item once, chunked at any size, and holds none of them', async () => {
    for (const size of [1, 3, 7, 64]) {
      const chunks = [];
      for (let i = 0; i < DOC.length; i += size)
        chunks.push(DOC.slice(i, i + size));
      const seen = [];
      for await (const item of iterateJoslStream(chunks))
        seen.push(item);
      deepStrictEqual(seen, [{ id: 1, tags: ['x'] }, { id: 2, nested: { v: 1 } }, { id: 3 }], `size ${size}`);
    }
    // the machine behind it retains at most the item in progress
    const reader = createStreamReader({ detachRoot: () => {} });
    reader.feed(DOC + '\n');
    deepStrictEqual(reader.root(), [{ id: 3 }], 'only the item in progress is held');
    reader.end();
    deepStrictEqual(reader.root(), [], 'and the last one leaves at the end');
    const events = [];
    const indexed = createStreamReader({ detachRoot: () => {}, onEvent: (e) => events.push(e.type === 'root-item' ? e.index : e.path.join('/')) });
    indexed.feed(DOC);
    indexed.end();
    deepStrictEqual(events, [0, '0/id', '0/tags', 1, '1/id', '1/nested', '1/nested/v', 2, '2/id'], 'indices survive detachment');
  });

  it('refuses a table root by name, and closes the chunk source once on an early return, an abort or a throw', async () => {
    await rejects(async () => { for await (const item of iterateJoslStream(['a = 1\nb = 2\n'])) void item; },
      (e) => e instanceof JoslSyntaxError && /table root/.test(e.message));
    const { counts, source } = pullSource(['[[]]\nid = 1\n', '[[]]\nid = 2\n', '[[]]\nid = 3\n']);
    const items = iterateJoslStream(source)[Symbol.asyncIterator]();
    deepStrictEqual((await items.next()).value, { id: 1 });
    strictEqual(counts.pulled, 2, 'an item completes when the next header arrives');
    await items.return();
    strictEqual(counts.closed, 1);

    const controller = new AbortController();
    const aborted = pullSource(['[[]]\nid = 1\n', '[[]]\nid = 2\n']);
    const stream = iterateJoslStream(aborted.source, { signal: controller.signal })[Symbol.asyncIterator]();
    controller.abort(new Error('stop'));
    await rejects(stream.next(), /stop/);
    strictEqual(aborted.counts.closed, 1);

    const broken = pullSource(['[[]]\nid = 1\n'], { throwAt: 1 });
    await rejects(async () => { for await (const item of iterateJoslStream(broken.source)) void item; }, /the source broke/);
    strictEqual(broken.counts.closed, 1);
    const limited = ['[[]]\nid = 1\n[[]]\nid = 2\n'];
    const seen = [];
    for await (const item of iterateJoslStream(limited, { maxRetainedValues: 2 }))
      seen.push(item);
    deepStrictEqual(seen, [{ id: 1 }, { id: 2 }], 'the retained count starts over with every detached item');
  });

  it('iterateCsvStream closes its chunk source once on early return and honours a signal', async () => {
    const { counts, source } = pullSource(['a,b\n1,2\n', '3,4\n', '5,6\n']);
    const rows = iterateCsvStream(source, { headers: true })[Symbol.asyncIterator]();
    deepStrictEqual((await rows.next()).value, { a: '1', b: '2' });
    await rows.return();
    strictEqual(counts.closed, 1);
    const controller = new AbortController();
    controller.abort();
    const aborted = pullSource(['a,b\n1,2\n']);
    await rejects(iterateCsvStream(aborted.source, { signal: controller.signal }).next(), (e) => e.name === 'AbortError');
    strictEqual(aborted.counts.closed, 1);
  });
});

void tick;
