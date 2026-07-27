import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFile } from 'node:fs/promises';

import {
  compileJSONPointer,
  compileRelativeJSONPointer,
  JSONPOINTER_NOTHING,
  compileJSONPath,
  compileJsonQuery,
  queryJson,
} from '@jarenjs/json';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { compileJtltStylesheet } from '@jarenjs/json/jtlt';
import { compileXQuery } from '@jarenjs/json/xquery';
import { JarenValidator } from '@jarenjs/validate';
import { createTypeTestCompiler } from '@jarenjs/validate/query';

// Every code example in packages/json/README.md runs here, verbatim where
// the example is self-contained, with the README's implied context (the
// RFC 9535 bookstore plus the ratings array) supplied once below. When a
// README example changes, this file must change with it - the README's
// claims are assertions, not prose.

const data = {
  store: {
    book: [
      { category: 'reference', author: 'Nigel Rees', title: 'Sayings of the Century', price: 8.95 },
      { category: 'fiction', author: 'Evelyn Waugh', title: 'Sword of Honour', price: 12.99 },
      { category: 'fiction', author: 'Herman Melville', title: 'Moby Dick', isbn: '0-553-21311-3', price: 8.99 },
      { category: 'fiction', author: 'J. R. R. Tolkien', title: 'The Lord of the Rings', isbn: '0-395-19395-8', price: 22.99 },
    ],
    bicycle: { color: 'red', price: 399 },
  },
  ratings: [
    { isbn: '0-395-19395-8', stars: 5 },
    { isbn: '0-553-21311-3', stars: 4 },
    { isbn: '0-000-00000-0', stars: 1 },
  ],
};

describe('README examples: JSON Pointer', () => {
  it('resolves pointers and relative pointers as documented', () => {
    const doc = { limits: { min: 2, max: 9 }, value: 5 };

    const getMin = compileJSONPointer('/limits/min');
    assert.strictEqual(getMin(doc), 2);
    assert.strictEqual(getMin({}), JSONPOINTER_NOTHING);

    const getLimits = compileRelativeJSONPointer('1/limits');
    assert.deepStrictEqual(getLimits(doc, '/value'), { min: 2, max: 9 });

    const getName = compileRelativeJSONPointer('0#');
    assert.strictEqual(getName(doc, '/limits/min'), 'min');
  });
});

describe('README examples: the JSONPath compiler', () => {
  it('compiles once and runs on any document', () => {
    const query = compileJSONPath('$.store.book[?@.price < 10].title');

    assert.deepStrictEqual(query(data), ['Sayings of the Century', 'Moby Dick']);

    const other = { store: { book: [{ title: 'Cheap', price: 1 }] } };
    assert.deepStrictEqual(query(other), ['Cheap']);
  });
});

describe('README examples: the Jaren JSON Query language', () => {
  it('runs the opening filter + project example', () => {
    const query = compileJsonQuery({
      $for: { b: '$.store.book[*]' },
      $where: { $lt: ['$b.price', 10] },
      $orderby: '$b.price',
      $return: { title: '$b.title', price: '$b.price' },
    });

    assert.deepStrictEqual(query(data), [
      { title: 'Sayings of the Century', price: 8.95 },
      { title: 'Moby Dick', price: 8.99 },
    ]);
  });

  it('accepts a bare JSONPath string as the degenerate query', () => {
    assert.deepStrictEqual(
      queryJson('$.store.book[?@.price < 10].title', data),
      ['Sayings of the Century', 'Moby Dick']);
  });

  it('runs the join example (spec A.3)', () => {
    assert.deepStrictEqual(
      queryJson({
        $for: { b: '$.store.book[*]', r: '$.ratings[*]' },
        $where: { $eq: ['$b.isbn', '$r.isbn'] },
        $orderby: '$b.price',
        $return: { title: '$b.title', stars: '$r.stars' },
      }, data),
      [
        { title: 'Moby Dick', stars: 4 },
        { title: 'The Lord of the Rings', stars: 5 },
      ]);
  });

  it('runs the grouping example (spec A.4)', () => {
    assert.deepStrictEqual(
      queryJson({
        $for: { b: '$.store.book[*]' },
        $groupby: { genre: '$b.category' },
        $return: { genre: '$genre', count: { $count: '$b' }, avg: { $avg: '$b.price' } },
      }, data),
      [
        { genre: 'reference', count: 1, avg: 8.95 },
        { genre: 'fiction', count: 3, avg: 14.99 },
      ]);
  });

  it('collects and binds external parameters', () => {
    const cheaper = compileJsonQuery({
      $for: { b: '$.store.book[*]' },
      $where: { $le: ['$b.price', '$maxPrice'] },
      $return: '$b.title',
    });

    assert.deepStrictEqual([...cheaper.externals], ['maxPrice']);
    assert.deepStrictEqual(
      cheaper(data, { maxPrice: 9 }),
      ['Sayings of the Century', 'Moby Dick']);
  });

  it('reduces a tuple stream with $fold', () => {
    assert.strictEqual(queryJson({
      $fold: { total: 0 },
      $for: { b: '$.store.book[*]' },
      $where: { $lt: ['$b.price', 10] },
      $return: { $add: ['$total', '$b.price'] },
    }, data), 17.939999999999998);
  });

  it('walks a runtime path by folding $get over its segments', () => {
    assert.strictEqual(queryJson({
      $fold: { cur: '$.doc' },
      $for: { seg: '$.path[*]' },
      $return: { $get: ['$cur', '$seg'] },
    }, { doc: { a: { b: [10, 20] } }, path: ['a', 'b', 1] }), 20);
  });

  it('buckets dates into ISO weeks', () => {
    assert.deepStrictEqual(queryJson({
      $for: { e: '$[*]' },
      $groupby: { w: { '$start-of': ['$e.on', 'week'] } },
      $orderby: ['$w'],
      $return: { week: '$w', count: { $count: '$e' } },
    }, [{ on: '2026-01-05' }, { on: '2026-01-08' }, { on: '2026-01-20' }]),
    [{ week: '2026-01-05', count: 2 }, { week: '2026-01-19', count: 1 }]);
  });

  it('averages a sliding window', () => {
    assert.deepStrictEqual(queryJson({
      $for: { w: { $in: '$[*]', $window: 'sliding', $size: 3 } },
      $return: { $avg: '$w' },
    }, [1, 2, 3, 4, 5]), [2, 3, 4]);
  });
});

