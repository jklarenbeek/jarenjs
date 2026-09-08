import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { compileJtltStylesheet } from './grammar-harness.js';

// Every worked example of JTLT-FORMAT.md Appendix A, verbatim. When the
// specification changes, this file must change with it - the appendix
// promises its fixtures run as engine tests.

describe('JTLT-FORMAT Appendix A', () => {
  it('A.1 the empty template renders the input text', () => {
    const render = compileJtltStylesheet([]);
    assert.strictEqual(
      render({ greeting: 'hello', count: 2, flag: true, gap: null }),
      'hello2true');
  });

  it('A.2 a Markdown list', () => {
    const render = compileJtltStylesheet([
      { match: '$', body: ['# Books\n', { $apply: '$.store.book[*]' }] },
      { match: '$.store.book[*]', body: ['- ', '$.title', ' (', '$.price', ')\n'] },
    ]);
    assert.strictEqual(
      render({
        store: {
          book: [
            { title: 'A', price: 8.95 },
            { title: 'B', price: 12.99 },
          ],
        },
      }),
      '# Books\n- A (8.95)\n- B (12.99)\n');
  });

  it('A.3 XML: escaped interpolation, raw literals, $raw', () => {
    const render = compileJtltStylesheet({
      $jtlt: '0.1',
      output: 'xml',
      rules: [
        {
          match: '$',
          body: ['<note title="', '$.title', '">', { $raw: '$.markup' }, '</note>'],
        },
      ],
    });
    assert.strictEqual(
      render({ title: 'Q&A', markup: '<b>hi</b>' }),
      '<note title="Q&amp;A"><b>hi</b></note>');
  });

  it('A.4 two modes: table of contents + body text', () => {
    const render = compileJtltStylesheet({
      $jtlt: '0.1',
      rules: [
        {
          match: '$',
          body: ['TOC\n', { $apply: ['$.sections[*]', 'toc'] }, '\n',
            { $apply: '$.sections[*]' }],
        },
        { mode: 'toc', match: '$.sections[*]', body: ['- ', '$.heading', '\n'] },
        {
          match: '$.sections[*]',
          body: ['== ', '$.heading', ' ==\n', '$.text', '\n'],
        },
      ],
    });
    assert.strictEqual(
      render({
        sections: [
          { heading: 'Introduction', text: 'Start here.' },
          { heading: 'Usage', text: 'Then this.' },
        ],
      }),
      'TOC\n- Introduction\n- Usage\n\n== Introduction ==\nStart here.\n== Usage ==\nThen this.\n');
  });

  it('A.5 $apply is a value-of with rule override', () => {
    const valueOf = compileJtltStylesheet([
      { match: '$', body: ['Title: ', { $apply: '$.title' }, '\n'] },
    ]);
    assert.strictEqual(valueOf({ title: 'Moby Dick' }), 'Title: Moby Dick\n');

    const overridden = compileJtltStylesheet([
      { match: '$', body: ['Title: ', { $apply: '$.title' }, '\n'] },
      { match: '$.title', body: ['«', '$', '»'] },
    ]);
    assert.strictEqual(overridden({ title: 'Moby Dick' }),
      'Title: «Moby Dick»\n');
  });

  it('A.6 parameters and the reserved externals', () => {
    const render = compileJtltStylesheet([
      {
        match: '$..price',
        body: ['$path', ' = ', { $mul: ['$', '$rate'] }, ' ', '$root.currency', '\n'],
      },
    ]);
    assert.deepStrictEqual(render.externals, ['rate']);
    assert.strictEqual(
      render({ currency: 'EUR', items: [{ sku: 'a1', price: 10 }] }, { rate: 1.21 }),
      "EURa1$['items'][0]['price'] = 12.1 EUR\n");
  });

  it('A.7 embedding JSON with $json', () => {
    const render = compileJtltStylesheet([
      { match: '$', body: ['const data = ', { $json: '$' }, ';'] },
    ]);
    assert.strictEqual(render({ a: [1, 2] }), 'const data = {"a":[1,2]};');
  });
});
