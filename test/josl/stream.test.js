import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, throws } from 'node:assert';

import {
  parseJosl,
  createStreamReader,
  parseJoslStream,
  JoslSyntaxError,
} from '@jarenjs/josl';

const DOC = [
  'title = "streamed"',
  'big = 123n',
  '',
  '[server]',
  'host = "localhost"',
  'motd = """',
  'multi',
  'line"""',
  'ports = [',
  '  8080, # http',
  '  8443,',
  ']',
  '',
  '[[items]]',
  'id = 1',
  'when = 2026-07-18T12:00:00Z',
  '',
  '[[items]]',
  'id = 2',
  're = /^ok$/i',
].join('\n');

function chunksOf(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size)
    out.push(text.slice(i, i + size));
  return out;
}

describe('josl: streaming', () => {
  it('chunked feeding matches whole-document parsing at every chunk size', () => {
    const expected = parseJosl(DOC);
    for (const size of [1, 2, 3, 5, 7, 16, 64]) {
      const reader = createStreamReader();
      for (const chunk of chunksOf(DOC, size))
        reader.feed(chunk);
      deepStrictEqual(reader.end(), expected, `chunk size ${size}`);
    }
  });

  it('emits document-order events with absolute paths', () => {
    const events = [];
    const reader = createStreamReader({
      onEvent: (e) => events.push(e.type === 'pair' ? [e.type, e.path, e.value] : [e.type, e.path]),
    });
    reader.feed('a = 1\n[t]\nb = 2\n[[arr]]\nc.d = 3\n');
    reader.end();
    deepStrictEqual(events, [
      ['pair', ['a'], 1],
      ['table', ['t']],
      ['pair', ['t', 'b'], 2],
      ['table-array', ['arr', 0]],
      ['pair', ['arr', 0, 'c', 'd'], 3],
    ]);
  });

  it('emits events as soon as a logical line completes', () => {
    const seen = [];
    const reader = createStreamReader({ onEvent: (e) => seen.push(e.path.join('.')) });
    reader.feed('a = 1\nb = ');
    deepStrictEqual(seen, ['a']); // a is complete, b is still pending
    reader.feed('2\nc = 3');
    deepStrictEqual(seen, ['a', 'b']); // c has no newline yet
    reader.end();
    deepStrictEqual(seen, ['a', 'b', 'c']);
  });

  it('exposes the partial root during streaming', () => {
    const reader = createStreamReader();
    reader.feed('[[]]\nname = "one"\n[[]]\nname = "t');
    deepStrictEqual(reader.root(), [{ name: 'one' }, {}]);
    reader.feed('wo"\n');
    deepStrictEqual(reader.end(), [{ name: 'one' }, { name: 'two' }]);
  });

  it('parses async iterables of chunks', async () => {
    async function* llmish() {
      for (const chunk of chunksOf(DOC, 4))
        yield chunk;
    }
    deepStrictEqual(await parseJoslStream(llmish()), parseJosl(DOC));
  });

  it('reports errors with positions from streamed input too', () => {
    const reader = createStreamReader();
    reader.feed('ok = 1\n');
    throws(() => {
      reader.feed('nope = what\n');
      reader.end();
    }, (e) => e instanceof JoslSyntaxError && e.line === 2 && e.column === 8);
  });

  it('rejects feeding after end', () => {
    const reader = createStreamReader();
    reader.end();
    throws(() => reader.feed('a = 1'), /cannot feed after end/);
  });

  it('errors on unterminated constructs at end of stream', () => {
    const r1 = createStreamReader();
    r1.feed('a = """never closed');
    throws(() => r1.end(), JoslSyntaxError);
    const r2 = createStreamReader();
    r2.feed('a = [1, 2');
    throws(() => r2.end(), JoslSyntaxError);
  });

  it('root() before any content is an empty table', () => {
    strictEqual(typeof createStreamReader().root(), 'object');
    deepStrictEqual(createStreamReader().root(), {});
  });
});
