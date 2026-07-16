import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { compileJsltStylesheet } from '@jarenjs/json/jslt';

function compileTypeTest(schema) {
  if (schema === false)
    return () => false;
  if (schema === true || typeof schema !== 'object' || schema === null)
    return () => true;
  return (value) => {
    if (schema.type === 'object'
      && (typeof value !== 'object' || value === null || Array.isArray(value)))
      return false;
    const required = schema.required ?? [];
    for (let i = 0; i < required.length; i++) {
      if (!Object.hasOwn(value, required[i]))
        return false;
    }
    return true;
  };
}

describe('JSLT format Appendix A examples', () => {
  it('A.1 - the empty stylesheet is the identity transform', () => {
    const stylesheet = [];
    const input = {
      store: {
        book: [
          { title: 'Sayings of the Century', price: 8.95 },
        ],
      },
    };
    const output = compileJsltStylesheet(stylesheet)(input);
    assert.strictEqual(output, input);
  });

  it('A.2 - surgical override: VAT on every price', () => {
    const stylesheet = [
      { match: '$..price', body: { $mul: ['$', 1.21] } },
    ];
    const input = {
      catalog: {
        book: [
          { title: 'A', price: 10 },
          { title: 'B', price: 20 },
        ],
      },
      meta: { publisher: { name: 'N' } },
    };
    const output = compileJsltStylesheet(stylesheet)(input);
    assert.deepStrictEqual(output, {
      catalog: {
        book: [
          { title: 'A', price: 12.1 },
          { title: 'B', price: 24.2 },
        ],
      },
      meta: { publisher: { name: 'N' } },
    });
    assert.strictEqual(output.meta, input.meta);
  });

  it('A.3 - the book example with the children array constructor', () => {
    const stylesheet = {
      $jslt: '0.1',
      rules: [
        {
          match: {
            schema: {
              type: 'object',
              required: ['isbn'],
            },
          },
          body: {
            title: '$.title',
            children: [
              { $apply: '$.chapters[*]' },
            ],
          },
        },
        {
          match: {
            schema: {
              type: 'object',
              required: ['heading'],
            },
          },
          body: { name: '$.heading' },
        },
      ],
    };
    const input = {
      isbn: '0-553-21311-3',
      title: 'Moby Dick',
      chapters: [
        { heading: 'Loomings' },
        { heading: 'The Carpet-Bag' },
      ],
    };
    assert.deepStrictEqual(
      compileJsltStylesheet(stylesheet, { compileTypeTest })(input),
      {
        title: 'Moby Dick',
        children: [
          { name: 'Loomings' },
          { name: 'The Carpet-Bag' },
        ],
      });
  });

  it('A.4 - two modes: table of contents and body rendering', () => {
    const stylesheet = {
      $jslt: '0.1',
      rules: [
        {
          match: '$',
          body: {
            toc: [
              { $apply: ['$.sections[*]', 'toc'] },
            ],
            body: [
              { $apply: ['$.sections[*]', 'render'] },
            ],
          },
        },
        {
          mode: 'toc',
          match: '$.sections[*]',
          body: { ref: '$.id', label: '$.heading' },
        },
        {
          mode: 'render',
          match: '$.sections[*]',
          body: {
            anchor: '$.id',
            heading: '$.heading',
            text: '$.text',
          },
        },
      ],
    };
    const input = {
      title: 'Guide',
      sections: [
        {
          id: 'intro',
          heading: 'Introduction',
          text: 'Start here.',
        },
        {
          id: 'usage',
          heading: 'Usage',
          text: 'Then this.',
        },
      ],
    };
    assert.deepStrictEqual(compileJsltStylesheet(stylesheet)(input), {
      toc: [
        { ref: 'intro', label: 'Introduction' },
        { ref: 'usage', label: 'Usage' },
      ],
      body: [
        {
          anchor: 'intro',
          heading: 'Introduction',
          text: 'Start here.',
        },
        {
          anchor: 'usage',
          heading: 'Usage',
          text: 'Then this.',
        },
      ],
    });
  });

  it('A.5 - fresh: an annotated copy the caller may mutate', () => {
    const stylesheet = {
      $jslt: '0.1',
      unmatched: 'fresh',
      rules: [
        {
          match: {
            schema: {
              type: 'object',
              required: ['price'],
            },
          },
          body: {
            title: '$.title',
            price: '$.price',
            taxed: { $mul: ['$.price', 1.21] },
          },
        },
      ],
    };
    const input = {
      products: [
        { title: 'A', price: 10 },
      ],
    };
    const output = compileJsltStylesheet(
      stylesheet, { compileTypeTest })(input);
    assert.deepStrictEqual(output, {
      products: [
        { title: 'A', price: 10, taxed: 12.1 },
      ],
    });
    assert.notStrictEqual(output, input);
    assert.notStrictEqual(output.products, input.products);
  });

  it('A.6 - error: exhaustive dispatch with an explicit fallback', () => {
    const stylesheet = {
      $jslt: '0.1',
      unmatched: 'error',
      rules: [
        {
          match: '$',
          body: [
            { $apply: '$.events[*]' },
          ],
        },
        {
          match: {
            schema: {
              type: 'object',
              required: ['error'],
            },
          },
          body: { level: 'fatal', message: '$.error' },
        },
        {
          match: {
            schema: {
              type: 'object',
              required: ['info'],
            },
          },
          body: { level: 'note', message: '$.info' },
        },
        { body: { level: 'unknown' } },
      ],
    };
    const input = {
      events: [
        { info: 'started' },
        { error: 'disk full' },
        { beep: true },
      ],
    };
    assert.deepStrictEqual(
      compileJsltStylesheet(stylesheet, { compileTypeTest })(input),
      [
        { level: 'note', message: 'started' },
        { level: 'fatal', message: 'disk full' },
        { level: 'unknown' },
      ]);
  });

  it('A.7 - parameters and reserved externals', () => {
    const stylesheet = [
      {
        match: '$..price',
        body: {
          amount: { $mul: ['$', '$rate'] },
          currency: '$root.currency',
          at: '$path',
        },
      },
    ];
    const input = {
      currency: 'EUR',
      items: [
        { sku: 'a1', price: 10 },
      ],
    };
    const transform = compileJsltStylesheet(stylesheet);
    assert.deepStrictEqual(transform.externals, ['rate']);
    assert.deepStrictEqual(transform(input, { rate: 1.21 }), {
      currency: 'EUR',
      items: [
        {
          sku: 'a1',
          price: {
            amount: 12.1,
            currency: 'EUR',
            at: "$['items'][0]['price']",
          },
        },
      ],
    });
  });
});