describe('README examples: generating queries with LLMs', () => {
  it('validates, compiles and runs a structured-output query document', async () => {
    // stand-in for the provider's structured-output call in the README;
    // returns what a schema-constrained model would emit for the prompt
    const generate = async (_prompt, _schema) => JSON.stringify({
      $for: { b: '$.store.book[*]' },
      $where: { $lt: ['$b.price', 10] },
      $groupby: { genre: '$b.category' },
      $return: { genre: '$genre', cheap: { $count: '$b' } },
    });
    const prompt = 'cheap books per genre';

    // the README pipeline, verbatim
    const schema = JSON.parse(await readFile('packages/json/schemas/jaren-query.schema.json', 'utf8'));

    const text = await generate(prompt, schema);

    const isQueryDoc = new JarenValidator().compile(schema);
    const doc = JSON.parse(text);
    if (!isQueryDoc(doc)) throw new Error('model escaped the schema');
    const query = compileJsonQuery(doc);

    assert.deepStrictEqual(query(data), [
      { genre: 'reference', cheap: 1 },
      { genre: 'fiction', cheap: 1 },
    ]);

    // ... and the validator actually rejects out-of-grammar documents
    assert.strictEqual(isQueryDoc({ $eq: [1, 2, 3] }), false);
  });
});

describe('README examples: the XQuery text front-end', () => {
  it('compiles the README query text', () => {
    const q = compileXQuery('for $b in $doc?store?book?* where $b?price lt 10 return $b?title');

    assert.deepStrictEqual(
      q(null, { doc: data }),
      ['Sayings of the Century', 'Moby Dick']);
  });
});

describe('README examples: JSLT declarative transformation', () => {
  it('performs the surgical VAT override and shares untouched subtrees', () => {
    const applyVat = compileJsltStylesheet([
      { match: '$..price', body: { $mul: ['$', 1.21] } },
    ]);

    const input = {
      catalog: { books: [{ title: 'A', price: 10 }] },
      meta: { publisher: 'N' },
    };
    const output = applyVat(input);

    assert.strictEqual(output.catalog.books[0].price, 12.1);
    assert.strictEqual(output.meta, input.meta);
  });

  it('renders the same sections through two modes', () => {
    const renderGuide = compileJsltStylesheet({
      $jslt: '0.1',
      rules: [
        {
          match: '$',
          body: {
            toc: [{ $apply: ['$.sections[*]', 'toc'] }],
            body: [{ $apply: ['$.sections[*]', 'render'] }],
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
          body: { anchor: '$.id', text: '$.text' },
        },
      ],
    });

    assert.deepStrictEqual(renderGuide({
      sections: [{
        id: 'intro',
        heading: 'Introduction',
        text: 'Start here.',
      }],
    }), {
      toc: [{ ref: 'intro', label: 'Introduction' }],
      body: [{ anchor: 'intro', text: 'Start here.' }],
    });
  });

  it('wires schema matches through the validator type-test bridge', () => {
    const annotateBooks = compileJsltStylesheet([
      {
        match: {
          schema: { type: 'object', required: ['title', 'author'] },
        },
        body: {
          title: '$.title',
          byline: { $concat: ['$.title', ' by ', '$.author'] },
        },
      },
    ], { compileTypeTest: createTypeTestCompiler() });

    assert.deepStrictEqual(
      annotateBooks({ book: { title: 'Moby Dick', author: 'Herman Melville' } }),
      {
        book: {
          title: 'Moby Dick',
          byline: 'Moby Dick by Herman Melville',
        },
      });
  });
});

describe('README examples: JTLT template-driven text output', () => {
  it('renders the book list as markdown text', () => {
    const listBooks = compileJtltStylesheet([
      { match: '$', body: ['# Books\n', { $apply: '$.store.book[*]' }] },
      { match: '$.store.book[*]', body: ['- ', '$.title', ' (', '$.price', ')\n'] },
    ]);

    assert.strictEqual(listBooks(data),
      '# Books\n'
      + '- Sayings of the Century (8.95)\n'
      + '- Sword of Honour (12.99)\n'
      + '- Moby Dick (8.99)\n'
      + '- The Lord of the Rings (22.99)\n');
  });

  it('renders XML with escaped interpolation and raw literal markup', () => {
    const toXml = compileJtltStylesheet({
      $jtlt: '0.1',
      output: 'xml',
      rules: [
        { match: '$', body: ['<books>', { $apply: '$.store.book[*]' }, '</books>'] },
        { match: '$.store.book[*]', body: ['<book title="', '$.title', '"/>'] },
      ],
    });

    assert.strictEqual(toXml(data),
      '<books>'
      + '<book title="Sayings of the Century"/>'
      + '<book title="Sword of Honour"/>'
      + '<book title="Moby Dick"/>'
      + '<book title="The Lord of the Rings"/>'
      + '</books>');
  });
});
