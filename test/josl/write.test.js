import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, throws } from 'node:assert';

import {
  parseJosl,
  parseToml,
  stringifyJosl,
  createStreamWriter,
  stringifyJoslChunks,
  JoslStringifyError,
} from '@jarenjs/josl';

describe('josl: streaming writer', () => {
  it('builds a document event by event that the reader accepts', () => {
    const w = createStreamWriter();
    w.comment('generated')
      .pair('title', 'example')
      .pair(['owner', 'name'], 'Tom')
      .table('server')
      .pair('host', 'localhost')
      .pair('big', 123n)
      .tableArray('items')
      .pair('id', 1)
      .tableArray('items')
      .pair('id', 2);
    deepStrictEqual(parseJosl(w.end()), {
      title: 'example',
      owner: { name: 'Tom' },
      server: { host: 'localhost', big: 123n },
      items: [{ id: 1 }, { id: 2 }],
    });
  });

  it('delivers chunks through onChunk as they are produced', () => {
    const chunks = [];
    const w = createStreamWriter({ onChunk: (c) => chunks.push(c) });
    w.pair('a', 1);
    strictEqual(chunks.length, 1);
    strictEqual(chunks[0], 'a = 1\n');
    w.table('t');
    w.pair('b', 2);
    strictEqual(w.text(), chunks.join(''));
    deepStrictEqual(parseJosl(w.end()), { a: 1, t: { b: 2 } });
  });

  it('streams root-array records, one rootItem at a time', () => {
    const w = createStreamWriter();
    w.rootItem({ name: 'one', meta: { x: 1 } });
    w.rootItem();
    w.pair('name', 'two');
    w.table('meta');
    w.pair('x', 2);
    deepStrictEqual(parseJosl(w.end()), [
      { name: 'one', meta: { x: 1 } },
      { name: 'two', meta: { x: 2 } },
    ]);
  });

  it('round-trips through the reader in strict toml mode', () => {
    const w = createStreamWriter({ mode: 'toml' });
    w.pair('title', 'x').table('t').pair('when', new Date(0));
    deepStrictEqual(parseToml(w.end()), {
      title: 'x',
      t: { when: new Date(0) },
    });
  });

  it('validates what the reader would reject', () => {
    throws(() => createStreamWriter().pair('a', 1).pair('a', 2), JoslStringifyError);
    throws(() => createStreamWriter().table('t').table('t'), JoslStringifyError);
    throws(() => createStreamWriter({ mode: 'toml' }).rootItem(), JoslStringifyError);
    throws(() => createStreamWriter({ mode: 'toml' }).pair('a', null), JoslStringifyError);
    throws(() => createStreamWriter().pair('a', 1).rootItem(), JoslStringifyError);
    throws(() => createStreamWriter().table('t').rootItem(), JoslStringifyError);
    const w = createStreamWriter();
    w.end();
    throws(() => w.pair('a', 1), JoslStringifyError);
  });

  it('allows repeated tableArray but rejects repeated table headers per scope', () => {
    const w = createStreamWriter();
    w.rootItem().table('meta').pair('x', 1);
    w.rootItem().table('meta').pair('x', 2); // same header, new record scope
    deepStrictEqual(parseJosl(w.end()), [{ meta: { x: 1 } }, { meta: { x: 2 } }]);
  });
});

describe('josl: stringifyJoslChunks', () => {
  it('yields one chunk per root-array record', () => {
    const value = [{ a: 1 }, { b: { c: 2 } }, { d: 3 }];
    const chunks = [...stringifyJoslChunks(value)];
    strictEqual(chunks.length, 3);
    deepStrictEqual(parseJosl(chunks.join('')), value);
    deepStrictEqual(chunks.join(''), stringifyJosl(value));
  });
  it('yields a single chunk for table roots, identical to stringifyJosl', () => {
    const value = { a: 1, t: { b: 2 }, arr: [{ x: 1 }] };
    const chunks = [...stringifyJoslChunks(value)];
    strictEqual(chunks.length, 1);
    strictEqual(chunks[0], stringifyJosl(value));
  });
  it('rejects invalid roots', () => {
    throws(() => [...stringifyJoslChunks(42)], JoslStringifyError);
    throws(() => [...stringifyJoslChunks([1])], JoslStringifyError);
    throws(() => [...stringifyJoslChunks([{ a: 1 }], { mode: 'toml' })], JoslStringifyError);
  });
});
